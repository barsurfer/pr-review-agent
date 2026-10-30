import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'

// config.ts calls required('ANTHROPIC_API_KEY') at import, so set it before the dynamic import.
let modelContextWindow: (model: string) => number
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;({ modelContextWindow } = await import('../config.js'))
})

describe('modelContextWindow', () => {
  it('maps 4.5-generation reviewers to 200K', () => {
    expect(modelContextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(modelContextWindow('claude-sonnet-4-5-20250929')).toBe(200_000)
    expect(modelContextWindow('claude-opus-4-5')).toBe(200_000)
  })

  it('maps 4.6+/5.x reviewers (incl. Haiku 5.5) to 1M', () => {
    expect(modelContextWindow('claude-haiku-5-5')).toBe(1_000_000)
    expect(modelContextWindow('claude-sonnet-4-6')).toBe(1_000_000)
    expect(modelContextWindow('claude-sonnet-5')).toBe(1_000_000)
    expect(modelContextWindow('claude-sonnet-5-5')).toBe(1_000_000)
    expect(modelContextWindow('claude-opus-4-8')).toBe(1_000_000)
    expect(modelContextWindow('claude-opus-5-5')).toBe(1_000_000)
  })

  it('falls back to a conservative 200K for an unmapped model', () => {
    expect(modelContextWindow('claude-something-7')).toBe(200_000)
  })
})

describe('breadth settings', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const load = async (env: Record<string, string>) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.resetModules()
    return (await import('../config.js')).config.breadth
  }

  it('falls back to the default thresholds when the parameter is empty or not a number', async () => {
    expect(await load({ BREADTH_MIN_FILES: '', BREADTH_MIN_UNTOUCHED: '' })).toMatchObject({ minFiles: 5, minUntouched: 3 })
    expect(await load({ BREADTH_MIN_FILES: 'many', BREADTH_MIN_UNTOUCHED: 'few' })).toMatchObject({ minFiles: 5, minUntouched: 3 })
  })

  it('honors explicit thresholds, including 0', async () => {
    expect(await load({ BREADTH_MIN_FILES: '8', BREADTH_MIN_UNTOUCHED: '0' })).toMatchObject({ minFiles: 8, minUntouched: 0 })
  })

  it('reads the benchmark deadline with the entrypoint fallback for empty, malformed or non-positive values', async () => {
    expect((await load({ BENCHMARK_DEADLINE_SECONDS: '600' })).benchmarkDeadlineSeconds).toBe(600)
    for (const bad of ['', '15m', '0', '-5']) {
      expect((await load({ BENCHMARK_DEADLINE_SECONDS: bad })).benchmarkDeadlineSeconds).toBe(840)
    }
  })
})

describe('llmApiKey — conditional required key per provider', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('keeps the exact ANTHROPIC_API_KEY throw for the default anthropic provider', async () => {
    vi.stubEnv('LLM_PROVIDER', 'anthropic'); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', 'or-key')
    vi.resetModules()
    await expect(import('../config.js')).rejects.toThrow('Missing required environment variable: ANTHROPIC_API_KEY')
  })

  it('requires only OPENROUTER_API_KEY when LLM_PROVIDER=openrouter', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter'); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', 'or-key')
    vi.resetModules()
    const { config } = await import('../config.js')
    expect(config.llmProvider).toBe('openrouter')
    expect(config.llmApiKey).toBe('or-key')
  })

  it('falls back to the ANTHROPIC_API_KEY slot for openrouter when OPENROUTER_API_KEY is unset', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter'); vi.stubEnv('ANTHROPIC_API_KEY', 'anth-key'); vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.resetModules()
    const { config } = await import('../config.js')
    expect(config.llmApiKey).toBe('anth-key')
  })

  it('throws for openrouter when neither key is set', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter'); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.resetModules()
    await expect(import('../config.js')).rejects.toThrow(/OPENROUTER_API_KEY/)
  })
})
