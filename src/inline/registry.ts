import type { MarkedThread } from '../vcs/adapter.js'
import { SUMMARY_HEADER, LEGACY_HEADER_LINE, LEGACY_HEADER_TAG, parseRootMarker, parseAnswerMarker, parseNoteMarker, lastNonEmptyLine } from './markers.js'
import { verify } from './state.js'
import { parseRows } from './rows.js'
import { isTrusted } from './identity.js'
import type { IdentityResult } from './identity.js'
import type { SummaryState, ThreadEntry, Severity } from './types.js'

type OkIdentity = Extract<IdentityResult, { status: 'api' | 'setting_only' }>
type Root = MarkedThread['root']

const STATE_PREFIX = '*inline-state v1 |'
const firstLine = (body: string): string => body.replace(/\r\n/g, '\n').split('\n', 1)[0].trimEnd()

// Structural only: a quoted or substring marker never qualifies.
function isSummaryShaped(body: string): boolean {
  const first = firstLine(body)
  return first === SUMMARY_HEADER || first === LEGACY_HEADER_LINE || lastNonEmptyLine(body).startsWith(STATE_PREFIX)
}

// Narrow net for listMarkedThreads: roots with a finding marker and summary candidates; answers and notes come as descendants.
export const isInlineMarked = (body: string): boolean => parseRootMarker(body) !== null || isSummaryShaped(body)

export type SummarySelection =
  | { kind: 'none' }
  | { kind: 'found'; comment: Root; check: 'valid' | 'tampered'; state?: SummaryState; extras: number }

function strictlyValid(body: string, agentId: string): SummaryState | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  if (lines[0] !== SUMMARY_HEADER && (lines[0] !== LEGACY_HEADER_LINE || lines[1]?.trimEnd() !== LEGACY_HEADER_TAG)) return null
  return verify(body, agentId)
}

export function selectSummary(threads: readonly MarkedThread[], identity: OkIdentity): SummarySelection {
  const candidates = threads
    .map(t => t.root)
    .filter(r => !r.inline && isTrusted(identity.ids, r.authorIds) && isSummaryShaped(r.body))
    .sort((a, b) => a.seq - b.seq)
  if (candidates.length === 0) return { kind: 'none' }
  const comment = candidates[0]
  const state = strictlyValid(comment.body, identity.agentId)
  return state
    ? { kind: 'found', comment, check: 'valid', state, extras: candidates.length - 1 }
    : { kind: 'found', comment, check: 'tampered', extras: candidates.length - 1 }
}

const FIRST_LINE_RE = /^\*\*(HIGH|MEDIUM|LOW) – (.+?)\*\*(?: \(was (F[1-9][0-9]{0,5}), dismissed\))?$/
const GIST_MAX = 200

function parseRootText(body: string): { severity: Severity; title: string; was?: string; gist: string } {
  const lines = body.replace(/\r\n/g, '\n').trimEnd().split('\n')
  const m = FIRST_LINE_RE.exec(lines[0].trimEnd())
  const gist = lines.slice(1, -1).join(' ').replace(/\s+/g, ' ').trim().slice(0, GIST_MAX)
  return m
    ? { severity: m[1] as Severity, title: m[2], ...(m[3] ? { was: m[3] } : {}), gist }
    : { severity: 'MEDIUM', title: lines[0].replace(/\s+/g, ' ').trim().slice(0, 100), gist }
}

export interface Registry {
  status: 'ok'
  summary: SummarySelection
  entries: ThreadEntry[]
  nextK: number
  untrusted: number
}
export interface RegistryMismatch { status: 'identity_mismatch'; reason: string; untrusted: number }

export function buildRegistry(threads: readonly MarkedThread[], identity: OkIdentity): Registry | RegistryMismatch {
  let untrusted = 0
  let untrustedStructural = 0
  for (const t of threads) {
    const trustedRoot = isTrusted(identity.ids, t.root.authorIds)
    if (!trustedRoot && (parseRootMarker(t.root.body) || (!t.root.inline && isSummaryShaped(t.root.body)))) { untrusted++; untrustedStructural++ }
    for (const c of t.comments) {
      if (!isTrusted(identity.ids, c.authorIds) && (parseAnswerMarker(c.body) || parseNoteMarker(c.body))) untrusted++
    }
  }
  // Under a setting-only identity the setting itself may be wrong, so a foreign marker author is a stop, not noise.
  if (identity.status === 'setting_only' && untrustedStructural > 0) {
    return { status: 'identity_mismatch', reason: 'marker comments by an author outside AGENT_ACCOUNT_ID', untrusted }
  }

  const summary = selectSummary(threads, identity)
  const rows = summary.kind === 'found' && summary.check === 'valid' ? parseRows(summary.comment.body) : null
  const rowById = new Map(rows?.threads.map(r => [r.id, r]) ?? [])

  const entries: ThreadEntry[] = []
  let maxK = 0
  const bump = (id: string): void => { maxK = Math.max(maxK, Number(id.slice(1))) }
  for (const r of rows?.threads ?? []) bump(r.id)
  for (const r of rows?.resolved ?? []) bump(r.id)
  for (const id of rows?.overflow && 'ids' in rows.overflow ? rows.overflow.ids : []) bump(id)

  for (const t of threads) {
    const marker = parseRootMarker(t.root.body)
    if (!marker || !isTrusted(identity.ids, t.root.authorIds)) continue
    bump(marker.id)
    const text = parseRootText(t.root.body)
    const row = rowById.get(marker.id)
    const line = t.root.inline?.line
    entries.push({
      id: marker.id,
      k: Number(marker.id.slice(1)),
      severity: text.severity,
      title: text.title,
      gist: text.gist,
      // The row's path, lines and base were saved together; the thread's own path may be a different revision's.
      file: row?.file ?? t.root.inline?.path ?? '',
      ...(row ? (row.lines ? { lines: row.lines } : {}) : line !== undefined ? { lines: String(line) } : {}),
      openedAt: row ? row.base : marker.openedAt,
      markerAt: marker.openedAt,
      ...(t.root.inline ? { anchor: { path: t.root.inline.path, ...(line !== undefined ? { line } : {}) } } : {}),
      ...(text.was ? { was: text.was } : {}),
      rootId: t.root.id,
      url: t.root.url,
      resolved: t.resolved,
      humanComments: t.comments.filter(c => !isTrusted(identity.ids, c.authorIds)).length,
    })
  }
  entries.sort((a, b) => a.k - b.k)
  return { status: 'ok', summary, entries, nextK: maxK + 1, untrusted }
}
