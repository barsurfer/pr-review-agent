import { isGeneratedOrLock } from './breadth.js'
import { normalizeIssueType, type IssueType, type ReviewFinding } from './formatter.js'
import { normalizeFindingPath, parseLineRange, type KeptFinding } from './findings-output.js'
import { isNumericLines } from './judge-decisions.js'
import type { Lens, SectionDef, SectionKind } from './lenses.js'
import { addedLines, parseChangedFiles } from './parsers.js'
import { sanitizeTitle } from '../inline/rows.js'
import type { SectionBlock, SectionRow } from './section-render.js'
import { LENS_REGISTRY } from './lenses.js'
import type { LensRun, ReviewContext } from './types.js'

type Severity = ReviewFinding['severity']

export type DropReason = 'unknown_kind' | 'excluded_file' | 'wrong_path' | 'too_wide' | 'not_added_line' | 'over_cap'

export interface SectionPlace {
  lens: string
  file: string
  start: number
  end: number
  label: string
  reason: string
  body: string
  severity: Severity
  type: IssueType
  kind?: string
  score?: number
  absorbed?: boolean
  dropped?: 'covered_by_finding' | 'covered_by_thread'
  shown?: boolean
}

export interface OpenAnchor { file: string; lines?: string }

export interface IntakeResult { received: number; places: SectionPlace[]; dropped: Record<DropReason, number> }

export interface IntakeEnv {
  filteredDiff: string
  fileContexts: ReadonlyArray<{ path: string }>
  deltaDiff?: string
}

const DOC_FILE = /\.(md|mdx|txt|rst|adoc)$/i
const VENDORED = /(^|\/)(vendor|third_party|node_modules|dist)\//
const TEST_PATH = [
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/, /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|cypress|playwright)\//, /_test\.(go|py|rb)$/,
  /(^|\/)test_[^/]+\.py$/, /Tests?\.(java|kt|cs|groovy|swift)$/, /Spec\.(groovy|kt|scala)$/, /_spec\.rb$/,
]
const isTestPath = (p: string): boolean => TEST_PATH.some(re => re.test(p))
const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const placeLines = (p: Pick<SectionPlace, 'start' | 'end'>): string => (p.end > p.start ? `${p.start}-${p.end}` : String(p.start))

function matchKind(kinds: readonly SectionKind[], title: string): { kind: SectionKind; reason: string } | null {
  for (const kind of kinds) {
    const m = new RegExp(`^\\s*${escapeRe(kind.label)}s?\\s*[:–—-]\\s*(\\S[\\s\\S]*)$`, 'i').exec(title)
    if (m) return { kind, reason: m[1].trim() }
  }
  return null
}

function splitLines(lines: string | undefined): Array<{ start: number; end: number }> | null {
  if (!isNumericLines(lines)) return null
  const out: Array<{ start: number; end: number }> = []
  for (const item of String(lines).split(',')) {
    const m = /^\s*L?(\d+)(?:\s*[-–—]\s*L?(\d+))?\s*$/i.exec(item)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    out.push({ start: Math.min(a, b), end: Math.max(a, b) })
  }
  return out
}

export const addedByFile = (diff: string): Map<string, Set<number>> => {
  const out = new Map<string, Set<number>>()
  for (const l of addedLines(diff)) {
    const key = normalizeFindingPath(l.file)
    out.set(key, (out.get(key) ?? new Set()).add(l.line))
  }
  return out
}

export function intakeSection(lens: Lens, findings: readonly ReviewFinding[], env: IntakeEnv): IntakeResult {
  const def = lens.section
  const dropped: Record<DropReason, number> = { unknown_kind: 0, excluded_file: 0, wrong_path: 0, too_wide: 0, not_added_line: 0, over_cap: 0 }
  const changed = parseChangedFiles(env.filteredDiff)
  const paths = changed.map(f => f.path)
  const status = new Map(changed.map(f => [f.path, f.status]))
  const added = addedByFile(env.deltaDiff || env.filteredDiff)
  const shownFiles = new Set(env.fileContexts.map(c => normalizeFindingPath(c.path, paths)))
  const places: SectionPlace[] = []

  for (const f of findings) {
    if (!f || typeof f !== 'object') continue
    const title = String(f.title ?? '')
    let label: string = f.severity
    let reason = title
    let kind: SectionKind | undefined
    if (def.kinds) {
      const hit = matchKind(def.kinds, title)
      if (!hit) { dropped.unknown_kind++; continue }
      kind = hit.kind
      label = hit.kind.label
      reason = hit.reason
    }
    const file = f.file ? normalizeFindingPath(f.file, paths) : ''
    if (!file || !paths.includes(file) || status.get(file) === 'deleted' || DOC_FILE.test(file) || isGeneratedOrLock(file) || VENDORED.test(file)) { dropped.excluded_file++; continue }
    if (kind && ((kind.path === 'test' && !isTestPath(file)) || (kind.path === 'non_test' && isTestPath(file)) || (kind.path === 'fully_shown' && status.get(file) !== 'added' && !shownFiles.has(file)))) { dropped.wrong_path++; continue }
    const spans = splitLines(f.lines)
    if (!spans) { dropped.not_added_line++; continue }
    const reported: Severity = Object.hasOwn(SEVERITY_RANK, f.severity) ? f.severity : 'LOW'
    const severity: Severity = 'fixed' in def.severity ? def.severity.fixed : SEVERITY_RANK[reported] > SEVERITY_RANK[def.severity.max] ? def.severity.max : reported
    for (const span of spans) {
      if (def.maxPlaceLines && span.end - span.start + 1 > def.maxPlaceLines) { dropped.too_wide++; continue }
      const lines = added.get(file)
      let ok = !!lines
      if (lines) {
        if (def.addedLines === 'all') { for (let n = span.start; n <= span.end && ok; n++) ok = lines.has(n) } else { ok = false; for (let n = span.start; n <= span.end && !ok; n++) ok = lines.has(n) }
      }
      if (!ok) { dropped.not_added_line++; continue }
      places.push({
        lens: lens.name, file, ...span, label, reason, body: String(f.body ?? ''), severity,
        type: kind?.type ?? normalizeIssueType(f.type), ...(kind ? { kind: kind.label } : {}),
      })
    }
  }
  const cap = lens.cap ?? 25
  if (places.length > cap) { dropped.over_cap += places.length - cap; places.length = cap }
  return { received: findings.length, places, dropped }
}

// A place re-expressed as a finding, for a section lens placed in Findings: the validation above still ran, the main judge does the rest.
export const placeAsFinding = (p: SectionPlace): ReviewFinding => ({ severity: p.severity, title: `${p.label}: ${p.reason}`, file: p.file, lines: placeLines(p), body: p.body, type: p.type })

const intersects = (a: { start: number; end: number }, b: { start: number; end: number }): boolean => a.start <= b.end && b.start <= a.end

export function overlapsAnchor(file: string, range: { start: number; end: number }, anchors: readonly OpenAnchor[], paths: readonly string[]): boolean {
  return anchors.some(a => {
    const r = parseLineRange(a.lines)
    return !!r && normalizeFindingPath(a.file, paths) === file && intersects(r, range)
  })
}

const ABSORBABLE_TYPES: ReadonlySet<string> = new Set(['maintainability', 'tests', 'other'])

// Runs inside the judge; pure, because the judge may apply its decisions more than once and the last call is the one that stands.
export function makeRoute(sections: ReadonlyArray<{ def: SectionDef; places: readonly SectionPlace[] }>, open: readonly OpenAnchor[], paths: readonly string[]): { route: (kept: readonly KeptFinding[]) => Map<number, string>; absorbed: () => Map<SectionPlace, number> } {
  let last = new Map<SectionPlace, number>()
  const route = (kept: readonly KeptFinding[]): Map<number, string> => {
    const moved = new Map<number, string>()
    last = new Map()
    kept.forEach((k, n) => {
      if (k.severity !== 'LOW' || (k.type && !ABSORBABLE_TYPES.has(k.type)) || !k.file) return
      const range = parseLineRange(k.lines)
      const file = normalizeFindingPath(k.file, paths)
      if (!range || overlapsAnchor(file, range, open, paths)) return
      for (const s of sections) {
        if (!s.def.absorbLow) continue
        const place = s.places.find(p => p.file === file && !p.dropped && intersects(p, range))
        if (!place) continue
        moved.set(n, place.lens)
        last.set(place, (last.get(place) ?? 0) + 1)
        return
      }
    })
    return moved
  }
  return { route, absorbed: () => last }
}

const neutralize = (s: string): string => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/gi, '').replace(/@/g, '＠')

const ROW_BODY_CAP = 300

function bodyText(s: string): string {
  const flat = neutralize(s).replace(/\s+/g, ' ').replace(/^[\s\-*]+/, '').trim()
  return flat.length > ROW_BODY_CAP ? flat.slice(0, ROW_BODY_CAP - 1).trimEnd() + '…' : flat
}

const cap40 = (s: string): string => (s.length > 40 ? s.slice(0, 39) + '…' : s)

interface Group { file: string; label: string; places: SectionPlace[] }

function groupPlaces(places: readonly SectionPlace[]): { groups: Group[]; moreFiles: Map<Group, number> } {
  const byKey = new Map<string, Group>()
  for (const p of places) {
    const key = `${p.file}\u0000${p.label}`
    byKey.set(key, byKey.get(key) ?? { file: p.file, label: p.label, places: [] })
    byKey.get(key)!.places.push(p)
  }
  const moreFiles = new Map<Group, number>()
  const byLabel = new Map<string, Group[]>()
  for (const g of byKey.values()) byLabel.set(g.label, [...(byLabel.get(g.label) ?? []), g])
  const groups: Group[] = []
  for (const list of byLabel.values()) {
    if (list.length <= 3) { groups.push(...list); continue }
    const top = list.reduce((a, b) => (b.places.length > a.places.length ? b : a))
    moreFiles.set(top, list.length - 1)
    groups.push(top)
  }
  return { groups, moreFiles }
}

const firstStart = (g: Group): number => Math.min(...g.places.map(p => p.start))

// Flags the places a row really shows, so a place hidden behind the row cap is never reported as posted.
export function buildRows(def: SectionDef, places: readonly SectionPlace[]): { rows: SectionRow[]; hidden: number } {
  let rows: Array<{ file: string; start: number; row: SectionRow; shown: SectionPlace[] }>
  if (def.group) {
    const { groups, moreFiles } = groupPlaces(places)
    rows = groups.map(g => {
      const best = g.places.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a))
      const spans = [...g.places].sort((a, b) => a.start - b.start).map(placeLines).join(', ')
      const extra = moreFiles.get(g)
      return { file: g.file, start: firstStart(g), shown: g.places, row: { text: `- \`${g.file}:${cap40(spans)}\` · ${g.label} · ${sanitizeTitle(neutralize(best.reason))}${extra ? ` (+${extra} more files)` : ''}` } }
    })
  } else {
    rows = places.map(p => {
      const body = def.rowBody ? bodyText(p.body) : ''
      return { file: p.file, start: p.start, shown: [p], row: { text: `- \`${p.file}:${cap40(placeLines(p))}\` · ${p.label} · ${sanitizeTitle(neutralize(p.reason))}`, ...(body ? { body } : {}) } }
    })
  }
  rows.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.start - b.start)
  const shownRows = rows.slice(0, def.rowCap)
  for (const p of places) p.shown = false
  for (const r of shownRows) for (const p of r.shown) p.shown = true
  return { rows: shownRows.map(r => r.row), hidden: Math.max(0, rows.length - def.rowCap) }
}

export interface FinalizeInput {
  runs: readonly LensRun[]
  defs: ReadonlyMap<string, SectionDef>
  findings: ReadonlyArray<{ file?: string; lines?: string }>
  open: readonly OpenAnchor[]
  paths: readonly string[]
  posted: boolean
}

export interface SectionSummary { kept: number; absorbed_low: number; covered_by_finding: number; covered_by_thread: number; rows: number; rows_hidden: number; posted: number }

// The posted Findings are what a section place must not repeat; an unjudged review posts the reviewer's own list.
export function finalizeContextSections(ctx: ReviewContext, open: readonly OpenAnchor[], posted: boolean): SectionBlock[] {
  const defs = new Map((ctx.lensRuns ?? []).flatMap(r => (LENS_REGISTRY[r.name] ? [[r.name, LENS_REGISTRY[r.name].section] as const] : [])))
  const blocks = finalizeSections({ runs: ctx.lensRuns ?? [], defs, findings: ctx.judgedFindings ?? ctx.reviewObject?.findings ?? [], open, paths: (ctx.changedFiles ?? []).map(f => f.path), posted })
  ctx.sectionBlocks = blocks
  return blocks
}

// Called once the comment really went out, so a dry run or a stopped write never reports a row as posted.
export function markSectionsPosted(ctx: ReviewContext): void {
  ctx.sectionsPosted = true
  for (const r of ctx.lensRuns ?? []) if (r.section && r.places) r.section.posted = r.places.filter(p => p.shown && !p.dropped).length
}

// Mutates each run's places (coverage flags) and its section summary, and returns the blocks in ascending order.
export function finalizeSections(input: FinalizeInput): SectionBlock[] {
  const located = input.findings.flatMap(f => {
    const range = parseLineRange(f.lines)
    return f.file && range ? [{ file: normalizeFindingPath(f.file, input.paths), range }] : []
  })
  const blocks: SectionBlock[] = []
  for (const run of input.runs) {
    const def = input.defs.get(run.name)
    if (!def || run.placement !== 'section' || !run.sectionOk || !run.places) continue
    let byFinding = 0
    let byThread = 0
    for (const p of run.places) {
      p.dropped = undefined
      if (!p.absorbed && located.some(f => f.file === p.file && intersects(f.range, p))) { p.dropped = 'covered_by_finding'; byFinding++; continue }
      if (overlapsAnchor(p.file, p, input.open, input.paths)) { p.dropped = 'covered_by_thread'; byThread++ }
    }
    const left = run.places.filter(p => !p.dropped)
    const { rows, hidden } = buildRows(def, left)
    run.section = { kept: run.places.length, absorbed_low: run.absorbedLow ?? 0, covered_by_finding: byFinding, covered_by_thread: byThread, rows: rows.length, rows_hidden: hidden, posted: input.posted ? left.filter(p => p.shown).length : 0 }
    if (rows.length) blocks.push({ lens: run.name, heading: def.heading, legend: def.legend, order: def.order, rows, more: hidden })
  }
  return blocks.sort((a, b) => a.order - b.order)
}
