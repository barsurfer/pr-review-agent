// ---------------------------------------------------------------------------
// Shared types for the review state machine
// ---------------------------------------------------------------------------

import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply } from '../vcs/adapter.js'
import type { LoadedPrompt } from '../prompt/loader.js'
import type { LLMUsage } from '../llm/shared.js'
import type { FileContext } from '../context/fetcher.js'
import type { ReviewObject, ReviewFinding, FindingScore } from './formatter.js'
import type { KeptFinding, AlsoAffectsLog, FirstPassSite, FirstPassSiteLog } from './findings-output.js'
import type { AppliedDecision, JudgeAnomalies, RenderJudged } from './judge-decisions.js'
import type { SuggestedFixStats } from './suggested-fix.js'
import type { BreadthStatus, SecondLookStatus, LensStatus, CandidateOrigin, BreadthPlan } from './breadth.js'
import type { ShownSource } from './shown-anchors.js'
import type { LensRecommendation } from './lenses.js'
import type { SiteDropReason, SharedPrefix } from './client.js'
import type { InlineEngine } from '../inline/types.js'
import type { DropReason, SectionPlace, SectionSummary } from './lens-sections.js'
import type { SectionBlock } from './section-render.js'

/** Every node in the review flow. */
export enum State {
  CHECK_TRIGGER,
  FETCH_PR_INFO,
  CHECK_BRANCHES,
  FETCH_DIFF,
  CHECK_THRESHOLDS,
  CHECK_PREVIOUS_REVIEWS,
  CHECK_REPLIES,
  RESPOND_TO_REPLIES,
  POST_REPLY_LIMIT_NOTE,
  LOAD_PROMPT,
  FETCH_CONTEXT,
  ESTIMATE_TOKENS,
  CALL_MODEL,
  CHECK_NO_CHANGE,
  BREADTH_REVIEW,
  SECOND_LOOK,
  LENS_REVIEW,
  JUDGE_REVIEW,
  BUNDLED_REVIEW,
  POST_REVIEW,
  POST_FILTER_NOTICE,
  SKIP,
  DONE,
}

export interface ContentFilterRecord {
  stage: string
  signal: string
  native_finish_reason?: string
  category?: string
  reasons?: string[]
  http_status?: number
  bundle?: number
}

/** A finished review handed to an outcome sink instead of being posted (benchmark mode). */
export interface ReviewOutcome {
  review: ReviewObject
  reviewText: string
  judged: boolean
  judgeScores?: FindingScore[]
  judgedFindings?: KeptFinding[]   // set only by the single-pass structured judge; bundled review leaves it unset
  breadthFindings?: ReviewFinding[]
  secondLookFindings?: ReviewFinding[]
  lensFindings?: ReviewFinding[]
}

export interface LensRun {
  name: string
  status: LensStatus
  model: string
  findings: ReviewFinding[]
  promptHash?: string
  usage?: StageUsage
  placement?: 'section'
  places?: SectionPlace[]
  sectionOk?: boolean
  absorbedLow?: number
  intake?: { received: number; places: number; dropped: Record<DropReason, number> }
  judgeLog?: SectionJudgeLog
  section?: SectionSummary
  rereview?: { outside_delta: number }
}

export interface SectionJudgeLog {
  status: 'succeeded' | 'failed' | 'refused' | 'aborted_time' | 'skipped_time' | 'skipped_budget'
  model: string
  prompt_hash: string | null
  tokens: { input: number; output: number; cache_read?: number; cache_write?: number } | null
  cost_usd: number | null
  anomalies?: { unknown_ids: number; undecided: number; duplicate_ids: number }
  sanity?: { retried: boolean; degenerate_after_retry: boolean; reasons: string[] }
  decisions: Array<{ id: string; label: string; anchor: string; reason: string; verdict: string; evidence: string; score: number }>
}

export interface RereviewLensJudge {
  status: 'succeeded' | 'failed' | 'refused'
  model: string
  prompt_hash: string | null
  tokens: { input: number; output: number; cache_read?: number; cache_write?: number } | null
  cost_usd: number | null
  kept: 0
  sanity?: { retried: boolean; degenerate_after_retry: boolean; reasons: string[] }
  decisions: AppliedDecision[]
}

export interface StageUsage {
  input_tokens: number
  output_tokens: number
  cost_usd?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  attempts?: LLMUsage[]
}

export type UncachedReason = 'model' | 'effort' | 'unsupported_model' | 'no_judge' | 'rereview' | 'bundled' | 'no_shared_pass'
  | 'skipped_small' | 'skipped_few_untouched' | 'skipped_no_findings' | 'skipped_budget' | 'skipped_time'
  | `rejected_400: ${string}` | 'off_after_400' | `skipped_after_plan: ${string}`

export interface PromptCacheLog {
  ttl: '5m'
  reviewer_marked: boolean
  shared_stages: string[]
  uncached: Array<{ stage: string; reason: UncachedReason }>
  session_id?: string
  pass_effort?: { effort: string; status: 'on' | 'unsupported_model' | 'no_shared_pass' | `rejected_400: ${string}` }
}

export interface SinkResult {
  counterpartRows?: number
  alsoAffectsRows?: number
  alsoAffects?: AlsoAffectsLog[]
  firstPassSiteRows?: number
  firstPassSites?: FirstPassSiteLog[]
}

export interface PassCall {
  stage: string
  end: 'ok' | 'truncated' | 'aborted_time' | 'error'
  max_tokens: number
  output_tokens: number | null
  reasoning_tokens: number | null
  limit_ms: number | null
  input_tokens?: number | null
  cache_read_tokens?: number | null
  cache_write_tokens?: number | null
  cost_usd?: number | null
  pass_effort?: string
  final_reasoning_tokens?: number | null
}

export interface EstimateBreakdown {
  total: number
  prompt: number
  diff: number
  delta: number
  files: number
  file_count: number
  prev_reviews: number
  prev_review_count: number
  replies: number
  reply_count: number
}

export interface EstimateParts { overhead: number; diff: number; files: number; file_count: number }

export interface StageEstimate { tokens: number | null; parts?: EstimateParts; contexts_dropped?: true }

export interface TokenCall {
  stage: string
  bundle?: number
  model: string
  end: PassCall['end']
  input_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  prompt_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  estimated_input_tokens: number | null
  estimate_parts?: EstimateParts
  contexts_dropped?: true
  tier: boolean
  cost_usd: number | null
  cost_reported: boolean
  tier_cost_usd: number | null
  attempts?: number
}

export interface TokenMetrics {
  estimate: EstimateBreakdown | null
  estimate_initial?: EstimateBreakdown
  reviewer: { estimated_input_tokens: number; prompt_tokens: number; ratio: number; calls: number } | null
  calls: TokenCall[]
  calls_dropped?: number
  tier_calls: number
  tier_cost_usd: number
  calls_cost_usd: number
  max_prompt_tokens: number | null
}

export type OutcomeSink = (outcome: ReviewOutcome) => void | SinkResult | Promise<void | SinkResult>

export type EventKind = 'comment' | 'other'

export interface TriggerInfo {
  event: string
  commentAuthor: string
  kind?: EventKind
}

/** Accumulated data shared across states. */
export interface ReviewContext {
  // Immutable inputs
  readonly adapter: VCSAdapter
  readonly prId: string
  readonly dryRun: boolean
  readonly promptPath?: string
  readonly force: 'off' | 'clean' | 're-review'
  readonly logUsage: boolean
  readonly repoSlug: string
  readonly outcomeSink?: OutcomeSink
  readonly inline?: InlineEngine
  readonly trigger?: TriggerInfo
  readonly checkedCommit?: string
  readonly startTime: number

  // Populated progressively
  prInfo?: PRInfo
  diff?: string
  filteredDiff?: string
  deltaDiff?: string   // changes since the last-reviewed commit; fed to re-reviews so fixes are visible
  changedFiles?: ChangedFile[]
  lineCount?: number
  reviewableFileCount?: number
  reviewableLineCount?: number
  previousReviews?: ReviewComment[]
  replies?: CommentReply[]
  prompt?: LoadedPrompt
  fileContexts?: FileContext[]
  reviewText?: string
  reviewTextBeforeJudge?: string
  reviewObject?: ReviewObject   // reviewer's structured output — typed source for findings/delta metrics
  skipReason?: string
  usage: { input_tokens: number; output_tokens: number; cache_read: number; cache_write: number; cost_usd?: number; reasoning?: number }
  judgeUsage?: StageUsage
  judgeScores?: FindingScore[]   // judge's per-finding 0–10 confidence — logged, never posted
  judgeStatus?: 'disabled' | 'skipped_no_findings' | 'succeeded' | 'failed'   // what the judge did this run; unset when the judge stage wasn't reached
  judgePromptHash?: string   // sha256-12 of the judge prompt, set only when the judge actually ran
  judgeDecisions?: AppliedDecision[]
  judgeAnomalies?: JudgeAnomalies
  judgeSanity?: { retried: boolean; degenerate_after_retry: boolean; reasons: string[] }
  judgedFindings?: KeptFinding[]
  rereviewLensJudge?: RereviewLensJudge
  lensCandidatesCleared?: boolean
  sectionBlocks?: SectionBlock[]
  sectionsPosted?: boolean
  // A render closure, so POST_REVIEW orders findings and splices blocks into the posted comment while reviewText stays plain.
  renderJudged?: RenderJudged
  suggestedFixes?: SuggestedFixStats
  proposalsDropped?: number
  counterpartRows?: number
  alsoAffectsRows?: number
  alsoAffectsLog?: AlsoAffectsLog[]
  passCalls?: PassCall[]
  tokenCalls?: TokenCall[]
  stageEstimates?: Record<string, StageEstimate>
  bundleIndex?: number
  estimateBreakdown?: EstimateBreakdown
  estimateBreakdownInitial?: EstimateBreakdown
  promptCache?: PromptCacheLog
  cachePrefix?: SharedPrefix
  reviewUsage?: StageUsage
  // Kept outside the gated per-call rows so cost pricing never depends on ENABLE_TOKEN_METRICS.
  remainderRequests?: Array<{ usage: StageUsage; model: string }>
  judgeRequests?: StageUsage[]
  failedModel?: string
  // Keyed by first-pass candidate index; every site also carries its own cN, so nothing downstream derives the id from a position.
  firstPassSites?: Map<number, FirstPassSite[]>
  firstPassSitesNamed?: FirstPassSite[]
  firstPassSitesDropped?: Partial<Record<FirstPassSite['via'], Partial<Record<SiteDropReason, number>>>>
  firstPassSiteRows?: number
  firstPassSitesLog?: FirstPassSiteLog[]
  // Kept apart from reviewObject so reviewer metrics and the judge-failure fallback stay reviewer-only.
  breadthFindings?: ReviewFinding[]
  breadthStatus?: BreadthStatus
  breadthModel?: string
  breadthPromptHash?: string
  breadthUsage?: StageUsage
  // Second-look re-reads the already-flagged files for misses; kept apart from reviewObject for the same reason as breadth.
  secondLookFindings?: ReviewFinding[]
  secondLookStatus?: SecondLookStatus
  secondLookPromptHash?: string
  secondLookUsage?: StageUsage
  lensRuns?: LensRun[]
  lensRecommendations?: LensRecommendation[] | null
  untouchedFiles?: string[]
  breadthPlan?: BreadthPlan
  // What each discovery pass was actually shown, so a judge anchor on an unchanged line is only accepted for code that pass saw.
  shownBreadth?: ShownSource
  shownSecondLook?: ShownSource
  shownLens?: ShownSource
  judgeCandidates?: Array<ReviewFinding & { origin: CandidateOrigin }>
  estimatedInputTokens: number

  // Tracking
  action: string
  reviewNumber: number
  inputBudget?: number
  bundleCount?: number  // set when the PR was reviewed as bundles instead of one pass
  degraded?: boolean  // file contexts dropped to fit MAX_INPUT_TOKENS (diff-only review)
  dedupHit?: 'checked_commit' | 'target_merge'
  mergeNarrowed?: boolean
  deltaBase?: string
  replyLimitNote?: boolean
  contentFilters?: ContentFilterRecord[]
  declinedBundles?: number
  divertedFromReview?: boolean
  replyDeclined?: boolean
  headChecked?: boolean
  deltaFetchFailed?: boolean
  bundleUncertain?: boolean
}
