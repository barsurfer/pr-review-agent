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
