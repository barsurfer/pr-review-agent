// Thin seam over the model API — keeps provider SDKs in one place so a second backend is a new
// impl, not a re-plumb. Anthropic (native SDK) and OpenRouter (OpenAI-compatible, via axios) today.
import { config } from '../config.js'
import { AnthropicProvider } from './anthropic-provider.js'
import { OpenRouterProvider } from './openrouter-provider.js'
import type { LLMProvider } from './shared.js'

export type { LLMProvider, LLMUsage, LLMOptions } from './shared.js'
export { TruncatedResponseError, missingRequired } from './shared.js'
export { anthropicBaseUrl, anthropicClientOptions } from './anthropic-provider.js'

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
