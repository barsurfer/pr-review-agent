// Dated ids resolve as their alias and OpenRouter names the same models anthropic/claude-sonnet-5.5[:variant]; import-free because config.ts uses it.
export function baseModelId(model: string): string {
  return model.replace(/^anthropic\//, '').replace(/:[\w-]+$/, '').replace(/\./g, '-').replace(/-\d{8}$/, '')
}

// Context windows (max_input_tokens, from the Models API): 4.5-gen = 200K, 4.6+/5.x = 1M; matched by id prefix.
const MODEL_CONTEXT_WINDOWS: readonly [string, number][] = [
  ['claude-haiku-4-5', 200_000],
  ['claude-sonnet-4-5', 200_000],
  ['claude-opus-4-5', 200_000],
  ['claude-haiku-5', 1_000_000],
  ['claude-sonnet-4-6', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-opus-4-6', 1_000_000],
  ['claude-opus-4-7', 1_000_000],
  ['claude-opus-4-8', 1_000_000],
  ['claude-opus-5', 1_000_000],
  ['claude-fable-5', 1_000_000],
  ['claude-mythos-5', 1_000_000],
]

const windowByPrefix = (model: string) => MODEL_CONTEXT_WINDOWS.find(([prefix]) => model.startsWith(prefix))?.[1]

// The raw id first, so every id that already resolved keeps its window; only misses are normalized.
export function tableContextWindow(model: string): number | undefined {
  return windowByPrefix(model) ?? windowByPrefix(baseModelId(model))
}

// Models probed to accept a mid-conversation system message, the only layout the prompt cache uses for an extra pass.
const SYSTEM_AFTER_MODELS = /^claude-(opus-5|opus-5-5|opus-4-8|fable-.+|mythos-.+|sonnet-5-5|haiku-5-5)$/

export const takesSystemAfter = (model: string): boolean => SYSTEM_AFTER_MODELS.test(baseModelId(model))

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// Models documented or probed to accept a per-message effort change (output_config on a mid-conversation system message).
const EFFORT_AFTER_MODELS = /^claude-(opus-5|opus-5-5|fable-5-[12]|mythos-5-[12]|sonnet-5-5|haiku-5-5)$/

export const takesEffortAfter = (model: string): boolean => EFFORT_AFTER_MODELS.test(baseModelId(model))
