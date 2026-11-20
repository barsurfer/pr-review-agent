import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pins the exact SDK arguments and HTTP request each provider builds for the plain call, the cached reviewer and a cached pass, as v0.0.59 sent them.

vi.mock('../config.js', () => ({
  config: {
    llmProvider: 'anthropic',
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', referer: 'https://app.example', title: 'my-app' },
    anthropic: { baseUrl: '', workspaceId: '' },
    repoSlug: 'my-repo',
    review: { promptCache: false },
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

import { AnthropicProvider } from '../llm/anthropic-provider.js'
import { OpenRouterProvider } from '../llm/openrouter-provider.js'
import { config } from '../config.js'
import type { LLMOptions, UserPart } from '../llm/shared.js'

const cfg = config as any
const schema = { type: 'object', required: ['findings'], properties: { findings: { type: 'array', items: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } } }
const answer = { findings: [{ title: 'x' }] }
const user: UserPart[] = [{ text: 'PR block', cache: true }, { text: 'briefing' }]
const base: LLMOptions = { model: 'claude-haiku-5-5', maxTokens: 64000, maxRetries: 1, effort: 'high' }
const pass: LLMOptions = { ...base, tolerateMissing: ['summary'], systemAfter: 'OVERLAY', sessionId: 'sess-1' }
const visible = (_k: string, v: unknown) => (v === undefined ? '<undefined>' : typeof AbortSignal !== 'undefined' && v instanceof AbortSignal ? '<AbortSignal>' : v)

const anthropicReply = () => stream.mockReturnValue({
  finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, output_tokens_details: { thinking_tokens: 0 } } }),
})
const openRouterReply = () => post.mockResolvedValue({ data: { choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 }, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 }, cost: 0.001 } } })

beforeEach(() => { post.mockReset(); stream.mockReset(); cfg.review.promptCache = false })

async function anthropicWire(call: (p: AnthropicProvider) => Promise<unknown>) {
  anthropicReply()
  const result = await call(new AnthropicProvider('k'))
  return { stream: JSON.parse(JSON.stringify(stream.mock.calls, visible)), result }
}
async function openRouterWire(cached: boolean, call: (p: OpenRouterProvider) => Promise<unknown>) {
  cfg.review.promptCache = cached
  openRouterReply()
  const result = await call(new OpenRouterProvider('k'))
  return { post: JSON.parse(JSON.stringify(post.mock.calls, visible)), result }
}

describe('v0.0.59 Anthropic wire shapes', () => {
  it('plain call', async () => {
    await expect(JSON.stringify(await anthropicWire(p => p.completeStructured('S', 'U', schema, base)), visible, 2)).toMatchFileSnapshot('./__fixtures__/identity-v0059/wire-anthropic-plain.json')
  })
  it('cached reviewer', async () => {
    await expect(JSON.stringify(await anthropicWire(p => p.completeStructured('S', user, schema, base)), visible, 2)).toMatchFileSnapshot('./__fixtures__/identity-v0059/wire-anthropic-cached-reviewer.json')
  })
  it('cached pass', async () => {
    await expect(JSON.stringify(await anthropicWire(p => p.completeStructured('S', user, schema, pass)), visible, 2)).toMatchFileSnapshot('./__fixtures__/identity-v0059/wire-anthropic-cached-pass.json')
  })
  it('cached pass under a deadline signal', async () => {
    const signal = new AbortController().signal
    await expect(JSON.stringify(await anthropicWire(p => p.completeStructured('S', user, schema, { ...pass, signal })), visible, 2)).toMatchFileSnapshot('./__fixtures__/identity-v0059/wire-anthropic-cached-pass-signal.json')
  })
})

describe('v0.0.59 OpenRouter wire shapes', () => {
  const or: LLMOptions = { ...base, model: 'anthropic/claude-haiku-5.5' }
  it('plain call', async () => {
    await expect(JSON.stringify(await openRouterWire(false, p => p.completeStructured('S', 'U', schema, or)), visible, 2)).toMatchFileSnapshot('./__fixtures__/identity-v0059/wire-openrouter-plain.json')
  })
  it('cached reviewer', async () => {
    await expect(JSON.stringify(await openRouterWire(true, p => p.completeStructured('S', user, schema, { ...or, sessionId: 'sess-1' })), visible, 2)).toMatchFileSnapshot('./__fixtures__/identity-v0059/wire-openrouter-cached-reviewer.json')
  })
  it('cached pass', async () => {
    await expect(JSON.stringify(await openRouterWire(true, p => p.completeStructured('S', user, schema, { ...pass, model: or.model })), visible, 2)).toMatchFileSnapshot('./__fixtures__/identity-v0059/wire-openrouter-cached-pass.json')
  })
  it('cached pass under a deadline signal', async () => {
    const signal = new AbortController().signal
    await expect(JSON.stringify(await openRouterWire(true, p => p.completeStructured('S', user, schema, { ...pass, model: or.model, signal })), visible, 2)).toMatchFileSnapshot('./__fixtures__/identity-v0059/wire-openrouter-cached-pass-signal.json')
  })
})
