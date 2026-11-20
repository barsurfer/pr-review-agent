import { config } from '../config.js'

// Resolved at call time so benchmark labels apply; following the reviewer lets breadth share its prompt cache.
export function breadthPass(): { model: string; effort: string } {
  const { model, effort } = config.breadth
  return { model: model || config.anthropic.model, effort: effort || (model ? '' : config.review.effort) }
}
