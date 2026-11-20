import { sanitizeTitle } from './rows.js'
import type { Listed, Severity, ThreadEntry } from './types.js'

export const MAX_LIST_ROWS = 40
const MAX_GIST = 160

const RANK: Record<Severity, number> = { HIGH: 2, MEDIUM: 1, LOW: 0 }
const rank = (s: string): number => RANK[s as Severity] ?? 0

export interface PriorItems { n: number; commit: string; entries: readonly ThreadEntry[]; summaryOnly: readonly Listed[] }

const where = (file?: string, lines?: string): string => (file ? `${file}${lines ? `:${lines}` : ''} · ` : '')
const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim()

function gistOf(l: Listed): string {
  const g = oneLine(l.gist)
  const text = g.length > MAX_GIST ? g.slice(0, MAX_GIST - 1).trimEnd() + '…' : g
  return text ? `${sanitizeTitle(l.title)}: ${text}` : sanitizeTitle(l.title)
}

// Open rows keep priority over resolved and summary-only ones, and within each group the most severe and newest stay.
export function buildPrior(items: PriorItems, files?: readonly string[]): { block: string } | undefined {
  const keep = (file?: string): boolean => !files || (file !== undefined && files.includes(file))
  const entries = items.entries.filter(e => keep(e.file))
  const open = entries.filter(e => !e.resolved).sort((a, b) => rank(b.severity) - rank(a.severity) || b.k - a.k)
  const resolved = entries.filter(e => e.resolved).sort((a, b) => rank(b.severity) - rank(a.severity) || b.k - a.k)
  const noted = items.summaryOnly.filter(l => keep(l.file))

  const room = (used: number): number => Math.max(0, MAX_LIST_ROWS - used)
  const openKept = open.slice(0, MAX_LIST_ROWS)
  const notedKept = noted.slice(0, room(openKept.length))
  const resolvedKept = resolved.slice(0, room(openKept.length + notedKept.length))
  if (openKept.length + notedKept.length + resolvedKept.length === 0) return undefined

  const out = [`## Already Reported on This PR (Review #${items.n}, commit ${items.commit}):`]
  const threadLine = (e: ThreadEntry): string => `[${e.id}] ${e.severity} · ${where(e.file, e.lines)}${sanitizeTitle(e.title)}`
  if (openKept.length) {
    out.push('These findings already have threads; do not report them again, even if still present:', ...openKept.map(threadLine))
  }
  if (notedKept.length) {
    out.push('Noted earlier without a thread; report each again in findings if it is still present:',
      ...notedKept.map(l => `- ${l.severity} · ${where(l.file, l.lines)}${gistOf(l)}`))
  }
  if (resolvedKept.length) {
    out.push('Resolved by a developer; report one again only if it is now more severe than listed:', ...resolvedKept.map(threadLine))
  }
  return { block: out.join('\n') }
}
