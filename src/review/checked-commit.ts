import { cliOrEnv } from './cli-value.js'

// 64 admits SHA-256 repositories; below 12 a value is too short to identify a head.
const HASH = /^[0-9a-f]{12,64}$/

export function isCheckedCommitHash(value: string): boolean {
  return HASH.test(value.toLowerCase())
}

export function resolveCheckedCommit(cli: string | undefined, env: string): string | undefined {
  const value = cliOrEnv(cli, env).toLowerCase()
  if (!value) return undefined
  if (isCheckedCommitHash(value)) return value
  console.warn(`Warning: ignoring the checked commit "${value.slice(0, 64)}" (--checked-commit/LAST_CHECKED_COMMIT) - expected 12 to 64 hex characters`)
  return undefined
}

// CI hands back the agent's own checked_commit, whose length depends on the VCS, so either side may be the abbreviated one.
export function headMatches(checked: string, sourceCommit: string): boolean {
  const head = sourceCommit.toLowerCase()
  const [short, long] = checked.length <= head.length ? [checked, head] : [head, checked]
  return short.length >= 12 && long.startsWith(short)
}
