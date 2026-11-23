import { config } from '../config.js'
import { DeadlineAbortError, TruncatedResponseError, type LLMUsage } from '../llm/shared.js'
import { callPricing } from './usage.js'
import type { ReviewContext, PassCall, TokenCall, TokenMetrics } from './types.js'

export function callEnd(err?: unknown): PassCall['end'] {
  return err === undefined ? 'ok' : err instanceof DeadlineAbortError ? 'aborted_time' : err instanceof TruncatedResponseError ? 'truncated' : 'error'
}

const fmt = (n: number): string => n.toLocaleString()

function tokenRow(ctx: ReviewContext, stage: string, model: string, end: PassCall['end'], usage: Partial<LLMUsage> | undefined): TokenCall {
  const est = ctx.stageEstimates?.[stage]
  const common = {
    stage,
    ...(ctx.bundleIndex !== undefined ? { bundle: ctx.bundleIndex } : {}),
    model,
    end,
    estimated_input_tokens: est?.tokens ?? null,
    ...(stage === 'review' && est?.parts ? { estimate_parts: est.parts } : {}),
    ...(stage === 'review' && est?.contexts_dropped ? { contexts_dropped: true as const } : {}),
  }
  if (usage?.input_tokens === undefined) {
    return { ...common, input_tokens: null, cache_read_tokens: null, cache_write_tokens: null, prompt_tokens: null, output_tokens: null, reasoning_tokens: null, tier: false, cost_usd: null, cost_reported: false, tier_cost_usd: null }
  }
  // An aborted stream's output count is a start-of-message snapshot, so it is priced at zero and reported as unknown.
  const aborted = end === 'aborted_time'
  const priced = callPricing({ ...usage, input_tokens: usage.input_tokens, output_tokens: aborted ? 0 : usage.output_tokens ?? 0 }, model, !!config.review.promptCache)
  return {
    ...common,
    input_tokens: usage.input_tokens,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    prompt_tokens: priced.prompt_tokens,
    output_tokens: aborted ? null : usage.output_tokens ?? 0,
    reasoning_tokens: !aborted && (usage.reasoning_tokens ?? 0) > 0 ? usage.reasoning_tokens! : null,
    tier: priced.tier,
    cost_usd: priced.cost_usd,
    cost_reported: priced.cost_reported,
    tier_cost_usd: priced.tier_cost_usd,
    ...(priced.attempts ? { attempts: priced.attempts } : {}),
  }
}

function tierLine(row: TokenCall): string {
  const est = row.estimated_input_tokens !== null ? `estimate ~${fmt(row.estimated_input_tokens)}` : 'no estimate'
  return `  Long-context tier: ${row.stage}${row.bundle !== undefined ? ` bundle ${row.bundle}` : ''} on ${row.model}: ${fmt(row.prompt_tokens ?? 0)} input tokens (${est}), +$${(row.tier_cost_usd ?? 0).toFixed(4)} over base rates`
}

// Never throws: this is logging, and an error here must not replace the call's own outcome.
export function recordTokenCall(ctx: ReviewContext, stage: string, model: string, usage?: Partial<LLMUsage>, err?: unknown): void {
  if (!config.tokenMetrics) return
  try {
    const rows: TokenCall[] = []
    const completed = err instanceof DeadlineAbortError ? err.completed : undefined
    if (completed) for (const a of completed.attempts?.length ? completed.attempts : [completed]) rows.push(tokenRow(ctx, stage, model, 'error', a))
    rows.push(tokenRow(ctx, stage, model, callEnd(err), usage))
    ;(ctx.tokenCalls ??= []).push(...rows)
    for (const row of rows) if (row.tier) console.log(tierLine(row))
  } catch (e) {
    console.warn(`Token metrics skipped for ${stage}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function tokenSummaryLine(record: { repo_slug: string; pr_id: string; cost_usd: number; token_metrics?: TokenMetrics }): string | undefined {
  const m = record.token_metrics
  if (!m) return undefined
  const reviewer = m.reviewer
    ? `reviewer input ${fmt(m.reviewer.prompt_tokens)} vs estimate ~${fmt(m.reviewer.estimated_input_tokens)} (ratio ${m.reviewer.ratio})`
    : m.estimate ? `reviewer ratio n/a, estimate ~${fmt(m.estimate.total)}` : 'reviewer ratio n/a, no estimate'
  const calls = m.calls.length + (m.calls_dropped ?? 0)
  return `Token metrics: ${record.repo_slug}#${record.pr_id} | ${reviewer} | ${calls} call(s), max input ${m.max_prompt_tokens === null ? 'n/a' : fmt(m.max_prompt_tokens)}, ${m.tier_calls} over the 100k tier, tier +$${m.tier_cost_usd.toFixed(4)} | cost $${record.cost_usd.toFixed(4)}, per-call $${m.calls_cost_usd.toFixed(4)}`
}
