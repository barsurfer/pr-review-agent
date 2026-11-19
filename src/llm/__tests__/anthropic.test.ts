import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../config.js', () => ({ config: { llmProvider: 'anthropic', anthropic: { baseUrl: '', workspaceId: '' } } }))

const { stream } = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => {
  class BadRequestError extends Error {}
  class Anthropic {
    static BadRequestError = BadRequestError
    messages = { stream }
  }
  return { default: Anthropic }
})

import { createProvider, isSystemMessageRejection } from '../provider.js'

const opts = { model: 'claude-sonnet-5', maxTokens: 1000, maxRetries: 2 }
const withUsage = (usage: unknown) => stream.mockReturnValue({
  finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage }),
})
const answer = (object: unknown) => stream.mockReturnValue({
  finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(object) }], usage: { input_tokens: 1, output_tokens: 1 } }),
})

beforeEach(() => { stream.mockReset() })

describe('AnthropicProvider.completeStructured tolerateMissing', () => {
  const schema = {
    required: ['verdict', 'lens_recommendations'],
    properties: { lens_recommendations: { items: { required: ['lens', 'reason'] } } },
  } as Record<string, unknown>
  const tolerant = { ...opts, tolerateMissing: ['lens_recommendations'] }

  it('does not throw when a tolerated root key is omitted or one of its items drops a required key', async () => {
    answer({ verdict: 'ok' })
    await expect(createProvider('k').completeStructured('s', 'u', schema, tolerant)).resolves.toMatchObject({ object: { verdict: 'ok' } })
    answer({ verdict: 'ok', lens_recommendations: [{ lens: 'security' }] })
    await expect(createProvider('k').completeStructured('s', 'u', schema, tolerant)).resolves.toMatchObject({ object: { lens_recommendations: [{ lens: 'security' }] } })
  })

  it('still throws on the omitted root key when it is not tolerated', async () => {
    answer({ verdict: 'ok' })
    await expect(createProvider('k').completeStructured('s', 'u', schema, opts)).rejects.toThrow(/missing required field\(s\): lens_recommendations$/)
  })

  it('still enforces every other required key, and never sends the option to the SDK', async () => {
    answer({ lens_recommendations: [] })
    await expect(createProvider('k').completeStructured('s', 'u', schema, tolerant)).rejects.toThrow(/missing required field\(s\): verdict$/)
    expect(JSON.stringify(stream.mock.calls[0])).not.toContain('tolerate')
  })
})

describe('AnthropicProvider usage reasoning_tokens', () => {
  it('maps output_tokens_details.thinking_tokens only when positive', async () => {
    withUsage({ input_tokens: 1, output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } })
    expect((await createProvider('k').complete('s', 'u', opts)).usage.reasoning_tokens).toBe(4)
    for (const details of [null, undefined, { thinking_tokens: 0 }]) {
      withUsage({ input_tokens: 1, output_tokens: 9, output_tokens_details: details })
      expect('reasoning_tokens' in (await createProvider('k').complete('s', 'u', opts)).usage).toBe(false)
    }
  })
})

describe('AnthropicProvider request options', () => {
  it('without a signal the SDK gets exactly { maxRetries }; with one, the signal is added', async () => {
    answer({ verdict: 'ok' })
    await createProvider('k').completeStructured('s', 'u', { required: [] }, opts)
    expect(stream.mock.calls[0][1]).toStrictEqual({ maxRetries: 2 })

    const signal = new AbortController().signal
    answer({ verdict: 'ok' })
    await createProvider('k').completeStructured('s', 'u', { required: [] }, { ...opts, signal })
    expect(stream.mock.calls[1][1]).toStrictEqual({ maxRetries: 2, signal })
  })
})

describe('AnthropicProvider prompt-cache request shape', () => {
  const schema = { required: [] } as Record<string, unknown>

  it('a string user with no new options sends exactly the previous params', async () => {
    answer({})
    await createProvider('k').completeStructured('s', 'u', schema, opts)
    expect(stream.mock.calls[0][0]).toStrictEqual({ model: 'claude-sonnet-5', max_tokens: 1000, system: 's', output_config: { format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content: 'u' }] })
  })

  it('parts become text blocks with cache_control on the cached one, systemAfter a trailing system message, and sessionId is never sent', async () => {
    answer({})
    await createProvider('k').completeStructured('s', [{ text: 'U', cache: true }, { text: 'B' }], schema, { ...opts, systemAfter: 'O', sessionId: 'sess' })
    expect(stream.mock.calls[0][0]).toStrictEqual({
      model: 'claude-sonnet-5', max_tokens: 1000, system: 's', output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'U', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'B' }] }, { role: 'system', content: 'O' }],
    })
    expect(JSON.stringify(stream.mock.calls[0])).not.toContain('sess')
  })

  it('maps cache reads and writes, input_tokens staying the uncached rest', async () => {
    stream.mockReturnValue({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 1000, output_tokens: 5, cache_read_input_tokens: 99000, cache_creation_input_tokens: 0 } }) })
    const { usage } = await createProvider('k').completeStructured('s', [{ text: 'U', cache: true }], schema, opts)
    expect(usage).toEqual({ input_tokens: 1000, output_tokens: 5, cache_read_input_tokens: 99000, cache_creation_input_tokens: 0 })
  })

  it('a rejected trailing system message is not retried without effort; it surfaces once for the caller to re-send uncached', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const rejection = Object.assign(new (Anthropic as any).BadRequestError("400 role 'system' is not supported"), { status: 400 })
    stream.mockReturnValue({ finalMessage: async () => { throw rejection } })
    const err = await createProvider('k').completeStructured('s', [{ text: 'U', cache: true }], schema, { ...opts, effort: 'high', systemAfter: 'O' }).catch(e => e)
    expect(err).toBe(rejection)
    expect(isSystemMessageRejection(err)).toBe(true)
    expect(stream).toHaveBeenCalledTimes(1)
  })

  it('without systemAfter the same 400 still takes the effort retry, as before', async () => {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const rejection = Object.assign(new (Anthropic as any).BadRequestError("400 role 'system' is not supported"), { status: 400 })
    stream.mockReturnValueOnce({ finalMessage: async () => { throw rejection } })
    answer({})
    await createProvider('k').completeStructured('s', 'u', schema, { ...opts, effort: 'high' })
    expect(stream).toHaveBeenCalledTimes(2)
  })
})
