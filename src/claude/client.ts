import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import Anthropic from '@anthropic-ai/sdk'
import type { PRInfo, ReviewComment, CommentReply } from '../vcs/adapter.js'
import type { FileContext } from '../context/fetcher.js'
import type { LoadedPrompt } from '../prompt/loader.js'

const MAX_TOKENS = 4096

export async function runReview(
  apiKey: string,
  model: string,
  prInfo: PRInfo,
  diff: string,
  fileContexts: FileContext[],
  prompt: LoadedPrompt,
  previousReviews: ReviewComment[]
): Promise<string> {
  const client = new Anthropic({ apiKey })

  const userMessage = buildUserMessage(prInfo, diff, fileContexts, previousReviews)

  console.log(`Sending request to Claude (${model})...`)

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: prompt.content,
    messages: [{ role: 'user', content: userMessage }],
  })

  const block = response.content[0]
  if (block.type !== 'text') throw new Error('Unexpected response type from Claude')

  console.log(`Review received (${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens)`)

  return block.text
}

function buildUserMessage(
  prInfo: PRInfo,
  diff: string,
  fileContexts: FileContext[],
  previousReviews: ReviewComment[]
): string {
  const parts: string[] = []

  parts.push(`## Pull Request: ${prInfo.title}`)
  parts.push(`## Branch: ${prInfo.sourceBranch} → ${prInfo.targetBranch}`)

  if (prInfo.description) {
    parts.push(`## Description:\n${prInfo.description}`)
  }

  if (previousReviews.length > 0) {
    parts.push(`## Previous Review(s) by This Agent (${previousReviews.length} total):`)
    parts.push('The following reviews were posted on earlier revisions of this PR. Acknowledge what was fixed, do not repeat issues that are now resolved, and call out anything still unaddressed.')
    for (const review of previousReviews) {
      parts.push(`### Review from ${review.createdOn}:\n${review.body}`)
    }
  }

  parts.push(`## Diff:\n\`\`\`diff\n${diff}\n\`\`\``)

  if (fileContexts.length > 0) {
    parts.push('## Full file context:')
    for (const file of fileContexts) {
      parts.push(`### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
    }
  }

  return parts.join('\n\n')
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
  diff: string,
  originalReview: string,
  replies: CommentReply[]
): Promise<string> {
  const client = new Anthropic({ apiKey })

  const parts: string[] = []
  parts.push(`## Your Original Review:\n${originalReview}`)
  parts.push(`## Diff:\n\`\`\`diff\n${diff}\n\`\`\``)
  parts.push(`## Developer Replies (answer all of these):`)
  for (const r of replies) {
    parts.push(`**${r.author}** (${r.createdOn}):\n> ${r.body}`)
  }
  const userMessage = parts.join('\n\n')

  console.log(`Sending reply request to Claude (${model})...`)

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system: getReplyPrompt(),
    messages: [{ role: 'user', content: userMessage }],
  })

  const block = response.content[0]
  if (block.type !== 'text') throw new Error('Unexpected response type from Claude')

  console.log(`Reply received (${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens)`)

  return block.text
}
