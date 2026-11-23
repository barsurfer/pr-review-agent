import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReviewContext, StageEstimate } from '../types.js'
import { DeadlineAbortError, TruncatedResponseError, type LLMUsage } from '../../llm/shared.js'

const cfg = vi.hoisted(() => ({
  tokenMetrics: true,
  anthropic: { model: 'claude-haiku-5-5' },
  judge: { model: 'claude-haiku-5-5' },
  breadth: { model: '', effort: '' },
  lenses: { model: '' },
  review: { promptCache: false, effort: '' },
}))
vi.mock('../../config.js', () => ({ config: cfg }))

import { recordPassCall } from '../bundled.js'
import { callEnd, recordTokenCall, tokenSummaryLine } from '../token-metrics.js'

const ctxOf = (extra: Partial<ReviewContext> = {}): ReviewContext => ({ usage: {}, ...extra }) as unknown as ReviewContext
const u = (input_tokens: number, output_tokens: number, extra: Partial<LLMUsage> = {}): LLMUsage => ({ input_tokens, output_tokens, ...extra })
const call = (ctx: ReviewContext, stage: string, usage?: Partial<LLMUsage>, err?: unknown) => recordPassCall(ctx, stage, 32_000, undefined, usage, err)

let log: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  cfg.tokenMetrics = true
  cfg.review.promptCache = false
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('callEnd', () => {
  it('keeps err === undefined as the only ok, so a falsy thrown value is an error', () => {
    expect(callEnd(undefined)).toBe('ok')
    expect(callEnd(null)).toBe('error')
    expect(callEnd(0)).toBe('error')
    expect(callEnd('')).toBe('error')
    expect(callEnd(new Error('x'))).toBe('error')
    expect(callEnd(new DeadlineAbortError('t'))).toBe('aborted_time')
    expect(callEnd(new TruncatedResponseError('t', u(1, 1)))).toBe('truncated')
  })
})

describe('recordPassCall token rows (feature on)', () => {
  it('records a row per call in order, beside pass_calls, with the model of each stage', () => {
    const ctx = ctxOf()
    call(ctx, 'review', u(119_054, 1_792))
    call(ctx, 'judge', u(76_211, 1_286))
    expect(ctx.passCalls!.map(c => `${c.stage}:${c.end}`)).toEqual(['review:ok', 'judge:ok'])
    expect(ctx.tokenCalls).toEqual([
      expect.objectContaining({ stage: 'review', model: 'claude-haiku-5-5', end: 'ok', input_tokens: 119_054, cache_read_tokens: 0, cache_write_tokens: 0, prompt_tokens: 119_054, output_tokens: 1_792, reasoning_tokens: null, estimated_input_tokens: null, tier: true, cost_usd: 0.064, cost_reported: false, tier_cost_usd: 0.0512 }),
      expect.objectContaining({ stage: 'judge', end: 'ok', prompt_tokens: 76_211, tier: false, cost_usd: 0.0083, tier_cost_usd: 0 }),
    ])
  })

  it('prints one tier line per tier row and nothing for rows under the line', () => {
    const ctx = ctxOf({ stageEstimates: { review: { tokens: 69_720 } } })
    call(ctx, 'review', u(119_054, 1_792))
    call(ctx, 'judge', u(76_211, 1_286))
    expect(log.mock.calls.map((c: unknown[]) => c[0])).toEqual(['  Long-context tier: review on claude-haiku-5-5: 119,054 input tokens (estimate ~69,720), +$0.0512 over base rates'])
  })

  it('shows no estimate and the bundle number when there is no estimate and a bundle is set', () => {
    const ctx = ctxOf({ bundleIndex: 2 })
    call(ctx, 'review', u(120_000, 0))
    expect(log.mock.calls[0][0]).toContain('review bundle 2 on claude-haiku-5-5: 120,000 input tokens (no estimate)')
    expect(ctx.tokenCalls![0].bundle).toBe(2)
  })

  it('takes the estimate per stage and puts parts and contexts_dropped on review rows only', () => {
    const e: StageEstimate = { tokens: 5_000, parts: { overhead: 1, diff: 2, files: 3, file_count: 1 }, contexts_dropped: true }
    const ctx = ctxOf({ stageEstimates: { review: e, breadth: e, 'lens:rel': { tokens: 800 } } })
    call(ctx, 'review', u(10, 1))
    call(ctx, 'breadth', u(10, 1))
    call(ctx, 'lens:rel', u(10, 1))
    call(ctx, 'second_look', u(10, 1))
    const [r, b, l, s] = ctx.tokenCalls!
    expect(r).toMatchObject({ estimated_input_tokens: 5_000, estimate_parts: e.parts, contexts_dropped: true })
    expect(b.estimated_input_tokens).toBe(5_000)
    expect(b).not.toHaveProperty('estimate_parts')
    expect(b).not.toHaveProperty('contexts_dropped')
    expect(l.estimated_input_tokens).toBe(800)
    expect(s.estimated_input_tokens).toBeNull()
    expect(r).not.toHaveProperty('bundle')
  })

  it('has no tier and the table cost for a model without one', () => {
    cfg.anthropic.model = 'claude-sonnet-5-5'
    try {
      const ctx = ctxOf()
      call(ctx, 'review', u(300_000, 1_000))
      expect(ctx.tokenCalls![0]).toMatchObject({ model: 'claude-sonnet-5-5', tier: false, tier_cost_usd: 0, cost_usd: 0.61 })
      expect(log).not.toHaveBeenCalled()
    } finally { cfg.anthropic.model = 'claude-haiku-5-5' }
  })

  it('prices an unknown model quietly with the fallback rates', () => {
    cfg.judge.model = 'openai/gpt-5'
    try {
      const ctx = ctxOf()
      call(ctx, 'judge', u(1_000_000, 0))
      expect(ctx.tokenCalls![0]).toMatchObject({ model: 'openai/gpt-5', tier: false, tier_cost_usd: 0, cost_usd: 3 })
      expect(warn).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    } finally { cfg.judge.model = 'claude-haiku-5-5' }
  })

  it('keeps a provider-reported cost, flags it and takes the premium from the table', () => {
    const ctx = ctxOf()
    call(ctx, 'review', u(150_000, 2_000, { cost_usd: 0.08 }))
    expect(ctx.tokenCalls![0]).toMatchObject({ tier: true, cost_usd: 0.08, cost_reported: true, tier_cost_usd: 0.064 })
  })

  it('prices resent attempts per attempt and counts cache toward the line only under the cache flag', () => {
    cfg.review.promptCache = true
    const attempt = u(1_000, 500, { cache_read_input_tokens: 99_000, cache_creation_input_tokens: 0 })
    const ctx = ctxOf()
    call(ctx, 'review', u(2_000, 1_000, { cache_read_input_tokens: 198_000, cache_creation_input_tokens: 0, attempts: [attempt, attempt] }))
    expect(ctx.tokenCalls![0]).toMatchObject({ tier: false, prompt_tokens: 100_000, attempts: 2, cost_usd: 0.0027, cache_read_tokens: 198_000 })
  })

  it('reports reasoning only when positive and null when unknown', () => {
    const ctx = ctxOf()
    call(ctx, 'review', u(10, 100, { reasoning_tokens: 900 }))
    call(ctx, 'review', u(10, 100))
    call(ctx, 'review', u(10, 100, { reasoning_tokens: 0 }))
    expect(ctx.tokenCalls!.map(c => c.reasoning_tokens)).toEqual([900, null, null])
  })

  it('records a failure that carries usage with its real tokens and a failure without usage with nulls', () => {
    const ctx = ctxOf()
    call(ctx, 'review', u(50_000, 32_000), new TruncatedResponseError('cut', u(50_000, 32_000)))
    call(ctx, 'judge', undefined, new Error('boom'))
    const [t, f] = ctx.tokenCalls!
    expect(t).toMatchObject({ end: 'truncated', input_tokens: 50_000, output_tokens: 32_000, tier: false })
    expect(t.cost_usd).toBe(0.021)
    expect(f).toMatchObject({ end: 'error', input_tokens: null, cache_read_tokens: null, prompt_tokens: null, output_tokens: null, reasoning_tokens: null, cost_usd: null, cost_reported: false, tier: false, tier_cost_usd: null })
  })

  it('keeps the input of an aborted call, nulls its output and prices output at zero', () => {
    const ctx = ctxOf()
    call(ctx, 'breadth', u(120_000, 1, { reasoning_tokens: 5 }), new DeadlineAbortError('deadline'))
    expect(ctx.tokenCalls).toEqual([expect.objectContaining({ stage: 'breadth', end: 'aborted_time', input_tokens: 120_000, output_tokens: null, reasoning_tokens: null, tier: true, cost_usd: 0.06 })])
  })

  it('records the completed attempts of a deadline abort as error rows before the aborted row', () => {
    const one = new DeadlineAbortError('deadline', u(90_000, 1))
    one.completed = u(120_000, 800)
    const ctxOne = ctxOf({ stageEstimates: { breadth: { tokens: 70_000 } } })
    call(ctxOne, 'breadth', one.usage, one)
    expect(ctxOne.tokenCalls!.map(c => [c.end, c.input_tokens, c.estimated_input_tokens])).toEqual([['error', 120_000, 70_000], ['aborted_time', 90_000, 70_000]])
    expect(log.mock.calls).toHaveLength(1)

    const two = new DeadlineAbortError('deadline', u(1_000, 1))
    two.completed = u(30_000, 600, { attempts: [u(10_000, 200), u(20_000, 400)] })
    const ctxTwo = ctxOf()
    call(ctxTwo, 'breadth', two.usage, two)
    expect(ctxTwo.tokenCalls!.map(c => [c.end, c.input_tokens])).toEqual([['error', 10_000], ['error', 20_000], ['aborted_time', 1_000]])
    expect(ctxTwo.passCalls).toHaveLength(1)
  })

  it('is a no-op with no output when the feature is off, and leaves pass_calls as they were', () => {
    cfg.tokenMetrics = false
    const ctx = ctxOf()
    call(ctx, 'review', u(119_054, 1_792))
    recordTokenCall(ctx, 'reply', 'm', u(1, 1))
    expect(ctx.tokenCalls).toBeUndefined()
    expect(ctx.passCalls).toHaveLength(1)
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns once and never throws when the row cannot be built', () => {
    const ctx = ctxOf()
    Object.defineProperty(ctx, 'stageEstimates', { get() { throw new Error('bad ctx') } })
    expect(() => call(ctx, 'review', u(1, 1))).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(ctx.passCalls).toHaveLength(1)
  })

  it('does not throw for a falsy or string error value', () => {
    for (const err of [null, 'x', 0, '']) expect(() => recordTokenCall(ctxOf(), 'reply', 'claude-haiku-5-5', undefined, err)).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('tokenSummaryLine', () => {
  const base = { repo_slug: 'my-repo', pr_id: '101', cost_usd: 0.0723 }
  const m = { estimate: null, reviewer: null, calls: [], tier_calls: 0, tier_cost_usd: 0, calls_cost_usd: 0, max_prompt_tokens: null }

  it('is undefined without the key', () => {
    expect(tokenSummaryLine(base)).toBeUndefined()
  })

  it('renders the measured shape', () => {
    const line = tokenSummaryLine({ ...base, token_metrics: { ...m, reviewer: { estimated_input_tokens: 69_720, prompt_tokens: 119_054, ratio: 1.708, calls: 1 }, calls: [{}, {}] as never, tier_calls: 1, tier_cost_usd: 0.0512, calls_cost_usd: 0.0723, max_prompt_tokens: 119_054 } })
    expect(line).toBe('Token metrics: my-repo#101 | reviewer input 119,054 vs estimate ~69,720 (ratio 1.708) | 2 call(s), max input 119,054, 1 over the 100k tier, tier +$0.0512 | cost $0.0723, per-call $0.0723')
  })

  it('renders a skip with an estimate and one without, counting dropped rows, with no braces', () => {
    const est = { total: 412_300 } as never
    expect(tokenSummaryLine({ ...base, pr_id: '7', cost_usd: 0, token_metrics: { ...m, estimate: est } })).toBe('Token metrics: my-repo#7 | reviewer ratio n/a, estimate ~412,300 | 0 call(s), max input n/a, 0 over the 100k tier, tier +$0.0000 | cost $0.0000, per-call $0.0000')
    const none = tokenSummaryLine({ ...base, token_metrics: { ...m, calls: [{}] as never, calls_dropped: 4 } })!
    expect(none).toContain('reviewer ratio n/a, no estimate | 5 call(s)')
    expect(none).not.toMatch(/[{}]/)
  })
})
