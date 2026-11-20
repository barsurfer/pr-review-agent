import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../config.js', () => ({
  config: {
    llmProvider: 'anthropic',
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', referer: '', title: '' },
    anthropic: { baseUrl: '', workspaceId: '' },
    repoSlug: '',
    review: { promptCache: true },
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

import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '../anthropic-provider.js'
import { OpenRouterProvider } from '../openrouter-provider.js'
import { sumAttempts } from '../shared.js'
import { estimateAttemptsCost, estimateCost } from '../../review/usage.js'
import { config } from '../../config.js'
import type { LLMOptions, UserPart } from '../shared.js'

const cfg = config as any
const schema = { required: ['findings'], properties: { findings: { items: { required: ['title'] } } } } as Record<string, unknown>
const answer = { findings: [{ title: 'x' }] }
const dropped = { findings: [{}] }
const user: UserPart[] = [{ text: 'block', cache: true }, { text: 'briefing' }]
const pass: LLMOptions = { model: 'claude-haiku-5-5', maxTokens: 1000, maxRetries: 0, effort: 'high', systemAfter: 'OVERLAY', sessionId: 's1' }
const BETA = { 'anthropic-beta': 'mid-conversation-output-config-2026-07-01' }

const anthropicOk = (usage: object = { input_tokens: 1, output_tokens: 1 }) => stream.mockReturnValue({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage }) })
const reasoning = (n?: number) => ({ input_tokens: 1, output_tokens: 1, ...(n === undefined ? {} : { output_tokens_details: { thinking_tokens: n } }) })
const overflow = () => Object.assign(new (Anthropic.BadRequestError as any)('prompt is too long: 9'), { status: 400 })

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => { post.mockReset(); stream.mockReset(); cfg.review.promptCache = true; warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { warn.mockRestore() })

describe('Anthropic effortAfter', () => {
  it('renders [user, effort message, overlay] and the beta header only when set', async () => {
    anthropicOk()
    await new AnthropicProvider('k').completeStructured('S', user, schema, { ...pass, effortAfter: 'medium', keepEffort: true })
    const [params, options] = stream.mock.calls[0]
    expect(params.messages.map((m: any) => m.role)).toEqual(['user', 'system', 'system'])
    expect(params.messages[1]).toStrictEqual({ role: 'system', content: [], output_config: { effort: 'medium' } })
    expect(params.messages[2]).toStrictEqual({ role: 'system', content: 'OVERLAY' })
    expect(params.output_config.effort).toBe('high')
    expect(options).toStrictEqual({ maxRetries: 0, headers: BETA })
  })

  it('renders nothing without it: the shipped messages and options', async () => {
    anthropicOk()
    await new AnthropicProvider('k').completeStructured('S', user, schema, pass)
    const [params, options] = stream.mock.calls[0]
    expect(params.messages).toHaveLength(2)
    expect(options).toStrictEqual({ maxRetries: 0 })
  })

  it('keeps the deadline signal beside the header', async () => {
    anthropicOk()
    const signal = new AbortController().signal
    await new AnthropicProvider('k').completeStructured('S', user, schema, { ...pass, effortAfter: 'medium', signal })
    expect(stream.mock.calls[0][1]).toStrictEqual({ maxRetries: 0, headers: BETA, signal })
  })

  it('an overflow with keepEffort is one request and the effort is unchanged', async () => {
    const err = overflow()
    stream.mockReturnValue({ finalMessage: async () => { throw err } })
    await expect(new AnthropicProvider('k').completeStructured('S', user, schema, { ...pass, keepEffort: true })).rejects.toBe(err)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(stream.mock.calls[0][0].output_config.effort).toBe('high')
  })

  it('without keepEffort the same overflow still retries without effort', async () => {
    stream.mockReturnValueOnce({ finalMessage: async () => { throw overflow() } })
    anthropicOk()
    await new AnthropicProvider('k').completeStructured('S', 'U', schema, { ...pass, systemAfter: undefined })
    expect(stream).toHaveBeenCalledTimes(2)
    expect(stream.mock.calls[1][0].output_config.effort).toBeUndefined()
  })

  it.each([[0, 0], [1500, 1500], [undefined, undefined]])('reports the accepted count %s as %s, including with only keepEffort', async (thinking, expected) => {
    anthropicOk(reasoning(thinking))
    const a = await new AnthropicProvider('k').completeStructured('S', user, schema, { ...pass, effortAfter: 'medium', keepEffort: true })
    anthropicOk(reasoning(thinking))
    const b = await new AnthropicProvider('k').completeStructured('S', user, schema, { ...pass, keepEffort: true })
    for (const r of [a, b]) expect(r.usage.final_reasoning_tokens).toBe(expected)
    expect('final_reasoning_tokens' in a.usage).toBe(expected !== undefined)
  })

  it('never reports it for an ordinary call', async () => {
    anthropicOk(reasoning(0))
    const r = await new AnthropicProvider('k').completeStructured('S', user, schema, pass)
    expect(r.usage).toStrictEqual({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  })
})

const orReply = (object: unknown, usage: object) => ({ data: { choices: [{ message: { content: JSON.stringify(object) }, finish_reason: 'stop' }], usage } })
const orOpts: LLMOptions = { ...pass, model: 'anthropic/claude-haiku-5.5' }
const bodyOf = (i = 0) => post.mock.calls[i][1]
const rejection = { response: { status: 400, data: { error: { message: 'reasoning.effort: Invalid option', code: 400 } } } }

describe('OpenRouter effortAfter', () => {
  it('inserts the configuration_update message between the user turn and the overlay, only when set', async () => {
    post.mockResolvedValue(orReply(answer, {}))
    await new OpenRouterProvider('k').completeStructured('S', user, schema, { ...orOpts, effortAfter: 'medium', keepEffort: true })
    expect(bodyOf().messages.map((m: any) => m.role)).toEqual(['system', 'user', 'system', 'system'])
    expect(bodyOf().messages[2]).toStrictEqual({ role: 'system', content: '', configuration_update: { reasoning: { effort: 'medium' } } })
    expect(bodyOf().messages[3]).toStrictEqual({ role: 'system', content: 'OVERLAY' })
    expect(bodyOf().reasoning).toEqual({ effort: 'high' })

    post.mockClear()
    await new OpenRouterProvider('k').completeStructured('S', user, schema, orOpts)
    expect(bodyOf().messages).toHaveLength(3)
    expect(JSON.stringify(bodyOf())).not.toContain('configuration_update')
  })

  it('a reasoning.effort 400 with keepEffort is not retried without effort', async () => {
    post.mockRejectedValue(rejection)
    await expect(new OpenRouterProvider('k').completeStructured('S', user, schema, { ...orOpts, keepEffort: true })).rejects.toMatchObject({ status: 400 })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('without keepEffort the same rejection still retries without effort', async () => {
    post.mockRejectedValueOnce(rejection)
    post.mockResolvedValue(orReply(answer, {}))
    await new OpenRouterProvider('k').completeStructured('S', user, schema, orOpts)
    expect(post).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).reasoning).toBeUndefined()
  })

  it.each([[0, 0], [900, 900], [undefined, undefined]])('reports the accepted count %s as %s', async (n, expected) => {
    post.mockResolvedValue(orReply(answer, { completion_tokens_details: n === undefined ? {} : { reasoning_tokens: n } }))
    const r = await new OpenRouterProvider('k').completeStructured('S', user, schema, { ...orOpts, effortAfter: 'medium', keepEffort: true })
    expect(r.usage.final_reasoning_tokens).toBe(expected)
    expect('final_reasoning_tokens' in r.usage).toBe(expected !== undefined)
    post.mockClear()
    const plain = await new OpenRouterProvider('k').completeStructured('S', user, schema, orOpts)
    expect('final_reasoning_tokens' in plain.usage).toBe(false)
  })

  it('a resend going 100 then 0 reports the accepted 0 beside a summed aggregate', async () => {
    post.mockResolvedValueOnce(orReply(dropped, { prompt_tokens: 100, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 100 }, cost: 0.01 }))
    post.mockResolvedValueOnce(orReply(answer, { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 0 }, cost: 0.02 }))
    const r = await new OpenRouterProvider('k').completeStructured('S', user, schema, { ...orOpts, effortAfter: 'medium', keepEffort: true })
    expect(r.usage.final_reasoning_tokens).toBe(0)
    expect(r.usage).toMatchObject({ input_tokens: 200, output_tokens: 250, reasoning_tokens: 100 })
    expect(r.usage.cost_usd).toBeCloseTo(0.03)
  })
})

describe('mixed-cost schema retries', () => {
  const usage = (cost?: number) => ({ prompt_tokens: 1000, completion_tokens: 100, ...(cost === undefined ? {} : { cost }) })

  it.each([
    ['cost then none', 0.01, undefined],
    ['none then cost', undefined, 0.01],
  ])('%s: the feature omits the aggregate cost and each attempt is priced by its own cost or estimate', async (_n, first, second) => {
    post.mockResolvedValueOnce(orReply(dropped, usage(first)))
    post.mockResolvedValueOnce(orReply(answer, usage(second)))
    const r = await new OpenRouterProvider('k').completeStructured('S', user, schema, { ...orOpts, effortAfter: 'medium', keepEffort: true })
    expect(r.usage.cost_usd).toBeUndefined()
    expect(r.usage.attempts).toHaveLength(2)
    const estimate = estimateCost({ input: 1000, output: 100, cache_read: 0, cache_write: 0 }, 'claude-haiku-5-5')
    expect(estimateAttemptsCost(r.usage.attempts!, 'claude-haiku-5-5')).toBeCloseTo(0.01 + estimate, 4)
  })

  it('keeps the shipped sum when the feature is off, and when every attempt reported', async () => {
    post.mockResolvedValueOnce(orReply(dropped, usage(0.01)))
    post.mockResolvedValueOnce(orReply(answer, usage()))
    const off = await new OpenRouterProvider('k').completeStructured('S', user, schema, orOpts)
    expect(off.usage.cost_usd).toBeCloseTo(0.01)

    post.mockReset()
    post.mockResolvedValueOnce(orReply(dropped, usage(0.01)))
    post.mockResolvedValueOnce(orReply(answer, usage(0.02)))
    const on = await new OpenRouterProvider('k').completeStructured('S', user, schema, { ...orOpts, keepEffort: true })
    expect(on.usage.cost_usd).toBeCloseTo(0.03)
  })

  it('an uncached call without keepEffort is strict while the setting is on: cost then none omits the aggregate', async () => {
    cfg.review.cachedPassEffort = 'medium'
    post.mockResolvedValueOnce(orReply(dropped, usage(0.01)))
    post.mockResolvedValueOnce(orReply(answer, usage()))
    const r = await new OpenRouterProvider('k').completeStructured('S', 'U', schema, { ...orOpts, systemAfter: undefined })
    cfg.review.cachedPassEffort = ''
    expect(r.usage.cost_usd).toBeUndefined()
    expect('final_reasoning_tokens' in r.usage).toBe(false)
    const estimate = estimateCost({ input: 1000, output: 100, cache_read: 0, cache_write: 0 }, 'claude-haiku-5-5')
    expect(estimateAttemptsCost(r.usage.attempts!, 'claude-haiku-5-5')).toBeCloseTo(0.01 + estimate, 4)
  })

  it('a failed resend keeps the strict aggregate on the error', async () => {
    post.mockResolvedValueOnce(orReply(dropped, usage(0.01)))
    post.mockRejectedValueOnce({ response: { status: 400, data: { error: { message: 'bad', code: 400 } } } })
    const err = await new OpenRouterProvider('k').completeStructured('S', user, schema, { ...orOpts, keepEffort: true }).catch(e => e)
    expect(err.usage.cost_usd).toBeCloseTo(0.01)
  })
})

describe('sumAttempts', () => {
  const costed = { input_tokens: 10, output_tokens: 5, cost_usd: 0.5 }
  const free = { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 3, reasoning_tokens: 2 }

  it('sums tokens and flattens attempts; cost only when every attempt has one', () => {
    expect(sumAttempts(costed, { ...costed, cost_usd: 0.25 })).toMatchObject({ input_tokens: 20, output_tokens: 10, cost_usd: 0.75 })
    for (const m of [sumAttempts(costed, free), sumAttempts(free, costed)]) {
      expect(m).toMatchObject({ input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 3, reasoning_tokens: 2 })
      expect('cost_usd' in m).toBe(false)
      expect(m.attempts).toHaveLength(2)
    }
    expect(sumAttempts(sumAttempts(costed, free), costed).attempts).toHaveLength(3)
  })

  it('never carries final_reasoning_tokens', () => {
    const m = sumAttempts({ ...free, final_reasoning_tokens: 0 }, { ...costed, final_reasoning_tokens: 9 })
    expect(JSON.stringify(m)).not.toContain('final_reasoning')
  })
})

describe('deadline abort after a completed resend', () => {
  it('an uncached call without keepEffort keeps the completed attempt while the setting is on, and nothing when it is off', async () => {
    const { DeadlineAbortError } = await import('../shared.js')
    for (const setting of ['medium', '']) {
      cfg.review.cachedPassEffort = setting
      post.mockReset()
      post.mockResolvedValueOnce(orReply(dropped, { prompt_tokens: 10, completion_tokens: 9000 }))
      const ac = new AbortController()
      post.mockImplementationOnce(async () => { ac.abort(); throw new Error('aborted') })
      const err = await new OpenRouterProvider('k').completeStructured('S', 'U', schema, { ...orOpts, systemAfter: undefined, signal: ac.signal }).catch(e => e)
      expect(err).toBeInstanceOf(DeadlineAbortError)
      expect(err.completed?.output_tokens).toBe(setting ? 9000 : undefined)
      expect(err.usage?.output_tokens).toBe(setting ? undefined : 9000)
    }
    cfg.review.cachedPassEffort = ''
  })

  it('keeps the completed attempts apart from the abort only with keepEffort', async () => {
    const { DeadlineAbortError } = await import('../shared.js')
    for (const keep of [true, false]) {
      post.mockReset()
      post.mockResolvedValueOnce(orReply(dropped, { prompt_tokens: 10, completion_tokens: 7000 }))
      const ac = new AbortController()
      post.mockImplementationOnce(async () => { ac.abort(); throw new Error('aborted') })
      const err = await new OpenRouterProvider('k').completeStructured('S', user, schema, { ...orOpts, signal: ac.signal, ...(keep ? { keepEffort: true as const } : {}) }).catch(e => e)
      expect(err).toBeInstanceOf(DeadlineAbortError)
      if (keep) expect(err.completed?.output_tokens).toBe(7000)
      else expect(err.completed).toBeUndefined()
    }
  })
})
