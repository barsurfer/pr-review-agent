import type { ReviewContext, State } from '../review/types.js'
import type { LLMUsage } from '../llm/shared.js'

export interface InlineDeps {
  transition: (state: State, ctx: ReviewContext) => Promise<State>
  markHeadChecked: (ctx: ReviewContext) => void
  narrowTargetMergeDelta: (ctx: ReviewContext, base: string, head: string, delta: string) => Promise<string | null>
}

export interface InlineEngine {
  step(state: State, ctx: ReviewContext, deps: InlineDeps): Promise<State>
  prior?: { block: string }
  priorFor(files: string[]): { block: string } | undefined
  replyUsage?: LLMUsage
  record(): InlineRecord
}

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW'

export interface ThreadEntry {
  id: string
  k: number
  severity: Severity
  title: string
  gist: string
  file: string
  lines?: string
  openedAt: string
  was?: string
  rootId: string
  url: string
  resolved: boolean
  humanComments: number
}

export interface SummaryState { n: number; commits: string[] }

export interface Listed { severity: string; title: string; gist: string; file?: string; lines?: string }

export type SummaryOnlyReason = 'low' | 'no_line' | 'out_of_hunk' | 'old_side' | 'over_cap' | 'duplicate'

export type InlineOutcome =
  | 'written' | 'write_failed' | 'replies_only' | 'dedup' | 'skipped' | 'incoherent_no_change' | 'write_uncertain' | 'force_invalidate_failed'
  | 'head_moved_skip' | 'head_moved_partial' | 'concurrent_run' | 'identity_unavailable' | 'identity_mismatch' | 'dry_run'

export interface InlineRecord {
  active: boolean
  reason?: 'unsupported_vcs' | 'benchmark'
  completed?: boolean
  outcome?: InlineOutcome
  identity?: 'api' | 'setting' | 'unavailable'
  summary_check?: 'valid' | 'tampered' | 'missing'
  summary?: 'created' | 'edited' | 'not_written'
  roots?: { posted: number; failed: number; summary_only: Record<SummaryOnlyReason, number> }
  suppressed?: { open_duplicate: number; resolved: number; in_run_duplicate: number }
  raised_over_resolved?: number
  answers?: { threads: number; posted: number; failed: number; deferred_cap: number; limit_notes: number; summary: number }
  reply_usage?: { model: string; input_tokens: number; output_tokens: number; cost_usd: number } | null
  untrusted_markers?: number
  writes_reconciled?: number
  rows_collapsed?: number
  head_moved_at?: string
  footer_lines_removed?: number
}
