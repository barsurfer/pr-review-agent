// The judge only classifies; policy lives here so one judged run can be re-scored offline under any flag combination.

import { renderReview, type ReviewFinding, type ReviewObject, type FindingScore } from './formatter.js'
import { normalizeFindingPath, parseLineRange, titlesOverlap, normTitle, isAnchored, type KeptFinding } from './findings-output.js'
import { addedLines, type AddedLine } from './parsers.js'
import { coversRange, shownFile, type ShownAnchors, type ShownSource } from './shown-anchors.js'
import type { AdditionalLocation } from './judge-quality.js'

export const REASON_CATEGORIES = [
  'validated', 'unconfirmed_high', 'chained_hypothetical',
  'incorrect', 'already_handled', 'unverifiable', 'style_only', 'low_value', 'minor', 'duplicate', 'out_of_scope',
  'framework_uncertainty',
] as const

export type ReasonCategory = typeof REASON_CATEGORIES[number]
type Severity = ReviewFinding['severity']

export interface JudgeDecision {
  candidate_id: string
  reason_category: ReasonCategory
  evidence: string
  note: string
  score: number
  rewritten_body?: string
  question?: string
  anchor_file?: string
  anchor_lines?: string
  anchor_quote?: string
  duplicate_of?: string
  additional_locations?: AdditionalLocation[]
  proposal?: unknown
}

export interface JudgeOutput {
  decisions: JudgeDecision[]
  summary: string
  behavioral_diff: string[]
  production_risk: string[]
  unresolved_questions: string[]
  merge_confidence: number
}

export interface JudgePolicy {
  keepMinor: boolean
  keepUnverified: boolean
  keepTestGaps?: boolean
}

export const DEFAULT_JUDGE_POLICY: JudgePolicy = { keepMinor: false, keepUnverified: false }

export type JudgeAction = 'keep' | 'downgrade' | 'drop' | 'move_to_unresolved'
type AnchorSource = NonNullable<KeptFinding['anchorSource']>
export type AnchorBasis = 'added_line' | 'shown_context' | 'fallback'

export interface AppliedDecision {
  candidate_id: string
  reason_category: ReasonCategory | null   // null when the judge returned no decision for the candidate
  reclassified_from: 'incorrect' | 'already_handled' | null
  action: JudgeAction
  original_severity: Severity
  final_severity: Severity | null
  score: number | null
  evidence: string
  note: string
  rewritten: boolean
  // Resolved anchor on every decided candidate, so an offline re-score can place even a dropped finding; null only when undecided.
  anchor_source: AnchorSource | null
  anchor_file: string | null
  anchor_lines: string | null
  // Present only under the matching opt-in flag, so flag-off records are unchanged.
  anchor_basis?: AnchorBasis
  policy_override?: 'test_gap'
  duplicate_of?: string
  invalid_duplicate?: boolean
  expansions?: Array<{ file: string; accepted: boolean; suppressed_by?: string }>
  proposal?: string
  quality_action?: string
  retained_candidate_id?: string
}

export interface JudgeAnomalies {
  unknown_ids: number
  undecided: number
  duplicate_ids: number
  drop_without_evidence: number
  invalid_duplicate?: number
}

export interface JudgeOptions {
  quality?: boolean
  shownAnchors?: ShownAnchors
  proposals?: boolean
  codeProposals?: boolean
  counterparts?: boolean
}

export type RenderJudged = (suffixes: ReadonlyMap<number, string>, order?: readonly number[]) => string

export interface JudgedReview {
  kept: KeptFinding[]
  decisions: AppliedDecision[]
  anomalies: JudgeAnomalies
  scores: FindingScore[]
  markdown: string
  render: RenderJudged
  renderWith?: RenderJudged
  proposalsDropped?: number
}

export const candidateId = (index: number): string => `c${index}`

// Over this a rewrite is no longer a terse clarification, so the reviewer's own body is safer.
export const REWRITE_CAP = 600
export const PROPOSAL_CAP = 500

const PROPOSAL_MAX_LINES = 7
// Bound total size (chars + non-blank lines) instead of parsing fences: a size cap keeps proposals terse and can't be gamed by fence or whitespace tricks.
export function sanitizeProposal(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.trim()
  if (!s || s.length > PROPOSAL_CAP) return undefined
  const lines = s.split(/\r\n|\r|\n/).filter(l => l.trim())
  if (lines.length > PROPOSAL_MAX_LINES) return undefined
  return s
}

// Code is pasted as-is: dedent, since trim breaks the first line's relative indent, and count blank lines so padding cannot escape the caps.
export function sanitizeCodeProposal(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // The fence-unwrap regex below backtracks in O(run × length) on an unclosed backtick run, so bound the input first.
  if (raw.length > 4 * PROPOSAL_CAP) return undefined
  let s = raw.replace(/\r\n?/g, '\n').trimEnd()
  const fenced = s.match(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\1$/)
  if (fenced) s = fenced[2]
  const lines = s.split('\n')
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const indents = lines.filter(l => l.trim()).map(l => /^[ \t]*/.exec(l)![0])
  const common = indents.reduce((prefix, w) => {
    let n = 0
    while (n < prefix.length && prefix[n] === w[n]) n++
    return prefix.slice(0, n)
  }, indents[0] ?? '')
  const code = lines.map(l => (l.trim() ? l.slice(common.length) : '')).join('\n')
  if (!code || code.length > PROPOSAL_CAP || lines.length > PROPOSAL_MAX_LINES) return undefined
  return code
}
const UNVERIFIED_SCORE_CAP = 5
const NEEDS_EVIDENCE: ReadonlySet<ReasonCategory> = new Set(['incorrect', 'already_handled'])
const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }
const DISCLAIMER = '*"This verdict is opinionated and must be validated by a human reviewer."*'

function downgradeTo(severity: Severity, cap: Severity): { action: JudgeAction; severity: Severity } {
  return SEVERITY_RANK[severity] > SEVERITY_RANK[cap] ? { action: 'downgrade', severity: cap } : { action: 'keep', severity }
}

// Final severity is derived here, never taken from the model, so a decision cannot inflate severity.
export function policyAction(reason: ReasonCategory, severity: Severity, policy: JudgePolicy): { action: JudgeAction; severity: Severity | null } {
  switch (reason) {
    case 'validated': return { action: 'keep', severity }
    case 'unconfirmed_high': return downgradeTo(severity, 'MEDIUM')
    case 'chained_hypothetical': return downgradeTo(severity, 'LOW')
    case 'minor': return policy.keepMinor ? downgradeTo(severity, 'LOW') : { action: 'drop', severity: null }
    case 'unverifiable': return policy.keepUnverified ? { action: 'keep', severity } : { action: 'drop', severity: null }
    case 'framework_uncertainty': return policy.keepUnverified ? { action: 'keep', severity } : { action: 'move_to_unresolved', severity: null }
    default: return { action: 'drop', severity: null }
  }
}

// Digits only: a symbol that merely contains a digit ("Phase 4", "_F2C_RETURN_TYPES") is not a line and must not anchor.
const NUMERIC_LINES = /^\s*L?\d+(?:\s*[-–—,]\s*L?\d+)*\s*$/i
const isNumericLines = (lines: string | undefined): boolean => NUMERIC_LINES.test(String(lines ?? ''))

const TEST_GAP_EXPLICIT = /\b(untested|(not|never) tested|no (unit |regression |automated |integration )?tests?\b|missing tests?|without tests?|lacks? (a )?tests?|ha(s|ve) no (unit |regression )?tests?|no test (covers|exercises|for|asserts)|test coverage)/i
const TEST_GAP_GENERIC = /\b(never (exercis|test)|no coverage|not covered|cannot fail|can't fail|tautolog|trivially pass|does not (exercise|cover|assert|test)|doesn't (exercise|cover|assert|test)|never asserts?)/gi
const TESTING_CONTEXT = /\b(tests?|tested|testing|mocks?|mocked|fixtures?)\b/i

// "Cannot fail" or "does not cover" also describe code and docs, so they count only with a testing word outside the phrase itself.
export function isTestGap(title: string, body: string): boolean {
  const text = `${title}\n${body}`
  if (TEST_GAP_EXPLICIT.test(text)) return true
  const rest = text.replace(TEST_GAP_GENERIC, ' ')
  return rest !== text && TESTING_CONTEXT.test(rest)
}

interface Anchor { file?: string; lines?: string; source: AnchorSource; basis?: AnchorBasis }

// Sources actually shown: `origin` to the pass that produced the candidate (breadth/second-look/lens), `judge` to the judge; absent unless the opt-in flag is on.
interface ShownContext { origin?: ShownSource; judge?: ShownSource }

// Below this a quote is too short to locate a unique line without guessing ("}", "return null").
const MIN_QUOTE_LEN = 12

interface DiffIndex { byFile: Map<string, AddedLine[]>; present: boolean }

// Added lines by new-side path; `present` is false for an empty/unparseable diff, where the judge anchor cannot be validated and is not accepted.
function buildDiffIndex(diff: string): DiffIndex {
  const byFile = new Map<string, AddedLine[]>()
  for (const l of addedLines(diff)) {
    const key = normalizeFindingPath(l.file)
    const arr = byFile.get(key) ?? []
    arr.push({ ...l, file: key })
    byFile.set(key, arr)
  }
  return { byFile, present: byFile.size > 0 }
}

// A numeric line/range overlaps an added line in the file → the judge anchor is on changed code.
function onChangedLine(idx: DiffIndex, file: string, lines: string): boolean {
  const range = parseLineRange(lines)
  const added = idx.byFile.get(normalizeFindingPath(file, [...idx.byFile.keys()]))
  if (!range || !added) return false
  return added.some(a => a.line >= range.start && a.line <= range.end)
}

// path:line prefix the judge sometimes welds onto evidence/quote (e.g. "src/pool.ts:42 some code").
const filePrefix = (s: string | undefined): string | undefined =>
  String(s ?? '').match(/([\w./\\-]+\.[A-Za-z0-9]+):\d+/)?.[1]

// File source: reviewer file → judge anchor_file → path:line prefix of quote/evidence; a non-changed file is skipped so a later source can still fire.
function quoteFile(candidate: ReviewFinding, d: JudgeDecision, idx: DiffIndex): string | undefined {
  const keys = [...idx.byFile.keys()]
  for (const raw of [candidate.file, d.anchor_file, filePrefix(d.anchor_quote), filePrefix(d.evidence)]) {
    if (!raw) continue
    const norm = normalizeFindingPath(String(raw), keys)
    if (idx.byFile.has(norm)) return norm
  }
  return undefined
}

// Added lines containing the verbatim quote — within the known file, else across all changed files for a unique global match.
function quoteMatches(idx: DiffIndex, file: string | undefined, quote: string): AddedLine[] {
  const q = quote.trim()
  const pool = file ? (idx.byFile.get(file) ?? []) : [...idx.byFile.values()].flat()
  return pool.filter(a => a.text.trim().includes(q))
}

// First source that resolves wins; the reviewer anchor is ungated (additive-only), while the judge/quote sources must be proven against the diff.
export function locateInDiff(candidate: ReviewFinding, d: JudgeDecision, diff: string): Anchor {
  return resolveAnchor(candidate, d, buildDiffIndex(diff))
}

// Unique verbatim match among the shown lines of the first named file the pass was actually shown.
function shownQuoteHit(src: ShownSource, rawFiles: ReadonlyArray<string | undefined>, quote: string): { file: string; line: number } | null {
  for (const raw of rawFiles) {
    if (!raw) continue
    const key = normalizeFindingPath(String(raw), [...src.keys()])
    const lines = shownFile(src, key)
    if (!lines) continue
    const hits = [...lines].filter(([, text]) => text.trim().includes(quote))
    return hits.length === 1 ? { file: key, line: hits[0][0] } : null
  }
  return null
}

function resolveAnchor(candidate: ReviewFinding, d: JudgeDecision, idx: DiffIndex, breadthOrigin = false, shown: ShownContext = {}): Anchor {
  const tracked = !!(shown.origin || shown.judge)
  const numeric = !!candidate.file && isNumericLines(candidate.lines)
  const onAdded = numeric && idx.present && onChangedLine(idx, candidate.file!, candidate.lines!)
  // A line on code this pass was shown is a valid location even when unchanged; whether the defect is PR-introduced is a separate judgment.
  const onShown = numeric && !!shown.origin && coversRange(shown.origin, candidate.file!, candidate.lines!)
  // A breadth line is held to the judge-channel rule below: off the diff it would post a ghost anchor.
  const gated = breadthOrigin && numeric && !(onAdded || onShown)
  // Ungated: the reviewer saw full files and may cite context/deletion/out-of-diff lines that must keep anchoring.
  if (candidate.file && isNumericLines(candidate.lines) && !gated) return { file: candidate.file, lines: candidate.lines, source: 'reviewer', basis: tracked ? (onAdded ? 'added_line' : onShown ? 'shown_context' : undefined) : undefined }

  // The judge is the untrusted channel, so its numeric anchor is honored only on a changed line of a present diff — a model-typed line with no diff to validate it against would post a ghost anchor.
  const judgeFile = normalizeFindingPath(String(d.anchor_file ?? '')) || candidate.file
  const judgeLines = String(d.anchor_lines ?? '').trim()
  if (judgeFile && isNumericLines(judgeLines) && idx.present && onChangedLine(idx, judgeFile, judgeLines)) {
    return { file: judgeFile, lines: judgeLines, source: 'judge', basis: tracked ? 'added_line' : undefined }
  }
  if (judgeFile && isNumericLines(judgeLines) && shown.judge && coversRange(shown.judge, judgeFile, judgeLines)) {
    return { file: judgeFile, lines: judgeLines, source: 'judge', basis: 'shown_context' }
  }

  // Deterministic recovery: a single long-enough verbatim match, never a guess. The judge may copy the numbered gutter or the `+` marker it was shown.
  const quote = cleanQuote(String(d.anchor_quote ?? ''))
  if (idx.present && quote.length >= MIN_QUOTE_LEN) {
    const hits = quoteMatches(idx, quoteFile(candidate, d, idx), quote)
    if (hits.length === 1) return { file: hits[0].file, lines: String(hits[0].line), source: 'diff', basis: tracked ? 'added_line' : undefined }
  }
  if (shown.judge && quote.length >= MIN_QUOTE_LEN) {
    const hit = shownQuoteHit(shown.judge, [candidate.file, d.anchor_file, filePrefix(d.anchor_quote), filePrefix(d.evidence)], quote)
    if (hit) return { file: hit.file, lines: String(hit.line), source: 'diff', basis: 'shown_context' }
  }

  // Non-numeric `lines` is dropped (the bundled path re-parses any digit and mis-anchors); a judge-named changed file is kept for file-level placement.
  return { file: candidate.file ?? quoteFile(candidate, d, idx), lines: isNumericLines(candidate.lines) && !gated ? candidate.lines : undefined, source: 'none', basis: tracked ? 'fallback' : undefined }
}

export const normalizeId = (id: string): string => String(id).trim().replace(/^\[|\]$/g, '').toLowerCase()
const clampScore = (n: number): number => Math.max(0, Math.min(10, Math.round(Number(n) || 0)))

type Resolved = AppliedDecision & { question?: string; body: string; anchor: Anchor }

function resolve(d: JudgeDecision, candidate: ReviewFinding, policy: JudgePolicy, idx: DiffIndex, breadthOrigin: boolean, shown: ShownContext = {}): Resolved {
  // A provider that doesn't enforce the enum can hand back anything; treat it as unproven.
  let reason: ReasonCategory = (REASON_CATEGORIES as readonly string[]).includes(d.reason_category) ? d.reason_category : 'unverifiable'
  let reclassified_from: AppliedDecision['reclassified_from'] = null
  const evidence = String(d.evidence ?? '').trim()
  // A drop that claims the code disproves the finding must show where, or it is only unverified.
  if (NEEDS_EVIDENCE.has(reason) && !evidence) {
    reclassified_from = reason as 'incorrect' | 'already_handled'
    reason = 'unverifiable'
  }
  const anchor = resolveAnchor(candidate, d, idx, breadthOrigin, shown)
  // The judge files named test gaps as low_value "add a test" requests, yet offline they match golden bugs about as often as kept findings.
  const testGap = !!policy.keepTestGaps && reason === 'low_value' && isAnchored({ ...candidate, file: anchor.file, lines: anchor.lines, anchorSource: anchor.source }) && isTestGap(candidate.title, candidate.body)
  const { action, severity } = testGap ? downgradeTo(candidate.severity, 'LOW') : policyAction(reason, candidate.severity, policy)
  const kept = action === 'keep' || action === 'downgrade'
  const unproven = reason === 'unverifiable' || reason === 'framework_uncertainty'
  const score = kept && unproven ? Math.min(clampScore(d.score), UNVERIFIED_SCORE_CAP) : clampScore(d.score)
  const rewrite = String(d.rewritten_body ?? '').trim()
  const rewritten = kept && rewrite.length > 0 && rewrite.length <= REWRITE_CAP
  return {
    candidate_id: '', reason_category: reason, reclassified_from, action,
    original_severity: candidate.severity, final_severity: severity, score,
    evidence, note: String(d.note ?? '').trim(), rewritten,
    anchor_source: anchor.source, anchor_file: anchor.file ?? null, anchor_lines: anchor.lines ?? null,
    ...(anchor.basis ? { anchor_basis: anchor.basis } : {}),
    ...(testGap ? { policy_override: 'test_gap' as const } : {}),
    question: String(d.question ?? '').trim() || undefined,
    body: rewritten ? rewrite : candidate.body,
    anchor,
  }
}

export function applyJudgeDecisions(candidates: readonly ReviewFinding[], output: JudgeOutput, policy: JudgePolicy = DEFAULT_JUDGE_POLICY, canBeSplit: readonly string[] = [], diff = '', breadthFrom = Infinity, options?: JudgeOptions): JudgedReview {
  const idx = buildDiffIndex(diff)
  const anomalies: JudgeAnomalies = { unknown_ids: 0, undecided: 0, duplicate_ids: 0, drop_without_evidence: 0 }
  const index = new Map(candidates.map((_, i) => [candidateId(i), i]))
  const byCandidate = new Map<number, JudgeDecision[]>()
  for (const d of output.decisions ?? []) {
    const i = index.get(normalizeId(d.candidate_id))
    if (i === undefined) { anomalies.unknown_ids++; continue }
    byCandidate.set(i, [...(byCandidate.get(i) ?? []), d])
  }

  const proposals = !!options?.proposals
  const sa = options?.shownAnchors
  const shownFor = (i: number): ShownContext => !sa ? {} : {
    judge: sa.judge,
    origin: i >= (sa.lensFrom ?? Infinity) ? sa.lens : i >= (sa.secondLookFrom ?? Infinity) ? sa.secondLook : i >= breadthFrom ? sa.breadth : undefined,
  }

  const entries: Entry[] = candidates.map((candidate, i) => {
    const given = byCandidate.get(i) ?? []
    if (!given.length) {
      // Precision-safe default: a candidate the judge never ruled on is not posted, only counted.
      anomalies.undecided++
      return null
    }
    if (given.length > 1) anomalies.duplicate_ids++
    const resolved = given.map(d => {
      const r = resolve(d, candidate, policy, idx, i >= breadthFrom, shownFor(i))
      const proposal = proposals ? (options?.codeProposals ? sanitizeCodeProposal(d.proposal) : sanitizeProposal(d.proposal)) : undefined
      return { r: proposal ? { ...r, proposal } : r, d }
    })
    const chosen = resolved.find(x => x.r.action === 'drop') ?? resolved[0]
    if (chosen.r.reclassified_from) anomalies.drop_without_evidence++
    return { i, candidate, r: chosen.r, d: chosen.d }
  })

  if (options?.quality) demoteInvalidDuplicates(entries, candidates, index, idx, policy, anomalies)

  const decisions: AppliedDecision[] = []
  const kept: KeptFinding[] = []
  const moved: string[] = []
  const rows: KeptRow[] = []
  const sanitizerDropped: number[] = []
  candidates.forEach((candidate, i) => {
    const id = candidateId(i)
    const entry = entries[i]
    if (!entry) {
      decisions.push({
        candidate_id: id, reason_category: null, reclassified_from: null, action: 'drop',
        original_severity: candidate.severity, final_severity: null, score: null, evidence: '', note: '', rewritten: false, anchor_source: null, anchor_file: null, anchor_lines: null,
      })
      return
    }
    const { question, body, anchor, proposal, ...applied } = entry.r
    const isKept = entry.r.action === 'keep' || entry.r.action === 'downgrade'
    const keptProposal = proposals && isKept && proposal ? { proposal } : {}
    if (proposals && options?.codeProposals && isKept && !proposal && typeof entry.d.proposal === 'string' && entry.d.proposal.trim()) sanitizerDropped.push(i)
    const expansion = options?.quality && isKept && entry.d.additional_locations?.length
      ? expandLocations(candidate, entry.d.additional_locations, anchor, idx)
      : null
    decisions.push({ ...applied, candidate_id: id, ...(expansion ? { expansions: expansion.log } : {}), ...keptProposal })

    if (entry.r.action === 'move_to_unresolved') moved.push(question ?? candidate.title)
    if (isKept) {
      kept.push({
        severity: entry.r.final_severity!, title: candidate.title, body, file: anchor.file, lines: anchor.lines,
        score: entry.r.score!, type: candidate.type, anchorSource: anchor.source, ...keptProposal,
        ...(entry.r.quality_action ? { quality_action: entry.r.quality_action } : {}),
        ...(options?.counterparts ? { reviewerBody: candidate.body } : {}),
      })
      rows.push({ candidate: i, expansion: false, validated: entry.r.reason_category === 'validated', evidenced: !!entry.r.evidence, rescueOf: entry.r.invalid_duplicate ? index.get(normalizeId(String(entry.r.duplicate_of ?? ''))) : undefined })
      for (const x of expansion?.accepted ?? []) {
        kept.push({ severity: entry.r.final_severity!, title: candidate.title, body: x.body, file: x.file, lines: x.lines, score: entry.r.score!, type: candidate.type, anchorSource: 'diff', ...(options?.quality ? { quality_action: 'expansion' } : {}) })
        rows.push({ candidate: i, expansion: true, validated: entry.r.reason_category === 'validated', evidenced: !!entry.r.evidence })
      }
    }
  })

  if (options?.quality) dedupKept(kept, rows, decisions, idx)

  const scores: FindingScore[] = kept.map(k => ({ title: k.title, severity: k.severity, score: k.score!, file: k.file, lines: k.lines }))
  const render: RenderJudged = (suffixes, order) => renderJudgedReview(kept, output, moved, canBeSplit, suffixes, order)
  return {
    kept, decisions, anomalies, scores, markdown: renderJudgedReview(kept, output, moved, canBeSplit), render,
    // Kept as the code-proposal contract callers check for; POST_REVIEW reads render, which every judged review has.
    ...(options?.codeProposals ? { renderWith: render, proposalsDropped: sanitizerDropped.filter(i => decisions[i].quality_action !== 'dedup_suppressed').length } : {}),
  }
}

type Entry = { i: number; candidate: ReviewFinding; r: Resolved; d: JudgeDecision } | null

// The judge can relocate a kept finding, so same-file overlap is judged on resolved anchors, not the candidates' original locations.
const locationOf = (a: Anchor, idx: DiffIndex): { file: string; range: { start: number; end: number } | null } => {
  const file = a.file ? normalizeFindingPath(a.file, [...idx.byFile.keys()]) : ''
  return { file: idx.byFile.has(file) ? file : '', range: isNumericLines(a.lines) ? parseLineRange(a.lines!) : null }
}

// A duplicate only means something when the clearer twin is itself kept, in the same file and location; judged against the final kept set so decision order cannot matter.
function demoteInvalidDuplicates(entries: Entry[], candidates: readonly ReviewFinding[], index: Map<string, number>, idx: DiffIndex, policy: JudgePolicy, anomalies: JudgeAnomalies): void {
  const retained = new Set<number>()
  for (const e of entries) {
    if (e && e.r.reason_category !== 'duplicate' && (e.r.action === 'keep' || e.r.action === 'downgrade')) retained.add(e.i)
  }
  for (const e of entries) {
    if (!e || e.r.reason_category !== 'duplicate') continue
    const target = index.get(normalizeId(String(e.d.duplicate_of ?? '')))
    const here = locationOf(e.r.anchor, idx)
    const there = target === undefined ? null : (entries[target] ? locationOf(entries[target]!.r.anchor, idx) : null)
    if (target !== undefined && there && target !== e.i && retained.has(target)
      && here.file && here.file === there.file && here.range && there.range
      && here.range.start <= there.range.end && there.range.start <= here.range.end) {
      e.r.duplicate_of = candidateId(target)
      continue
    }
    const { action, severity } = policyAction('unverifiable', e.candidate.severity, policy)
    const kept = action === 'keep' || action === 'downgrade'
    Object.assign(e.r, {
      reason_category: 'unverifiable', action, final_severity: severity,
      score: kept ? Math.min(e.r.score ?? 0, UNVERIFIED_SCORE_CAP) : e.r.score,
      invalid_duplicate: true, duplicate_of: String(e.d.duplicate_of ?? '').trim() || undefined,
      ...(kept ? { quality_action: 'dup_rescue' } : {}),
    })
    anomalies.invalid_duplicate = (anomalies.invalid_duplicate ?? 0) + 1
  }
}

interface KeptRow { candidate: number; expansion: boolean; validated: boolean; evidenced: boolean; rescueOf?: number }

// Expansion and duplicate rescue can post the same issue twice; collapse on location plus title or explicit rescue provenance, never on a shared line alone.
function dedupKept(kept: KeptFinding[], rows: readonly KeptRow[], decisions: AppliedDecision[], idx: DiffIndex): void {
  const keys = [...idx.byFile.keys()]
  const place = kept.map(k => ({
    file: k.file ? normalizeFindingPath(k.file, keys) : '',
    range: isNumericLines(k.lines) ? parseLineRange(k.lines!) : null,
  }))
  const normBody = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const sameIssue = (a: number, b: number): boolean => {
    const pa = place[a], pb = place[b]
    if (!pa.file || pa.file !== pb.file || !pa.range || !pb.range) return false
    if (pa.range.start > pb.range.end || pb.range.start > pa.range.end) return false
    const ra = rows[a], rb = rows[b]
    const provenance = (ra.rescueOf !== undefined && rb.expansion && rb.candidate === ra.rescueOf)
      || (rb.rescueOf !== undefined && ra.expansion && ra.candidate === rb.rescueOf)
    if (provenance) return true
    // Shared title words can bind two distinct same-line findings; require the bodies to corroborate it is one issue.
    const nb = normBody(kept[a].body)
    if (!nb || nb !== normBody(kept[b].body)) return false
    return titlesOverlap(kept[a].title, kept[b].title) || normTitle(kept[a].title) === normTitle(kept[b].title)
  }

  const order = kept.map((_, n) => n).sort((a, b) => {
    const ra = rows[a], rb = rows[b]
    return Number(rb.validated) - Number(ra.validated) || Number(rb.evidenced) - Number(ra.evidenced)
      || (kept[b].score ?? 0) - (kept[a].score ?? 0) || Number(ra.expansion) - Number(rb.expansion)
      || ra.candidate - rb.candidate || a - b
  })
  const survivors: number[] = []
  const dropped = new Set<number>()
  for (const n of order) {
    const winner = survivors.find(s => sameIssue(n, s))
    if (winner === undefined) { survivors.push(n); continue }
    dropped.add(n)
    const loser = rows[n], retained = candidateId(rows[winner].candidate)
    const d = decisions[loser.candidate]
    if (loser.expansion) {
      const log = d.expansions?.find(e => e.accepted && e.file === place[n].file && !e.suppressed_by)
      if (log) log.suppressed_by = retained
    } else {
      d.quality_action = 'dedup_suppressed'
      d.retained_candidate_id = retained
    }
  }
  if (dropped.size) kept.splice(0, kept.length, ...kept.filter((_, n) => !dropped.has(n)))
}

const cleanQuote = (q: string): string => q.trim().replace(/^\d+\s+/, '').replace(/^\+/, '').trim()

// A path/basename at a filename boundary, so "b.ts" matches "src/b.ts" or "the b.ts" but not "old-b.ts" or "b.tsx".
function namesFile(text: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w.\\-])${esc}(?![\\w\\-]|\\.\\w)`).test(text)
}

// Only files the candidate itself already names get a row, each proven against an added line, so the judge cannot widen scope or invent locations.
function expandLocations(candidate: ReviewFinding, locations: readonly AdditionalLocation[], parent: Anchor, idx: DiffIndex): { accepted: Array<{ file: string; lines: string; body: string }>; log: Array<{ file: string; accepted: boolean }> } {
  const accepted: Array<{ file: string; lines: string; body: string }> = []
  const log: Array<{ file: string; accepted: boolean }> = []
  const keys = [...idx.byFile.keys()]
  const used = new Set<string>(parent.file ? [normalizeFindingPath(parent.file, keys)] : [])
  const haystack = `${candidate.title}\n${candidate.body}`

  for (const loc of locations) {
    if (!loc || typeof loc !== 'object') continue
    const file = normalizeFindingPath(String(loc.file ?? ''), keys)
    if (!file || used.has(file)) continue
    const base = file.split('/').pop()!
    const uniqueBase = keys.filter(k => k.split('/').pop() === base).length === 1
    const excerpt = String(loc.candidate_excerpt ?? '').trim()
    const quote = cleanQuote(String(loc.anchor_quote ?? ''))
    const range = isNumericLines(loc.lines) ? parseLineRange(loc.lines) : null
    const hits = !range || quote.length < MIN_QUOTE_LEN ? [] : (idx.byFile.get(file) ?? []).filter(a => a.line >= range.start && a.line <= range.end && a.text.trim().includes(quote))
    const body = String(loc.body ?? '').trim().slice(0, REWRITE_CAP)
    const ok = idx.byFile.has(file) && excerpt.length > 0 && haystack.includes(excerpt)
      && (namesFile(excerpt, file) || (uniqueBase && namesFile(excerpt, base)))
      && hits.length === 1 && body.length > 0
    log.push({ file, accepted: ok })
    if (!ok) continue
    used.add(file)
    accepted.push({ file, lines: String(hits[0].line), body })
  }
  return { accepted, log }
}

// Must stay byte-compatible with what the judge used to write: Findings bullets and the Merge Confidence line are re-parsed downstream.
export function renderJudgedReview(kept: readonly KeptFinding[], output: JudgeOutput, movedQuestions: readonly string[] = [], canBeSplit: readonly string[] = [], suffixes?: ReadonlyMap<number, string>, order?: readonly number[]): string {
  const questions = [...(output.unresolved_questions ?? [])]
  for (const q of movedQuestions) if (!questions.includes(q)) questions.push(q)
  const review: ReviewObject = {
    summary: output.summary,
    findings: kept.map(k => ({ severity: k.severity, title: k.title, file: k.file, lines: k.lines, body: k.body })),
    behavioral_diff: output.behavioral_diff ?? [],
    production_risk: output.production_risk ?? [],
    unresolved_questions: questions,
    can_be_split: canBeSplit.length ? [...canBeSplit] : undefined,
  }
  const confidence = Math.max(0, Math.min(100, Math.round(Number(output.merge_confidence) || 0)))
  return `${renderReview(review, { emptyFindings: 'No actionable findings.', suffix: suffixes && (i => suffixes.get(i) ?? ''), order })}\n\n### Merge Confidence: ${confidence}%\n\n${DISCLAIMER}`
}

export function renderCandidatesForJudge(review: ReviewObject): string {
  return renderReview(review, { tag: i => `[${candidateId(i)}] ` })
}

export function summarizeDecisions(decisions: readonly AppliedDecision[]): string {
  return decisions.map(d => {
    const reason = d.reason_category ?? 'no decision'
    const from = d.reclassified_from ? ` (was ${d.reclassified_from}, no evidence)` : ''
    const sev = d.final_severity && d.final_severity !== d.original_severity ? ` ${d.original_severity}→${d.final_severity}` : ''
    const score = d.score !== null ? ` ${d.score}/10` : ''
    const anchor = d.anchor_source === 'judge' ? ' (anchored by judge)' : d.anchor_source === 'diff' ? ' (anchored from diff)' : d.anchor_source === 'none' ? ' (no usable line)' : ''
    return `${d.candidate_id} ${reason}${from} → ${d.action}${sev}${score}${anchor}${d.note ? `: ${d.note}` : ''}`
  }).join('\n')
}
