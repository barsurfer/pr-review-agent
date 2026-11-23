import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type { ReviewContext, TokenCall, EstimateBreakdown } from '../types.js'

let buildUsageRecord: (typeof import('../usage.js'))['buildUsageRecord']
let tokenSummaryLine: (typeof import('../token-metrics.js'))['tokenSummaryLine']
let config: (typeof import('../../config.js'))['config']
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;({ buildUsageRecord } = await import('../usage.js'))
  ;({ tokenSummaryLine } = await import('../token-metrics.js'))
  ;({ config } = await import('../../config.js'))
})

const ctxOf = (over: Partial<ReviewContext> = {}): ReviewContext => ({
  adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
  usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 0 },
  estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
  ...over,
} as unknown as ReviewContext)

const row = (over: Partial<TokenCall> = {}): TokenCall => ({
  stage: 'review', model: 'claude-haiku-5-5', end: 'ok', input_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0, prompt_tokens: 1000,
  output_tokens: 100, reasoning_tokens: null, estimated_input_tokens: null, tier: false, cost_usd: 0.001, cost_reported: false, tier_cost_usd: 0, ...over,
})
const est = (total: number): EstimateBreakdown => ({ total, prompt: 10, diff: 20, delta: 0, files: 30, file_count: 2, prev_reviews: 0, prev_review_count: 0, replies: 0, reply_count: 0 })

let prev: boolean
beforeEach(() => { prev = config.tokenMetrics; config.tokenMetrics = true })
afterEach(() => { config.tokenMetrics = prev; vi.restoreAllMocks() })

describe('token_metrics record block', () => {
  it('is absent with no estimate and no call, and when the setting is off', () => {
    expect(buildUsageRecord(ctxOf(), 1, null)).not.toHaveProperty('token_metrics')
    config.tokenMetrics = false
    expect(buildUsageRecord(ctxOf({ estimateBreakdown: est(60), tokenCalls: [row()] }), 1, null)).not.toHaveProperty('token_metrics')
  })

  it('is present with an estimate and no calls, with empty roll-ups', () => {
    const m = buildUsageRecord(ctxOf({ estimateBreakdown: est(412_300) }), 1, null).token_metrics!
    expect(m).toEqual({ estimate: est(412_300), reviewer: null, calls: [], tier_calls: 0, tier_cost_usd: 0, calls_cost_usd: 0, max_prompt_tokens: null })
  })

  it('is present with calls and no estimate (reply-only run)', () => {
    const m = buildUsageRecord(ctxOf({ tokenCalls: [row({ stage: 'reply' })] }), 1, null).token_metrics!
    expect(m.estimate).toBeNull()
    expect(m.calls).toHaveLength(1)
  })

  it('carries estimate_initial only after a re-estimate and keys the block between delta and jenkins', () => {
    const r = buildUsageRecord(ctxOf({ estimateBreakdown: est(60), estimateBreakdownInitial: est(90), tokenCalls: [] }), 1, null)
    expect(r.token_metrics!.estimate_initial).toEqual(est(90))
    const keys = Object.keys(r)
    expect(keys.indexOf('token_metrics')).toBeGreaterThan(keys.indexOf('delta'))
    expect(keys.indexOf('token_metrics')).toBeLessThan(keys.indexOf('jenkins'))
  })

  it('computes the reviewer ratio over review rows with both values, and nulls it after a context retry', () => {
    const rows = [
      row({ prompt_tokens: 3000, estimated_input_tokens: 1000, bundle: 1 }),
      row({ prompt_tokens: 1500, estimated_input_tokens: 1000, bundle: 2 }),
      row({ stage: 'judge', prompt_tokens: 9000 }),
    ]
    const m = buildUsageRecord(ctxOf({ estimateBreakdown: est(60), tokenCalls: rows }), 1, null).token_metrics!
    expect(m.reviewer).toEqual({ estimated_input_tokens: 2000, prompt_tokens: 4500, ratio: 2.25, calls: 2 })
    const retried = [row({ prompt_tokens: null, estimated_input_tokens: 500 }), row({ prompt_tokens: 800, estimated_input_tokens: null, contexts_dropped: true })]
    expect(buildUsageRecord(ctxOf({ estimateBreakdown: est(60), tokenCalls: retried }), 1, null).token_metrics!.reviewer).toBeNull()
  })

  it('caps at 50 rows keeping every tier row then the largest prompts in call order, with roll-ups over all rows', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ prompt_tokens: 1000 + i, tier: i >= 57, tier_cost_usd: i >= 57 ? 0.5 : 0, cost_usd: 0.01, estimated_input_tokens: i }))
    const m = buildUsageRecord(ctxOf({ tokenCalls: rows }), 1, null).token_metrics!
    expect(m.calls).toHaveLength(50)
    expect(m.calls_dropped).toBe(10)
    const kept = m.calls.map(c => c.estimated_input_tokens!)
    expect(kept).toEqual([...kept].sort((a, b) => a - b))
    expect(kept).toEqual(Array.from({ length: 50 }, (_, i) => i + 10))
    expect(m.tier_calls).toBe(3)
    expect(m.tier_cost_usd).toBe(1.5)
    expect(m.calls_cost_usd).toBe(0.6)
    expect(m.max_prompt_tokens).toBe(1059)
  })

  it('keeps a tier row over larger rows and drops null-prompt rows first', () => {
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => row({ prompt_tokens: 5000 + i, estimated_input_tokens: i })),
      row({ prompt_tokens: null, estimated_input_tokens: 100 }),
      row({ prompt_tokens: 200_000, tier: true, tier_cost_usd: 0.8, estimated_input_tokens: 101 }),
    ]
    const m = buildUsageRecord(ctxOf({ tokenCalls: rows }), 1, null).token_metrics!
    expect(m.calls.map(c => c.estimated_input_tokens)).toContain(101)
    expect(m.calls.map(c => c.estimated_input_tokens)).not.toContain(100)
    expect(m.calls_dropped).toBe(2)
    expect(m.calls.map(c => c.estimated_input_tokens)).not.toContain(0)
  })

  it('warns once and drops only the block when building it fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = ctxOf({ estimateBreakdown: est(60) })
    Object.defineProperty(bad, 'tokenCalls', { get() { throw new Error('boom') } })
    const r = buildUsageRecord(bad, 1, null)
    expect(r).not.toHaveProperty('token_metrics')
    expect(r.action).toBe('REVIEW')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('tokenSummaryLine', () => {
  it('prints the exact line for a measured review and for a budget skip, without braces', () => {
    const rows = [row({ prompt_tokens: 119_054, estimated_input_tokens: 69_720, tier: true, tier_cost_usd: 0.0512, cost_usd: 0.064 }), row({ stage: 'judge', prompt_tokens: 76_211, cost_usd: 0.0083 })]
    const r = buildUsageRecord(ctxOf({ prInfo: undefined, estimateBreakdown: est(69_720), tokenCalls: rows }), 1, null)
    const line = tokenSummaryLine({ ...r, repo_slug: 'my-repo', pr_id: '101', cost_usd: 0.0723 })!
    expect(line).toBe('Token metrics: my-repo#101 | reviewer input 119,054 vs estimate ~69,720 (ratio 1.708) | 2 call(s), max input 119,054, 1 over the 100k tier, tier +$0.0512 | cost $0.0723, per-call $0.0723')
    expect(line).not.toMatch(/[{}]/)

    const skip = buildUsageRecord(ctxOf({ estimateBreakdown: est(412_300) }), 1, null)
    expect(tokenSummaryLine({ ...skip, repo_slug: 'my-repo', pr_id: '7', cost_usd: 0 }))
      .toBe('Token metrics: my-repo#7 | reviewer ratio n/a, estimate ~412,300 | 0 call(s), max input n/a, 0 over the 100k tier, tier +$0.0000 | cost $0.0000, per-call $0.0000')
  })

  it('counts rows the cap dropped and is undefined without the block', () => {
    const rows = Array.from({ length: 55 }, () => row())
    const r = buildUsageRecord(ctxOf({ tokenCalls: rows }), 1, null)
    expect(tokenSummaryLine({ ...r, repo_slug: 'r', pr_id: '1', cost_usd: 0 })).toContain('55 call(s)')
    config.tokenMetrics = false
    expect(tokenSummaryLine({ ...buildUsageRecord(ctxOf(), 1, null), repo_slug: 'r', pr_id: '1', cost_usd: 0 })).toBeUndefined()
  })
})
