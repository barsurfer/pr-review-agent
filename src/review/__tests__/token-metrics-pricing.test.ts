import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import type { LLMUsage } from '../../llm/shared.js'

let usage: typeof import('../usage.js')
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  usage = await import('../usage.js')
})
afterEach(() => { vi.restoreAllMocks() })

const u = (input_tokens: number, output_tokens: number, extra: Partial<LLMUsage> = {}): LLMUsage => ({ input_tokens, output_tokens, ...extra })
const HAIKU = 'claude-haiku-5-5'

describe('billedAtTier', () => {
  it('is Haiku 5.5 only and strictly above 100k of input plus cache', () => {
    expect(usage.billedAtTier({ input: 100_000, output: 0 }, HAIKU)).toBe(false)
    expect(usage.billedAtTier({ input: 100_001, output: 0 }, HAIKU)).toBe(true)
    expect(usage.billedAtTier({ input: 2_000, output: 0, cache_read: 99_000 }, HAIKU)).toBe(true)
    expect(usage.billedAtTier({ input: 2_000, output: 0, cache_write: 99_000 }, HAIKU)).toBe(true)
    expect(usage.billedAtTier({ input: 300_000, output: 0 }, 'claude-sonnet-5-5')).toBe(false)
    expect(usage.billedAtTier({ input: 150_000, output: 0 }, 'anthropic/claude-haiku-5.5')).toBe(true)
  })
})

describe('callPricing', () => {
  it('prices a Haiku 5.5 request over the line at the tier and reports the premium', () => {
    const p = usage.callPricing(u(119_054, 1_792), HAIKU, false)
    expect(p).toEqual({ tier: true, tier_cost_usd: 0.0512, cost_usd: 0.064, cost_reported: false, prompt_tokens: 119_054 })
  })

  it('draws the tier line at exactly 100,000', () => {
    expect(usage.callPricing(u(100_000, 0), HAIKU, false).tier).toBe(false)
    expect(usage.callPricing(u(100_001, 0), HAIKU, false).tier).toBe(true)
  })

  it('counts cache reads toward the line when the cache flag is on', () => {
    const p = usage.callPricing(u(2_000, 100, { cache_read_input_tokens: 99_000, cache_creation_input_tokens: 0 }), HAIKU, true)
    expect(p.tier).toBe(true)
    expect(p.prompt_tokens).toBe(101_000)
  })

  it('does not add cache columns with the flag off (input already includes cached reads on OpenRouter)', () => {
    const p = usage.callPricing(u(101_000, 0, { cache_read_input_tokens: 99_000 }), HAIKU, false)
    expect(p.prompt_tokens).toBe(101_000)
    expect(p.cost_usd).toBe(usage.estimateCost({ input: 101_000, output: 0 }, HAIKU))
  })

  it('gives models without a tier a zero premium and the table cost', () => {
    const p = usage.callPricing(u(300_000, 0), 'claude-sonnet-5-5', false)
    expect(p).toMatchObject({ tier: false, tier_cost_usd: 0, cost_usd: 0.6, cost_reported: false })
  })

  it('prices an unknown model with the Sonnet 4.6 fallback and prints no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = usage.callPricing(u(1_000_000, 0), 'openai/gpt-5', false)
    expect(p).toMatchObject({ tier: false, tier_cost_usd: 0, cost_usd: 3 })
    expect(warn).not.toHaveBeenCalled()
    usage.estimateCost({ input: 1, output: 0 }, 'openai/gpt-5')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  describe('provider-reported cost', () => {
    it('keeps the reported cost and takes the premium from the table', () => {
      const p = usage.callPricing(u(150_000, 2_000, { cost_usd: 0.08 }), 'anthropic/claude-haiku-5.5', false)
      expect(p).toMatchObject({ tier: true, cost_usd: 0.08, cost_reported: true, tier_cost_usd: 0.064 })
    })

    it('shows a provider that billed the base card as a cost below the premium', () => {
      const p = usage.callPricing(u(150_000, 2_000, { cost_usd: 0.016 }), 'anthropic/claude-haiku-5.5', false)
      expect(p).toMatchObject({ tier: true, cost_usd: 0.016, cost_reported: true, tier_cost_usd: 0.064 })
    })

    it('has no tier under 100k even with a reported cost', () => {
      expect(usage.callPricing(u(50_000, 1_000, { cost_usd: 0.01 }), HAIKU, false)).toMatchObject({ tier: false, tier_cost_usd: 0, cost_reported: true })
    })

    it('a resend where only one attempt reported a cost is not wholly reported', () => {
      const a = u(1_000, 100, { cost_usd: 0.001 })
      const b = u(1_000, 100)
      expect(usage.callPricing(u(2_000, 200, { attempts: [a, b] }), HAIKU, true).cost_reported).toBe(false)
    })
  })

  describe('resent attempts', () => {
    it('prices each attempt alone, so two 100k requests never reach the tier', () => {
      const attempt = u(1_000, 500, { cache_read_input_tokens: 99_000, cache_creation_input_tokens: 0 })
      const p = usage.callPricing(u(2_000, 1_000, { cache_read_input_tokens: 198_000, cache_creation_input_tokens: 0, attempts: [attempt, attempt] }), HAIKU, true)
      expect(p).toMatchObject({ tier: false, tier_cost_usd: 0, prompt_tokens: 100_000, attempts: 2, cost_usd: 0.0027 })
    })

    it('takes the premium from the tiered attempt only', () => {
      const p = usage.callPricing(u(180_000, 0, { attempts: [u(120_000, 0), u(60_000, 0)] }), HAIKU, true)
      expect(p.tier).toBe(true)
      expect(p.prompt_tokens).toBe(120_000)
      expect(p.tier_cost_usd).toBe(0.048)
    })
  })
})

describe('estimateCost and estimateAttemptsCost keep their numbers and warnings', () => {
  const models = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-5-5', 'anthropic/claude-haiku-5.5']
  const sizes = [{ input: 1_000, output: 500 }, { input: 90_000, output: 2_000, cache_read: 20_000, cache_write: 1_000 }, { input: 150_000, output: 3_000 }]

  it('quiet changes nothing but the warning, across the table', () => {
    for (const m of models) for (const t of sizes) {
      expect(usage.estimateCost(t, m, true)).toBe(usage.estimateCost(t, m))
      const attempts = [u(t.input, t.output, { cache_read_input_tokens: t.cache_read ?? 0, cache_creation_input_tokens: t.cache_write ?? 0 })]
      expect(usage.estimateAttemptsCost(attempts, m, true)).toBe(usage.estimateAttemptsCost(attempts, m))
    }
  })

  it('pins the existing prices', () => {
    expect(usage.estimateCost({ input: 119_054, output: 1_792 }, HAIKU)).toBe(0.064)
    expect(usage.estimateCost({ input: 76_211, output: 1_286 }, HAIKU)).toBe(0.0083)
    expect(usage.estimateCost({ input: 90_000, output: 0, cache_read: 20_000 }, HAIKU)).toBe(0.046)
    expect(usage.estimateCost({ input: 1_000_000, output: 0, cache_read: 1_000_000 }, 'claude-sonnet-5-5')).toBe(2.1)
  })

  it('warns on an unknown model unless quiet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    usage.estimateCost({ input: 1, output: 1 }, 'mystery')
    usage.estimateAttemptsCost([u(1, 1)], 'mystery')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toBe('No pricing entry for model "mystery" — estimating with claude-sonnet-4-6 rates')
    usage.estimateCost({ input: 1, output: 1 }, 'mystery', true)
    usage.estimateAttemptsCost([u(1, 1)], 'mystery', true)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
