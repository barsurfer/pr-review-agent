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

import { createProvider } from '../provider.js'

const opts = { model: 'claude-sonnet-5', maxTokens: 1000, maxRetries: 2 }
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
