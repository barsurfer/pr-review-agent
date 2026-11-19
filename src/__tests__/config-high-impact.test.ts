import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'

beforeAll(() => { process.env.ANTHROPIC_API_KEY = 'test-key' })

describe('ENABLE_HIGH_IMPACT', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const load = async (env: Record<string, string>) => {
    vi.unstubAllEnvs()
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.resetModules()
    return (await import('../config.js')).config
  }

  it('defaults off and turns on only from the exact string true, leaving the lens settings alone', async () => {
    const off = await load({})
    expect(off.review.highImpact).toBe(false)
    for (const v of ['1', 'TRUE', 'yes', '']) expect((await load({ ENABLE_HIGH_IMPACT: v })).review.highImpact).toBe(false)
    const on = await load({ ENABLE_HIGH_IMPACT: 'true' })
    expect(on.review.highImpact).toBe(true)
    expect(on.lenses).toEqual(off.lenses)
  })
})

describe('EXTRA_PASS_MAX_OUTPUT_TOKENS', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const load = async (env: Record<string, string>) => {
    vi.unstubAllEnvs()
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.resetModules()
    return (await import('../config.js')).config
  }

  it('reads a positive integer and treats unset, zero, negative or non-numeric values as unset (0)', async () => {
    expect((await load({})).anthropic.extraPassMaxTokens).toBe(0)
    expect((await load({ EXTRA_PASS_MAX_OUTPUT_TOKENS: '128000' })).anthropic.extraPassMaxTokens).toBe(128000)
    for (const v of ['0', '-5', 'abc', '', 'NaN']) expect((await load({ EXTRA_PASS_MAX_OUTPUT_TOKENS: v })).anthropic.extraPassMaxTokens).toBe(0)
  })
})
