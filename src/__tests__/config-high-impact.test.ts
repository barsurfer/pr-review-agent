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
