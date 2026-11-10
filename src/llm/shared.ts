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

// Carries the usage of a truncated response so the caller can still record real token counts
// (and the stop reason) instead of logging a zeroed, near-empty error record.
export class TruncatedResponseError extends Error {
  constructor(message: string, readonly usage: LLMUsage) {
    super(message)
    this.name = 'TruncatedResponseError'
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
