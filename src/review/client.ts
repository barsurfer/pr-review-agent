import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { createProvider, type LLMUsage } from '../llm/provider.js'
import { renderReview, ISSUE_TYPES, type ReviewObject, type ReviewFinding, type FindingScore } from './formatter.js'
import type { KeptFinding } from './findings-output.js'
import {
  REASON_CATEGORIES, DEFAULT_JUDGE_POLICY, applyJudgeDecisions, renderCandidatesForJudge, summarizeDecisions,
  type JudgeOutput, type JudgePolicy, type JudgeOptions, type AppliedDecision, type JudgeAnomalies,
} from './judge-decisions.js'
import { composeJudgePrompt, QUALITY_DECISION_PROPERTIES, PROPOSAL_DECISION_PROPERTIES, SHOWN_ANCHOR_DESCRIPTIONS } from './judge-quality.js'
import { numberDiffLines, numberFileLines } from './parsers.js'
import { LENS_REGISTRY, sanitizeLensRecommendations, type LensRecommendation } from './lenses.js'
import type { PRInfo, ReviewComment, CommentReply } from '../vcs/adapter.js'
import type { FileContext } from '../context/fetcher.js'
import type { LoadedPrompt } from '../prompt/loader.js'

const REPLY_MAX_TOKENS = 4096

export interface ModelResult {
  text: string
  usage: LLMUsage
  /** Reviewer's structured output — typed source for findings/delta metrics. Review runs only. */
  review?: ReviewObject
  lensRecommendations?: LensRecommendation[] | null
}

export interface JudgeResult extends ModelResult {
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

const schemaVariants = new Map<string, Record<string, unknown>>()

// Flag-off returns the shared constant itself, so the model-facing schema (and any identity check on it) is unchanged.
export function judgeOutputSchema(quality: boolean, shownAnchors: boolean, proposals = false): Record<string, unknown> {
  if (!quality && !shownAnchors && !proposals) return JUDGE_OUTPUT_SCHEMA
  const key = `${quality}:${shownAnchors}:${proposals}`
  const cached = schemaVariants.get(key)
  if (cached) return cached
  const schema = structuredClone(JUDGE_OUTPUT_SCHEMA) as unknown as { properties: { decisions: { items: { properties: Record<string, unknown> } } } }
  const props = schema.properties.decisions.items.properties as Record<string, { description?: string }>
  if (shownAnchors) {
    props.anchor_file.description = SHOWN_ANCHOR_DESCRIPTIONS.anchor_file
    props.anchor_lines.description = SHOWN_ANCHOR_DESCRIPTIONS.anchor_lines
  }
  if (quality) Object.assign(props, structuredClone(QUALITY_DECISION_PROPERTIES))
  if (proposals) Object.assign(props, structuredClone(PROPOSAL_DECISION_PROPERTIES))
  schemaVariants.set(key, schema)
  return schema
}

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

let lensRecommendationSchema: Record<string, unknown> | undefined

// Log-only, so lens gating can be checked offline against golden hits before any lens is skipped on the reviewer's word.
export function reviewOutputSchema(lensRecommendation: boolean): Record<string, unknown> {
  if (!lensRecommendation) return REVIEW_OUTPUT_SCHEMA
  if (lensRecommendationSchema) return lensRecommendationSchema
  const schema = structuredClone(REVIEW_OUTPUT_SCHEMA) as unknown as { properties: Record<string, unknown>; required: string[] }
  const triggers = Object.values(LENS_REGISTRY).map(l => `${l.name} (${l.when})`).join('; ')
  schema.properties.lens_recommendations = {
    type: 'array',
    description: `A focused follow-up review pass exists for each of these concerns: ${triggers}. List a lens only when THIS diff has substantive changed code for that concern in which a dedicated pass could plausibly find a real defect the change introduces. Return an empty array for small, cosmetic, or unrelated changes. This does not affect the review itself and is not shown to the developer.`,
    items: {
      type: 'object',
      properties: {
        lens: { type: 'string', enum: Object.keys(LENS_REGISTRY) },
        reason: { type: 'string', description: 'One short clause naming the changed code that gives this concern real surface.' },
      },
      required: ['lens', 'reason'],
      additionalProperties: false,
    },
  }
  schema.required.push('lens_recommendations')
  lensRecommendationSchema = schema
  return schema
}

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
  lensRecommendation = false,
): Promise<ModelResult> {
  const userMessage = buildUserMessage(prInfo, diff, fileContexts, previousReviews, developerReplies, changesSinceLastReview, lineNumbers)

  console.log(`Sending request to the model (${model}, maxRetries: ${maxRetries})...`)
  const callOpts = { model, maxTokens, maxRetries, effort: effort || undefined }
  const { object: raw, usage } = await createProvider(apiKey).completeStructured<ReviewObject & { lens_recommendations?: unknown }>(
    prompt.content, userMessage, reviewOutputSchema(lensRecommendation),
    // A log-only field must never cost a review, so a model that omits it still yields the review.
    lensRecommendation ? { ...callOpts, tolerateMissing: ['lens_recommendations'] } : callOpts,
  )
  // missingRequired passes a null key and strict:false (OpenRouter) can send one; null findings is no verdict, so fail as a missing key does, keeping the paid usage.
  if (!Array.isArray(raw.findings)) throw Object.assign(new Error('Structured output missing required field(s): findings'), { usage })
  const { lens_recommendations: recommended, ...stripped } = raw
  const object = coerceTextLists(lensRecommendation ? stripped : raw)
  const text = renderReview(object)

  console.log(`Review received (${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${object.no_change ? 'NO_CHANGE' : `${object.findings.length} findings`})`)

  return lensRecommendation
    ? { text, usage, review: object, lensRecommendations: sanitizeLensRecommendations(recommended) }
    : { text, usage, review: object }
}

const REQUIRED_TEXT_LISTS = ['behavioral_diff', 'production_risk', 'unresolved_questions'] as const

// These lists only feed the rendered text, so a null one from a strict:false provider is safely empty.
function coerceTextLists(review: ReviewObject): ReviewObject {
  const coerced: string[] = REQUIRED_TEXT_LISTS.filter(k => !Array.isArray(review[k]))
  if (review.can_be_split !== undefined && !Array.isArray(review.can_be_split)) coerced.push('can_be_split')
  if (!coerced.length) return review
  console.warn(`  Reviewer returned ${coerced.join(', ')} as a non-list — treated as empty`)
  const fixed: Record<string, unknown> = { ...review }
  for (const k of coerced) fixed[k] = []
  return fixed as unknown as ReviewObject
}

// Findings only, with the reviewer's item schema so the two can't drift; a distinct object because tests dispatch their mocks on schema identity.
export const BREADTH_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { findings: REVIEW_OUTPUT_SCHEMA.properties.findings },
  required: ['findings'],
  additionalProperties: false,
} as const

export async function runLens(
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
  label = 'lens',
): Promise<{ findings: ReviewFinding[]; usage: LLMUsage; promptHash: string }> {
  const userMessage = `${buildUserMessage(prInfo, diff, fileContexts, [], [], '', lineNumbers)}\n\n${briefing}`
  console.log(`Sending to ${label} reviewer (${model}, maxRetries: ${maxRetries})...`)
  const { object, usage } = await createProvider(apiKey).completeStructured<{ findings: ReviewFinding[] }>(
    systemPrompt, userMessage, BREADTH_OUTPUT_SCHEMA, { model, maxTokens, maxRetries, effort: effort || undefined },
  )
  console.log(`${label[0].toUpperCase()}${label.slice(1)} received (${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${object.findings?.length ?? 0} findings)`)
  // A strict:false provider can return a non-array findings; coerce so candidate assembly's .map never throws.
  const findings = Array.isArray(object.findings) ? object.findings : []
  return { findings, usage, promptHash: createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12) }
}

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
  label = 'breadth',
): Promise<{ findings: ReviewFinding[]; usage: LLMUsage; promptHash: string }> {
  return runLens(apiKey, model, maxRetries, maxTokens, effort, prInfo, diff, fileContexts, systemPrompt, briefing, lineNumbers, label)
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
  options?: JudgeOptions,
): Promise<JudgeResult> {
  const parts: string[] = []
  parts.push(renderDiff(diff, lineNumbers))
  if (fileContexts.length > 0) parts.push(renderFileContexts(fileContexts, lineNumbers))
  parts.push(`## Review to Validate:\n${renderCandidatesForJudge(review)}`)
  const userMessage = parts.join('\n\n')

  const quality = !!options?.quality
  const shownAnchors = !!options?.shownAnchors
  const proposals = !!options?.proposals
  const judgePrompt = quality || shownAnchors || proposals ? composeJudgePrompt(getJudgePrompt(), { quality, shownAnchors, proposals }) : getJudgePrompt()
  const schema = judgeOutputSchema(quality, shownAnchors, proposals)
  const callOpts = { model, maxTokens, maxRetries, effort: effort || undefined }
  console.log(`Sending to judge (${model}, maxRetries: ${maxRetries}${fileContexts.length ? `, ${fileContexts.length} context file(s)` : ''})...`)
  const { object, usage } = await createProvider(apiKey).completeStructured<JudgeOutput>(judgePrompt, userMessage, schema, callOpts)

  console.log(`Judge received (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`)

  const judged = applyJudgeDecisions(review.findings, object, policy, review.can_be_split, diff, breadthFrom, options)

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
): Promise<ModelResult> {
  const parts: string[] = []
  parts.push(`## Your Original Review:\n${originalReview}`)
  parts.push(`## Diff:\n\`\`\`diff\n${diff}\n\`\`\``)
  parts.push(`## Developer Replies (answer all of these):`)
  for (const r of replies) {
    parts.push(`**${r.author}** (${r.createdOn}):\n> ${r.body}`)
  }
  const userMessage = parts.join('\n\n')

  console.log(`Sending reply request to the model (${model}, maxRetries: ${maxRetries})...`)
  const { text, usage } = await createProvider(apiKey).complete(getReplyPrompt(), userMessage, { model, maxTokens: REPLY_MAX_TOKENS, maxRetries })

  console.log(`Reply received (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`)

  return { text, usage }
}
