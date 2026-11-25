import { isContextLengthError } from '../review/parsers.js'

export interface LLMUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  // Provider-reported USD for the call (OpenRouter with usage.include); unset for Anthropic, which
  // has no cost field — callers fall back to the static pricing table when this is absent.
  cost_usd?: number
  // Subset of output_tokens spent on reasoning, set only when the provider reports a positive count.
  reasoning_tokens?: number
  // Each attempt of a resent call (prompt cache only), so cost estimates apply Haiku 5.5's prompt-size tier per request, not to the sum.
  attempts?: LLMUsage[]
  // The accepted response's reported reasoning count, 0 included (absent = unknown); set only on feature-enabled cached calls and never summed.
  final_reasoning_tokens?: number
}

export type UserPart = { text: string; cache?: true }

export interface LLMOptions {
  model: string
  maxTokens: number
  maxRetries: number
  effort?: string   // Anthropic output_config.effort / OpenRouter reasoning.effort (low|medium|high|xhigh|max); unset = model default
  tolerateMissing?: string[]
  signal?: AbortSignal
  systemAfter?: string
  sessionId?: string
  effortAfter?: string
  keepEffort?: true
}

export interface LLMProvider {
  complete(system: string, user: string, opts: LLMOptions): Promise<{ text: string; usage: LLMUsage }>
  completeStructured<T>(system: string, user: string | UserPart[], schema: Record<string, unknown>, opts: LLMOptions): Promise<{ object: T; usage: LLMUsage }>
}

const withoutFinalReasoning = ({ final_reasoning_tokens: _f, ...rest }: LLMUsage): LLMUsage => rest

// The aggregate omits cost_usd unless every attempt reported one, so a mixed set is priced attempt by attempt instead of undercounted.
export function sumAttempts(...usages: LLMUsage[]): LLMUsage {
  const attempts = usages.flatMap(u => u.attempts ?? [withoutFinalReasoning(u)])
  const sum = (pick: (u: LLMUsage) => number | undefined): number => attempts.reduce((n, a) => n + (pick(a) ?? 0), 0)
  const reasoning = sum(a => a.reasoning_tokens)
  return {
    input_tokens: sum(a => a.input_tokens),
    output_tokens: sum(a => a.output_tokens),
    cache_read_input_tokens: sum(a => a.cache_read_input_tokens),
    cache_creation_input_tokens: sum(a => a.cache_creation_input_tokens),
    ...(attempts.every(a => a.cost_usd !== undefined) ? { cost_usd: sum(a => a.cost_usd) } : {}),
    ...(reasoning > 0 ? { reasoning_tokens: reasoning } : {}),
    attempts,
  }
}

export const hasCachePart = (user: string | UserPart[]): boolean => Array.isArray(user) && user.some(p => p.cache)

// Carries the usage of a truncated response so the caller can still record real token counts
// (and the stop reason) instead of logging a zeroed, near-empty error record.
export class TruncatedResponseError extends Error {
  constructor(message: string, readonly usage: LLMUsage) {
    super(message)
    this.name = 'TruncatedResponseError'
  }
}

export type ContentFilterSignal = 'native_refusal' | 'content_filter' | 'message_refusal' | 'moderation'

export interface ContentFilterDetails {
  signal: ContentFilterSignal
  nativeFinishReason?: string
  category?: string
  reasons?: string[]
  httpStatus?: number
  usage?: LLMUsage
}

// A refusal repeats for the same input, so nothing may retry or resend it; flagged_input is customer code and is never kept.
export class ContentFilterError extends Error {
  readonly signal: ContentFilterSignal
  readonly nativeFinishReason?: string
  readonly category?: string
  readonly reasons?: string[]
  readonly httpStatus?: number
  usage?: LLMUsage

  constructor(d: ContentFilterDetails) {
    super(`The model's safety filters declined the request (${d.signal}${d.category ? `, ${d.category}` : ''})`)
    this.name = 'ContentFilterError'
    this.signal = d.signal
    if (d.nativeFinishReason !== undefined) this.nativeFinishReason = d.nativeFinishReason
    if (d.category !== undefined) this.category = d.category
    if (d.reasons?.length) this.reasons = d.reasons
    if (d.httpStatus !== undefined) this.httpStatus = d.httpStatus
    if (d.usage) this.usage = d.usage
  }
}

// A benchmark pass deadline fired; kept apart from TruncatedResponseError and transport errors so the stage records aborted_time, not failed.
export class DeadlineAbortError extends Error {
  // Usage of attempts that finished before the abort, kept apart from the aborted stream's partial usage.
  completed?: LLMUsage

  constructor(message: string, readonly usage?: LLMUsage) {
    super(message)
    this.name = 'DeadlineAbortError'
  }
}

// OpenRouter's rejection wording is unverified, so any non-overflow 400 on a systemAfter call counts
export const isSystemMessageRejection = (err: unknown): boolean => (err as { status?: number } | null)?.status === 400 && !isContextLengthError(err)

// Required root keys the object is missing ([] from a schema-honoring provider). `deep` also flags
// dropped array-item required keys (findings[].severity) a strict:false provider can omit while
// satisfying the root — countFindings/applyJudgeDecisions assume those exist.
export function missingRequired(object: unknown, schema: Record<string, unknown>, deep = false, tolerate: readonly string[] = []): string[] {
  const required = (schema.required as string[] | undefined) ?? []
  const obj = (object ?? {}) as Record<string, unknown>
  const missing = required.filter(k => obj[k] === undefined && !tolerate.includes(k))
  if (!deep) return missing
  const props = (schema.properties ?? {}) as Record<string, { items?: { required?: string[] } }>
  for (const [key, prop] of Object.entries(props)) {
    const itemRequired = prop?.items?.required
    if (!itemRequired || tolerate.includes(key) || !Array.isArray(obj[key])) continue
    ;(obj[key] as unknown[]).forEach((el, i) => {
      const elObj = (el ?? {}) as Record<string, unknown>
      for (const rk of itemRequired) if (elObj[rk] === undefined) missing.push(`${key}[${i}].${rk}`)
    })
  }
  return missing
}

// An empty reply with no refusal signal is a broken call, not an answer worth posting.
export function requireText(text: string, usage: LLMUsage): string {
  if (text.trim() === '') throw Object.assign(new Error('Model returned empty text'), { usage })
  return text
}
