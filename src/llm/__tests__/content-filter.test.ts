import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../config.js', () => ({
  config: {
    llmProvider: 'openrouter',
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', referer: '', title: '' },
    anthropic: { baseUrl: '', workspaceId: '' },
    repoSlug: '',
  },
}))

const { post, stream } = vi.hoisted(() => ({ post: vi.fn(), stream: vi.fn() }))
vi.mock('axios', () => ({ default: { post } }))
vi.mock('@anthropic-ai/sdk', () => {
  class BadRequestError extends Error {}
  class Anthropic {
    static BadRequestError = BadRequestError
    messages = { stream }
  }
  return { default: Anthropic }
})

import { createProvider, ContentFilterError } from '../provider.js'
import { config } from '../../config.js'

const cfg = config as unknown as { llmProvider: string }
const opts = { model: 'anthropic/claude-haiku-5-5', maxTokens: 1000, maxRetries: 3 }
const schema = { required: ['summary'], properties: {} } as Record<string, unknown>
const usage = { prompt_tokens: 412, completion_tokens: 0, cost: 0.0004 }
const SECRET = 'localStorage.getItem(token) // flagged customer code'

const choice = (c: Record<string, unknown>, u: unknown = usage) => ({ data: { choices: [{ message: { content: null }, finish_reason: 'stop', ...c }], usage: u } })
const catchError = async (p: Promise<unknown>): Promise<ContentFilterError> => {
  const err = await p.then(() => undefined, (e: unknown) => e)
  expect(err).toBeInstanceOf(ContentFilterError)
  return err as ContentFilterError
}
const axios403 = (error: unknown) => Object.assign(new Error('Request failed with status code 403'), { response: { status: 403, headers: {}, data: { error } } })

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  post.mockReset(); stream.mockReset()
  cfg.llmProvider = 'openrouter'
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('OpenRouter refusal signals', () => {
  it.each([
    ['native_finish_reason refusal', { native_finish_reason: 'refusal', finish_reason: 'content_filter' }, 'native_refusal'],
    ['finish_reason content_filter', { finish_reason: 'content_filter' }, 'content_filter'],
    ['a non-empty message.refusal', { message: { content: null, refusal: 'I cannot help with that.' } }, 'message_refusal'],
  ])('%s throws ContentFilterError with the signal, and the request usage attached', async (_n, c, signal) => {
    post.mockResolvedValue(choice(c))
    const err = await catchError(createProvider('k').completeStructured('s', 'u', schema, opts))
    expect(err.signal).toBe(signal)
    expect(err.usage).toMatchObject({ input_tokens: 412, output_tokens: 0, cost_usd: 0.0004 })
  })

  it('keeps the native finish reason and checks native refusal first', async () => {
    post.mockResolvedValue(choice({ native_finish_reason: 'refusal', finish_reason: 'content_filter', message: { content: null, refusal: 'no' } }))
    const err = await catchError(createProvider('k').complete('s', 'u', opts))
    expect(err).toMatchObject({ signal: 'native_refusal', nativeFinishReason: 'refusal' })
  })

  it('an empty refusal string is not a refusal', async () => {
    post.mockResolvedValue(choice({ message: { content: 'ok', refusal: '  ' } }))
    await expect(createProvider('k').complete('s', 'u', opts)).resolves.toMatchObject({ text: 'ok' })
  })

  it('empty content with zero completion tokens is only logged, never a filter', async () => {
    post.mockResolvedValue(choice({ message: { content: '' } }, { prompt_tokens: 5, completion_tokens: 0 }))
    const warn = vi.mocked(console.warn)
    const err = await createProvider('k').completeStructured('s', 'u', schema, opts).then(() => undefined, (e: unknown) => e)
    expect(err).not.toBeInstanceOf(ContentFilterError)
    expect(warn.mock.calls.flat().join('\n')).toContain('zero completion tokens')
  })

  it('logs one finish line per call', async () => {
    post.mockResolvedValue({ data: { choices: [{ message: { content: 'hi' }, finish_reason: 'stop', native_finish_reason: 'end_turn' }], usage: {} } })
    await createProvider('k').complete('s', 'u', opts)
    expect(log.mock.calls.flat()).toContain('  finish: stop (native: end_turn)')
  })

  it('never retries or resends a refusal, whatever the retry budget', async () => {
    post.mockResolvedValue(choice({ finish_reason: 'content_filter' }))
    await catchError(createProvider('k').completeStructured('s', 'u', schema, opts))
    expect(post).toHaveBeenCalledTimes(1)
    post.mockClear()
    post.mockResolvedValue(choice({ finish_reason: 'content_filter' }))
    await catchError(createProvider('k').complete('s', 'u', { ...opts, effort: 'high' }))
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('a refusal on the missing-field resend keeps the first attempt\'s usage and does not send a third request', async () => {
    const first = { data: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 } } }
    post.mockResolvedValueOnce(first).mockResolvedValueOnce(choice({ finish_reason: 'content_filter' }))
    const err = await catchError(createProvider('k').completeStructured('s', 'u', schema, opts))
    expect(post).toHaveBeenCalledTimes(2)
    expect(err.usage).toMatchObject({ input_tokens: 512, output_tokens: 10 })
  })
})

describe('OpenRouter moderation', () => {
  const meta = { reasons: ['harassment'], flagged_input: SECRET, provider_name: 'openai' }

  it('a 403 with moderation metadata is a refusal, sent once, and drops the flagged input', async () => {
    post.mockRejectedValue(axios403({ code: 403, message: 'Your input was flagged', metadata: meta }))
    const err = await catchError(createProvider('k').complete('s', 'u', opts))
    expect(post).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({ signal: 'moderation', httpStatus: 403, reasons: ['harassment'] })
    expect(JSON.stringify({ ...err, message: err.message, stack: err.stack })).not.toContain(SECRET)
  })

  it('flagged_input alone also counts, without reasons', async () => {
    post.mockRejectedValue(axios403({ code: 403, message: 'flagged', metadata: { flagged_input: SECRET } }))
    const err = await catchError(createProvider('k').complete('s', 'u', opts))
    expect(err.reasons).toBeUndefined()
  })

  it('a 403 without that metadata stays a plain error', async () => {
    post.mockRejectedValue(axios403({ code: 403, message: 'guardrail block', metadata: { provider_name: 'x' } }))
    const err = await createProvider('k').complete('s', 'u', opts).then(() => undefined, (e: unknown) => e)
    expect(err).not.toBeInstanceOf(ContentFilterError)
    expect(err).toMatchObject({ message: 'guardrail block', status: 403 })
    post.mockRejectedValue(axios403(undefined))
    expect(await createProvider('k').complete('s', 'u', opts).then(() => undefined, (e: unknown) => e)).not.toBeInstanceOf(ContentFilterError)
  })

  it('a 200 body with an error and no choices is a refusal when it carries the metadata', async () => {
    post.mockResolvedValue({ data: { error: { code: 403, message: 'flagged', metadata: meta }, usage: { prompt_tokens: 7, completion_tokens: 0 } } })
    const err = await catchError(createProvider('k').completeStructured('s', 'u', schema, opts))
    expect(post).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({ signal: 'moderation', httpStatus: 200 })
    expect(err.usage).toMatchObject({ input_tokens: 7 })
    expect(JSON.stringify(err.reasons)).not.toContain(SECRET)
  })

  it('a 200 error body without the metadata stays the existing error', async () => {
    post.mockResolvedValue({ data: { error: { code: 502, message: 'upstream down' } } })
    const err = await createProvider('k').complete('s', 'u', opts).then(() => undefined, (e: unknown) => e)
    expect(err).not.toBeInstanceOf(ContentFilterError)
    expect(err).toMatchObject({ message: 'upstream down', status: 502 })
  })
})

describe('empty complete() text', () => {
  it('throws instead of returning an empty reply, with the usage attached (OpenRouter)', async () => {
    post.mockResolvedValue({ data: { choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } } })
    await expect(createProvider('k').complete('s', 'u', opts)).rejects.toMatchObject({ message: 'Model returned empty text', usage: { input_tokens: 9 } })
  })

  it('throws instead of returning an empty reply (Anthropic)', async () => {
    cfg.llmProvider = 'anthropic'
    stream.mockReturnValue({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '  ' }], usage: { input_tokens: 1, output_tokens: 1 } }) })
    await expect(createProvider('k').complete('s', 'u', opts)).rejects.toThrow('Model returned empty text')
  })
})

describe('Anthropic refusal', () => {
  beforeEach(() => { cfg.llmProvider = 'anthropic' })
  const refused = (details: unknown) => stream.mockReturnValue({
    finalMessage: async () => ({ stop_reason: 'refusal', stop_details: details, content: [], usage: { input_tokens: 412, output_tokens: 0 } }),
  })

  it('stop_reason refusal throws ContentFilterError with the category and usage, structured and plain', async () => {
    refused({ type: 'refusal', category: 'cyber', explanation: 'x' })
    const err = await catchError(createProvider('k').completeStructured('s', 'u', schema, opts))
    expect(err).toMatchObject({ signal: 'native_refusal', nativeFinishReason: 'refusal', category: 'cyber' })
    expect(err.usage).toMatchObject({ input_tokens: 412, output_tokens: 0 })
    await catchError(createProvider('k').complete('s', 'u', opts))
  })

  it('a null category is omitted, and the call is never repeated', async () => {
    refused({ type: 'refusal', category: null, explanation: null })
    const err = await catchError(createProvider('k').completeStructured('s', 'u', schema, { ...opts, effort: 'high' }))
    expect(err.category).toBeUndefined()
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('logs the stop reason once per call', async () => {
    stream.mockReturnValue({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } }) })
    await createProvider('k').complete('s', 'u', opts)
    expect(log.mock.calls.flat()).toContain('  finish: end_turn')
  })
})

describe('Anthropic refusal billing', () => {
  beforeEach(() => { cfg.llmProvider = 'anthropic' })
  const refusedWith = (category: string | null, output: number) => stream.mockReturnValue({
    finalMessage: async () => ({ stop_reason: 'refusal', stop_details: { type: 'refusal', category, explanation: null }, content: [], usage: { input_tokens: 412, output_tokens: output } }),
  })

  it.each(['cyber', 'general_harms', null])('a no-output refusal in category %s is priced at zero', async category => {
    refusedWith(category, 0)
    const err = await catchError(createProvider('k').complete('s', 'u', opts))
    expect(err.usage).toMatchObject({ input_tokens: 412, cost_usd: 0 })
  })

  it.each(['bio', 'frontier_llm', 'reasoning_extraction'])('a no-output refusal in the billed category %s keeps the table price', async category => {
    refusedWith(category, 0)
    const err = await catchError(createProvider('k').complete('s', 'u', opts))
    expect(err.usage?.cost_usd).toBeUndefined()
  })

  it('a refusal after partial output is billed whatever its category', async () => {
    refusedWith('cyber', 25)
    const err = await catchError(createProvider('k').complete('s', 'u', opts))
    expect(err.usage?.cost_usd).toBeUndefined()
  })
})
