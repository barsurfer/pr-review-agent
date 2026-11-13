import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../config.js', async () => {
  const { tableContextWindow } = await vi.importActual<typeof import('../model-id.js')>('../model-id.js')
  return {
    config: {
      llmProvider: 'openrouter',
      vcsProvider: 'bitbucket',
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1/' },
      anthropic: { model: 'anthropic/claude-haiku-5.5', modelContextTokens: 0 },
      judge: { model: 'anthropic/claude-haiku-5.5' },
      breadth: { enabled: false, model: '' },
      lenses: { enabled: false, model: '' },
    },
    // Same body as config.ts, so table-known ids resolve exactly as in production.
    modelContextWindow: (model: string) => tableContextWindow(model) ?? 200_000,
  }
})

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('axios', () => ({ default: { get } }))

// Entries copied from a saved GET /api/v1/models response.
const MODEL_LIST = {
  data: [
    { id: 'openai/gpt-6-luna', canonical_slug: 'openai/gpt-6-luna-20260922', context_length: 1_050_000, top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 } },
    { id: 'openai/gpt-5-nano', canonical_slug: 'openai/gpt-5-nano-2025-08-07', context_length: 400_000, top_provider: { context_length: 400_000, max_completion_tokens: 128_000 } },
    { id: 'qwen/qwen3.8-27b', canonical_slug: 'qwen/qwen3.8-27b-20260814', context_length: 1_048_575, top_provider: { context_length: 262_144, max_completion_tokens: 235_929 } },
    { id: 'openrouter/auto', canonical_slug: 'openrouter/auto', context_length: 2_000_000, top_provider: { context_length: null, max_completion_tokens: null } },
  ],
}

type Cfg = {
  llmProvider: string; vcsProvider: string
  anthropic: { model: string; modelContextTokens: number }
  judge: { model: string }
  breadth: { enabled: boolean; model: string }
  lenses: { enabled: boolean; model: string }
}

let log: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>

const defaults = (): Cfg => ({
  llmProvider: 'openrouter', vcsProvider: 'bitbucket',
  anthropic: { model: 'anthropic/claude-haiku-5.5', modelContextTokens: 0 },
  judge: { model: 'anthropic/claude-haiku-5.5' },
  breadth: { enabled: false, model: '' },
  lenses: { enabled: false, model: '' },
})

// The lookup runs at most once per process, so every test gets a fresh module; the mocked config object survives resetModules, so it is reset too.
async function load(set: (cfg: Cfg) => void = () => {}) {
  vi.resetModules()
  const { config } = await import('../../config.js')
  Object.assign(config, defaults())
  set(config as unknown as Cfg)
  const mod = await import('../context-window.js')
  return { ...mod, cfg: config as unknown as Cfg }
}

beforeEach(() => {
  get.mockReset()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { log.mockRestore(); warn.mockRestore() })

describe('resolveContextWindows', () => {
  it('production ids (anthropic/claude-haiku-5.5 reviewer + judge) make no HTTP call, print nothing and keep the table window', async () => {
    const { resolveContextWindows, contextWindowFor } = await load()
    await resolveContextWindows()
    expect(get).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(contextWindowFor('anthropic/claude-haiku-5.5', true)).toBe(1_000_000)
    expect(contextWindowFor('anthropic/claude-haiku-5.5')).toBe(1_000_000)
  })

  it('no HTTP call for any table-known pair, enabled breadth and lens models included', async () => {
    const { resolveContextWindows, contextWindowFor } = await load(c => {
      c.anthropic.model = 'claude-haiku-4-5-20251001'
      c.judge.model = 'anthropic/claude-sonnet-5.5:nitro'
      c.breadth = { enabled: true, model: 'claude-opus-4-8' }
      c.lenses = { enabled: true, model: 'anthropic/claude-haiku-4.5' }
    })
    await resolveContextWindows()
    expect(get).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(contextWindowFor('claude-haiku-4-5-20251001', true)).toBe(200_000)
    expect(contextWindowFor('anthropic/claude-sonnet-5.5:nitro')).toBe(1_000_000)
    expect(contextWindowFor('anthropic/claude-haiku-4.5')).toBe(200_000)
  })

  it('resolves an unknown slug from the OpenRouter model list once per process, logging the window and its source', async () => {
    get.mockResolvedValue({ data: MODEL_LIST })
    const { resolveContextWindows, contextWindowFor } = await load(c => { c.anthropic.model = 'openai/gpt-6-luna'; c.judge.model = 'openai/gpt-6-luna' })
    await resolveContextWindows()
    await resolveContextWindows()
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', { timeout: 5_000 })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(`Context window from the OpenRouter model list: openai/gpt-6-luna ${(1_050_000).toLocaleString()}`)
    expect(warn).not.toHaveBeenCalled()
    expect(contextWindowFor('openai/gpt-6-luna', true)).toBe(1_050_000)
    expect(contextWindowFor('openai/gpt-6-luna')).toBe(1_050_000)
  })

  it('takes the smaller of context_length and top_provider.context_length, and context_length alone when the provider reports none', async () => {
    get.mockResolvedValue({ data: MODEL_LIST })
    const { resolveContextWindows, contextWindowFor } = await load(c => { c.anthropic.model = 'qwen/qwen3.8-27b'; c.judge.model = 'openrouter/auto' })
    await resolveContextWindows()
    expect(contextWindowFor('qwen/qwen3.8-27b', true)).toBe(262_144)
    expect(contextWindowFor('openrouter/auto')).toBe(2_000_000)
  })

  it('matches a :variant suffix and a canonical slug to the listed model', async () => {
    get.mockResolvedValue({ data: MODEL_LIST })
    const { resolveContextWindows, contextWindowFor } = await load(c => { c.anthropic.model = 'openai/gpt-6-luna:nitro'; c.judge.model = 'openai/gpt-5-nano-2025-08-07' })
    await resolveContextWindows()
    expect(contextWindowFor('openai/gpt-6-luna:nitro', true)).toBe(1_050_000)
    expect(contextWindowFor('openai/gpt-5-nano-2025-08-07')).toBe(400_000)
  })

  it('looks up only budgeted models: a mixed pair asks once and resolves only the unknown one', async () => {
    get.mockResolvedValue({ data: MODEL_LIST })
    const { resolveContextWindows, contextWindowFor } = await load(c => {
      c.anthropic.model = 'openai/gpt-6-luna'; c.judge.model = 'anthropic/claude-haiku-4.5'
      c.breadth = { enabled: false, model: 'openai/unlisted-breadth' }
    })
    await resolveContextWindows()
    expect(get).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(`Context window from the OpenRouter model list: openai/gpt-6-luna ${(1_050_000).toLocaleString()}`)
    expect(warn).not.toHaveBeenCalled()
    expect(contextWindowFor('anthropic/claude-haiku-4.5')).toBe(200_000)
  })

  it('a model missing from the list keeps the 200K fallback with one notice naming it and MODEL_CONTEXT_TOKENS', async () => {
    get.mockResolvedValue({ data: MODEL_LIST })
    const { resolveContextWindows, contextWindowFor } = await load(c => { c.anthropic.model = 'openai/gpt-6-luna'; c.judge.model = 'openai/not-listed' })
    await resolveContextWindows()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Warning: no known context window for openai/not-listed - using the 200K fallback; set MODEL_CONTEXT_TOKENS to the real window')
    expect(contextWindowFor('openai/not-listed')).toBe(200_000)
    expect(contextWindowFor('openai/gpt-6-luna')).toBe(1_050_000)
  })

  it.each([
    ['a network error', Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'), { code: 'ENOTFOUND' }), 'getaddrinfo ENOTFOUND openrouter.ai'],
    ['a timeout', Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }), 'timeout of 5000ms exceeded'],
  ])('fails open on %s: 200K for every unknown model and exactly one warning', async (_name, err, message) => {
    get.mockRejectedValue(err)
    const { resolveContextWindows, contextWindowFor } = await load(c => { c.anthropic.model = 'openai/gpt-6-luna'; c.judge.model = 'openai/gpt-5-nano' })
    await resolveContextWindows()
    expect(get).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(`Warning: could not read the OpenRouter model list (${message}) - using the 200K fallback context window for openai/gpt-6-luna, openai/gpt-5-nano; set MODEL_CONTEXT_TOKENS to the real window`)
    expect(log).not.toHaveBeenCalled()
    expect(contextWindowFor('openai/gpt-6-luna', true)).toBe(200_000)
    expect(contextWindowFor('openai/gpt-5-nano')).toBe(200_000)
  })

  it('fails open on an unexpected response body', async () => {
    get.mockResolvedValue({ data: { error: { message: 'nope' } } })
    const { resolveContextWindows, contextWindowFor } = await load(c => { c.anthropic.model = 'openai/gpt-6-luna' })
    await resolveContextWindows()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('(unexpected response shape)')
    expect(contextWindowFor('openai/gpt-6-luna', true)).toBe(200_000)
  })

  it('never calls out under the Anthropic provider; an unknown id still gets the fallback notice', async () => {
    const { resolveContextWindows, contextWindowFor } = await load(c => { c.llmProvider = 'anthropic'; c.anthropic.model = 'claude-something-7' })
    await resolveContextWindows()
    expect(get).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Warning: no known context window for claude-something-7 - using the 200K fallback; set MODEL_CONTEXT_TOKENS to the real window')
    expect(contextWindowFor('claude-something-7', true)).toBe(200_000)
  })

  it('never runs in benchmark mode', async () => {
    const { resolveContextWindows } = await load(c => { c.vcsProvider = 'reviewbench'; c.anthropic.model = 'openai/gpt-6-luna' })
    await resolveContextWindows()
    expect(get).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips the lookup and the notice when MODEL_CONTEXT_TOKENS is set, since the override fills in every unknown window', async () => {
    const { resolveContextWindows, contextWindowFor } = await load(c => { c.anthropic.model = 'openai/gpt-6-luna'; c.judge.model = 'openai/gpt-6-luna'; c.anthropic.modelContextTokens = 900_000 })
    await resolveContextWindows()
    expect(get).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(contextWindowFor('openai/gpt-6-luna', true)).toBe(900_000)
  })
})

describe('contextWindowFor — MODEL_CONTEXT_TOKENS replaces the reviewer window and fills in only for other models the table lacks', () => {
  const KNOWN = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5:nitro', 'claude-opus-4-8']

  it('clause 3: unset, every table-known id resolves exactly as modelContextWindow, for the reviewer and every other role', async () => {
    const { contextWindowFor } = await load()
    const { modelContextWindow } = await import('../../config.js')
    for (const id of KNOWN) {
      expect(contextWindowFor(id, true), id).toBe(modelContextWindow(id))
      expect(contextWindowFor(id), id).toBe(modelContextWindow(id))
    }
  })

  it('clause 3: set, the reviewer window is the override whatever the model, as before', async () => {
    const { contextWindowFor } = await load(c => { c.anthropic.modelContextTokens = 100_000 })
    for (const id of [...KNOWN, 'openai/gpt-6-luna']) expect(contextWindowFor(id, true), id).toBe(100_000)
  })

  it('clause 1: one variable fixes an all-unknown setup — judge, breadth, second-look and lens models take the override', async () => {
    const { contextWindowFor } = await load(c => { c.anthropic.modelContextTokens = 1_000_000 })
    expect(contextWindowFor('openai/gpt-6-luna', true)).toBe(1_000_000)
    expect(contextWindowFor('openai/gpt-6-luna')).toBe(1_000_000)
    expect(contextWindowFor('google/gemini-x')).toBe(1_000_000)
  })

  it('clause 2: a table-known non-reviewer model keeps its table window, so the override cannot raise past it (or lower it)', async () => {
    const { contextWindowFor } = await load(c => { c.anthropic.modelContextTokens = 1_000_000 })
    expect(contextWindowFor('anthropic/claude-haiku-4.5')).toBe(200_000)
    expect(contextWindowFor('claude-haiku-4-5-20251001')).toBe(200_000)
    const lowered = await load(c => { c.anthropic.modelContextTokens = 300_000 })
    expect(lowered.contextWindowFor('claude-sonnet-5')).toBe(1_000_000)
  })

  it('the override wins over a listed window for an unknown model', async () => {
    get.mockResolvedValue({ data: MODEL_LIST })
    const { resolveContextWindows, contextWindowFor, cfg } = await load(c => { c.anthropic.model = 'openai/gpt-6-luna' })
    await resolveContextWindows()
    expect(contextWindowFor('openai/gpt-6-luna')).toBe(1_050_000)
    cfg.anthropic.modelContextTokens = 500_000
    expect(contextWindowFor('openai/gpt-6-luna')).toBe(500_000)
  })
})
