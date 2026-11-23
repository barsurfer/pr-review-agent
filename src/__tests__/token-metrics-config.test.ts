import { describe, it, expect, vi, afterEach } from 'vitest'

describe('ENABLE_TOKEN_METRICS setting', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const load = async (value: string | undefined) => {
    vi.unstubAllEnvs()
    // A missing dotenv file stops a developer .env refilling the key; an unset key (not '') is what takes the default.
    vi.stubEnv('DOTENV_CONFIG_PATH', 'D:/nonexistent/.env')
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.stubEnv('ENABLE_TOKEN_METRICS', value)
    vi.resetModules()
    return (await import('../config.js')).config.tokenMetrics
  }

  it('defaults to false when the key is unset', async () => {
    expect(await load(undefined)).toBe(false)
  })

  it('turns on only from the exact string true', async () => {
    expect(await load('true')).toBe(true)
    for (const value of ['', 'false', 'TRUE', '1', ' true', 'yes']) expect(await load(value), value).toBe(false)
  })
})
