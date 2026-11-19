import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { TruncatedResponseError, DeadlineAbortError, missingRequired, isSystemMessageRejection } from './shared.js'
import type { LLMProvider, LLMUsage, LLMOptions, UserPart } from './shared.js'

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic(anthropicClientOptions(apiKey))
  }

  async complete(system: string, user: string, opts: LLMOptions): Promise<{ text: string; usage: LLMUsage }> {
    const response = await this.streamFinal({ model: opts.model, max_tokens: opts.maxTokens, system, messages: [{ role: 'user', content: user }] }, opts)
    return { text: textOf(response, opts.maxTokens), usage: mapUsage(response.usage) }
  }

  async completeStructured<T>(system: string, user: string | UserPart[], schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: LLMUsage }> {
    const response = await this.streamFinal({ model: opts.model, max_tokens: opts.maxTokens, system, output_config: { format: { type: 'json_schema', schema } }, messages: anthropicMessages(user, opts.systemAfter) }, opts)
    const text = textOf(response, opts.maxTokens)
    let object: T
    try {
      object = JSON.parse(text) as T
    } catch {
      throw new Error('Model returned invalid JSON despite structured output')
    }
    // Structured output should honor the schema, but a degraded response can be valid JSON yet
    // miss required keys — fail loudly here instead of crashing later on `.length` of undefined.
    const missing = missingRequired(object, schema, false, opts.tolerateMissing)
    if (missing.length) throw Object.assign(new Error(`Structured output missing required field(s): ${missing.join(', ')}`), { usage: mapUsage(response.usage) })
    return { object, usage: mapUsage(response.usage) }
  }

  // Stream + finalMessage (not create): the SDK rejects a non-streaming request whose max_tokens
  // could exceed the 10-min timeout, which the Claude 5 family hits since it thinks by default.
  // effort (when set) rides output_config; models that don't support it (e.g. Haiku 4.5) 400, so
  // catch that and retry once without it rather than fail the review.
  private streamFinal(params: Record<string, unknown>, opts: LLMOptions): Promise<Anthropic.Message> {
    const run = (p: Record<string, unknown>): Promise<Anthropic.Message> => {
      const params = p as Parameters<typeof this.client.messages.stream>[0]
      if (!opts.signal) return this.client.messages.stream(params, { maxRetries: opts.maxRetries }).finalMessage()
      // The SDK links this signal to the stream and to its retry backoff, so one abort ends the call wherever it is.
      const stream = this.client.messages.stream(params, { maxRetries: opts.maxRetries, signal: opts.signal })
      return stream.finalMessage().catch((err: unknown) => {
        if (!opts.signal?.aborted) throw err
        const partial = stream.currentMessage?.usage
        throw new DeadlineAbortError(`Model call aborted at the benchmark pass deadline (${opts.model})`, partial ? mapUsage(partial) : undefined)
      })
    }
    if (!opts.effort) return run(params)
    const withEffort = { ...params, output_config: { ...((params.output_config as Record<string, unknown>) ?? {}), effort: opts.effort } }
    return run(withEffort).catch((err: unknown) => {
      // A 400 on a systemAfter call goes to the caller's uncached re-send, which keeps this effort retry.
      if (err instanceof Anthropic.BadRequestError && !(opts.systemAfter && isSystemMessageRejection(err))) {
        console.warn(`  effort "${opts.effort}" not accepted by ${opts.model} — retrying without it`)
        return run(params)
      }
      throw err
    })
  }
}

function anthropicMessages(user: string | UserPart[], systemAfter?: string): Array<{ role: string; content: unknown }> {
  const content = typeof user === 'string' ? user : user.map(p => ({ type: 'text', text: p.text, ...(p.cache ? { cache_control: { type: 'ephemeral' } } : {}) }))
  return [{ role: 'user', content }, ...(systemAfter ? [{ role: 'system', content: systemAfter }] : [])]
}

// A max_tokens stop is a cut-off response — refuse rather than post a partial. Newer models
// can emit a thinking block ahead of the text, so find the text block, don't assume it's first.
function textOf(response: Anthropic.Message, maxTokens: number): string {
  if (response.stop_reason === 'max_tokens') {
    throw new TruncatedResponseError(`Model response truncated at ${maxTokens} output tokens — refusing to post a cut-off response`, mapUsage(response.usage))
  }
  const block = response.content.find(b => b.type === 'text')
  if (!block || block.type !== 'text') throw new Error('Unexpected response type from Claude (no text block)')
  return block.text
}

function mapUsage(u: Anthropic.Message['usage']): LLMUsage {
  const thinking = u.output_tokens_details?.thinking_tokens
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    ...(typeof thinking === 'number' && thinking > 0 ? { reasoning_tokens: thinking } : {}),
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
