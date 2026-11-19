import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../config.js', () => ({
  config: {
    llmProvider: 'openrouter',
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', referer: '', title: '' },
    anthropic: { baseUrl: '', workspaceId: '' },
    repoSlug: '',
  },
}))

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('axios', () => ({ default: { post } }))

import { createProvider, DeadlineAbortError } from '../provider.js'
import { config } from '../../config.js'

const cfg = config as any
const opts = { model: 'anthropic/claude-haiku-5.5', maxTokens: 1000, maxRetries: 3 }
const okJson = (object: unknown) => ({ data: { choices: [{ message: { content: JSON.stringify(object) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } })
const http429 = (retryAfter: string) => Object.assign(new Error('Request failed with status code 429'), { response: { status: 429, headers: { 'retry-after': retryAfter }, data: { error: { message: 'rate limited' } } } })
const schema = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { required: ['severity'] } }, first_pass_sites: { type: 'array', items: { required: ['id', 'file', 'lines', 'where'] } } } }

beforeEach(() => { post.mockReset(); cfg.llmProvider = 'openrouter' })
afterEach(() => { vi.useRealTimers() })

describe('OpenRouter pass deadline', () => {
  it('without a signal the axios config is exactly the old one', async () => {
    post.mockResolvedValue(okJson({ findings: [] }))
    await createProvider('k').completeStructured('s', 'u', schema, opts)
    expect(Object.keys(post.mock.calls[0][2])).toEqual(['headers', 'timeout'])
  })

  it('an abort during a long Retry-After backoff ends the call at the deadline, with no second attempt', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10_000)
    post.mockRejectedValueOnce(http429('300')).mockResolvedValue(okJson({ findings: [] }))

    const call = createProvider('k').completeStructured('s', 'u', schema, { ...opts, signal: controller.signal })
    const settled = expect(call).rejects.toBeInstanceOf(DeadlineAbortError)
    await vi.advanceTimersByTimeAsync(10_000)
    await settled

    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][2].signal).toBe(controller.signal)
  })

  it('a request cancelled by the signal is not retried even though it has no response', async () => {
    const controller = new AbortController()
    post.mockImplementationOnce(async () => { controller.abort(); throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }) })

    await expect(createProvider('k').completeStructured('s', 'u', schema, { ...opts, signal: controller.signal })).rejects.toBeInstanceOf(DeadlineAbortError)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('an already-aborted signal sends nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(createProvider('k').completeStructured('s', 'u', schema, { ...opts, signal: controller.signal })).rejects.toBeInstanceOf(DeadlineAbortError)
    expect(post).not.toHaveBeenCalled()
  })

  it('a malformed first_pass_sites entry is tolerated in one request; untolerated it would cost a resend', async () => {
    const malformed = { findings: [], first_pass_sites: [{ id: 'c0', file: 'b.ts', lines: '20' }] }
    post.mockResolvedValue(okJson(malformed))
    await expect(createProvider('k').completeStructured('s', 'u', schema, { ...opts, tolerateMissing: ['first_pass_sites'] })).resolves.toMatchObject({ object: malformed })
    expect(post).toHaveBeenCalledTimes(1)

    post.mockClear()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(createProvider('k').completeStructured('s', 'u', schema, opts)).rejects.toThrow(/first_pass_sites\[0\]\.where/)
    expect(post).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('Anthropic pass deadline (real SDK, stubbed fetch)', () => {
  beforeEach(() => { cfg.llmProvider = 'anthropic' })
  afterEach(() => { vi.unstubAllGlobals() })

  it('an abort during the SDK retry backoff after a 429 with Retry-After ends the call, with no second request', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: 429, headers: { 'retry-after': '300', 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const started = Date.now()

    await expect(createProvider('k').completeStructured('s', 'u', schema, { ...opts, model: 'claude-haiku-5-5', signal: controller.signal })).rejects.toBeInstanceOf(DeadlineAbortError)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('an abort while the request is in flight surfaces as DeadlineAbortError', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })))
    })))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    await expect(createProvider('k').completeStructured('s', 'u', schema, { ...opts, model: 'claude-haiku-5-5', signal: controller.signal })).rejects.toBeInstanceOf(DeadlineAbortError)
  })
})
