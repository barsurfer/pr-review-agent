import { PARTIAL_FILTER_LINE, CONTENT_FILTER_MARKER } from '../review/content-filter.js'
import { stripPreviousFooter, stripDeltaStats, stripJudgeNotes, stripPreamble, stripJenkinsMeta, isNoChange, renderFinding, type RenderedFinding } from '../review/formatter.js'
import { parseVerdictScore, scanTodos } from '../review/parsers.js'
import { PROPOSAL_CAP } from '../review/judge-decisions.js'
import { COMMENT_BUDGET, MAX_FENCE, fenceFor, fixCodeContent, fixFreeContent, renderFixBlock } from '../review/suggested-fix.js'
import { SUMMARY_HEADER, LEGACY_HEADER_LINE, LEGACY_HEADER_TAG, buildRootMarker, buildStateLine, stripGeneratedFooters } from './markers.js'
import { splitState, withState } from './state.js'
import {
  sanitizeTitle, MAX_HISTORY, threadRow, summaryOnlyRow, resolvedRow, overflowLine, historyLine, capHistory, parseThreadRow, parseResolvedRow, parseOverflow, parseHistoryLine, parseSummaryOnlyRow,
  type ThreadRow, type SummaryOnlyRow, type ResolvedRow,
} from './rows.js'
import type { Severity, SummaryState } from './types.js'

export const MAX_OPEN_ROWS = 50
const MIN_OPEN_ROWS = 10
const KEEP_SUMMARY_ONLY = 20
const MIN_HISTORY = 5
const PRE_FLOOR = 300
const TRUNC_MARGIN = 40
const OVERFLOW_IDS_MAX = 1500
const FINDINGS_HEADING = /^### Findings[ \t]*$/m

const RANK: Record<Severity, number> = { HIGH: 2, MEDIUM: 1, LOW: 0 }
const kOf = (id: string): number => Number(id.slice(1))

export type Guarded = { ok: true; cleaned: string; todoSection: string } | { ok: false; reason: 'empty_or_no_change' }

// Same stages and guards as the legacy POST_REVIEW, so a truncated or empty model reply is never turned into a summary.
export function cleanAndGuard(raw: string, opts: { judged: boolean; diff: string; todoScan: boolean }): Guarded {
  const cleaned = stripJenkinsMeta(stripPreamble(stripJudgeNotes(stripDeltaStats(stripPreviousFooter(raw)))))
  if (!cleaned.trim() || isNoChange(cleaned)) return { ok: false, reason: 'empty_or_no_change' }
  const tailOk = opts.judged ? parseVerdictScore(cleaned) !== null : /^#{1,4}\s*Unresolved Questions\b/im.test(cleaned)
  if (!tailOk) {
    throw new Error(`Review appears truncated — missing ${opts.judged ? 'Merge Confidence' : 'Unresolved Questions'} section; refusing to post a partial review`)
  }
  const todos = opts.todoScan ? scanTodos(opts.diff) : []
  const todoSection = todos.length ? '\n\n### TODOs Introduced\n' + todos.map(t => `- \`${t.file}:${t.line}\` — ${t.text}`).join('\n') : ''
  return { ok: true, cleaned, todoSection }
}

export interface RootInput { severity: Severity; title: string; body: string; id: string; c12: string; was?: string; fixBlock?: string; model?: string; build?: string }

export function rootBody(r: RootInput): string {
  const first = `**${r.severity} – ${sanitizeTitle(r.title)}**${r.was ? ` (was ${r.was}, dismissed)` : ''}`
  const text = stripGeneratedFooters(r.body).text
  return `${first}\n\n${text}${r.fixBlock ?? ''}\n\n${buildRootMarker(r.id, r.c12, { model: r.model, build: r.build })}`
}

export interface FixPart { block: string; body: string }

// Same acceptance rules as the legacy composer, so a proposal that would be rejected there never reaches a thread.
export function fixPart(f: { body: string; proposal?: string; bodyWithoutFix?: string }): FixPart | undefined {
  if (!f.proposal || f.proposal.length > PROPOSAL_CAP) return undefined
  const code = fixCodeContent(f.proposal)
  if (code === null) return undefined
  const body = f.bodyWithoutFix && fixFreeContent(f.bodyWithoutFix) !== null ? f.bodyWithoutFix : f.body
  const fence = fenceFor(code, body)
  return fence.length > MAX_FENCE ? undefined : { block: renderFixBlock(code, fence), body }
}

export const inlineFooter = (identity: string, model: string | undefined, n: number, c12: string, build?: string): string =>
  `---\n*Inline review by ${identity}${model ? ` (${model})` : ''} | Review ${n} | Commit ${c12}${build ? ` | Build ${build}` : ''}*`

const CONFIDENCE_LINE = /^#{1,4}\s*Merge Confidence:\s*\d+%\s*$/

// Composed text only, so the judged text keeps the score the truncation guard and the usage record read; a rule replaces the heading so the disclaimer stays a standalone notice.
export function stripMergeConfidence(plain: string): string {
  const lines = plain.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!CONFIDENCE_LINE.test(lines[i].trimEnd())) { out.push(lines[i]); continue }
    out.push('---')
  }
  return out.join('\n').trimEnd()
}

// Model text must not forge rows, the header or any marker, because rows and markers are read back as state.
function sanitizeNarrative(text: string): { text: string; removed: number } {
  const stripped = stripGeneratedFooters(text)
  let removed = stripped.removed
  const kept = stripped.text.split('\n').filter(line => {
    const t = line.trimEnd()
    // The partial-review line and the notice marker are added from flags, so a copy in the narrative would double or forge them.
    if (t === PARTIAL_FILTER_LINE || t === CONTENT_FILTER_MARKER) return false
    const forged = t === SUMMARY_HEADER || t === LEGACY_HEADER_LINE || t === LEGACY_HEADER_TAG || parseThreadRow(t) || parseResolvedRow(t) || parseOverflow(t) || parseHistoryLine(t) || parseSummaryOnlyRow(t)
    if (forged) removed++
    return !forged
  })
  return { text: kept.join('\n').trimEnd(), removed }
}

const GENERATED_SECTIONS = new Set(['### Resolved by developers', '### Review History'])
const INLINE_FOOTER_RE = /^\*Inline review by .*\*$/

// Null when the body has no narrative to reuse (no Findings heading, an empty lead, or the collapsed overflow form).
export function carryNarrative(body: string): string | null {
  const split = splitState(body)
  if (!split) return null
  const lines = split.above.split('\n')
  const footer = lines.map(l => INLINE_FOOTER_RE.test(l.trimEnd())).lastIndexOf(true)
  const kept = footer < 0 ? lines : lines.slice(0, lines[footer - 1]?.trim() === '---' ? footer - 1 : footer)
  let fenced = false
  const at = kept.findIndex(l => {
    if (/^[ \t]*(`{3,}|~{3,})/.test(l)) fenced = !fenced
    return !fenced && l.trimEnd() === '### Findings'
  })
  if (at < 0) return null
  // 0.0.63/0.0.64 bodies carry a second header line (the tag); the current layout has one heading only.
  const first = lines[0]?.trimEnd()
  const headerLines = first === SUMMARY_HEADER ? 1 : first === LEGACY_HEADER_LINE && lines[1]?.trimEnd() === LEGACY_HEADER_TAG ? 2 : -1
  if (headerLines < 0) return null
  // An empty summary text is still a narrative: the old layout carried its heading, so the current one does too.
  const pre = kept.slice(headerLines, at).join('\n').trim() || (headerLines === 1 ? '### Summary' : '')
  if (!pre) return null
  let i = at + 1
  while (i < kept.length && !kept[i].startsWith('### ')) i++
  const post: string[] = []
  let skip = false
  for (; i < kept.length; i++) {
    const t = kept[i].trimEnd()
    if (t.startsWith('### ')) skip = GENERATED_SECTIONS.has(t)
    if (!skip) post.push(kept[i])
  }
  const tail = post.join('\n').trim()
  return `${pre}\n\n### Findings\nNo findings.${tail ? `\n\n${tail}` : ''}`
}

function splitAtFindings(plain: string, findings: readonly RenderedFinding[]): { pre: string; post: string } {
  const block = findings.length ? findings.map(f => renderFinding(f)).join('\n\n') : 'No findings.'
  const exact = `### Findings\n${block}`
  const at = plain.indexOf(exact)
  if (at >= 0) return { pre: plain.slice(0, at), post: plain.slice(at + exact.length) }
  const heading = FINDINGS_HEADING.exec(plain)
  if (!heading) return { pre: plain, post: '' }
  const start = heading.index
  const next = /^### /m.exec(plain.slice(start + heading[0].length))
  const end = next ? start + heading[0].length + next.index : plain.length
  return { pre: plain.slice(0, start), post: plain.slice(end) }
}

// A cut can leave a fence open, which would swallow every row below it.
function closeFence(text: string): string {
  const fences = text.split('\n').filter(l => /^[ \t]*(`{3,}|~{3,})/.test(l)).length
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text
}

export interface ComposeInput {
  review: { plain: string; findings: readonly RenderedFinding[] }
  threads: readonly ThreadRow[]
  summaryOnly: readonly SummaryOnlyRow[]
  resolved: readonly ResolvedRow[]
  history: readonly string[]
  historyText: string
  todoSection: string
  declined?: boolean
  notice?: boolean
  footer: { identity: string; model?: string; build?: string }
  head12: string
  state: SummaryState
  agentId: string
  hideConfidence?: boolean
}

export interface ComposedSummary { body: string; removed: number; collapsed: number }

interface Params {
  history: number; resolved: boolean; titlesOnly: boolean; soKeep: number; openFull: number; overflowCount: boolean; cutAuto: boolean; todoKeep: number
}

const MIN_TODO_ITEMS = 10

// Added-line scans are unbounded, so the section gives way to a capped list and then to one count line.
function trimTodos(text: string, keep: number): string {
  if (!text) return text
  const [heading, ...items] = text.trim().split('\n')
  if (keep >= items.length) return text
  if (keep <= 0) return `${heading}\n- ${items.length} added; list omitted to fit the size limit`
  return [heading, ...items.slice(0, keep), `- and ${items.length - keep} more`].join('\n')
}

const bySeverity = (rows: ReadonlyArray<{ severity: Severity }>): string =>
  (['HIGH', 'MEDIUM', 'LOW'] as const).map(s => [s, rows.filter(r => r.severity === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ')

export function composeSummary(input: ComposeInput): ComposedSummary {
  const split = splitAtFindings(input.review.plain, input.review.findings)
  const pre = sanitizeNarrative(split.pre)
  pre.text = pre.text.replace(/^\s*### Summary[ \t]*(?:\n|$)/, '').trim()
  const post = sanitizeNarrative(split.post)
  if (input.hideConfidence) post.text = stripMergeConfidence(post.text)
  const todoText = input.todoSection ? sanitizeNarrative(input.todoSection).text : ''
  const removed = pre.removed + post.removed

  const open = [...input.threads].sort((a, b) => RANK[b.severity] - RANK[a.severity] || kOf(b.id) - kOf(a.id))
  const history = capHistory([...input.history, historyLine(input.state.n, input.head12, input.historyText)])
  const footer = inlineFooter(input.footer.identity, input.footer.model, input.state.n, input.head12, input.footer.build)
  const stateLen = buildStateLine(input.state.n, input.state.commits, '0'.repeat(16)).length
  const limit = COMMENT_BUDGET - 2 - stateLen

  let collapsed = 0
  const build = (p: Params, cut: number): string => {
    collapsed = 0
    const full = open.slice(0, p.openFull)
    const rest = open.slice(p.openFull).sort((a, b) => kOf(a.id) - kOf(b.id))
    collapsed += rest.length
    const findings: string[] = []
    if (full.length || rest.length) {
      findings.push('**Open threads: resolve when fixed**')
      const lines = full.map(r => threadRow(r))
      if (rest.length) {
        const ids = rest.map(r => r.id)
        lines.push(p.overflowCount || p.openFull === 0 ? `Also open: ${ids.length} more threads` : overflowLine(ids, OVERFLOW_IDS_MAX))
      }
      findings.push(lines.join('\n'))
    }
    if (input.summaryOnly.length) {
      const shown = input.summaryOnly.slice(0, p.soKeep)
      const hidden = input.summaryOnly.length - shown.length
      collapsed += hidden
      const lines = shown.map(r => summaryOnlyRow(r, p.titlesOnly))
      if (hidden) lines.push(`and ${hidden} more ${input.summaryOnly.every(r => r.severity === 'LOW') ? 'low-severity' : 'summary-only'} findings`)
      // Without the blank line Bitbucket renders the rows as plain text, not a list.
      findings.push('**Not posted as threads**\n\n' + lines.join('\n'))
    }
    if (!findings.length && !input.notice) findings.push('No findings.')
    if (input.declined) findings.push(PARTIAL_FILTER_LINE)

    let preText = pre.text
    let postText = post.text
    if (cut > 0) {
      const postCut = Math.min(cut, postText.length)
      if (postCut > 0) postText = closeFence(postText.slice(0, postText.length - postCut).trimEnd()) + '\n\n(truncated)'
      const left = cut - postCut
      if (left > 0 && preText.length > PRE_FLOOR) {
        preText = closeFence(preText.slice(0, Math.max(PRE_FLOOR, preText.length - left)).trimEnd()) + (postCut > 0 ? '' : '\n\n(truncated)')
      }
    }

    const parts = [
      SUMMARY_HEADER,
      input.notice ? CONTENT_FILTER_MARKER : '',
      preText,
      findings.length ? `### Findings\n${findings.join('\n\n')}` : '',
      postText,
      trimTodos(todoText, p.todoKeep),
      p.resolved && input.resolved.length ? `### Resolved by developers\n${input.resolved.map(r => resolvedRow(r)).join('\n')}` : '',
      `### Review History\n${history.slice(-p.history).join('\n')}`,
      footer,
    ].map(s => s.trim()).filter(Boolean)
    return parts.join('\n\n')
  }

  const fits = (s: string): boolean => s.length <= limit
  const render = (p: Params): string => {
    const first = build(p, 0)
    if (fits(first) || !p.cutAuto) return first
    return build(p, first.length - limit + TRUNC_MARGIN)
  }

  const p: Params = { history: MAX_HISTORY, resolved: true, titlesOnly: false, soKeep: Infinity, openFull: MAX_OPEN_ROWS, overflowCount: false, cutAuto: false, todoKeep: Infinity }
  const steps: Array<(x: Params) => void> = [
    x => { x.history = MIN_HISTORY },
    x => { x.resolved = false },
    x => { x.titlesOnly = true },
    x => { x.todoKeep = MIN_TODO_ITEMS },
    x => { x.cutAuto = true },
    x => { x.todoKeep = 0 },
    x => { x.soKeep = KEEP_SUMMARY_ONLY },
    x => { x.soKeep = 0 },
    x => { x.openFull = Math.min(x.openFull, MIN_OPEN_ROWS) },
    x => { x.overflowCount = true },
    x => { x.openFull = 0 },
  ]
  let body = render(p)
  for (const step of steps) {
    if (fits(body)) break
    step(p)
    body = render(p)
  }
  if (!fits(body)) {
    const so = input.summaryOnly
    const important = so.filter(r => r.severity !== 'LOW').sort((x, y) => RANK[y.severity] - RANK[x.severity])
    // Rows kept here are the only way a summary-only finding reaches the next run, so HIGH/MEDIUM go first and a count never replaces them while they fit.
    const fallback = (n: number): string => {
      const kept = important.slice(0, n)
      const hidden = so.filter(r => !kept.includes(r))
      collapsed = open.length + hidden.length
      const parts = [SUMMARY_HEADER]
      if (open.length) parts.push(`Also open: ${open.length} more threads\n(${bySeverity(open)})`)
      if (so.length) parts.push(['**Not posted as threads**', '', ...kept.map(r => summaryOnlyRow(r, true)), ...(hidden.length ? [`and ${hidden.length} more summary-only findings (${bySeverity(hidden)})`] : [])].join('\n'))
      if (!open.length && !so.length) parts.push('No findings.')
      return [...parts, footer].join('\n\n')
    }
    let n = 0
    while (n < important.length && fits(fallback(n + 1))) n++
    body = fallback(n)
  }
  return { body: withState(body, input.state, input.agentId), removed, collapsed }
}
