import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { createProvider, type LLMUsage } from '../llm/provider.js'
import { renderReview, ISSUE_TYPES, type ReviewObject, type ReviewFinding, type FindingScore } from '../review/formatter.js'
import type { KeptFinding } from '../review/findings-output.js'
import {
  REASON_CATEGORIES, DEFAULT_JUDGE_POLICY, applyJudgeDecisions, renderCandidatesForJudge, summarizeDecisions,
  type JudgeOutput, type JudgePolicy, type AppliedDecision, type JudgeAnomalies,
} from '../review/judge-decisions.js'
import { numberDiffLines, numberFileLines } from '../review/parsers.js'
import type { PRInfo, ReviewComment, CommentReply } from '../vcs/adapter.js'
import type { FileContext } from '../context/fetcher.js'
import type { LoadedPrompt } from '../prompt/loader.js'

const REPLY_MAX_TOKENS = 4096

export interface ClaudeResult {
  text: string
  usage: LLMUsage
  /** Reviewer's structured output — typed source for findings/delta metrics. Review runs only. */
  review?: ReviewObject
}

export interface JudgeResult extends ClaudeResult {
  /** Validation reasoning — logged, never posted. */
  notes?: string
  /** Per-finding 0–10 confidence for the kept findings — logged to results.jsonl, never posted. */
  scores?: FindingScore[]
  /** sha256-12 of the judge system prompt actually used — config attribution for usage records. */
  promptHash?: string
  decisions?: AppliedDecision[]
  anomalies?: JudgeAnomalies
  kept?: KeptFinding[]
}

// The judge rules on candidate ids and the app renders the comment, so reasoning can't leak; the judge only anchors candidates whose reviewer location has no numeric line.
export const JUDGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      description: 'Exactly one decision per candidate id in the review. Internal — logged, never posted.',
      items: {
        type: 'object',
        properties: {
          candidate_id: { type: 'string', description: 'The candidate id from the review, e.g. "c0".' },
          reason_category: { type: 'string', enum: [...REASON_CATEGORIES], description: 'The single category that best explains the decision.' },
          evidence: { type: 'string', description: 'file:line and a short quote of the code that settles it. For incorrect and already_handled, the code that contradicts or covers the claim. Empty string when there is none.' },
          note: { type: 'string', description: 'One sentence: why this category.' },
          score: { type: 'integer', description: '0–10 confidence the candidate is a real problem at its stated severity: 10 = certain with quoted evidence; 5 = plausible but not fully verifiable; 0 = speculative. Independent of severity.' },
          rewritten_body: { type: 'string', description: 'Only for a candidate you keep whose body is verbose or unclear: problem, why it matters, fix, in 1–3 sentences. Omit to keep the reviewer text.' },
          question: { type: 'string', description: 'framework_uncertainty only: the open question, one line, as it should appear under Unresolved Questions.' },
          anchor_file: { type: 'string', description: 'Only when the candidate shows no numeric line: the file path where the problem is in the diff.' },
          anchor_lines: { type: 'string', description: 'Only when the candidate shows no numeric line: digits only — the line number or range, e.g. "42" or "26-31", never a symbol name or quoted code.' },
          anchor_quote: { type: 'string', description: 'For a candidate you keep: a verbatim copy of the single diff line that best locates it — exactly as it appears, one line only, not a line number, not a paraphrase, not multiple lines joined. Lets the system anchor it from the diff when the line number is unknown.' },
        },
        required: ['candidate_id', 'reason_category', 'evidence', 'note', 'score'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', description: 'One-line production risk assessment of the PR itself — what changed and whether it is safe.' },
    behavioral_diff: { type: 'array', items: { type: 'string' }, description: 'What changed and why it matters, one short line each.' },
    production_risk: { type: 'array', items: { type: 'string' }, description: 'Failure scenarios tied to kept findings only.' },
    unresolved_questions: { type: 'array', items: { type: 'string' }, description: 'Questions still open after validation, excluding framework_uncertainty candidates.' },
    merge_confidence: { type: 'integer', description: '0–100: overall confidence the PR is safe to merge.' },
  },
  required: ['decisions', 'summary', 'behavioral_diff', 'production_risk', 'unresolved_questions', 'merge_confidence'],
  additionalProperties: false,
} as const

// The reviewer emits typed fields, not prose — the system renders the markdown (renderReview),
// so preamble, tone, or a footer can't leak into the posted review. Mirrors base-prompt.txt's
// OUTPUT section; the judge adds Merge Confidence downstream.
export const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One-line production risk assessment. On a re-review, note which previous findings are fixed vs still open.' },
    findings: {
      type: 'array',
      description: 'Issues being flagged, most severe first. New findings only on a re-review — previous findings are already on record.',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: 'HIGH only for a confirmed, reproducible runtime failure (crash, data loss, security breach, outage).' },
          title: { type: 'string', description: 'Short label for the issue.' },
          file: { type: 'string', description: 'File path when the finding is tied to specific code. Omit if not line-specific.' },
          lines: { type: 'string', description: 'The diff line number or range as digits only, e.g. "42" or "26-31". NEVER a function/symbol name or quoted code. Omit only for a genuinely file-level finding.' },
          body: { type: 'string', description: 'Problem, why it matters, fix. Terse — no essays.' },
          type: { type: 'string', enum: [...ISSUE_TYPES], description: 'The one dominant issue category. performance = slow/expensive under normal operation; reliability = hangs/leaks/fails under error, timeout, or retry. Omit if none clearly applies.' },
        },
        required: ['severity', 'title', 'body'],
        additionalProperties: false,
      },
    },
    behavioral_diff: { type: 'array', items: { type: 'string' }, description: 'What changed vs the target branch and why it matters, as short bullets.' },
    production_risk: { type: 'array', items: { type: 'string' }, description: 'Concrete failure modes and realistic outage scenarios, as short bullets.' },
    unresolved_questions: { type: 'array', items: { type: 'string' }, description: 'Anything you cannot verify as safe. Empty only when genuinely nothing is open. New questions only on a re-review.' },
    can_be_split: { type: 'array', items: { type: 'string' }, description: 'Only when a SPLIT CHECK instruction is present: independent themes this PR could split into. Empty/omitted if cohesive.' },
    delta_stats: {
      type: 'object',
      description: 'Only on a re-review: counts vs the previous review.',
      properties: {
        resolved: { type: 'integer', description: 'Previous findings fixed by the new commits.' },
        still_open: { type: 'integer', description: 'Previous findings still present.' },
        new_findings: { type: 'integer', description: 'New findings introduced in this re-review.' },
      },
      required: ['resolved', 'still_open', 'new_findings'],
      additionalProperties: false,
    },
    no_change: { type: 'boolean', description: 'Set true ONLY on a re-review (when a previous review is in context) and nothing material changed — no findings resolved, none new, only cosmetic edits. NEVER set it on a first review. Leave the other fields empty when true.' },
  },
  required: ['summary', 'findings', 'behavioral_diff', 'production_risk', 'unresolved_questions'],
  additionalProperties: false,
} as const

export async function runReview(
  apiKey: string,
  model: string,
  maxRetries: number,
  maxTokens: number,
  effort: string,
  prInfo: PRInfo,
  diff: string,
  fileContexts: FileContext[],
  prompt: LoadedPrompt,
  previousReviews: ReviewComment[],
  developerReplies: CommentReply[] = [],
  changesSinceLastReview = '',
  lineNumbers = false,
): Promise<ClaudeResult> {
  const userMessage = buildUserMessage(prInfo, diff, fileContexts, previousReviews, developerReplies, changesSinceLastReview, lineNumbers)

  console.log(`Sending request to Claude (${model}, maxRetries: ${maxRetries})...`)
  const { object, usage } = await createProvider(apiKey).completeStructured<ReviewObject>(
    prompt.content, userMessage, REVIEW_OUTPUT_SCHEMA, { model, maxTokens, maxRetries, effort: effort || undefined },
  )
  const text = renderReview(object)

  console.log(`Review received (${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${object.no_change ? 'NO_CHANGE' : `${object.findings.length} findings`})`)

  return { text, usage, review: object }
}

// Findings only, with the reviewer's item schema so the two can't drift; a distinct object because tests dispatch their mocks on schema identity.
export const BREADTH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { findings: REVIEW_OUTPUT_SCHEMA.properties.findings },
  required: ['findings'],
  additionalProperties: false,
} as const

export async function runBreadth(
  apiKey: string,
  model: string,
  maxRetries: number,
  maxTokens: number,
  effort: string,
  prInfo: PRInfo,
  diff: string,
  fileContexts: FileContext[],
  systemPrompt: string,
  briefing: string,
  lineNumbers = false,
): Promise<{ findings: ReviewFinding[]; usage: LLMUsage; promptHash: string }> {
  const userMessage = `${buildUserMessage(prInfo, diff, fileContexts, [], [], '', lineNumbers)}\n\n${briefing}`
  console.log(`Sending to breadth reviewer (${model}, maxRetries: ${maxRetries})...`)
  const { object, usage } = await createProvider(apiKey).completeStructured<{ findings: ReviewFinding[] }>(
    systemPrompt, userMessage, BREADTH_OUTPUT_SCHEMA, { model, maxTokens, maxRetries, effort: effort || undefined },
  )
  console.log(`Breadth received (${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${object.findings?.length ?? 0} findings)`)
  return { findings: object.findings ?? [], usage, promptHash: createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12) }
}

function buildUserMessage(
  prInfo: PRInfo,
  diff: string,
  fileContexts: FileContext[],
  previousReviews: ReviewComment[],
  developerReplies: CommentReply[],
  changesSinceLastReview = '',
  lineNumbers = false,
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

  parts.push(renderDiff(diff, lineNumbers))

  // The full diff above is the whole PR vs target — it doesn't mark which lines are new since the
  // last review, so on re-reviews scope the actual changes so fixes are visible without inferring
  // them from the previous review's prose.
  if (changesSinceLastReview && previousReviews.length > 0) {
    parts.push(`## Changes Since Your Last Review:\nThe diff below is ONLY the lines changed since your previous review above — use it to see exactly what was added or fixed. Credit findings these changes resolve, and assess anything new. The complete PR diff is above for full context.\n\`\`\`diff\n${lineNumbers ? numberDiffLines(changesSinceLastReview) : changesSinceLastReview}\n\`\`\``)
  }

  if (fileContexts.length > 0) parts.push(renderFileContexts(fileContexts, lineNumbers))

  return parts.join('\n\n')
}

function renderDiff(diff: string, lineNumbers: boolean): string {
  if (!lineNumbers) return `## Diff:\n\`\`\`diff\n${diff}\n\`\`\``
  return `## Diff (each added or unchanged line starts with its line number in the new file — cite those numbers in \`lines\`):\n\`\`\`diff\n${numberDiffLines(diff)}\n\`\`\``
}

function renderFileContexts(fileContexts: FileContext[], lineNumbers = false): string {
  const heading = lineNumbers ? '## Full file context (each line starts with its line number):' : '## Full file context:'
  return [heading, ...fileContexts.map(f => `### ${f.path}\n\`\`\`\n${lineNumbers ? numberFileLines(f.content) : f.content}\n\`\`\``)].join('\n\n')
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
  maxTokens: number,
  effort: string,
  diff: string,
  review: ReviewObject,
  fileContexts: FileContext[] = [],
  policy: JudgePolicy = DEFAULT_JUDGE_POLICY,
  lineNumbers = false,
  breadthFrom?: number,
): Promise<JudgeResult> {
  const parts: string[] = []
  parts.push(renderDiff(diff, lineNumbers))
  if (fileContexts.length > 0) parts.push(renderFileContexts(fileContexts, lineNumbers))
  parts.push(`## Review to Validate:\n${renderCandidatesForJudge(review)}`)
  const userMessage = parts.join('\n\n')

  const judgePrompt = getJudgePrompt()
  console.log(`Sending to judge (${model}, maxRetries: ${maxRetries}${fileContexts.length ? `, ${fileContexts.length} context file(s)` : ''})...`)
  const { object, usage } = await createProvider(apiKey).completeStructured<JudgeOutput>(
    judgePrompt, userMessage, JUDGE_OUTPUT_SCHEMA, { model, maxTokens, maxRetries, effort: effort || undefined },
  )

  console.log(`Judge received (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`)

  const judged = applyJudgeDecisions(review.findings, object, policy, review.can_be_split, diff, breadthFrom)
  const promptHash = createHash('sha256').update(judgePrompt).digest('hex').slice(0, 12)
  return {
    text: judged.markdown, usage, notes: summarizeDecisions(judged.decisions), scores: judged.scores, promptHash,
    decisions: judged.decisions, anomalies: judged.anomalies, kept: judged.kept,
  }
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
  const parts: string[] = []
  parts.push(`## Your Original Review:\n${originalReview}`)
  parts.push(`## Diff:\n\`\`\`diff\n${diff}\n\`\`\``)
  parts.push(`## Developer Replies (answer all of these):`)
  for (const r of replies) {
    parts.push(`**${r.author}** (${r.createdOn}):\n> ${r.body}`)
  }
  const userMessage = parts.join('\n\n')

  console.log(`Sending reply request to Claude (${model}, maxRetries: ${maxRetries})...`)
  const { text, usage } = await createProvider(apiKey).complete(getReplyPrompt(), userMessage, { model, maxTokens: REPLY_MAX_TOKENS, maxRetries })

  console.log(`Reply received (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`)

  return { text, usage }
}
