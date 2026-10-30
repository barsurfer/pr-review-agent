import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../config.js', () => ({
  config: {
    llmProvider: 'openrouter',
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', referer: '', title: '' },
    anthropic: { baseUrl: '', workspaceId: '' },
  },
}))

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('axios', () => ({ default: { post } }))

import { createProvider, TruncatedResponseError } from '../provider.js'
import { isContextLengthError } from '../../review/parsers.js'

const opts = { model: 'openai/gpt-x', maxTokens: 1000, maxRetries: 2 }
const resp = (data: unknown) => ({ data })
const okText = (content: unknown, usage: unknown) => resp({ choices: [{ message: { content }, finish_reason: 'stop' }], usage })

beforeEach(() => { post.mockReset() })

describe('OpenRouterProvider.complete', () => {
  it('returns text, maps usage incl. cost_usd, and requests usage.include + system/user roles', async () => {
    post.mockResolvedValue(okText('hello', { prompt_tokens: 100, completion_tokens: 20, cost: 0.01, prompt_tokens_details: { cached_tokens: 10 } }))
    const r = await createProvider('k').complete('sys', 'usr', opts)
    expect(r.text).toBe('hello')
    expect(r.usage).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, cost_usd: 0.01 })
    const body = post.mock.calls[0][1] as Record<string, unknown>
    expect(body.messages).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }])
    expect(body.usage).toEqual({ include: true })
  })

  it('omits cost_usd when the gateway reports no cost', async () => {
    post.mockResolvedValue(okText('hi', { prompt_tokens: 1, completion_tokens: 1 }))
    const r = await createProvider('k').complete('s', 'u', opts)
    expect(r.usage.cost_usd).toBeUndefined()
  })

  it('falls back to cost_details.upstream_inference_cost when cost is 0 (BYOK key)', async () => {
    post.mockResolvedValue(okText('hi', { prompt_tokens: 1, completion_tokens: 1, cost: 0, cost_details: { upstream_inference_cost: 0.0000118 } }))
    const r = await createProvider('k').complete('s', 'u', opts)
    expect(r.usage.cost_usd).toBe(0.0000118)
  })

  it('throws TruncatedResponseError carrying usage on finish_reason length', async () => {
    post.mockResolvedValue(resp({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 1000 } }))
    const err = await createProvider('k').complete('s', 'u', opts).catch(e => e)
    expect(err).toBeInstanceOf(TruncatedResponseError)
    expect((err as TruncatedResponseError).usage.output_tokens).toBe(1000)
  })

  it('throws on null content (refusal / non-text finish)', async () => {
    post.mockResolvedValue(resp({ choices: [{ message: { content: null }, finish_reason: 'stop' }], usage: {} }))
    await expect(createProvider('k').complete('s', 'u', opts)).rejects.toThrow(/no text content/)
  })

  it('throws on an HTTP-200 body error without retrying', async () => {
    post.mockResolvedValue(resp({ error: { message: 'rate limited upstream', code: 429 } }))
    await expect(createProvider('k').complete('s', 'u', opts)).rejects.toThrow(/rate limited upstream/)
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('OpenRouterProvider.completeStructured', () => {
  const schema = { required: ['verdict'] } as Record<string, unknown>

  it('parses the object and sends response_format json_schema (strict:false)', async () => {
    post.mockResolvedValue(okText(JSON.stringify({ verdict: 'ok' }), { prompt_tokens: 1, completion_tokens: 1 }))
    const r = await createProvider('k').completeStructured('s', 'u', schema, opts)
    expect(r.object).toEqual({ verdict: 'ok' })
    const body = post.mock.calls[0][1] as Record<string, unknown>
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'result', schema, strict: false } })
  })

  it('throws on invalid JSON', async () => {
    post.mockResolvedValue(okText('not json', {}))
    await expect(createProvider('k').completeStructured('s', 'u', schema, opts)).rejects.toThrow(/invalid JSON/)
  })

  it('throws on a missing required key', async () => {
    post.mockResolvedValue(okText(JSON.stringify({ other: 1 }), {}))
    await expect(createProvider('k').completeStructured('s', 'u', schema, opts)).rejects.toThrow(/missing required field/)
  })
})

describe('OpenRouterProvider error normalization', () => {
  it('surfaces a context-overflow 400 as an error isContextLengthError recognizes', async () => {
    post.mockRejectedValue({ response: { status: 400, data: { error: { message: "This model's maximum context length is 8192 tokens" } } } })
    const err = await createProvider('k').complete('s', 'u', { ...opts, maxRetries: 0 }).catch(e => e)
    expect(err.status).toBe(400)
    expect(isContextLengthError(err)).toBe(true)
  })

  it('retries a 503', async () => {
    vi.useFakeTimers()
    post.mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValueOnce(okText('ok', {}))
    const p = createProvider('k').complete('s', 'u', opts)
    await vi.runAllTimersAsync()
    await p
    expect(post).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('detects overflow from a string error.code even when the message is generic', async () => {
    post.mockResolvedValue(resp({ error: { message: 'Request failed', code: 'context_length_exceeded' } }))
    const err = await createProvider('k').complete('s', 'u', { ...opts, maxRetries: 0 }).catch(e => e)
    expect(err.status).toBe(400)
    expect(isContextLengthError(err)).toBe(true)
  })

  it('matches non-OpenAI overflow phrasings so the degrade backstop fires', async () => {
    post.mockRejectedValue({ response: { status: 400, data: { error: { message: 'The input token count 2000000 exceeds the maximum number of tokens allowed' } } } })
    const err = await createProvider('k').complete('s', 'u', { ...opts, maxRetries: 0 }).catch(e => e)
    expect(err.status).toBe(400)
    expect(isContextLengthError(err)).toBe(true)
  })

  it('does not retry a timeout — it may have already billed upstream', async () => {
    post.mockRejectedValue({ code: 'ECONNABORTED', message: 'timeout of 600000ms exceeded' })
    await expect(createProvider('k').complete('s', 'u', opts)).rejects.toThrow()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('retries a connection error that never reached the server', async () => {
    vi.useFakeTimers()
    post.mockRejectedValueOnce({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }).mockResolvedValueOnce(okText('ok', {}))
    const p = createProvider('k').complete('s', 'u', opts)
    await vi.runAllTimersAsync()
    await p
    expect(post).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
