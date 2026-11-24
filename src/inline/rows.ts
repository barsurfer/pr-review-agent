import type { Severity } from './types.js'

export const MAX_TITLE = 100
export const MAX_HISTORY = 20

const SEV = 'HIGH|MEDIUM|LOW'
const FID = 'F[1-9][0-9]{0,5}'

// Titles come from a model and sit inside bold markup, so whitespace is flattened and ** removed to keep rows parseable.
export function sanitizeTitle(t: string): string {
  const flat = t.replace(/\s+/g, ' ').replace(/\*{2,}/g, '*').trim()
  return flat.length > MAX_TITLE ? flat.slice(0, MAX_TITLE - 1).trimEnd() + '…' : flat
}

export interface ThreadRow {
  kind: 'thread'; severity: Severity; title: string; file: string; lines?: string; base: string
  id: string; was?: string; url: string; note?: CodeNote
}
export interface CodeNote { kind: 'line' | 'file' | 'deleted'; since: string }
export interface SummaryOnlyRow { kind: 'summary_only'; severity: Severity; title: string; file?: string; lines?: string; body?: string }
export interface ResolvedRow { kind: 'resolved'; id: string; severity: Severity; title: string }
export type OverflowRow = { kind: 'overflow'; ids: string[] } | { kind: 'overflow'; count: number }

const NOTE_WORD: Record<CodeNote['kind'], string> = { line: 'line changed', file: 'file changed', deleted: 'file deleted' }

const loc = (file: string, lines?: string): string => (lines ? `${file}:${lines}` : file)

export function threadRow(r: Omit<ThreadRow, 'kind'>): string {
  const was = r.was ? ` · was ${r.was} (dismissed)` : ''
  return `- **${r.severity} – ${sanitizeTitle(r.title)}** (\`${loc(r.file, r.lines)}@${r.base}\`) · ${r.id}${was} · [thread](${r.url})${r.note ? ` · ${NOTE_WORD[r.note.kind]} since ${r.note.since}` : ''}`
}

export function summaryOnlyRow(r: Omit<SummaryOnlyRow, 'kind'>, titleOnly = false): string {
  const where = r.file ? ` (\`${loc(r.file, r.lines)}\`)` : ''
  const head = `- **${r.severity} – ${sanitizeTitle(r.title)}**${where} · no thread`
  const body = r.body?.replace(/\s+/g, ' ').trim()
  return body && !titleOnly ? `${head}\n  ${body}` : head
}

export const resolvedRow = (r: Omit<ResolvedRow, 'kind'>): string => `- ${r.id} · resolved by a developer · ${r.severity} – ${sanitizeTitle(r.title)}`

export function overflowLine(ids: readonly string[], maxChars = Infinity): string {
  const list = `Also open: ${ids.join(', ')}`
  return list.length <= maxChars ? list : `Also open: ${ids.length} more threads`
}

const THREAD_RE = new RegExp(String.raw`^- \*\*(${SEV}) – (.+?)\*\* \(\`(.+)\`\) · (${FID})(?: · was (${FID}) \(dismissed\))? · \[thread\]\(([^)\s]+)\)(?: · (?:(line|file) changed since ([0-9a-f]{7})|file (deleted) since ([0-9a-f]{7})|changed in this push))?$`)
const LOC_RE = /^(.+?)(?::([0-9]+(?:-[0-9]+)?))?@([0-9a-f]{12})$/
const SUMMARY_ONLY_RE = new RegExp(String.raw`^- \*\*(${SEV}) – (.+?)\*\*(?: \(\`(.+?)\`\))? · no thread$`)
const PLAIN_LOC_RE = /^(.+?)(?::([0-9]+(?:-[0-9]+)?))?$/
const RESOLVED_RE = new RegExp(String.raw`^- (${FID}) · resolved by a developer · (${SEV}) – (.+)$`)
const OVERFLOW_RE = new RegExp(String.raw`^Also open: (?:(${FID}(?:, ${FID})*)|([0-9]+) more threads)$`)

export function parseThreadRow(line: string): ThreadRow | null {
  const m = THREAD_RE.exec(line)
  if (!m) return null
  const l = LOC_RE.exec(m[3])
  if (!l) return null
  return {
    kind: 'thread', severity: m[1] as Severity, title: m[2], file: l[1], ...(l[2] ? { lines: l[2] } : {}), base: l[3],
    id: m[4], ...(m[5] ? { was: m[5] } : {}), url: m[6],
    ...(m[7] ? { note: { kind: m[7] as 'line' | 'file', since: m[8] } } : m[9] ? { note: { kind: 'deleted' as const, since: m[10] } } : {}),
  }
}

export function parseResolvedRow(line: string): ResolvedRow | null {
  const m = RESOLVED_RE.exec(line)
  return m ? { kind: 'resolved', id: m[1], severity: m[2] as Severity, title: m[3] } : null
}

export function parseOverflow(line: string): OverflowRow | null {
  const m = OVERFLOW_RE.exec(line)
  if (!m) return null
  return m[1] ? { kind: 'overflow', ids: m[1].split(', ') } : { kind: 'overflow', count: Number(m[2]) }
}

export function parseSummaryOnlyRow(line: string, bodyLine?: string): SummaryOnlyRow | null {
  const m = SUMMARY_ONLY_RE.exec(line)
  if (!m) return null
  const l = m[3] ? PLAIN_LOC_RE.exec(m[3]) : null
  const body = bodyLine?.startsWith('  ') ? bodyLine.trim() : ''
  return { kind: 'summary_only', severity: m[1] as Severity, title: m[2], ...(l ? { file: l[1], ...(l[2] ? { lines: l[2] } : {}) } : {}), ...(body ? { body } : {}) }
}

export function parseRows(body: string): { threads: ThreadRow[]; summaryOnly: SummaryOnlyRow[]; resolved: ResolvedRow[]; overflow?: OverflowRow } {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const out: ReturnType<typeof parseRows> = { threads: [], summaryOnly: [], resolved: [] }
  lines.forEach((line, i) => {
    const t = parseThreadRow(line)
    if (t) { out.threads.push(t); return }
    const r = parseResolvedRow(line)
    if (r) { out.resolved.push(r); return }
    const o = parseOverflow(line)
    if (o) { out.overflow = o; return }
    const s = parseSummaryOnlyRow(line, lines[i + 1])
    if (s) out.summaryOnly.push(s)
  })
  return out
}

export function historyLine(n: number, c12: string, text: string): string {
  return `- Review ${n} · ${c12} · ${text.replace(/\s+/g, ' ').trim()}`
}

const HISTORY_RE = /^- Review ([0-9]+) · ([0-9a-f]{12}) · (.*)$/

export function parseHistoryLine(line: string): { n: number; c12: string; text: string } | null {
  const m = HISTORY_RE.exec(line)
  return m ? { n: Number(m[1]), c12: m[2], text: m[3] } : null
}

export function parseHistory(body: string): string[] {
  return body.replace(/\r\n/g, '\n').split('\n').filter(l => HISTORY_RE.test(l))
}

export const capHistory = (lines: readonly string[], max = MAX_HISTORY): string[] => lines.slice(-max)
