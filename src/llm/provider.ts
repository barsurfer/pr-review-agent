// Thin seam over the model API — keeps the SDK in one place so structured output and a
// future non-Anthropic provider are a new impl, not a re-plumb. Anthropic-only today.
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import type { ClaudeUsage } from '../claude/client.js'

export interface LLMOptions {
  model: string
  maxTokens: number
  maxRetries: number
}

export interface LLMProvider {
  complete(system: string, user: string, opts: LLMOptions): Promise<{ text: string; usage: ClaudeUsage }>
  completeStructured<T>(system: string, user: string, schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: ClaudeUsage }>
}

class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async complete(system: string, user: string, opts: LLMOptions): Promise<{ text: string; usage: ClaudeUsage }> {
    const response = await this.client.messages.create(
      { model: opts.model, max_tokens: opts.maxTokens, system, messages: [{ role: 'user', content: user }] },
      { maxRetries: opts.maxRetries },
    )
    return { text: textOf(response, opts.maxTokens), usage: mapUsage(response.usage) }
  }

  async completeStructured<T>(system: string, user: string, schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: ClaudeUsage }> {
    const response = await this.client.messages.create(
      { model: opts.model, max_tokens: opts.maxTokens, system, output_config: { format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content: user }] },
      { maxRetries: opts.maxRetries },
    )
    const text = textOf(response, opts.maxTokens)
    let object: T
    try {
      object = JSON.parse(text) as T
    } catch {
      throw new Error('Model returned invalid JSON despite structured output')
    }
    // Structured output should honor the schema, but a degraded response can be valid JSON yet
    // miss required keys — fail loudly here instead of crashing later on `.length` of undefined.
    const missing = missingRequired(object, schema)
    if (missing.length) throw new Error(`Structured output missing required field(s): ${missing.join(', ')}`)
    return { object, usage: mapUsage(response.usage) }
  }
}

// A max_tokens stop is a cut-off response — refuse rather than post a partial. Newer models
// can emit a thinking block ahead of the text, so find the text block, don't assume it's first.
function textOf(response: Anthropic.Message, maxTokens: number): string {
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Model response truncated at ${maxTokens} output tokens — refusing to post a cut-off response`)
  }
  const block = response.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Unexpected response type from Claude (no text block)')
  return block.text
}

function mapUsage(u: Anthropic.Message['usage']): ClaudeUsage {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

/** Top-level required keys the parsed object is missing — a schema-honoring provider returns []. */
export function missingRequired(object: unknown, schema: Record<string, unknown>): string[] {
  const required = (schema.required as string[] | undefined) ?? []
  const obj = (object ?? {}) as Record<string, unknown>
  return required.filter(k => obj[k] === undefined)
}

export function createProvider(apiKey: string): LLMProvider {
  switch (config.llmProvider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey)
    default:
      throw new Error(`Unknown LLM_PROVIDER "${config.llmProvider}" (supported: anthropic)`)
  }
}
