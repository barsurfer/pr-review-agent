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

import { createProvider, TruncatedResponseError } from '../provider.js'
import { config } from '../../config.js'

const cfg = config as unknown as { llmProvider: string }
const opts = { model: 'openai/gpt-5-nano', maxTokens: 1000, maxRetries: 0 }
const schema = {
  required: ['decisions', 'summary'],
  properties: { decisions: { items: { required: ['candidate_id', 'note', 'score'] } } },
} as Record<string, unknown>

const complete = { decisions: [{ candidate_id: 'c0', note: 'n', score: 7 }], summary: 's' }
const dropped = { decisions: [{ candidate_id: 'c0' }], summary: 's' }
const usageA = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 4 }, cost: 0.001 }
const usageB = { prompt_tokens: 200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 6 }, cost: 0.002 }
const reply = (object: unknown, usage: unknown, finish = 'stop') => ({ data: { choices: [{ message: { content: typeof object === 'string' ? object : JSON.stringify(object) }, finish_reason: finish }], usage } })
const summed = { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, cost_usd: 0.003 }
const firstOnly = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, cost_usd: 0.001 }

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  post.mockReset(); stream.mockReset()
  cfg.llmProvider = 'openrouter'
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { warn.mockRestore() })

describe('OpenRouter structured output: one resend on a missing required field', () => {
  it('a well-formed response is one request and no warning', async () => {
    post.mockResolvedValueOnce(reply(complete, usageA))
    const r = await createProvider('k').completeStructured('s', 'u', schema, opts)
    expect(r.object).toEqual(complete)
    expect(r.usage).toEqual(firstOnly)
    expect(post).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('resends the identical request once and sums both usages when the resend is complete', async () => {
    post.mockResolvedValueOnce(reply(dropped, usageA)).mockResolvedValueOnce(reply(complete, usageB))
    const r = await createProvider('k').completeStructured('s', 'u', schema, { ...opts, effort: 'high' })
    expect(r.object).toEqual(complete)
    expect(r.usage).toEqual(summed)
    expect(post).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(post.mock.calls[1])).toBe(JSON.stringify(post.mock.calls[0]))
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('  Structured output from openai/gpt-5-nano missing decisions[0].note, decisions[0].score — retrying once')
  })

  it('throws the same error as before, carrying both usages, when the resend drops a field too', async () => {
    post.mockResolvedValueOnce(reply(dropped, usageA)).mockResolvedValueOnce(reply({ decisions: [{ candidate_id: 'c0', note: 'n' }], summary: 's' }, usageB))
    const err = await createProvider('k').completeStructured('s', 'u', schema, opts).catch(e => e)
    expect(err.message).toBe('Structured output missing required field(s): decisions[0].score')
    expect(err.usage).toEqual(summed)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('a resend that fails another way still reports the first attempt\'s usage', async () => {
    post.mockResolvedValueOnce(reply(dropped, usageA)).mockResolvedValueOnce(reply('cut', usageB, 'length'))
    const truncated = await createProvider('k').completeStructured('s', 'u', schema, opts).catch(e => e)
    expect(truncated).toBeInstanceOf(TruncatedResponseError)
    expect(truncated.usage).toEqual(summed)

    post.mockReset().mockResolvedValueOnce(reply(dropped, usageA)).mockResolvedValueOnce(reply('not json', usageB))
    const invalid = await createProvider('k').completeStructured('s', 'u', schema, opts).catch(e => e)
    expect(invalid.message).toBe('Model returned invalid JSON despite structured output')
    expect(invalid.usage).toEqual(firstOnly)
  })

  it.each([
    ['invalid JSON', () => post.mockResolvedValueOnce(reply('not json', usageA)), /invalid JSON/],
    ['a truncated response', () => post.mockResolvedValueOnce(reply('{"decisions":', usageA, 'length')), /truncated/],
    ['no text content', () => post.mockResolvedValueOnce({ data: { choices: [{ message: { content: null }, finish_reason: 'stop' }], usage: usageA } }), /no text content/],
    ['an HTTP 400', () => post.mockRejectedValueOnce({ response: { status: 400, data: { error: { message: 'bad request' } } } }), /bad request/],
  ])('no resend on %s', async (_name, arrange, message) => {
    arrange()
    await expect(createProvider('k').completeStructured('s', 'u', schema, opts)).rejects.toThrow(message)
    expect(post).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('Anthropic structured output: missing required field', () => {
  it('throws once with the call\'s usage and never resends', async () => {
    cfg.llmProvider = 'anthropic'
    stream.mockReturnValue({
      finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ decisions: [] }) }], usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 } }),
    })
    const err = await createProvider('k').completeStructured('s', 'u', schema, { ...opts, model: 'claude-sonnet-5' }).catch(e => e)
    expect(err.message).toBe('Structured output missing required field(s): summary')
    expect(err.usage).toEqual({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 })
    expect(stream).toHaveBeenCalledTimes(1)
  })
})
