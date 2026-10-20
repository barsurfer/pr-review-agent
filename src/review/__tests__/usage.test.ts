import { describe, it, expect, beforeAll } from 'vitest'
import type { ReviewContext } from '../types.js'

// usage.ts pulls in config (required ANTHROPIC_API_KEY) at import — set it before the dynamic import.
let estimateCost: (tokens: { input: number; output: number }, model: string) => number
let buildUsageRecord: (typeof import('../usage.js'))['buildUsageRecord']
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;({ estimateCost, buildUsageRecord } = await import('../usage.js'))
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

describe('buildUsageRecord provenance fields', () => {
  const baseCtx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)

  it('stamps agent_commit + a 12-hex prompt_hash and passes judge_prompt_hash from ctx', () => {
    const r = buildUsageRecord(baseCtx({ prompt: { content: 'SYS', source: 'repo' } as never, judgePromptHash: 'abc123def456' }), 100, null)
    expect(r.agent_commit).toBeTruthy()
    expect(r.prompt_hash).toMatch(/^[0-9a-f]{12}$/)
    expect(r.judge_prompt_hash).toBe('abc123def456')
  })

  it('judge_prompt_hash is null when the judge did not run', () => {
    expect(buildUsageRecord(baseCtx(), 1, null).judge_prompt_hash).toBeNull()
  })

  it('prompt_hash is null without a loaded prompt and stable for identical content', () => {
    expect(buildUsageRecord(baseCtx(), 1, null).prompt_hash).toBeNull()
    const p = { content: 'X', source: 'repo' } as never
    expect(buildUsageRecord(baseCtx({ prompt: p }), 1, null).prompt_hash)
      .toBe(buildUsageRecord(baseCtx({ prompt: p }), 1, null).prompt_hash)
  })

  it('passes judge_status through, null when the judge stage was not reached', () => {
    expect(buildUsageRecord(baseCtx({ judgeStatus: 'succeeded' }), 1, null).judge_status).toBe('succeeded')
    expect(buildUsageRecord(baseCtx(), 1, null).judge_status).toBeNull()
  })
})
