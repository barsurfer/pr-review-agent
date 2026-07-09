import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import Anthropic from '@anthropic-ai/sdk'
import type { PRInfo, ReviewComment, CommentReply } from '../vcs/adapter.js'
import type { FileContext } from '../context/fetcher.js'
import type { LoadedPrompt } from '../prompt/loader.js'

const MAX_TOKENS = 16000
const REPLY_MAX_TOKENS = 4096

export interface ClaudeUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface ClaudeResult {
  text: string
  usage: ClaudeUsage
}

export interface JudgeResult extends ClaudeResult {
  /** Validation reasoning — logged, never posted. */
  notes?: string
}

// Structured output keeps validation reasoning physically separate from the
// posted review — prompt-only suppression proved leaky (PR 8722)
const JUDGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    review_markdown: {
      type: 'string',
      description: 'The final review comment exactly as it will be posted, starting with the "### Summary" heading. No validation reasoning, no preamble.',
    },
    judge_notes: {
      type: 'string',
      description: 'Validation reasoning: which findings were dropped or downgraded and why. Internal — never posted.',
    },
  },
  required: ['review_markdown', 'judge_notes'],
  additionalProperties: false,
} as const

export async function runReview(
  apiKey: string,
  model: string,
  maxRetries: number,
  prInfo: PRInfo,
  diff: string,
  fileContexts: FileContext[],
  prompt: LoadedPrompt,
  previousReviews: ReviewComment[],
  developerReplies: CommentReply[] = [],
  changesSinceLastReview = ''
): Promise<ClaudeResult> {
  const client = new Anthropic({ apiKey, maxRetries })

  const userMessage = buildUserMessage(prInfo, diff, fileContexts, previousReviews, developerReplies, changesSinceLastReview)

  console.log(`Sending request to Claude (${model}, maxRetries: ${maxRetries})...`)

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: prompt.content,
    messages: [{ role: 'user', content: userMessage }],
  })

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Review truncated at ${MAX_TOKENS} output tokens — refusing to post a cut-off review`)
  }

  // Find the text block rather than assuming it's first — newer models can emit a
  // thinking (or other) block ahead of the text.
  const block = response.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Unexpected response type from Claude (no text block)')

  const usage: ClaudeUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
  }

  console.log(`Review received (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`)

  return { text: block.text, usage }
}

function buildUserMessage(
  prInfo: PRInfo,
  diff: string,
  fileContexts: FileContext[],
  previousReviews: ReviewComment[],
  developerReplies: CommentReply[],
  changesSinceLastReview = ''
): string {
  const parts: string[] = []

  parts.push(`## Pull Request: ${prInfo.title}`)
  parts.push(`## Branch: ${prInfo.sourceBranch} → ${prInfo.targetBranch}`)

  if (prInfo.description) {
    parts.push(`## Description:\n${prInfo.description}`)
  }

  if (previousReviews.length > 0) {
    const latest = previousReviews[previousReviews.length - 1]
    parts.push(`## Previous Review by This Agent (latest of ${previousReviews.length} total):`)
    parts.push('This is the most recent review posted on an earlier revision of this PR. Acknowledge what was fixed, do not repeat issues that are now resolved, and call out anything still unaddressed.')
    parts.push(`### Review from ${latest.createdOn}:\n${latest.body}`)
  }

  if (developerReplies.length > 0) {
    parts.push(`## Developer Discussion on Previous Review(s):`)
    parts.push('Below is the conversation thread from previous reviews, including developer replies and the agent\'s own prior responses. IMPORTANT: If the agent previously acknowledged a finding as a false positive or accepted a developer\'s explanation, do NOT re-raise that finding. Treat the agent\'s prior conclusions as settled unless the new code changes invalidate them.')
    for (const r of developerReplies) {
      parts.push(`**${r.author}** (${r.createdOn}):\n> ${r.body}`)
    }
  }

  parts.push(`## Diff:\n\`\`\`diff\n${diff}\n\`\`\``)

  // The full diff above is the whole PR vs target — it doesn't mark which lines are new since the
  // last review, so on re-reviews scope the actual changes so fixes are visible without inferring
  // them from the previous review's prose.
  if (changesSinceLastReview && previousReviews.length > 0) {
    parts.push(`## Changes Since Your Last Review:\nThe diff below is ONLY the lines changed since your previous review above — use it to see exactly what was added or fixed. Credit findings these changes resolve, and assess anything new. The complete PR diff is above for full context.\n\`\`\`diff\n${changesSinceLastReview}\n\`\`\``)
  }

  if (fileContexts.length > 0) {
    parts.push('## Full file context:')
    for (const file of fileContexts) {
      parts.push(`### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
    }
  }

  return parts.join('\n\n')
}

function getJudgePrompt(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url))
    return readFileSync(join(__dir, '..', 'prompt', 'judge-prompt.txt'), 'utf-8')
  } catch {
    // @ts-ignore — injected at bundle time
    if (typeof __JUDGE_PROMPT__ !== 'undefined') return __JUDGE_PROMPT__ as string
    throw new Error('Cannot load judge prompt: file not found and no embedded copy')
  }
}

export async function runJudge(
  apiKey: string,
  model: string,
  maxRetries: number,
  diff: string,
  reviewText: string,
): Promise<JudgeResult> {
  const client = new Anthropic({ apiKey, maxRetries })

  const parts: string[] = []
  parts.push(`## Diff:\n\`\`\`diff\n${diff}\n\`\`\``)
  parts.push(`## Review to Validate:\n${reviewText}`)
  const userMessage = parts.join('\n\n')

  console.log(`Sending to judge (${model}, maxRetries: ${maxRetries})...`)

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: getJudgePrompt(),
    output_config: { format: { type: 'json_schema', schema: JUDGE_OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content: userMessage }],
  })

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Judge output truncated at ${MAX_TOKENS} output tokens — refusing to post a cut-off review`)
  }

  // Find the text block rather than assuming it's first — newer models can emit a
  // thinking (or other) block ahead of the text.
  const block = response.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Unexpected response type from Claude (no text block)')

  let parsed: { review_markdown: string; judge_notes: string }
  try {
    parsed = JSON.parse(block.text)
  } catch {
    throw new Error('Judge returned invalid JSON despite structured output — refusing to post')
  }

  const usage: ClaudeUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
  }

  console.log(`Judge received (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`)

  return { text: parsed.review_markdown, usage, notes: parsed.judge_notes }
}

function getReplyPrompt(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url))
    return readFileSync(join(__dir, '..', 'prompt', 'reply-prompt.txt'), 'utf-8')
  } catch {
    // @ts-ignore — injected at bundle time
    if (typeof __REPLY_PROMPT__ !== 'undefined') return __REPLY_PROMPT__ as string
    throw new Error('Cannot load reply prompt: file not found and no embedded copy')
  }
}

export async function runCommentResponse(
  apiKey: string,
  model: string,
  maxRetries: number,
  diff: string,
  originalReview: string,
  replies: CommentReply[]
): Promise<ClaudeResult> {
  const client = new Anthropic({ apiKey, maxRetries })

  const parts: string[] = []
  parts.push(`## Your Original Review:\n${originalReview}`)
  parts.push(`## Diff:\n\`\`\`diff\n${diff}\n\`\`\``)
  parts.push(`## Developer Replies (answer all of these):`)
  for (const r of replies) {
    parts.push(`**${r.author}** (${r.createdOn}):\n> ${r.body}`)
  }
  const userMessage = parts.join('\n\n')

  console.log(`Sending reply request to Claude (${model}, maxRetries: ${maxRetries})...`)

  const response = await client.messages.create({
    model,
    max_tokens: REPLY_MAX_TOKENS,
    system: getReplyPrompt(),
    messages: [{ role: 'user', content: userMessage }],
  })

  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Reply truncated at ${REPLY_MAX_TOKENS} output tokens — refusing to post a cut-off reply`)
  }

  // Find the text block rather than assuming it's first — newer models can emit a
  // thinking (or other) block ahead of the text.
  const block = response.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Unexpected response type from Claude (no text block)')

  const usage: ClaudeUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
  }

  console.log(`Reply received (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`)

  return { text: block.text, usage }
}
