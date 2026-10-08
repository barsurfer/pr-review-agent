// Thin seam over the model API — keeps the SDK in one place so structured output and a
// future non-Anthropic provider are a new impl, not a re-plumb. Anthropic-only today.
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import type { ClaudeUsage } from '../claude/client.js'

export interface LLMOptions {
  model: string
  maxTokens: number
  maxRetries: number
  effort?: string   // output_config.effort (low|medium|high|xhigh|max); unset = model default
}

export interface LLMProvider {
  complete(system: string, user: string, opts: LLMOptions): Promise<{ text: string; usage: ClaudeUsage }>
  completeStructured<T>(system: string, user: string, schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: ClaudeUsage }>
}

class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic(anthropicClientOptions(apiKey))
  }

  async complete(system: string, user: string, opts: LLMOptions): Promise<{ text: string; usage: ClaudeUsage }> {
    const response = await this.streamFinal({ model: opts.model, max_tokens: opts.maxTokens, system, messages: [{ role: 'user', content: user }] }, opts)
    return { text: textOf(response, opts.maxTokens), usage: mapUsage(response.usage) }
  }

  async completeStructured<T>(system: string, user: string, schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: ClaudeUsage }> {
    const response = await this.streamFinal({ model: opts.model, max_tokens: opts.maxTokens, system, output_config: { format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content: user }] }, opts)
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

  // Stream + finalMessage (not create): the SDK rejects a non-streaming request whose max_tokens
  // could exceed the 10-min timeout, which the Claude 5 family hits since it thinks by default.
  // effort (when set) rides output_config; models that don't support it (e.g. Haiku 4.5) 400, so
  // catch that and retry once without it rather than fail the review.
  private streamFinal(params: Record<string, unknown>, opts: LLMOptions): Promise<Anthropic.Message> {
    const run = (p: Record<string, unknown>): Promise<Anthropic.Message> =>
      this.client.messages.stream(p as Parameters<typeof this.client.messages.stream>[0], { maxRetries: opts.maxRetries }).finalMessage()
    if (!opts.effort) return run(params)
    const withEffort = { ...params, output_config: { ...((params.output_config as Record<string, unknown>) ?? {}), effort: opts.effort } }
    return run(withEffort).catch((err: unknown) => {
      if (err instanceof Anthropic.BadRequestError) {
        console.warn(`  effort "${opts.effort}" not accepted by ${opts.model} — retrying without it`)
        return run(params)
      }
      throw err
    })
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

// The SDK appends /v1/messages itself, so an endpoint registered as ".../v1" would 404 on /v1/v1.
export function anthropicBaseUrl(url: string): string | undefined {
  return url.trim().replace(/\/+$/, '').replace(/\/v1$/, '') || undefined
}

// Client options from config: the key, an optional baseURL, and the anthropic-workspace-id header
// when ANTHROPIC_WORKSPACE_ID is set (required for user-scoped keys that aren't bound to a workspace).
export function anthropicClientOptions(apiKey: string): { apiKey: string; baseURL?: string; defaultHeaders?: Record<string, string> } {
  const baseURL = anthropicBaseUrl(config.anthropic.baseUrl)
  const workspaceId = config.anthropic.workspaceId.trim()
  return {
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
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
