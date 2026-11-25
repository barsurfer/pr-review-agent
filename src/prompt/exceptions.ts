import { DEFAULT_EXCEPTIONS } from './defaults.js'

// A side table, not a LoadedPrompt field, so the shape every prompt consumer and fixture sees is unchanged.
const table = new WeakMap<object, string>()

export function rememberExceptions<T extends object>(prompt: T, exceptions: string | undefined): T {
  if (exceptions) table.set(prompt, exceptions)
  return prompt
}

export const exceptionsOf = (prompt: object | undefined): string => (prompt && table.get(prompt)) || DEFAULT_EXCEPTIONS
