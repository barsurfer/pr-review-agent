import { describe, it, expect, beforeAll } from 'vitest'

// usage.ts pulls in config (required ANTHROPIC_API_KEY) at import — set it before the dynamic import.
let estimateCost: (tokens: { input: number; output: number }, model: string) => number
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;({ estimateCost } = await import('../usage.js'))
})

describe('estimateCost', () => {
  it('prices current models per published $/MTok rates', () => {
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'claude-opus-5-5')).toBe(4)
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'claude-sonnet-5-5')).toBe(2)
    expect(estimateCost({ input: 0, output: 1_000_000 }, 'claude-sonnet-5')).toBe(10)
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'claude-fable-5-1')).toBe(10)
  })

  it('prices a dated model id as its alias', () => {
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'claude-haiku-4-5-20251001')).toBe(1)
  })

  it('prices Haiku 5.5 by prompt length (5x over 100k input tokens)', () => {
    expect(estimateCost({ input: 50_000, output: 0 }, 'claude-haiku-5-5')).toBe(0.005)  // ≤100k → $0.10/MTok
    expect(estimateCost({ input: 200_000, output: 0 }, 'claude-haiku-5-5')).toBe(0.1)   // >100k → $0.50/MTok
    expect(estimateCost({ input: 0, output: 1_000_000 }, 'claude-haiku-5-5')).toBe(0.5) // ≤100k output rate
  })

  it('falls back to sonnet-4-6 rates for an unknown model', () => {
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'mystery-model')).toBe(3)
  })
})
