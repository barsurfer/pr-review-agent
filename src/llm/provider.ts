// Thin seam over the model API — keeps provider SDKs in one place so a second backend is a new
// impl, not a re-plumb. Anthropic (native SDK) and OpenRouter (OpenAI-compatible, via axios) today.
import Anthropic from '@anthropic-ai/sdk'
import axios from 'axios'
import { config } from '../config.js'

export interface LLMUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  // Provider-reported USD for the call (OpenRouter with usage.include); unset for Anthropic, which
  // has no cost field — callers fall back to the static pricing table when this is absent.
  cost_usd?: number
}

export interface LLMOptions {
  model: string
  maxTokens: number
  maxRetries: number
  effort?: string   // output_config.effort (low|medium|high|xhigh|max); unset = model default
}

export interface LLMProvider {
  complete(system: string, user: string, opts: LLMOptions): Promise<{ text: string; usage: LLMUsage }>
  completeStructured<T>(system: string, user: string, schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: LLMUsage }>
}

class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic(anthropicClientOptions(apiKey))
  }

  async complete(system: string, user: string, opts: LLMOptions): Promise<{ text: string; usage: LLMUsage }> {
    const response = await this.streamFinal({ model: opts.model, max_tokens: opts.maxTokens, system, messages: [{ role: 'user', content: user }] }, opts)
    return { text: textOf(response, opts.maxTokens), usage: mapUsage(response.usage) }
  }

  async completeStructured<T>(system: string, user: string, schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: LLMUsage }> {
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

// OpenRouter's OpenAI-compatible gateway. Non-streaming: OpenAI semantics don't force streaming
// above a token threshold (unlike the Anthropic SDK), so a plain POST suffices.
class OpenRouterProvider implements LLMProvider {
  constructor(private readonly apiKey: string) {}

  async complete(system: string, user: string, opts: LLMOptions): Promise<{ text: string; usage: LLMUsage }> {
    const data = await this.request({ model: opts.model, max_tokens: opts.maxTokens, messages: openRouterMessages(system, user) }, opts)
    const choice = firstChoice(data, opts.maxTokens)
    return { text: contentOf(choice), usage: mapOpenRouterUsage(data.usage) }
  }

  async completeStructured<T>(system: string, user: string, schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: LLMUsage }> {
    // strict:false — our REVIEW/JUDGE schemas don't meet OpenAI strict's all-keys-required rule;
    // JSON.parse + missingRequired below is the fidelity guard instead. Gate models on supported_parameters.
    const response_format = { type: 'json_schema', json_schema: { name: 'result', schema, strict: false } }
    const data = await this.request({ model: opts.model, max_tokens: opts.maxTokens, response_format, messages: openRouterMessages(system, user) }, opts)
    const choice = firstChoice(data, opts.maxTokens)
    const text = contentOf(choice)
    let object: T
    try {
      object = JSON.parse(text) as T
    } catch {
      throw new Error('Model returned invalid JSON despite structured output')
    }
    const missing = missingRequired(object, schema, true)
    if (missing.length) throw new Error(`Structured output missing required field(s): ${missing.join(', ')}`)
    return { object, usage: mapOpenRouterUsage(data.usage) }
  }

  private async request(payload: Record<string, unknown>, opts: LLMOptions): Promise<OpenRouterResponse> {
    const url = `${config.openrouter.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...(config.openrouter.referer ? { 'HTTP-Referer': config.openrouter.referer } : {}),
      ...(config.openrouter.title ? { 'X-Title': config.openrouter.title } : {}),
    }
    // usage.include returns the real USD cost so the record logs it instead of a wrong-model estimate.
    const body = { ...payload, usage: { include: true } }
    let lastErr: unknown
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      try {
        const resp = await axios.post<OpenRouterResponse>(url, body, { headers, timeout: OPENROUTER_TIMEOUT_MS })
        const data = resp.data
        // OpenRouter can return HTTP 200 with an error object instead of choices.
        if (data?.error) throw openRouterError(typeof data.error.code === 'number' ? data.error.code : undefined, data.error.message ?? 'OpenRouter returned an error', data.error.code)
        return data
      } catch (err: unknown) {
        if (isOpenRouterError(err)) throw err
        lastErr = err
        if (attempt < opts.maxRetries && isRetryable(err)) {
          await delay(retryDelayMs(attempt, err))
          continue
        }
        throw axiosToError(err)
      }
    }
    throw axiosToError(lastErr)
  }
}

// Carries the usage of a truncated response so the caller can still record real token counts
// (and the stop reason) instead of logging a zeroed, near-empty error record.
export class TruncatedResponseError extends Error {
  constructor(message: string, readonly usage: LLMUsage) {
    super(message)
    this.name = 'TruncatedResponseError'
  }
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
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
  }
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; cost_details?: { upstream_inference_cost?: number }; prompt_tokens_details?: { cached_tokens?: number } }
  error?: { message?: string; code?: number | string }
}

const OPENROUTER_TIMEOUT_MS = 600_000

function openRouterMessages(system: string, user: string): Array<{ role: string; content: string }> {
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

function firstChoice(data: OpenRouterResponse, maxTokens: number): NonNullable<OpenRouterResponse['choices']>[number] {
  const choice = data.choices?.[0]
  if (!choice) throw new Error('OpenRouter returned no choices')
  if (choice.finish_reason === 'length') {
    throw new TruncatedResponseError(`Model response truncated at ${maxTokens} output tokens — refusing to post a cut-off response`, mapOpenRouterUsage(data.usage))
  }
  return choice
}

function contentOf(choice: NonNullable<OpenRouterResponse['choices']>[number]): string {
  const content = choice.message?.content
  if (typeof content !== 'string') throw new Error('OpenRouter returned no text content (refusal or non-text finish)')
  return content
}

function mapOpenRouterUsage(u: OpenRouterResponse['usage']): LLMUsage {
  // A BYOK key reports cost: 0 (no OpenRouter credits spent); the real upstream spend is in
  // cost_details.upstream_inference_cost. Prefer the gateway's own charge when it's non-zero.
  const cost = typeof u?.cost === 'number' && u.cost > 0 ? u.cost : u?.cost_details?.upstream_inference_cost
  return {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
    ...(typeof cost === 'number' ? { cost_usd: cost } : {}),
  }
}

type StatusError = Error & { status?: number; __openrouter?: true }

// Normalize to the Anthropic-recognized { status, message } shape so the shared degrade/retry/record code works unchanged.
function openRouterError(status: number | undefined, rawMessage: string, code?: number | string): StatusError {
  // Detect a context overflow by wording OR error code, independent of the reported status — an
  // HTTP-200 body error may carry a string code (context_length_exceeded) and no numeric status.
  // When it is an overflow, force status 400 + a phrase isContextLengthError matches so the
  // diff-only degrade backstop fires. Covers OpenAI/Anthropic/Gemini/Cohere phrasings.
  const hay = `${rawMessage} ${typeof code === 'string' ? code : ''}`
  const overflow = /context[ _]length|maximum context|reduce the length|context_length_exceeded|too many tokens|input is too long|input token count/i.test(hay)
  const e = new Error(overflow ? `prompt is too long: ${rawMessage}` : rawMessage) as StatusError
  const resolved = overflow ? 400 : status
  if (typeof resolved === 'number') e.status = resolved
  e.__openrouter = true
  return e
}

function isOpenRouterError(err: unknown): err is StatusError {
  return !!(err as StatusError)?.__openrouter
}

interface AxiosLikeError {
  response?: { status?: number; headers?: Record<string, string>; data?: { error?: { message?: string; code?: number | string } } }
  code?: string
  message?: string
}

function axiosToError(err: unknown): StatusError {
  const ax = err as AxiosLikeError
  const status = ax.response?.status
  const errBody = ax.response?.data?.error
  const message = errBody?.message ?? ax.message ?? 'OpenRouter request failed'
  return openRouterError(status, message, errBody?.code)
}

function isRetryable(err: unknown): boolean {
  const ax = err as AxiosLikeError
  // A non-streaming timeout may have already consumed (and billed) upstream generation, so retrying
  // re-bills with no partial output — don't. A connection error never reached the server, so retry it.
  if (ax.code === 'ECONNABORTED' || ax.code === 'ETIMEDOUT') return false
  if (!ax.response) return true
  const s = ax.response.status ?? 0
  return s === 429 || s >= 500
}

function retryDelayMs(attempt: number, err: unknown): number {
  const retryAfter = Number((err as AxiosLikeError).response?.headers?.['retry-after'])
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000
  return Math.min(500 * 2 ** attempt, 8000)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

// Required root keys the object is missing ([] from a schema-honoring provider). `deep` also flags
// dropped array-item required keys (findings[].severity) a strict:false provider can omit while
// satisfying the root — countFindings/applyJudgeDecisions assume those exist.
export function missingRequired(object: unknown, schema: Record<string, unknown>, deep = false): string[] {
  const required = (schema.required as string[] | undefined) ?? []
  const obj = (object ?? {}) as Record<string, unknown>
  const missing = required.filter(k => obj[k] === undefined)
  if (!deep) return missing
  const props = (schema.properties ?? {}) as Record<string, { items?: { required?: string[] } }>
  for (const [key, prop] of Object.entries(props)) {
    const itemRequired = prop?.items?.required
    if (!itemRequired || !Array.isArray(obj[key])) continue
    ;(obj[key] as unknown[]).forEach((el, i) => {
      const elObj = (el ?? {}) as Record<string, unknown>
      for (const rk of itemRequired) if (elObj[rk] === undefined) missing.push(`${key}[${i}].${rk}`)
    })
  }
  return missing
}

export function createProvider(apiKey: string): LLMProvider {
  switch (config.llmProvider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey)
    case 'openrouter':
      return new OpenRouterProvider(apiKey)
    default:
      throw new Error(`Unknown LLM_PROVIDER "${config.llmProvider}" (supported: anthropic, openrouter)`)
  }
}
