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

import { createProvider, TruncatedResponseError } from '../provider.js'
import { isContextLengthError } from '../../review/parsers.js'
import { config } from '../../config.js'

const opts = { model: 'openai/gpt-x', maxTokens: 1000, maxRetries: 2 }
const resp = (data: unknown) => ({ data })
const okText = (content: unknown, usage: unknown) => resp({ choices: [{ message: { content }, finish_reason: 'stop' }], usage })

beforeEach(() => { post.mockReset() })

describe('OpenRouterProvider attribution headers', () => {
  const or = (config as unknown as { openrouter: { referer: string; title: string } }).openrouter
  afterEach(() => { or.referer = ''; or.title = '' })
  const headersOf = () => (post.mock.calls[0][2] as { headers: Record<string, string> }).headers

  it('sends HTTP-Referer and the current X-OpenRouter-Title header when set', async () => {
    or.referer = 'https://app.example'; or.title = 'my-app'
    post.mockResolvedValue(okText('hi', {}))
    await createProvider('k').complete('s', 'u', opts)
    expect(headersOf()['HTTP-Referer']).toBe('https://app.example')
    expect(headersOf()['X-OpenRouter-Title']).toBe('my-app')
    expect(headersOf()['X-Title']).toBeUndefined()
  })

  it('omits attribution headers when unset (opt-out)', async () => {
    post.mockResolvedValue(okText('hi', {}))
    await createProvider('k').complete('s', 'u', opts)
    expect(headersOf()['HTTP-Referer']).toBeUndefined()
    expect(headersOf()['X-OpenRouter-Title']).toBeUndefined()
  })

  it('sends the repo slug as the `user` body field when set, omits it otherwise', async () => {
    const cfg = config as unknown as { repoSlug: string }
    post.mockResolvedValue(okText('hi', {}))
    await createProvider('k').complete('s', 'u', opts)
    expect((post.mock.calls[0][1] as { user?: string }).user).toBeUndefined()
    post.mockReset()
    cfg.repoSlug = 'alice-platform'
    post.mockResolvedValue(okText('hi', {}))
    await createProvider('k').complete('s', 'u', opts)
    expect((post.mock.calls[0][1] as { user?: string }).user).toBe('alice-platform')
    cfg.repoSlug = ''
  })
})

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

  describe('tolerateMissing', () => {
    const recSchema = {
      required: ['verdict', 'lens_recommendations'],
      properties: { lens_recommendations: { items: { required: ['lens', 'reason'] } } },
    } as Record<string, unknown>
    const tolerant = { ...opts, tolerateMissing: ['lens_recommendations'] }
    const answer = (object: unknown) => post.mockResolvedValue(okText(JSON.stringify(object), {}))

    it('does not throw when a tolerated root key is omitted or one of its items drops a required key', async () => {
      answer({ verdict: 'ok' })
      await expect(createProvider('k').completeStructured('s', 'u', recSchema, tolerant)).resolves.toMatchObject({ object: { verdict: 'ok' } })
      answer({ verdict: 'ok', lens_recommendations: [{ lens: 'security' }] })
      await expect(createProvider('k').completeStructured('s', 'u', recSchema, tolerant)).resolves.toMatchObject({ object: { lens_recommendations: [{ lens: 'security' }] } })
    })

    it('still throws for both when the key is not tolerated', async () => {
      answer({ verdict: 'ok' })
      await expect(createProvider('k').completeStructured('s', 'u', recSchema, opts)).rejects.toThrow(/missing required field\(s\): lens_recommendations$/)
      answer({ verdict: 'ok', lens_recommendations: [{ lens: 'security' }] })
      await expect(createProvider('k').completeStructured('s', 'u', recSchema, opts)).rejects.toThrow(/lens_recommendations\[0\]\.reason/)
    })

    it('still enforces every other required key, and never sends the option upstream', async () => {
      answer({ lens_recommendations: [] })
      await expect(createProvider('k').completeStructured('s', 'u', recSchema, tolerant)).rejects.toThrow(/missing required field\(s\): verdict$/)
      expect(JSON.stringify(post.mock.calls[0][1])).not.toContain('tolerate')
    })
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

describe('OpenRouterProvider effort', () => {
  const schema = { required: ['verdict'] } as Record<string, unknown>
  const bodyOf = (i = 0) => post.mock.calls[i][1] as Record<string, unknown>
  const plainBody = '{"model":"openai/gpt-x","max_tokens":1000,"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}],"usage":{"include":true}}'
  const structuredBody = '{"model":"openai/gpt-x","max_tokens":1000,"response_format":{"type":"json_schema","json_schema":{"name":"result","schema":{"required":["verdict"]},"strict":false}},"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"}],"usage":{"include":true}}'
  const invalidEffort = { response: { status: 400, data: { error: { message: 'reasoning.effort: Invalid option: expected one of "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none"', code: 400 } } } }
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore() })

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('sends reasoning.effort %s on complete and completeStructured', async effort => {
    post.mockResolvedValue(okText(JSON.stringify({ verdict: 'ok' }), {}))
    await createProvider('k').complete('s', 'u', { ...opts, effort })
    await createProvider('k').completeStructured('s', 'u', schema, { ...opts, effort })
    expect(bodyOf(0).reasoning).toEqual({ effort })
    expect(bodyOf(1).reasoning).toEqual({ effort })
    expect(JSON.stringify(bodyOf(0))).toBe(`${plainBody.slice(0, -1)},"reasoning":{"effort":"${effort}"}}`)
    expect(JSON.stringify(bodyOf(1))).toBe(`${structuredBody.slice(0, -1)},"reasoning":{"effort":"${effort}"}}`)
  })

  it.each([['unset', {}], ['undefined', { effort: undefined }], ['empty', { effort: '' }]])('sends the pre-effort body byte for byte when effort is %s', async (_label, extra) => {
    post.mockResolvedValue(okText(JSON.stringify({ verdict: 'ok' }), {}))
    await createProvider('k').complete('s', 'u', { ...opts, ...extra })
    await createProvider('k').completeStructured('s', 'u', schema, { ...opts, ...extra })
    expect(post).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(bodyOf(0))).toBe(plainBody)
    expect(JSON.stringify(bodyOf(1))).toBe(structuredBody)
    expect(warn).not.toHaveBeenCalled()
  })

  it('appends reasoning after the user field when a repo slug is set', async () => {
    const cfg = config as unknown as { repoSlug: string }
    cfg.repoSlug = 'alice-platform'
    post.mockResolvedValue(okText('hi', {}))
    await createProvider('k').complete('s', 'u', opts)
    await createProvider('k').complete('s', 'u', { ...opts, effort: 'high' })
    cfg.repoSlug = ''
    expect(JSON.stringify(bodyOf(0))).toBe(`${plainBody.slice(0, -1)},"user":"alice-platform"}`)
    expect(JSON.stringify(bodyOf(1))).toBe(`${plainBody.slice(0, -1)},"user":"alice-platform","reasoning":{"effort":"high"}}`)
  })

  it('retries once without reasoning on the observed 400 invalid-effort rejection, warning once', async () => {
    post.mockRejectedValueOnce(invalidEffort).mockResolvedValueOnce(okText(JSON.stringify({ verdict: 'ok' }), {}))
    const r = await createProvider('k').completeStructured('s', 'u', schema, { ...opts, effort: 'bogus' })
    expect(r.object).toEqual({ verdict: 'ok' })
    expect(post).toHaveBeenCalledTimes(2)
    expect(bodyOf(0).reasoning).toEqual({ effort: 'bogus' })
    expect(JSON.stringify(bodyOf(1))).toBe(structuredBody)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('  effort "bogus" not accepted by openai/gpt-x — retrying without it')
  })

  it('retries without reasoning on an HTTP-200 body rejection ("Reasoning is mandatory")', async () => {
    post.mockResolvedValueOnce(resp({ error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled.', code: 400 } }))
      .mockResolvedValueOnce(okText('ok', {}))
    const r = await createProvider('k').complete('s', 'u', { ...opts, effort: 'none' })
    expect(r.text).toBe('ok')
    expect(post).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(bodyOf(1))).toBe(plainBody)
  })

  it('retries only once: a second rejection is thrown', async () => {
    post.mockRejectedValue(invalidEffort)
    const err = await createProvider('k').complete('s', 'u', { ...opts, effort: 'bogus' }).catch(e => e)
    expect(err.status).toBe(400)
    expect(err.message).toMatch(/reasoning\.effort/)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['context overflow 400', { response: { status: 400, data: { error: { message: "This model's maximum context length is 8192 tokens" } } } }],
    ['overflow 400 that mentions reasoning', { response: { status: 400, data: { error: { message: 'input is too long for requested reasoning' } } } }],
    ['unrelated 400', { response: { status: 400, data: { error: { message: 'Invalid schema for response_format' } } } }],
    ['unrelated 400 that mentions reasoning', { response: { status: 400, data: { error: { message: 'This provider does not support reasoning with tools' } } } }],
    ['401 mentioning reasoning', { response: { status: 401, data: { error: { message: 'reasoning not allowed for this key' } } } }],
    ['402', { response: { status: 402, data: { error: { message: 'Insufficient credits' } } } }],
    ['422', { response: { status: 422, data: { error: { message: 'reasoning.effort: unprocessable' } } } }],
    ['timeout', { code: 'ECONNABORTED', message: 'timeout of 600000ms exceeded' }],
  ])('does not retry without effort on a %s', async (_label, failure) => {
    post.mockRejectedValue(failure)
    await expect(createProvider('k').complete('s', 'u', { ...opts, effort: 'high' })).rejects.toThrow()
    expect(post).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the context-overflow degrade signal when effort is set', async () => {
    post.mockRejectedValue({ response: { status: 400, data: { error: { message: "This model's maximum context length is 8192 tokens" } } } })
    const err = await createProvider('k').complete('s', 'u', { ...opts, effort: 'high' }).catch(e => e)
    expect(isContextLengthError(err)).toBe(true)
  })

  it('does not retry a reasoning rejection when no effort was sent', async () => {
    post.mockRejectedValue(invalidEffort)
    await expect(createProvider('k').complete('s', 'u', opts)).rejects.toThrow(/reasoning\.effort/)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('keeps reasoning on transient 5xx retries', async () => {
    vi.useFakeTimers()
    post.mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValueOnce(okText('ok', {}))
    const p = createProvider('k').complete('s', 'u', { ...opts, effort: 'high' })
    await vi.runAllTimersAsync()
    await p
    vi.useRealTimers()
    expect(post).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).reasoning).toEqual({ effort: 'high' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('maps usage with reasoning tokens: output_tokens is completion_tokens, cost_usd the provider total', async () => {
    const reasoningUsage = { prompt_tokens: 306, completion_tokens: 418, completion_tokens_details: { reasoning_tokens: 312 }, prompt_tokens_details: { cached_tokens: 0 } }
    post.mockResolvedValueOnce(okText('a', { ...reasoningUsage, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0002396 } }))
      .mockResolvedValueOnce(okText('b', { ...reasoningUsage, cost: 0.0002396 }))
    const byok = await createProvider('k').complete('s', 'u', { ...opts, effort: 'high' })
    const credits = await createProvider('k').complete('s', 'u', { ...opts, effort: 'high' })
    const expected = { input_tokens: 306, output_tokens: 418, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.0002396, reasoning_tokens: 312 }
    expect(byok.usage).toEqual(expected)
    expect(credits.usage).toEqual(expected)
  })

  describe('reasoning_tokens on usage', () => {
    const withDetails = (d: unknown) => okText('a', { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: d })
    const reasoningOf = async (d: unknown) => {
      post.mockResolvedValueOnce(withDetails(d))
      return (await createProvider('k').complete('s', 'u', opts)).usage
    }

    it('is set when reported above zero and leaves output_tokens as completion_tokens', async () => {
      const usage = await reasoningOf({ reasoning_tokens: 7 })
      expect(usage.reasoning_tokens).toBe(7)
      expect(usage.output_tokens).toBe(20)
    })

    it.each([['missing details', undefined], ['missing field', {}], ['zero', { reasoning_tokens: 0 }], ['non-number', { reasoning_tokens: '9' }]])('is absent for %s', async (_l, d) => {
      expect('reasoning_tokens' in await reasoningOf(d)).toBe(false)
    })

    it('sums across the structured resend, including when the resend itself fails', async () => {
      const schema = { required: ['verdict'] }
      const partial = (r: number) => okText(JSON.stringify({}), { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: r } })
      post.mockResolvedValueOnce(partial(5)).mockResolvedValueOnce(okText(JSON.stringify({ verdict: 'ok' }), { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 8 } }))
      const ok = await createProvider('k').completeStructured('s', 'u', schema, opts)
      expect(ok.usage.reasoning_tokens).toBe(13)
      expect(ok.usage.output_tokens).toBe(40)

      post.mockResolvedValueOnce(partial(5)).mockResolvedValueOnce(partial(6))
      const err = await createProvider('k').completeStructured('s', 'u', schema, opts).catch((e: unknown) => e as { usage: { reasoning_tokens?: number } })
      expect((err as { usage: { reasoning_tokens?: number } }).usage.reasoning_tokens).toBe(11)
    })
  })

  describe('structured output with reasoning content in the message', () => {
    const withReasoning = (content: unknown, finish = 'stop') => resp({
      choices: [{
        message: {
          role: 'assistant', content, refusal: null,
          reasoning: '{"verdict":"from-reasoning"} counting the cases first',
          reasoning_details: [{ type: 'reasoning.text', text: '{"verdict":"from-reasoning"}', format: 'anthropic-claude-v1', index: 0 }],
        },
        finish_reason: finish,
      }],
      usage: { prompt_tokens: 306, completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 290 } },
    })

    it('parses message.content only, never the reasoning text', async () => {
      post.mockResolvedValue(withReasoning(JSON.stringify({ verdict: 'ok' })))
      const r = await createProvider('k').completeStructured('s', 'u', schema, { ...opts, effort: 'high' })
      expect(r.object).toEqual({ verdict: 'ok' })
      expect(r.usage.output_tokens).toBe(400)
    })

    it('still throws on a missing required key when only the reasoning has it', async () => {
      post.mockResolvedValue(withReasoning(JSON.stringify({ other: 1 })))
      await expect(createProvider('k').completeStructured('s', 'u', schema, { ...opts, effort: 'high' })).rejects.toThrow(/missing required field\(s\): verdict$/)
    })

    it('throws TruncatedResponseError with reasoning-inclusive usage when reasoning eats max_tokens', async () => {
      post.mockResolvedValue(withReasoning('{"verdict": "o', 'length'))
      const err = await createProvider('k').completeStructured('s', 'u', schema, { ...opts, effort: 'high' }).catch(e => e)
      expect(err).toBeInstanceOf(TruncatedResponseError)
      expect((err as TruncatedResponseError).usage.output_tokens).toBe(400)
    })
  })
})
