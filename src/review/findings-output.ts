// Machine-readable findings report: review outcome → { pr, agent, findings[] } of file+line findings.
// Written to RB_OUT for the ReviewBench harness today; the same shape suits any other consumer
// (e.g. an HTTP endpoint returning findings for another agent).

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { ReviewFinding, FindingScore } from './formatter.js'

export interface ReportFinding {
  file: string
  start_line: number
  end_line: number
  message: string
  producer: string
}

/** The judge's kept findings reconciled with their anchors — the canonical kept set any consumer
 *  reads (benchmark findings.json, inline PR comments, a findings endpoint). Unlike the posted
 *  markdown, every entry here carries a structured file/line when one exists. */
export interface KeptFinding {
  severity: 'LOW' | 'MEDIUM' | 'HIGH'
  title: string
  body: string
  file?: string
  lines?: string
  score?: number
  anchorSource?: 'reviewer' | 'judge' | 'none'   // where file/lines came from, so a consumer can trust only what it wants
}

export interface FindingsReport {
  pr: { repo: string; pr_number: number; base: string; head: string }
  agent: string
  findings: ReportFinding[]
}

export interface ReportPR {
  repo: string
  prNumber: string
  base: string
  head: string
}

// Lenient on the model's notation: any line numbers present ("L10-L12", "40, 12") collapse to their min..max span.
export function parseLineRange(lines: string | undefined): { start: number; end: number } | null {
  // Coerce rather than assume a string — a provider that doesn't enforce the schema could hand back a number/array.
  const nums = String(lines ?? '').match(/\d+/g)?.map(Number).filter(n => n > 0) ?? []
  if (nums.length === 0) return null
  return { start: Math.min(...nums), end: Math.max(...nums) }
}

// ReviewBench matches paths exactly, so a model-cited variant (b/ prefix, basename) is snapped to the diff's path.
export function normalizeFindingPath(file: string, changedPaths: readonly string[] = []): string {
  const path = file.trim().replace(/^`+|`+$/g, '').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').replace(/:\d+(?:-\d+)?$/, '')
  if (changedPaths.length === 0 || changedPaths.includes(path)) return path
  const unprefixed = path.replace(/^[ab]\//, '')
  if (changedPaths.includes(unprefixed)) return unprefixed
  const bySuffix = changedPaths.filter(p => p.endsWith('/' + path))
  return bySuffix.length === 1 ? bySuffix[0] : path
}

// The `### Findings` section body, line-anchored so a mid-line "C# findings" in the Summary can't match.
function findingsSection(judgedText: string): string {
  return judgedText.match(/(?:^|\n)#{1,4}\s*Findings\b([\s\S]*?)(?=\n#{1,4}\s|$)/i)?.[1] ?? ''
}

// Count of finding bullets in the Findings section — compared against emitted findings to flag a
// format drift that would otherwise score zero silently.
export function countFindingBullets(judgedText: string): number {
  return [...findingsSection(judgedText).matchAll(/^[ \t]*[-*]\s*\*\*(?:HIGH|MEDIUM|LOW)\b/gim)].length
}

// Pull `path:lines` citations from a finding's location paren — backtick-quoted items first (so a
// multi-file finding keeps every file), else comma-split.
export function citations(parens: string): { path: string; lines: string }[] {
  const backticked = [...parens.matchAll(/`([^`]+)`/g)].map(m => m[1])
  const items = backticked.length ? backticked : parens.replace(/^[(]|[)]$/g, '').split(',')
  const out: { path: string; lines: string }[] = []
  for (const raw of items) {
    const s = raw.trim()
    const at = s.lastIndexOf(':')
    if (at > 0 && /\d/.test(s.slice(at + 1))) out.push({ path: s.slice(0, at), lines: s.slice(at + 1) })
  }
  return out
}

interface JudgedBullet { title: string; body: string; message: string; located: boolean; rows: { file: string; start_line: number; end_line: number }[] }

// Every finding bullet in the judge's `### Findings` section with its citations (one row per cited
// file). `located` is false for a prose-only bullet; the merge pairs each kept score to its bullet by
// title + located, rather than guess by location.
function parseJudgedBullets(judgedText: string, changedPaths: readonly string[]): JudgedBullet[] {
  const out: JudgedBullet[] = []
  const seen = new Set<string>()
  for (const block of findingsSection(judgedText).split(/\n(?=[ \t]*[-*]\s*\*\*(?:HIGH|MEDIUM|LOW)\b)/i)) {
    const head = block.match(/^[ \t]*[-*]\s*\*\*(?:HIGH|MEDIUM|LOW)\s*[–—-]\s*([\s\S]+?)\*\*[ \t]*(\([^\n]*\))?/i)
    if (!head) continue
    const title = head[1].replace(/\s+/g, ' ').trim()
    const body = block.slice(head[0].length).replace(/\s+/g, ' ').trim()
    const rows: JudgedBullet['rows'] = []
    let anchored = false   // the bullet carried a valid citation — true even if its row dedups away against an earlier bullet
    for (const c of citations(head[2] ?? '')) {
      const file = normalizeFindingPath(c.path, changedPaths)
      const range = parseLineRange(c.lines)
      if (!file || !range) continue
      anchored = true
      const key = `${file}:${range.start}-${range.end}:${title}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({ file, start_line: range.start, end_line: range.end })
    }
    out.push({ title, body, message: body ? `${title}: ${body}` : title, located: anchored, rows })
  }
  return out
}

// Kept findings read straight from the judge's final review_markdown — its own titles, bodies and
// location citations, rather than re-matching onto the reviewer's findings (a lossy join).
export function findingsFromJudgedMarkdown(judgedText: string, producer: string, changedPaths: readonly string[] = []): ReportFinding[] {
  return parseJudgedBullets(judgedText, changedPaths).flatMap(b => b.rows.map(r => ({ file: r.file, start_line: r.start_line, end_line: r.end_line, message: b.message, producer })))
}

// The schema requires file + line range, so PR-level findings have no place in it and are dropped.
export function mapFindings(findings: ReviewFinding[], producer: string, changedPaths: readonly string[] = []): ReportFinding[] {
  const out: ReportFinding[] = []
  for (const f of findings) {
    const file = f.file ? normalizeFindingPath(f.file, changedPaths) : ''
    const range = parseLineRange(f.lines)
    if (!file || !range) continue
    out.push({ file, start_line: range.start, end_line: range.end, message: `${f.title.trim()}: ${f.body.trim()}`, producer })
  }
  return out
}

// Common title words that carry no signal for matching — kept out of the overlap so a shared "the"
// or "in" can't bind two unrelated findings.
const STOPWORDS = new Set(['a', 'an', 'the', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'is', 'are', 'be', 'not', 'no', 'with', 'without', 'that', 'this', 'it', 'its', 'as', 'at', 'by', 'from', 'when', 'if'])
// Unicode-aware so a non-ASCII title doesn't collapse to an empty string (which would falsely match).
const normTitle = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const titleWords = (s: string): string[] => normTitle(s).split(' ').filter(w => w && !STOPWORDS.has(w))

// Strip a model's decoration (backticks, backslashes, a trailing ":line" the judge sometimes welds
// onto the path) so a judge-supplied file can be compared and used as an anchor.
function cleanFile(f: string | undefined): string | undefined {
  if (!f) return undefined
  const s = f.trim().replace(/^`+|`+$/g, '').replace(/\\/g, '/').replace(/:\d+(?:-\d+)?$/, '')
  return s || undefined
}
// Lenient agreement — unknown on either side never contradicts; two known paths agree when equal or
// one is the other's path suffix (a b/ prefix or basename-only citation), but NOT a mere shared
// basename in different directories. Lets the judge's own anchor veto a loose match it disproves.
function filesAgree(a: string | undefined, b: string | undefined): boolean {
  const ca = cleanFile(a)?.toLowerCase(), cb = cleanFile(b)?.toLowerCase()
  if (!ca || !cb) return true
  return ca === cb || ca.endsWith('/' + cb) || cb.endsWith('/' + ca)
}

// Best reviewer match for a reframed kept title — ≥ 2 shared non-stopword words at ≥ 0.5 overlap, the
// judge's file vetoing a wrong-file candidate, ties broken by closest length then severity and
// abstaining when still even, so a vague title can never steal a specific finding's anchor by position.
function bestLooseMatch(score: FindingScore, revs: readonly ReviewFinding[], used: Set<number>): number {
  const sw = new Set(titleWords(score.title))
  if (!sw.size) return -1
  let best = -1, bSim = 0, bLen = Infinity, bSev = false, tie = false
  for (let i = 0; i < revs.length; i++) {
    if (used.has(i) || !filesAgree(score.file, revs[i].file)) continue
    const rw = new Set(titleWords(revs[i].title))
    if (!rw.size) continue
    let inter = 0
    for (const w of sw) if (rw.has(w)) inter++
    if (inter < 2) continue
    const sim = inter / Math.min(sw.size, rw.size)
    if (sim < 0.5) continue
    const lenDiff = Math.abs(rw.size - sw.size)
    const sev = revs[i].severity === score.severity
    if (sim > bSim || (sim === bSim && lenDiff < bLen) || (sim === bSim && lenDiff === bLen && sev && !bSev)) {
      best = i; bSim = sim; bLen = lenDiff; bSev = sev; tie = false
    } else if (best >= 0 && sim === bSim && lenDiff === bLen && sev === bSev) {
      tie = true   // two equally-good candidates and nothing to separate them → abstain, never guess by position
    }
  }
  return tie ? -1 : best
}

// The reviewer finding a kept score refers to by exact normalized title. Duplicate-title candidates
// are split by the judge's file then severity; a remaining tie ABSTAINS rather than guess by array
// order. Empty titles never match.
function exactMatch(score: FindingScore, revs: readonly ReviewFinding[], used: Set<number>): number {
  const nt = normTitle(score.title)
  if (!nt) return -1
  let best = -1, bFile = false, bSev = false, tie = false
  for (let i = 0; i < revs.length; i++) {
    if (used.has(i) || normTitle(revs[i].title) !== nt) continue
    const fileMatch = !!cleanFile(score.file) && !!cleanFile(revs[i].file) && filesAgree(score.file, revs[i].file)
    const sev = revs[i].severity === score.severity
    if (best < 0 || (fileMatch && !bFile) || (fileMatch === bFile && sev && !bSev)) {
      best = i; bFile = fileMatch; bSev = sev; tie = false
    } else if (fileMatch === bFile && sev === bSev) {
      tie = true
    }
  }
  return tie ? -1 : best
}

// Pair the judge's kept scores (which findings survived) with the reviewer's structured findings
// (where they are in the diff), driving from the scores so a title reframe never drops a kept finding.
// Exact titles are claimed before looser matches; the anchor is taken atomically from one source
// (reviewer pair, else judge pair, else none) and `anchorSource` records which. Reusable beyond the benchmark.
export function resolveKeptFindings(reviewerFindings: readonly ReviewFinding[], judgeScores: readonly FindingScore[]): KeptFinding[] {
  const used = new Set<number>()
  const match = new Array<number>(judgeScores.length).fill(-1)
  judgeScores.forEach((s, k) => { const i = exactMatch(s, reviewerFindings, used); if (i >= 0) { match[k] = i; used.add(i) } })
  judgeScores.forEach((s, k) => { if (match[k] < 0) { const i = bestLooseMatch(s, reviewerFindings, used); if (i >= 0) { match[k] = i; used.add(i) } } })
  return judgeScores.map((s, k) => {
    const rev = match[k] >= 0 ? reviewerFindings[match[k]] : undefined
    const revFile = cleanFile(rev?.file), judgeFile = cleanFile(s.file)
    // Take a COMPLETE file+line pair from one source — reviewer first (diff ground truth), else the
    // judge's own — never weld one source's file to the other's line. No complete pair → no anchor.
    let file: string | undefined, lines: string | undefined, anchorSource: KeptFinding['anchorSource'] = 'none'
    if (revFile && parseLineRange(rev?.lines)) { file = revFile; lines = rev!.lines; anchorSource = 'reviewer' }
    else if (judgeFile && parseLineRange(s.lines)) { file = judgeFile; lines = s.lines; anchorSource = 'judge' }
    return { severity: s.severity, title: s.title.trim(), body: (rev?.body ?? '').trim(), file, lines, score: s.score, anchorSource }
  })
}

// Kept findings → the line-anchored report shape. Findings with no usable file/line are dropped
// (the schema requires both), same as the reviewer/markdown mappers.
export function keptToReportFindings(kept: readonly KeptFinding[], producer: string, changedPaths: readonly string[] = []): ReportFinding[] {
  const out: ReportFinding[] = []
  const seen = new Set<string>()
  for (const k of kept) {
    if (!k.file || k.anchorSource === 'none') continue
    const file = normalizeFindingPath(k.file, changedPaths)
    const range = parseLineRange(k.lines)
    if (!file || !range) continue
    const key = `${file}:${range.start}-${range.end}:${k.title}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ file, start_line: range.start, end_line: range.end, message: k.body ? `${k.title}: ${k.body}` : k.title, producer })
  }
  return out
}

// Per-PR merge tally — exposed so the benchmark can warn on a certain silent drop (a finding the
// judge kept but nothing could anchor) instead of the old row-count check, which multi-citation and
// recovered rows mask. Counts are per score and mutually exclusive.
export interface MergeStats {
  bullets: number
  located: number
  prose: number
  scores: number
  rowsMarkdown: number
  rowsRecovered: number
  dupOfLocated: number      // recovery dropped because its bullet was already located
  recoveredPaired: number   // recovery kept + anchored, paired to a prose bullet
  recoveredUnpaired: number // recovery kept + anchored, no bullet matched (reframe/drift)
  unanchoredPaired: number  // prose bullet kept but neither side anchored it → CERTAIN drop
  unanchoredUnpaired: number// kept score, no bullet and no anchor → possible drop
  unscoredProse: number     // prose bullet no score claimed (e.g. empty finding_scores) → CERTAIN drop
}

// Markdown-located findings pass through untouched; each kept score is paired to its bullet by exact
// title and recovered only if that bullet was prose-only — recovering a finding the judge located as
// prose without double-counting one it already anchored, even amid distinct findings on the same lines.
// A recovered row whose reviewer body is empty borrows the judge's bullet text so it carries a real claim.
export function mergeJudgedFindingsWithStats(judgedText: string, reviewerFindings: readonly ReviewFinding[], judgeScores: readonly FindingScore[] | undefined, producer: string, changedPaths: readonly string[] = []): { findings: ReportFinding[]; stats: MergeStats } {
  const bullets = parseJudgedBullets(judgedText, changedPaths)
  const primary = bullets.flatMap(b => b.rows.map(r => ({ file: r.file, start_line: r.start_line, end_line: r.end_line, message: b.message, producer })))
  const located = bullets.filter(b => b.located).length
  const stats: MergeStats = {
    bullets: bullets.length, located, prose: bullets.length - located, scores: judgeScores?.length ?? 0,
    rowsMarkdown: primary.length, rowsRecovered: 0, dupOfLocated: 0,
    recoveredPaired: 0, recoveredUnpaired: 0, unanchoredPaired: 0, unanchoredUnpaired: 0, unscoredProse: 0,
  }
  if (!judgeScores?.length) {
    stats.unscoredProse = bullets.length - located
    return { findings: primary, stats }
  }
  const usedBullet = new Set<number>()
  const recovered = resolveKeptFindings(reviewerFindings, judgeScores).flatMap(k => {
    const anchored = k.anchorSource !== 'none' && !!k.file
    const kt = normTitle(k.title)
    const cands = kt ? bullets.map((_, i) => i).filter(i => !usedBullet.has(i) && normTitle(bullets[i].title) === kt) : []
    if (!cands.length) {
      if (anchored) stats.recoveredUnpaired++; else stats.unanchoredUnpaired++
      return [k]   // no matching bullet → keep the recovery (reframe/drift)
    }
    // Among same-title bullets, pair by identity not array order: a located bullet already anchoring
    // this recovery's file (the same finding, so drop it), else a prose bullet (the one we recover),
    // else any located bullet.
    const kf = k.file ? normalizeFindingPath(k.file, changedPaths) : ''
    const bi = cands.find(i => bullets[i].located && kf && bullets[i].rows.some(r => r.file === kf))
      ?? cands.find(i => !bullets[i].located)
      ?? cands[0]
    usedBullet.add(bi)
    if (bullets[bi].located) { stats.dupOfLocated++; return [] }   // duplicate of a located row → drop
    if (anchored) stats.recoveredPaired++; else stats.unanchoredPaired++
    // Prose bullet → recover; borrow the judge's validated bullet text when the reviewer gave none.
    return [{ ...k, title: bullets[bi].title, body: k.body || bullets[bi].body }]
  })
  stats.unscoredProse = bullets.filter((b, i) => !b.located && !usedBullet.has(i)).length
  const recoveredRows = keptToReportFindings(recovered, producer, changedPaths)
  stats.rowsRecovered = recoveredRows.length
  return { findings: [...primary, ...recoveredRows], stats }
}

export function mergeJudgedFindings(judgedText: string, reviewerFindings: readonly ReviewFinding[], judgeScores: readonly FindingScore[] | undefined, producer: string, changedPaths: readonly string[] = []): ReportFinding[] {
  return mergeJudgedFindingsWithStats(judgedText, reviewerFindings, judgeScores, producer, changedPaths).findings
}

export function buildFindingsReport(pr: ReportPR, agent: string, findings: ReportFinding[]): FindingsReport {
  return {
    pr: { repo: pr.repo, pr_number: Number(pr.prNumber), base: pr.base, head: pr.head },
    agent,
    findings,
  }
}

// Write-then-rename so a run killed mid-write never leaves a truncated findings file behind.
export function writeFindingsReport(path: string, report: FindingsReport): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n')
  renameSync(tmp, path)
}
