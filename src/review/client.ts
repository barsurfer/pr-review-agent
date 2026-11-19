import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { createProvider, type LLMUsage, type UserPart } from '../llm/provider.js'
import { renderReview, ISSUE_TYPES, SCENARIOS, type ReviewObject, type ReviewFinding, type FindingScore } from './formatter.js'
import type { KeptFinding, FirstPassSite } from './findings-output.js'
import {
  REASON_CATEGORIES, DEFAULT_JUDGE_POLICY, applyJudgeDecisions, renderCandidatesForJudge, summarizeDecisions,
  type JudgeOutput, type JudgePolicy, type JudgeOptions, type AppliedDecision, type JudgeAnomalies, type RenderJudged,
} from './judge-decisions.js'
import { composeJudgePrompt, QUALITY_DECISION_PROPERTIES, PROPOSAL_DECISION_PROPERTIES, PROPOSAL_CODE_DECISION_PROPERTIES, SHOWN_ANCHOR_DESCRIPTIONS } from './judge-quality.js'
import { stripOwnSuggestedFixes } from './suggested-fix.js'
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
  cacheBlock?: string
}

// The prefix every cached call repeats byte for byte: the reviewer's system prompt, its schema and its user message.
export interface SharedPrefix {
  system: string
  schema: Record<string, unknown>
  block: string
  sessionId?: string
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
  render?: RenderJudged
  renderWith?: RenderJudged
  proposalsDropped?: number
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
export function judgeOutputSchema(quality: boolean, shownAnchors: boolean, proposals = false, code = false): Record<string, unknown> {
  if (!quality && !shownAnchors && !proposals) return JUDGE_OUTPUT_SCHEMA
  const codeProposals = proposals && code
  const key = `${quality}:${shownAnchors}:${proposals}${codeProposals ? ':code' : ''}`
  const cached = schemaVariants.get(key)
  if (cached) return cached
  const schema = structuredClone(JUDGE_OUTPUT_SCHEMA) as unknown as { properties: { decisions: { items: { properties: Record<string, unknown> } } } }
  const props = schema.properties.decisions.items.properties as Record<string, { description?: string }>
  if (shownAnchors) {
    props.anchor_file.description = SHOWN_ANCHOR_DESCRIPTIONS.anchor_file
    props.anchor_lines.description = SHOWN_ANCHOR_DESCRIPTIONS.anchor_lines
  }
  if (quality) Object.assign(props, structuredClone(QUALITY_DECISION_PROPERTIES))
  if (proposals) Object.assign(props, structuredClone(codeProposals ? PROPOSAL_CODE_DECISION_PROPERTIES : PROPOSAL_DECISION_PROPERTIES))
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
  cache?: { schema: Record<string, unknown>; sessionId?: string },
): Promise<ModelResult> {
  const userMessage = buildUserMessage(prInfo, diff, fileContexts, previousReviews, developerReplies, changesSinceLastReview, lineNumbers)

  console.log(`Sending request to the model (${model}, maxRetries: ${maxRetries})...`)
  const callOpts = { model, maxTokens, maxRetries, effort: effort || undefined }
  // A log-only field must never cost a review, so a model that omits it still yields the review.
  const opts = lensRecommendation ? { ...callOpts, tolerateMissing: ['lens_recommendations'] } : callOpts
  const { object: raw, usage } = cache
    ? await createProvider(apiKey).completeStructured<ReviewObject & { lens_recommendations?: unknown; first_pass_sites?: unknown }>(
        prompt.content, [{ text: userMessage, cache: true }], cache.schema, cache.sessionId ? { ...opts, sessionId: cache.sessionId } : opts,
      )
    : await createProvider(apiKey).completeStructured<ReviewObject & { lens_recommendations?: unknown; first_pass_sites?: unknown }>(
        prompt.content, userMessage, reviewOutputSchema(lensRecommendation), opts,
      )
  // missingRequired passes a null key and strict:false (OpenRouter) can send one; null findings is no verdict, so fail as a missing key does, keeping the paid usage.
  if (!Array.isArray(raw.findings)) throw Object.assign(new Error('Structured output missing required field(s): findings'), { usage })
  const { lens_recommendations: recommended, ...stripped } = raw
  const reviewed = cache ? stripPassExtras(stripped) : lensRecommendation ? stripped : raw
  const object = coerceTextLists(reviewed)
  const text = renderReview(object)

  console.log(`Review received (${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${object.no_change ? 'NO_CHANGE' : `${object.findings.length} findings`})`)

  const result: ModelResult = lensRecommendation
    ? { text, usage, review: object, lensRecommendations: sanitizeLensRecommendations(recommended) }
    : { text, usage, review: object }
  return cache ? { ...result, cacheBlock: userMessage } : result
}

// The shared schema offers the passes' extras to the reviewer too; its own review must never carry them.
function stripPassExtras(review: ReviewObject & { first_pass_sites?: unknown }): ReviewObject {
  const { first_pass_sites: _sites, ...rest } = review
  return { ...rest, findings: rest.findings.map(f => {
    if (!f || typeof f !== 'object') return f
    const { also_affects: _also, scenario: _scenario, ...kept } = f
    return kept
  }) }
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

const ALSO_AFFECTS_PROPERTY = { type: 'array', description: 'Other changed files in this diff where this same defect also occurs and that you are not reporting as a finding of their own: the same root cause causing the same failure at a sibling call site, a parallel handler or route, or the other side of a mismatched contract. One entry per place, at most 3. Omit it when the defect is in one file. Never list this finding\'s own file, a place mentioned only as evidence, cause, contrast, documentation or where the fix goes, or a different problem.', items: { type: 'object', properties: { file: { type: 'string', description: 'Path of the other changed file, exactly as it appears in the diff.' }, lines: { type: 'string', description: 'Digits only: the added or changed line or range in that file where the same defect occurs, e.g. "46" or "60-62".' }, where: { type: 'string', description: 'A few words naming the code at that line, e.g. "handleCreate dispatches CREATE_WORKSPACE without a flush".' } }, required: ['file', 'lines', 'where'], additionalProperties: false } }

const FIRST_PASS_SITES_PROPERTY = { type: 'array', description: 'Other changed files where the defect of a first-pass finding also occurs; see OTHER SITES OF FIRST-PASS FINDINGS. Omit when there are none.', items: { type: 'object', properties: { id: { type: 'string', description: 'The bracketed id of a first-pass finding in the message, e.g. "c3".' }, ...ALSO_AFFECTS_PROPERTY.items.properties }, required: ['id', 'file', 'lines', 'where'], additionalProperties: false } }

const SCENARIO_PROPERTY = { type: 'string', enum: [...SCENARIOS], description: 'Only for a finding found by tracing a scenario or contract named in SECOND LOOK item 4 or the IMPACT LENS: which one. Omit otherwise.' }

const findingsVariants = new Map<string, Record<string, unknown>>()

// No option returns BREADTH_OUTPUT_SCHEMA itself (tests dispatch on its identity); a variant is a clone because REVIEW_OUTPUT_SCHEMA shares the findings subtree.
export function findingsOutputSchema(opts: { alsoAffects?: boolean; scenario?: boolean; firstPassSites?: boolean } = {}): Record<string, unknown> {
  const alsoAffects = !!opts.alsoAffects, scenario = !!opts.scenario, firstPassSites = !!opts.firstPassSites
  if (!alsoAffects && !scenario && !firstPassSites) return BREADTH_OUTPUT_SCHEMA
  const key = `${alsoAffects}:${scenario}${firstPassSites ? ':sites' : ''}`
  const cached = findingsVariants.get(key)
  if (cached) return cached
  const schema = structuredClone(BREADTH_OUTPUT_SCHEMA) as unknown as { properties: { findings: { items: { properties: Record<string, unknown> } } } & Record<string, unknown> }
  const props = schema.properties.findings.items.properties
  if (alsoAffects) props.also_affects = structuredClone(ALSO_AFFECTS_PROPERTY)
  if (scenario) props.scenario = structuredClone(SCENARIO_PROPERTY)
  if (firstPassSites) schema.properties.first_pass_sites = structuredClone(FIRST_PASS_SITES_PROPERTY)
  findingsVariants.set(key, schema)
  return schema
}

const ALSO_AFFECTS_KEEP = 10

// A strict:false provider (OpenRouter) can return any shape for these optional fields.
export function sanitizeFindingExtras(finding: ReviewFinding): ReviewFinding {
  if (!finding || typeof finding !== 'object') return finding
  const { also_affects: rawAlso, scenario: rawScenario, ...rest } = finding as Omit<ReviewFinding, 'also_affects' | 'scenario'> & { also_affects?: unknown; scenario?: unknown }
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const also = (Array.isArray(rawAlso) ? rawAlso : []).flatMap(e => {
    if (!e || typeof e !== 'object') return []
    const { file, lines, where } = e as Record<string, unknown>
    const entry = { file: text(file), lines: text(lines), where: text(where).replace(/\s+/g, ' ') }
    return entry.file && entry.lines && entry.where ? [entry] : []
  }).slice(0, ALSO_AFFECTS_KEEP)
  const scenario = SCENARIOS.find(s => s === rawScenario)
  return { ...rest, ...(also.length ? { also_affects: also } : {}), ...(scenario ? { scenario } : {}) }
}

const sharedVariants = new Map<string, Record<string, unknown>>()

// Schema F: the reviewer's schema plus every extra a pass in this run may fill; no extra returns the reviewer's schema object itself.
export function sharedOutputSchema(opts: { lensRecommendation?: boolean; alsoAffects?: boolean; scenario?: boolean; firstPassSites?: boolean }): Record<string, unknown> {
  const base = reviewOutputSchema(!!opts.lensRecommendation)
  const alsoAffects = !!opts.alsoAffects, scenario = !!opts.scenario, firstPassSites = !!opts.firstPassSites
  if (!alsoAffects && !scenario && !firstPassSites) return base
  const key = `${!!opts.lensRecommendation}:${alsoAffects}:${scenario}:${firstPassSites}`
  const cached = sharedVariants.get(key)
  if (cached) return cached
  const schema = structuredClone(base) as { properties: Record<string, unknown> & { findings: { items: { properties: Record<string, unknown> } } } }
  const props = schema.properties.findings.items.properties
  if (alsoAffects) props.also_affects = structuredClone(ALSO_AFFECTS_PROPERTY)
  if (scenario) props.scenario = structuredClone(SCENARIO_PROPERTY)
  if (firstPassSites) schema.properties.first_pass_sites = structuredClone(FIRST_PASS_SITES_PROPERTY)
  sharedVariants.set(key, schema)
  return schema
}

// Schema F requires the reviewer's text fields too; a pass leaves them empty, so only findings and its item keys may trigger a resend.
export const SHARED_PASS_TOLERATE = ['summary', 'behavioral_diff', 'production_risk', 'unresolved_questions', 'can_be_split', 'lens_recommendations', 'first_pass_sites']

export type SiteDropReason = 'not_array' | 'not_object' | 'unknown_id' | 'bad_file' | 'bad_lines' | 'bad_where' | 'over_keep'

// Keyed by first-pass candidate index; an id the pass was not briefed with, or a malformed entry, is dropped rather than resent.
export function sanitizeFirstPassSites(raw: unknown, ids: ReadonlyMap<string, number>, via: FirstPassSite['via']): { sites: Map<number, FirstPassSite[]>; dropped: Partial<Record<SiteDropReason, number>> } {
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const sites = new Map<number, FirstPassSite[]>()
  const dropped: Partial<Record<SiteDropReason, number>> = {}
  const drop = (reason: SiteDropReason) => { dropped[reason] = (dropped[reason] ?? 0) + 1 }
  if (raw !== undefined && !Array.isArray(raw)) drop('not_array')
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== 'object') { drop('not_object'); continue }
    const { id, file, lines, where } = e as Record<string, unknown>
    const key = text(id).replace(/^\[|\]$/g, '').toLowerCase()
    const index = ids.get(key)
    const site: FirstPassSite = { id: key, file: text(file), lines: text(lines), where: text(where).replace(/\s+/g, ' '), via }
    if (index === undefined) { drop('unknown_id'); continue }
    if (!site.file) { drop('bad_file'); continue }
    if (!site.lines) { drop('bad_lines'); continue }
    if (!site.where) { drop('bad_where'); continue }
    const list = sites.get(index) ?? []
    if (list.length >= ALSO_AFFECTS_KEEP) { drop('over_keep'); continue }
    sites.set(index, [...list, site])
  }
  return { sites, dropped }
}

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
  schema: Record<string, unknown> = BREADTH_OUTPUT_SCHEMA,
  signal?: AbortSignal,
): Promise<{ findings: ReviewFinding[]; usage: LLMUsage; promptHash: string; firstPassSites?: unknown }> {
  const sites = 'first_pass_sites' in ((schema as { properties?: object }).properties ?? {})
  const userMessage = `${buildUserMessage(prInfo, diff, fileContexts, [], [], '', lineNumbers)}\n\n${briefing}`
  console.log(`Sending to ${label} reviewer (${model}, maxRetries: ${maxRetries})...`)
  // Sites are optional extras the sanitizer filters, so a malformed entry must not cost an OpenRouter resend of the whole pass.
  const { object, usage } = await createProvider(apiKey).completeStructured<{ findings: ReviewFinding[]; first_pass_sites?: unknown }>(
    systemPrompt, userMessage, schema, { model, maxTokens, maxRetries, effort: effort || undefined, ...(signal ? { signal } : {}), ...(sites ? { tolerateMissing: ['first_pass_sites'] } : {}) },
  )
  console.log(`${label[0].toUpperCase()}${label.slice(1)} received (${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${object.findings?.length ?? 0} findings)`)
  // A strict:false provider can return a non-array findings; coerce so candidate assembly's .map never throws.
  const findings = Array.isArray(object.findings) ? object.findings : []
  return {
    findings: schema === BREADTH_OUTPUT_SCHEMA ? findings : findings.map(sanitizeFindingExtras), usage, promptHash: createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12),
    ...(sites ? { firstPassSites: object.first_pass_sites } : {}),
  }
}

// The overlay rides a trailing system message: as user text after the cached block it suppressed pass thinking in the probes.
export async function runSharedPass(
  apiKey: string,
  model: string,
  maxRetries: number,
  maxTokens: number,
  effort: string,
  prefix: SharedPrefix,
  briefing: string,
  overlay: string,
  label: string,
  signal?: AbortSignal,
): Promise<{ findings: ReviewFinding[]; usage: LLMUsage; promptHash: string; firstPassSites?: unknown }> {
  const sites = 'first_pass_sites' in ((prefix.schema as { properties?: object }).properties ?? {})
  const user: UserPart[] = [{ text: prefix.block, cache: true }, { text: briefing }]
  console.log(`Sending to ${label} reviewer (${model}, maxRetries: ${maxRetries}, cached prefix)...`)
  const { object, usage } = await createProvider(apiKey).completeStructured<{ findings: ReviewFinding[]; first_pass_sites?: unknown }>(
    prefix.system, user, prefix.schema,
    { model, maxTokens, maxRetries, effort: effort || undefined, ...(signal ? { signal } : {}), tolerateMissing: SHARED_PASS_TOLERATE, systemAfter: overlay, ...(prefix.sessionId ? { sessionId: prefix.sessionId } : {}) },
  )
  console.log(`${label[0].toUpperCase()}${label.slice(1)} received (${usage.input_tokens} in / ${usage.cache_read_input_tokens ?? 0} cache read / ${usage.cache_creation_input_tokens ?? 0} cache write / ${usage.output_tokens} out tokens, ${object.findings?.length ?? 0} findings)`)
  const findings = Array.isArray(object.findings) ? object.findings : []
  return {
    findings: findings.map(sanitizeFindingExtras), usage, promptHash: createHash('sha256').update(`${prefix.system}\n\n${overlay}`).digest('hex').slice(0, 12),
    ...(sites ? { firstPassSites: object.first_pass_sites } : {}),
  }
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
  schema?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ findings: ReviewFinding[]; usage: LLMUsage; promptHash: string; firstPassSites?: unknown }> {
  const tail: [Record<string, unknown>?, AbortSignal?] = signal ? [schema ?? BREADTH_OUTPUT_SCHEMA, signal] : schema ? [schema] : []
  return runLens(apiKey, model, maxRetries, maxTokens, effort, prInfo, diff, fileContexts, systemPrompt, briefing, lineNumbers, label, ...tail)
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
    // The reviewer must not treat the posted suggested fixes as review text; the reply model still sees them.
    parts.push(`### Review from ${latest.createdOn}:\n${stripOwnSuggestedFixes(latest.body, 'review')}`)
  }

  if (developerReplies.length > 0) {
    parts.push(`## Developer Discussion on Previous Review(s):`)
    parts.push('Below is the conversation thread from previous reviews, including developer replies and the agent\'s own prior responses. IMPORTANT: If the agent previously acknowledged a finding as a false positive or accepted a developer\'s explanation, do NOT re-raise that finding. Treat the agent\'s prior conclusions as settled unless the new code changes invalidate them.')
    for (const r of developerReplies) {
      parts.push(`**${r.author}** (${r.createdOn}):\n> ${stripOwnSuggestedFixes(r.body, 'reply')}`)
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
  const codeProposals = proposals && !!options?.codeProposals
  const judgePrompt = quality || shownAnchors || proposals ? composeJudgePrompt(getJudgePrompt(), { quality, shownAnchors, proposals, codeProposals }) : getJudgePrompt()
  const schema = judgeOutputSchema(quality, shownAnchors, proposals, codeProposals)
  const callOpts = { model, maxTokens, maxRetries, effort: effort || undefined }
  console.log(`Sending to judge (${model}, maxRetries: ${maxRetries}${fileContexts.length ? `, ${fileContexts.length} context file(s)` : ''})...`)
  const { object, usage } = await createProvider(apiKey).completeStructured<JudgeOutput>(judgePrompt, userMessage, schema, callOpts)

  console.log(`Judge received (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`)

  const judged = applyJudgeDecisions(review.findings, object, policy, review.can_be_split, diff, breadthFrom, options)

  const promptHash = createHash('sha256').update(judgePrompt).digest('hex').slice(0, 12)
  return {
    text: judged.markdown, usage, notes: summarizeDecisions(judged.decisions), scores: judged.scores, promptHash,
    decisions: judged.decisions, anomalies: judged.anomalies, kept: judged.kept, render: judged.render,
    ...(judged.renderWith ? { renderWith: judged.renderWith, proposalsDropped: judged.proposalsDropped } : {}),
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
