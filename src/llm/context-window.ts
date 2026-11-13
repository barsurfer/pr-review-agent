import axios from 'axios'
import { config, modelContextWindow } from '../config.js'
import { tableContextWindow } from './model-id.js'

const LOOKUP_TIMEOUT_MS = 5_000
const listedWindows = new Map<string, number>()
let resolved = false

// The override has always replaced the reviewer's window; for any other model it only fills in where the table has no entry, so a known window still caps the budget.
export function contextWindowFor(model: string, reviewer = false): number {
  const override = config.anthropic.modelContextTokens > 0 ? config.anthropic.modelContextTokens : 0
  const known = tableContextWindow(model) !== undefined
  if (override && (reviewer || !known)) return override
  return (!known && listedWindows.get(model)) || modelContextWindow(model)
}

// Once per CLI run, before the FSM: only a model outside the table can trigger the HTTP lookup, so table-known ids never cause a new call.
export async function resolveContextWindows(): Promise<void> {
  if (resolved) return
  resolved = true
  if (config.vcsProvider === 'reviewbench' || config.anthropic.modelContextTokens > 0) return
  const models = [config.anthropic.model, config.judge.model, config.breadth.enabled ? config.breadth.model : '', config.lenses.enabled ? config.lenses.model : '']
  const unknown = [...new Set(models.filter(m => m && tableContextWindow(m) === undefined))]
  if (!unknown.length) return
  if (config.llmProvider === 'openrouter') {
    try {
      const list = await fetchModelList()
      for (const m of unknown) {
        const window = listedWindow(list, m)
        if (window) listedWindows.set(m, window)
      }
    } catch (err: unknown) {
      console.warn(`Warning: could not read the OpenRouter model list (${(err as Error).message}) - using the 200K fallback context window for ${unknown.join(', ')}; set MODEL_CONTEXT_TOKENS to the real window`)
      return
    }
    if (listedWindows.size) console.log(`Context window from the OpenRouter model list: ${[...listedWindows].map(([m, w]) => `${m} ${w.toLocaleString()}`).join(', ')}`)
  }
  const fallback = unknown.filter(m => !listedWindows.has(m))
  if (fallback.length) console.warn(`Warning: no known context window for ${fallback.join(', ')} - using the 200K fallback; set MODEL_CONTEXT_TOKENS to the real window`)
}

interface ListedModel {
  id?: string
  canonical_slug?: string
  context_length?: number | null
  top_provider?: { context_length?: number | null } | null
}

async function fetchModelList(): Promise<ListedModel[]> {
  const resp = await axios.get<{ data?: unknown }>(`${config.openrouter.baseUrl.replace(/\/+$/, '')}/models`, { timeout: LOOKUP_TIMEOUT_MS })
  if (!Array.isArray(resp.data?.data)) throw new Error('unexpected response shape')
  return resp.data.data as ListedModel[]
}

// The default provider can serve less than the model's nominal window (qwen/qwen3.8-27b: 1,048,575 vs 262,144), so the smaller one wins.
function listedWindow(list: ListedModel[], model: string): number | undefined {
  const bare = model.replace(/:[\w-]+$/, '')
  const entry = list.find(e => e.id === model || e.canonical_slug === model) ?? list.find(e => e.id === bare || e.canonical_slug === bare)
  const limits = [entry?.context_length, entry?.top_provider?.context_length].filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
  return limits.length ? Math.min(...limits) : undefined
}
