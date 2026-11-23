import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import type { ReviewContext, StageUsage } from '../types.js'

let priceRequests: (typeof import('../usage.js'))['priceRequests']
let remainderCost: (typeof import('../usage.js'))['remainderCost']
let estimateCost: (typeof import('../usage.js'))['estimateCost']
let buildUsageRecord: (typeof import('../usage.js'))['buildUsageRecord']
let config: (typeof import('../../config.js'))['config']
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;({ priceRequests, remainderCost, estimateCost, buildUsageRecord } = await import('../usage.js'))
  ;({ config } = await import('../../config.js'))
})
afterEach(() => { vi.restoreAllMocks() })

const HAIKU = 'claude-haiku-5-5'
const req = (input: number, output: number, extra: Partial<StageUsage> = {}) => ({ usage: { input_tokens: input, output_tokens: output, ...extra } as StageUsage, model: HAIKU })

describe('priceRequests', () => {
  it('prices a single model and tier group exactly as one estimateCost', () => {
    expect(priceRequests([req(60_000, 2_000), req(30_000, 500)], false)).toBe(estimateCost({ input: 90_000, output: 2_500 }, HAIKU))
    expect(priceRequests([req(1_234, 567)], false)).toBe(estimateCost({ input: 1_234, output: 567 }, HAIKU))
  })

  it('prices each request against the tier alone', () => {
    expect(priceRequests([req(60_000, 2_000), req(60_000, 2_000)], false)).toBeCloseTo(0.014, 6)
    expect(priceRequests([req(60_000, 2_000), req(120_000, 1_000)], false)).toBeCloseTo(0.007 + 0.0625, 6)
  })

  it('keeps tier and base requests of one model in separate groups', () => {
    expect(priceRequests([req(120_000, 0), req(120_000, 0), req(50_000, 0)], false)).toBeCloseTo(0.12 + 0.005, 6)
  })

  it('prices different models at their own rates', () => {
    expect(priceRequests([{ ...req(1_000_000, 0), model: 'claude-sonnet-5-5' }, req(50_000, 0)], false)).toBeCloseTo(2.005, 6)
  })

  it('sums reported costs in order and never table-prices a reported request', () => {
    expect(priceRequests([req(1, 1, { cost_usd: 0.1 }), req(1, 1, { cost_usd: 0.2 }), req(1, 1, { cost_usd: 0.3 })], false)).toBe(0.1 + 0.2 + 0.3)
  })

  it('adds the table price of unreported requests to the reported ones', () => {
    expect(priceRequests([req(400, 50, { cost_usd: 0.006 }), req(55_000, 1_000)], false)).toBeCloseTo(0.012, 6)
  })

  it('expands attempts and keeps an attempt that reported its own cost', () => {
    const attempts = [{ input_tokens: 60_000, output_tokens: 1_000 }, { input_tokens: 60_000, output_tokens: 1_000 }]
    expect(priceRequests([req(120_000, 2_000, { attempts })], false)).toBeCloseTo(0.013, 6)
    const mixed = [{ input_tokens: 60_000, output_tokens: 1_000, cost_usd: 0.5 }, { input_tokens: 60_000, output_tokens: 1_000 }]
    expect(priceRequests([req(120_000, 2_000, { attempts: mixed })], false)).toBeCloseTo(0.5 + 0.0065, 6)
  })

  it('counts cache fields only when the cache flag is on', () => {
    const r = req(10_000, 0, { cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 })
    expect(priceRequests([r], false)).toBeCloseTo(0.001, 6)
    expect(priceRequests([r], true)).toBe(estimateCost({ input: 10_000, output: 0, cache_read: 100_000, cache_write: 0 }, HAIKU))
  })

  it('never warns itself, so the record keeps the old warning count', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mystery = (input: number) => ({ ...req(input, 0), model: 'mystery-model' })
    priceRequests([mystery(1_000), mystery(2_000), mystery(3_000)], false)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('remainderCost', () => {
  const ctxOf = (over: Partial<ReviewContext>): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 }, estimatedInputTokens: 0, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)

  it('prices the listed requests when they account for every remainder token', () => {
    const ctx = ctxOf({ remainderRequests: [req(60_000, 2_000), req(60_000, 2_000)] })
    const r = remainderCost(ctx, { input: 120_000, output: 4_000 }, () => 99, false)
    expect(r.fallback).toBe(false)
    expect(r.cost).toBeCloseTo(0.014, 6)
  })

  it('falls back to the old whole-bucket price when a token is unaccounted for', () => {
    const ctx = ctxOf({ remainderRequests: [req(60_000, 2_000)] })
    expect(remainderCost(ctx, { input: 120_000, output: 4_000 }, () => 99, false)).toEqual({ cost: 99, fallback: true })
    expect(remainderCost(ctx, { input: 60_000, output: 2_000, cache_read: 5, cache_write: 0 }, () => 99, true)).toEqual({ cost: 99, fallback: true })
  })

  it('falls back when the context lists nothing at all', () => {
    expect(remainderCost(ctxOf({}), { input: 10, output: 10 }, () => 99, false)).toEqual({ cost: 99, fallback: true })
  })

  it('keeps the old aggregate arithmetic when every call reported a cost', () => {
    const ctx = ctxOf({ usage: { input_tokens: 2, output_tokens: 2, cache_read: 0, cache_write: 0, cost_usd: 0.3 }, remainderRequests: [req(1, 1, { cost_usd: 0.1 }), req(1, 1, { cost_usd: 0.2 })] })
    expect(remainderCost(ctx, { input: 2, output: 2 }, () => 0.3 - 0, false)).toEqual({ cost: 0.3, fallback: false })
  })
})

describe('buildUsageRecord with the prompt cache on (P8)', () => {
  const baseCtx = (over: Partial<ReviewContext>): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    estimatedInputTokens: 0, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)

  it('prices a cached reviewer call per attempt and the failed judge at its own model', () => {
    const prior = { cache: config.review.promptCache, model: config.anthropic.model, judge: config.judge.model }
    config.review.promptCache = true
    config.anthropic.model = 'claude-sonnet-5-5'
    config.judge.model = HAIKU
    try {
      const reviewerCall: StageUsage = { input_tokens: 50_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, attempts: [{ input_tokens: 50_000, output_tokens: 2_000 }] }
      const failedJudge: StageUsage = { input_tokens: 60_000, output_tokens: 64_000 }
      const ctx = baseCtx({
        usage: { input_tokens: 110_000, output_tokens: 66_000, cache_read: 0, cache_write: 0 },
        reviewUsage: reviewerCall,
        remainderRequests: [{ usage: reviewerCall, model: 'claude-sonnet-5-5' }, { usage: failedJudge, model: HAIKU }],
      })
      expect(buildUsageRecord(ctx, 1, null).cost_usd).toBeCloseTo(0.12 + 0.038, 4)
    } finally {
      config.review.promptCache = prior.cache
      config.anthropic.model = prior.model
      config.judge.model = prior.judge
    }
  })
})

describe('one resent reviewer request keeps the old per-attempt rounding', () => {
  const ctxOf = (over: Partial<ReviewContext>): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 }, estimatedInputTokens: 0, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)
  const headFormula = (attempts: Array<{ input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cost_usd?: number }>) => {
    const price = (a: (typeof attempts)[number]) => a.cost_usd ?? ((a.input_tokens / 1e6) * 0.1 + ((a.cache_creation_input_tokens ?? 0) / 1e6) * 0.1 * 1.25 + ((a.cache_read_input_tokens ?? 0) / 1e6) * 0.1 * 0.1 + (a.output_tokens / 1e6) * 0.5)
    return Math.round(attempts.reduce((n, a) => n + price(a), 0) * 10000) / 10000
  }
  const single = (attempts: Parameters<typeof headFormula>[0]) => {
    const sum = (k: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens') => attempts.reduce((n, a) => n + (a[k] ?? 0), 0)
    const usage: StageUsage = { input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cache_read_input_tokens: sum('cache_read_input_tokens'), cache_creation_input_tokens: sum('cache_creation_input_tokens'), attempts }
    const ctx = ctxOf({ remainderRequests: [{ usage, model: HAIKU }] })
    return remainderCost(ctx, { input: usage.input_tokens, output: usage.output_tokens, cache_read: sum('cache_read_input_tokens'), cache_write: sum('cache_creation_input_tokens') }, () => 99, true)
  }

  it('does not flip a half-step to the other side of the fourth decimal', () => {
    const attempts = [
      { input_tokens: 4179, output_tokens: 1947, cache_read_input_tokens: 24440, cache_creation_input_tokens: 2636 },
      { input_tokens: 2083, output_tokens: 1264, cache_read_input_tokens: 24440 },
    ]
    expect(headFormula(attempts)).toBe(0.0031)
    expect(single(attempts)).toEqual({ cost: 0.0031, fallback: false })
  })

  it('adds a reported attempt before the single rounding, as the old path did', () => {
    const attempts = [{ input_tokens: 60_001, output_tokens: 1_001, cost_usd: 0.50004 }, { input_tokens: 60_000, output_tokens: 1_000 }]
    expect(headFormula(attempts)).toBe(0.5065)
    expect(single(attempts)).toEqual({ cost: 0.5065, fallback: false })
  })
})

describe('unknown reviewer model warning count', () => {
  const baseCtx = (over: Partial<ReviewContext>): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    estimatedInputTokens: 0, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)
  const MYSTERY = 'mystery-model'
  const warningsFor = (ctx: ReviewContext, replyModel = ''): number => {
    const prior = { model: config.anthropic.model, judge: config.judge.model, reply: config.reply.model }
    config.anthropic.model = MYSTERY
    config.judge.model = ''
    config.reply.model = replyModel
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      buildUsageRecord(ctx, 1, null)
      return warn.mock.calls.filter(c => String(c[0]).includes('No pricing entry')).length
    } finally {
      config.anthropic.model = prior.model
      config.judge.model = prior.judge
      config.reply.model = prior.reply
    }
  }
  const mystery = (input: number) => ({ usage: { input_tokens: input, output_tokens: 10 } as StageUsage, model: MYSTERY })

  it('warns once for a reviewed run', () => {
    expect(warningsFor(baseCtx({ usage: { input_tokens: 1_000, output_tokens: 10, cache_read: 0, cache_write: 0 }, remainderRequests: [mystery(1_000)] }))).toBe(1)
  })

  it('warns once for a run with no tokens at all', () => {
    expect(warningsFor(baseCtx({ action: 'SKIP', usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 }, remainderRequests: [] }))).toBe(1)
  })

  it('warns once, not once per model, when the reply model is unknown too', () => {
    const reply = { usage: { input_tokens: 500, output_tokens: 10 } as StageUsage, model: 'mystery-reply' }
    expect(warningsFor(baseCtx({ action: 'REPLY', usage: { input_tokens: 1_500, output_tokens: 20, cache_read: 0, cache_write: 0 }, remainderRequests: [mystery(1_000), reply] }), 'mystery-reply')).toBe(1)
  })

  it('stays silent when every call reported its own cost', () => {
    const reported = { usage: { input_tokens: 1_000, output_tokens: 10, cost_usd: 0.1 } as StageUsage, model: MYSTERY }
    expect(warningsFor(baseCtx({ usage: { input_tokens: 1_000, output_tokens: 10, cache_read: 0, cache_write: 0, cost_usd: 0.1 }, remainderRequests: [reported] }))).toBe(0)
  })
})

describe('bundled judge cache tokens (cache on)', () => {
  it('prices the judge without cache fields, matching its judge_tokens, so nothing is counted twice', () => {
    const prior = { cache: config.review.promptCache, model: config.anthropic.model, judge: config.judge.model }
    config.review.promptCache = true
    config.anthropic.model = HAIKU
    config.judge.model = HAIKU
    try {
      const reviewerCall: StageUsage = { input_tokens: 60_000, output_tokens: 2_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      const judgeCall: StageUsage = { input_tokens: 55_000, output_tokens: 1_500, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0 }
      const ctx = {
        adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo', estimatedInputTokens: 0, action: 'REVIEW', reviewNumber: 1,
        usage: { input_tokens: 115_000, output_tokens: 3_500, cache_read: 30_000, cache_write: 0 },
        judgeUsage: { input_tokens: 55_000, output_tokens: 1_500 }, judgeRequests: [judgeCall], bundleCount: 1,
        remainderRequests: [{ usage: reviewerCall, model: HAIKU }],
      } as unknown as ReviewContext
      const record = buildUsageRecord(ctx, 1, null)
      const judge = estimateCost({ input: 55_000, output: 1_500 }, HAIKU)
      const reviewer = estimateCost({ input: 60_000, output: 2_000, cache_read: 30_000, cache_write: 0 }, HAIKU)
      expect(record.judge_cost_usd).toBe(judge)
      expect(record.cost_usd).toBe(reviewer + judge)
    } finally {
      config.review.promptCache = prior.cache
      config.anthropic.model = prior.model
      config.judge.model = prior.judge
    }
  })
})
