import axios from 'axios'
import { config } from '../config.js'
import { TruncatedResponseError, missingRequired } from './shared.js'
import type { LLMProvider, LLMUsage, LLMOptions } from './shared.js'

// OpenRouter's OpenAI-compatible gateway. Non-streaming: OpenAI semantics don't force streaming
// above a token threshold (unlike the Anthropic SDK), so a plain POST suffices.
export class OpenRouterProvider implements LLMProvider {
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
    const payload = { model: opts.model, max_tokens: opts.maxTokens, response_format, messages: openRouterMessages(system, user) }
    const first = await this.structuredAttempt<T>(payload, schema, opts)
    if (!first.missing.length) return { object: first.object, usage: first.usage }
    // A strict:false model can drop a nested required field on one sample and not the next; one resend costs less than failing the run.
    console.warn(`  Structured output from ${opts.model} missing ${first.missing.join(', ')} — retrying once`)
    const second = await this.structuredAttempt<T>(payload, schema, opts).catch((err: unknown) => { throw withPriorUsage(err, first.usage) })
    const usage = sumUsage(first.usage, second.usage)
    if (second.missing.length) throw Object.assign(new Error(`Structured output missing required field(s): ${second.missing.join(', ')}`), { usage })
    return { object: second.object, usage }
  }

  private async structuredAttempt<T>(payload: Record<string, unknown>, schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: LLMUsage; missing: string[] }> {
    const data = await this.request(payload, opts)
    const text = contentOf(firstChoice(data, opts.maxTokens))
    let object: T
    try {
      object = JSON.parse(text) as T
    } catch {
      throw new Error('Model returned invalid JSON despite structured output')
    }
    return { object, usage: mapOpenRouterUsage(data.usage), missing: missingRequired(object, schema, true, opts.tolerateMissing) }
  }

  private async request(payload: Record<string, unknown>, opts: LLMOptions): Promise<OpenRouterResponse> {
    const url = `${config.openrouter.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...(config.openrouter.referer ? { 'HTTP-Referer': config.openrouter.referer } : {}),
      ...(config.openrouter.title ? { 'X-OpenRouter-Title': config.openrouter.title } : {}),
    }
    // usage.include returns the real USD cost so the record logs it instead of a wrong-model estimate;
    // user tags the request with the reviewed repo for OpenRouter-side segmentation.
    const body = { ...payload, usage: { include: true }, ...(config.repoSlug ? { user: config.repoSlug } : {}) }
    if (!opts.effort) return this.send(url, headers, body, opts)
    // OpenRouter maps reasoning.effort to Claude 4.6+ output_config.effort; like the Anthropic provider, a rejected value is retried without it.
    return this.send(url, headers, { ...body, reasoning: { effort: opts.effort } }, opts).catch((err: unknown) => {
      if (isReasoningRejection(err)) {
        console.warn(`  effort "${opts.effort}" not accepted by ${opts.model} — retrying without it`)
        return this.send(url, headers, body, opts)
      }
      throw err
    })
  }

  private async send(url: string, headers: Record<string, string>, body: Record<string, unknown>, opts: LLMOptions): Promise<OpenRouterResponse> {
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

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number }; cost?: number; cost_details?: { upstream_inference_cost?: number }; prompt_tokens_details?: { cached_tokens?: number } }
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
  const reasoning = u?.completion_tokens_details?.reasoning_tokens
  return {
    input_tokens: u?.prompt_tokens ?? 0,
    // Already includes completion_tokens_details.reasoning_tokens (billed as output), as Anthropic's output_tokens includes thinking.
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
    ...(typeof cost === 'number' ? { cost_usd: cost } : {}),
    ...(typeof reasoning === 'number' && reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
  }
}

function sumUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  const cost = a.cost_usd === undefined && b.cost_usd === undefined ? undefined : (a.cost_usd ?? 0) + (b.cost_usd ?? 0)
  const reasoning = (a.reasoning_tokens ?? 0) + (b.reasoning_tokens ?? 0)
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    ...(cost === undefined ? {} : { cost_usd: cost }),
    ...(reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
  }
}

// The first attempt was paid for, so a resend that fails another way still reports it.
function withPriorUsage(err: unknown, prior: LLMUsage): unknown {
  if (!err || typeof err !== 'object') return err
  const own = (err as { usage?: LLMUsage }).usage
  return Object.assign(err, { usage: own ? sumUsage(prior, own) : prior })
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
  const e = new Error(overflow ? `${OVERFLOW_PREFIX}${rawMessage}` : rawMessage) as StatusError
  const resolved = overflow ? 400 : status
  if (typeof resolved === 'number') e.status = resolved
  e.__openrouter = true
  return e
}

const OVERFLOW_PREFIX = 'prompt is too long: '

function isOpenRouterError(err: unknown): err is StatusError {
  return !!(err as StatusError)?.__openrouter
}

// Observed: 400 "reasoning.effort: Invalid option: …"; documented: 400 "Reasoning is mandatory …" (effort none on Opus/Sonnet 5.5). Only these phrasings count, so an unrelated 400 that mentions reasoning is not retried.
function isReasoningRejection(err: unknown): boolean {
  if (!isOpenRouterError(err) || err.status !== 400) return false
  return /reasoning\.effort|reasoning is mandatory/i.test(err.message) && !err.message.startsWith(OVERFLOW_PREFIX)
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
