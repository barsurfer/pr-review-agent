// Dated ids resolve as their alias and OpenRouter names the same models anthropic/claude-sonnet-5.5[:variant]; import-free because config.ts uses it.
export function baseModelId(model: string): string {
  return model.replace(/^anthropic\//, '').replace(/:[\w-]+$/, '').replace(/\./g, '-').replace(/-\d{8}$/, '')
}
