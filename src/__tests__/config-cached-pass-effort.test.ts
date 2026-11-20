import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'

beforeAll(() => { process.env.ANTHROPIC_API_KEY = 'test-key' })

describe('CACHED_PASS_EFFORT', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

  const load = async (env: Record<string, string>) => {
    vi.unstubAllEnvs()
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.resetModules()
    return (await import('../config.js')).config
  }

  it('unset reads as the empty string and warns nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.CACHED_PASS_EFFORT
    expect((await load({})).review.cachedPassEffort).toBe('')
    expect(warn).not.toHaveBeenCalled()
  })

  it('accepts the five levels, trimmed', async () => {
    for (const v of ['low', 'medium', 'high', 'xhigh', 'max']) expect((await load({ CACHED_PASS_EFFORT: ` ${v} ` })).review.cachedPassEffort).toBe(v)
  })

  it('an empty or unknown value reads as off; only the unknown one warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await load({ CACHED_PASS_EFFORT: '' })).review.cachedPassEffort).toBe('')
    expect(warn).not.toHaveBeenCalled()
    expect((await load({ CACHED_PASS_EFFORT: 'extreme' })).review.cachedPassEffort).toBe('')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('CACHED_PASS_EFFORT=extreme')
  })
})
