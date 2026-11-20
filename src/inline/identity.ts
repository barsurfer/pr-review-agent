import type { AgentIdentity } from '../vcs/adapter.js'

export type IdentityResult =
  | { status: 'api' | 'setting_only'; ids: string[]; names: string[]; agentId: string }
  | { status: 'unavailable' }
  | { status: 'identity_mismatch'; reason: string }

const norm = (id: string): string => id.trim().replace(/[{}]/g, '')

// The signing id is the adapter's first id when it has one, so it never depends on which form the setting uses.
export function resolveIdentity(api: AgentIdentity | null | undefined, setting: string): IdentityResult {
  const configured = norm(setting)
  const ids = (api?.ids ?? []).map(norm).filter(Boolean)
  if (ids.length > 0) {
    if (configured && !ids.includes(configured)) {
      return { status: 'identity_mismatch', reason: 'AGENT_ACCOUNT_ID does not match the adapter identity' }
    }
    return { status: 'api', ids, names: api?.names ?? [], agentId: ids[0] }
  }
  if (configured) return { status: 'setting_only', ids: [configured], names: [], agentId: configured }
  return { status: 'unavailable' }
}

export const isTrusted = (ids: readonly string[], authorIds: readonly string[]): boolean => {
  const trusted = new Set(ids)
  return authorIds.some(a => trusted.has(norm(a)))
}
