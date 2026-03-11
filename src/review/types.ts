// ---------------------------------------------------------------------------
// Shared types for the review state machine
// ---------------------------------------------------------------------------

import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply } from '../vcs/adapter.js'
import type { LoadedPrompt } from '../prompt/loader.js'
import type { FileContext } from '../context/fetcher.js'

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
  JUDGE_REVIEW,
  POST_REVIEW,
  SKIP,
  DONE,
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

  // Populated progressively
  prInfo?: PRInfo
  diff?: string
  filteredDiff?: string
  changedFiles?: ChangedFile[]
  lineCount?: number
  previousReviews?: ReviewComment[]
  replies?: CommentReply[]
  prompt?: LoadedPrompt
  fileContexts?: FileContext[]
  reviewText?: string
  reviewTextBeforeJudge?: string
  skipReason?: string
  usage: { input_tokens: number; output_tokens: number }
  judgeUsage?: { input_tokens: number; output_tokens: number }
  estimatedInputTokens: number

  // Tracking
  action: string
  reviewNumber: number
}
