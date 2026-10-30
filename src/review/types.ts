// ---------------------------------------------------------------------------
// Shared types for the review state machine
// ---------------------------------------------------------------------------

import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply } from '../vcs/adapter.js'
import type { LoadedPrompt } from '../prompt/loader.js'
import type { FileContext } from '../context/fetcher.js'
import type { ReviewObject, ReviewFinding, FindingScore } from './formatter.js'
import type { KeptFinding } from './findings-output.js'
import type { AppliedDecision, JudgeAnomalies } from './judge-decisions.js'
import type { BreadthStatus, CandidateOrigin } from './breadth.js'

/** Every node in the review flow. */
export enum State {
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
  CALL_CLAUDE,
  CHECK_NO_CHANGE,
  BREADTH_REVIEW,
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
}

export type OutcomeSink = (outcome: ReviewOutcome) => void | Promise<void>

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
  usage: { input_tokens: number; output_tokens: number; cache_read: number; cache_write: number; cost_usd?: number }
  judgeUsage?: { input_tokens: number; output_tokens: number; cost_usd?: number }
  judgeScores?: FindingScore[]   // judge's per-finding 0–10 confidence — logged, never posted
  judgeStatus?: 'disabled' | 'skipped_no_findings' | 'succeeded' | 'failed'   // what the judge did this run; unset when the judge stage wasn't reached
  judgePromptHash?: string   // sha256-12 of the judge prompt, set only when the judge actually ran
  judgeDecisions?: AppliedDecision[]
  judgeAnomalies?: JudgeAnomalies
  judgedFindings?: KeptFinding[]
  // Kept apart from reviewObject so reviewer metrics and the judge-failure fallback stay reviewer-only.
  breadthFindings?: ReviewFinding[]
  breadthStatus?: BreadthStatus
  breadthModel?: string
  breadthPromptHash?: string
  breadthUsage?: { input_tokens: number; output_tokens: number; cost_usd?: number }
  untouchedFiles?: string[]
  judgeCandidates?: Array<ReviewFinding & { origin: CandidateOrigin }>
  estimatedInputTokens: number

  // Tracking
  action: string
  reviewNumber: number
  inputBudget?: number
  bundleCount?: number  // set when the PR was reviewed as bundles instead of one pass
  degraded?: boolean  // file contexts dropped to fit MAX_INPUT_TOKENS (diff-only review)
}
