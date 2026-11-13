// ---------------------------------------------------------------------------
// Shared types for the review state machine
// ---------------------------------------------------------------------------

import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply } from '../vcs/adapter.js'
import type { LoadedPrompt } from '../prompt/loader.js'
import type { FileContext } from '../context/fetcher.js'
import type { ReviewObject, ReviewFinding, FindingScore } from './formatter.js'
import type { KeptFinding } from './findings-output.js'
import type { AppliedDecision, JudgeAnomalies, RenderJudged } from './judge-decisions.js'
import type { SuggestedFixStats } from './suggested-fix.js'
import type { BreadthStatus, SecondLookStatus, LensStatus, CandidateOrigin, BreadthPlan } from './breadth.js'
import type { ShownSource } from './shown-anchors.js'
import type { LensRecommendation } from './lenses.js'

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
  SKIP,
  DONE,
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
  usage?: { input_tokens: number; output_tokens: number; cost_usd?: number }
}

export interface SinkResult {
  counterpartRows?: number
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
  judgeUsage?: { input_tokens: number; output_tokens: number; cost_usd?: number }
  judgeScores?: FindingScore[]   // judge's per-finding 0–10 confidence — logged, never posted
  judgeStatus?: 'disabled' | 'skipped_no_findings' | 'succeeded' | 'failed'   // what the judge did this run; unset when the judge stage wasn't reached
  judgePromptHash?: string   // sha256-12 of the judge prompt, set only when the judge actually ran
  judgeDecisions?: AppliedDecision[]
  judgeAnomalies?: JudgeAnomalies
  judgedFindings?: KeptFinding[]
  // A render closure, so POST_REVIEW orders findings and splices blocks into the posted comment while reviewText stays plain.
  renderJudged?: RenderJudged
  suggestedFixes?: SuggestedFixStats
  proposalsDropped?: number
  counterpartRows?: number
  // Kept apart from reviewObject so reviewer metrics and the judge-failure fallback stay reviewer-only.
  breadthFindings?: ReviewFinding[]
  breadthStatus?: BreadthStatus
  breadthModel?: string
  breadthPromptHash?: string
  breadthUsage?: { input_tokens: number; output_tokens: number; cost_usd?: number }
  // Second-look re-reads the already-flagged files for misses; kept apart from reviewObject for the same reason as breadth.
  secondLookFindings?: ReviewFinding[]
  secondLookStatus?: SecondLookStatus
  secondLookPromptHash?: string
  secondLookUsage?: { input_tokens: number; output_tokens: number; cost_usd?: number }
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
  dedupHit?: 'checked_commit'
  headChecked?: boolean
  deltaFetchFailed?: boolean
  bundleUncertain?: boolean
}
