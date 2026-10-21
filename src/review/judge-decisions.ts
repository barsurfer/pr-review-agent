// The judge only classifies; policy lives here so one judged run can be re-scored offline under any flag combination.

import { renderReview, type ReviewFinding, type ReviewObject, type FindingScore } from './formatter.js'
import { normalizeFindingPath, parseLineRange, type KeptFinding } from './findings-output.js'
import { addedLines, type AddedLine } from './parsers.js'

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
}

export const DEFAULT_JUDGE_POLICY: JudgePolicy = { keepMinor: false, keepUnverified: false }

export type JudgeAction = 'keep' | 'downgrade' | 'drop' | 'move_to_unresolved'
type AnchorSource = NonNullable<KeptFinding['anchorSource']>

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
  // Resolved anchor for the candidate regardless of keep/drop, so an offline re-score under a different policy can place a finding this policy dropped. Null only for an undecided candidate.
  anchor_source: AnchorSource | null
  anchor_file: string | null
  anchor_lines: string | null
}

export interface JudgeAnomalies {
  unknown_ids: number
  undecided: number
  duplicate_ids: number
  drop_without_evidence: number
}

export interface JudgedReview {
  kept: KeptFinding[]
  decisions: AppliedDecision[]
  anomalies: JudgeAnomalies
  scores: FindingScore[]
  markdown: string
}

export const candidateId = (index: number): string => `c${index}`

// Over this a rewrite is no longer a terse clarification, so the reviewer's own body is safer.
export const REWRITE_CAP = 600
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

interface Anchor { file?: string; lines?: string; source: AnchorSource }

// Below this a quote is too short to locate a unique line without guessing ("}", "return null").
const MIN_QUOTE_LEN = 12

interface DiffIndex { byFile: Map<string, AddedLine[]>; present: boolean }

// Added lines by new-side path; `present` is false for an empty/unparseable diff, where the judge anchor stays ungated.
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

// First source that resolves wins; the reviewer's numeric anchor is additive-only (never gated) so nothing that anchors today is lost, while the newer judge/quote sources must be proven against the diff.
export function locateInDiff(candidate: ReviewFinding, d: JudgeDecision, diff: string): Anchor {
  return resolveAnchor(candidate, d, buildDiffIndex(diff))
}

function resolveAnchor(candidate: ReviewFinding, d: JudgeDecision, idx: DiffIndex): Anchor {
  // Ungated: the reviewer saw full files and may cite context/deletion/out-of-diff lines that must keep anchoring.
  if (candidate.file && isNumericLines(candidate.lines)) return { file: candidate.file, lines: candidate.lines, source: 'reviewer' }

  // The judge is the untrusted channel, so its numeric anchor is honored only on a changed line (ungated when no diff is available, for unit parity).
  const judgeFile = normalizeFindingPath(String(d.anchor_file ?? '')) || candidate.file
  const judgeLines = String(d.anchor_lines ?? '').trim()
  if (judgeFile && isNumericLines(judgeLines) && (!idx.present || onChangedLine(idx, judgeFile, judgeLines))) {
    return { file: judgeFile, lines: judgeLines, source: 'judge' }
  }

  // Deterministic recovery: a single long-enough verbatim match, never a guess.
  const quote = String(d.anchor_quote ?? '').trim()
  if (idx.present && quote.length >= MIN_QUOTE_LEN) {
    const hits = quoteMatches(idx, quoteFile(candidate, d, idx), quote)
    if (hits.length === 1) return { file: hits[0].file, lines: String(hits[0].line), source: 'diff' }
  }

  return { file: candidate.file, lines: candidate.lines, source: 'none' }
}

const normalizeId = (id: string): string => String(id).trim().replace(/^\[|\]$/g, '').toLowerCase()
const clampScore = (n: number): number => Math.max(0, Math.min(10, Math.round(Number(n) || 0)))

function resolve(d: JudgeDecision, candidate: ReviewFinding, policy: JudgePolicy, idx: DiffIndex): AppliedDecision & { question?: string; body: string; anchor: Anchor } {
  // A provider that doesn't enforce the enum can hand back anything; treat it as unproven.
  let reason: ReasonCategory = (REASON_CATEGORIES as readonly string[]).includes(d.reason_category) ? d.reason_category : 'unverifiable'
  let reclassified_from: AppliedDecision['reclassified_from'] = null
  const evidence = String(d.evidence ?? '').trim()
  // A drop that claims the code disproves the finding must show where, or it is only unverified.
  if (NEEDS_EVIDENCE.has(reason) && !evidence) {
    reclassified_from = reason as 'incorrect' | 'already_handled'
    reason = 'unverifiable'
  }
  const { action, severity } = policyAction(reason, candidate.severity, policy)
  const kept = action === 'keep' || action === 'downgrade'
  const unproven = reason === 'unverifiable' || reason === 'framework_uncertainty'
  const score = kept && unproven ? Math.min(clampScore(d.score), UNVERIFIED_SCORE_CAP) : clampScore(d.score)
  const rewrite = String(d.rewritten_body ?? '').trim()
  const rewritten = kept && rewrite.length > 0 && rewrite.length <= REWRITE_CAP
  const anchor = resolveAnchor(candidate, d, idx)
  return {
    candidate_id: '', reason_category: reason, reclassified_from, action,
    original_severity: candidate.severity, final_severity: severity, score,
    evidence, note: String(d.note ?? '').trim(), rewritten,
    anchor_source: anchor.source, anchor_file: anchor.file ?? null, anchor_lines: anchor.lines ?? null,
    question: String(d.question ?? '').trim() || undefined,
    body: rewritten ? rewrite : candidate.body,
    anchor,
  }
}

export function applyJudgeDecisions(candidates: readonly ReviewFinding[], output: JudgeOutput, policy: JudgePolicy = DEFAULT_JUDGE_POLICY, canBeSplit: readonly string[] = [], diff = ''): JudgedReview {
  const idx = buildDiffIndex(diff)
  const anomalies: JudgeAnomalies = { unknown_ids: 0, undecided: 0, duplicate_ids: 0, drop_without_evidence: 0 }
  const index = new Map(candidates.map((_, i) => [candidateId(i), i]))
  const byCandidate = new Map<number, JudgeDecision[]>()
  for (const d of output.decisions ?? []) {
    const i = index.get(normalizeId(d.candidate_id))
    if (i === undefined) { anomalies.unknown_ids++; continue }
    byCandidate.set(i, [...(byCandidate.get(i) ?? []), d])
  }

  const decisions: AppliedDecision[] = []
  const kept: KeptFinding[] = []
  const moved: string[] = []
  candidates.forEach((candidate, i) => {
    const id = candidateId(i)
    const given = byCandidate.get(i) ?? []
    if (!given.length) {
      // Precision-safe default: a candidate the judge never ruled on is not posted, only counted.
      anomalies.undecided++
      decisions.push({
        candidate_id: id, reason_category: null, reclassified_from: null, action: 'drop',
        original_severity: candidate.severity, final_severity: null, score: null, evidence: '', note: '', rewritten: false, anchor_source: null, anchor_file: null, anchor_lines: null,
      })
      return
    }
    if (given.length > 1) anomalies.duplicate_ids++
    const resolved = given.map(d => resolve(d, candidate, policy, idx))
    const chosen = resolved.find(r => r.action === 'drop') ?? resolved[0]
    if (chosen.reclassified_from) anomalies.drop_without_evidence++
    const { question, body, anchor, ...applied } = chosen
    decisions.push({ ...applied, candidate_id: id })

    if (chosen.action === 'move_to_unresolved') moved.push(question ?? candidate.title)
    if (chosen.action === 'keep' || chosen.action === 'downgrade') {
      kept.push({
        severity: chosen.final_severity!, title: candidate.title, body, file: anchor.file, lines: anchor.lines,
        score: chosen.score!, type: candidate.type, anchorSource: anchor.source,
      })
    }
  })

  const scores: FindingScore[] = kept.map(k => ({ title: k.title, severity: k.severity, score: k.score!, file: k.file, lines: k.lines }))
  return { kept, decisions, anomalies, scores, markdown: renderJudgedReview(kept, output, moved, canBeSplit) }
}

// Must stay byte-compatible with what the judge used to write: Findings bullets and the Merge Confidence line are re-parsed downstream.
export function renderJudgedReview(kept: readonly KeptFinding[], output: JudgeOutput, movedQuestions: readonly string[] = [], canBeSplit: readonly string[] = []): string {
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
  return `${renderReview(review, { emptyFindings: 'No actionable findings.' })}\n\n### Merge Confidence: ${confidence}%\n\n${DISCLAIMER}`
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
