// ---------------------------------------------------------------------------
// Merge per-bundle review markdown into one review — pure, no I/O
// ---------------------------------------------------------------------------

import type { ReviewFinding, ReviewObject } from './formatter.js'
import { parseVerdictScore } from './parsers.js'

export interface ParsedReview {
  summary: string
  findings: ReviewFinding[]
  behavioral: string[]
  risk: string[]
  questions: string[]
  confidence: number | null
}

const SEVERITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const
const EMPTY_ITEM = /^(none|no\b[^\n]*)\.?$/i
const FINDING_START = /^[ \t]*[-*]\s*\*\*(HIGH|MEDIUM|LOW)\s*[–—-]\s*(.+?)\*\*[ \t]*(?:\(([^)\n]*)\))?[ \t]*/

function sections(md: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = md.split(/^#{1,4}[ \t]*/m).slice(1)
  for (const p of parts) {
    const nl = p.indexOf('\n')
    const head = (nl === -1 ? p : p.slice(0, nl)).trim().toLowerCase()
    const key = head.startsWith('merge confidence') ? 'confidence' : head
    out.set(key, nl === -1 ? '' : p.slice(nl + 1).trim())
  }
  return out
}

function bulletItems(body: string): string[] {
  const items: string[] = []
  for (const line of body.split('\n')) {
    const m = line.match(/^[ \t]*[-*]\s+(.*)$/)
    if (m) items.push(m[1].trim())
    else if (items.length && line.trim()) items[items.length - 1] += ' ' + line.trim()
  }
  return items.filter(i => !EMPTY_ITEM.test(i))
}

function parseFindings(body: string): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  let cur: ReviewFinding | null = null
  for (const line of body.split('\n')) {
    const m = line.match(FINDING_START)
    if (m) {
      const loc = (m[3] ?? '').replace(/`/g, '').trim()
      const at = loc.lastIndexOf(':')
      cur = {
        severity: m[1] as ReviewFinding['severity'],
        title: m[2].trim(),
        file: loc ? (at > 0 ? loc.slice(0, at) : loc).trim() : undefined,
        lines: at > 0 ? loc.slice(at + 1).trim() || undefined : undefined,
        body: line.slice(m[0].length).trim(),
      }
      findings.push(cur)
    } else if (cur && line.trim()) {
      cur.body = (cur.body ? cur.body + ' ' : '') + line.trim()
    }
  }
  return findings
}

export function parseReviewMarkdown(md: string): ParsedReview {
  const s = sections(md)
  return {
    summary: (s.get('summary') ?? '').replace(/\s+/g, ' ').trim(),
    findings: parseFindings(s.get('findings') ?? ''),
    behavioral: bulletItems(s.get('behavioral diff') ?? ''),
    risk: bulletItems(s.get('production risk') ?? ''),
    questions: bulletItems(s.get('unresolved questions') ?? ''),
    confidence: parseVerdictScore(md),
  }
}

function lineRange(lines?: string): [number, number] | null {
  const nums = (lines ?? '').match(/\d+/g)?.map(Number)
  return nums?.length ? [Math.min(...nums), Math.max(...nums)] : null
}

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])

function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b)
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const t of x) if (y.has(t)) shared++
  return shared / (x.size + y.size - shared)
}

function sameIssue(a: ReviewFinding, b: ReviewFinding): boolean {
  const sim = similarity(a.title, b.title)
  if (!a.file || !b.file) return !a.file && !b.file && sim >= 0.8
  if (a.file !== b.file) return false
  const ra = lineRange(a.lines), rb = lineRange(b.lines)
  if (!ra || !rb) return sim >= 0.6
  return ra[0] <= rb[1] && rb[0] <= ra[1] && sim >= 0.5
}

/** Collapse findings that name the same issue: same file, overlapping lines, similar title.
 *  Highest severity wins; input order breaks ties so the earlier bundle's wording is kept. */
export function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const ranked = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  const kept: ReviewFinding[] = []
  for (const f of ranked) if (!kept.some(k => sameIssue(k, f))) kept.push(f)
  return kept.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || (a.file ?? '').localeCompare(b.file ?? '')
    || (lineRange(a.lines)?.[0] ?? 0) - (lineRange(b.lines)?.[0] ?? 0))
}

function dedupeStrings(items: string[]): string[] {
  const kept: string[] = []
  for (const i of items) if (!kept.some(k => similarity(k, i) >= 0.7)) kept.push(i)
  return kept
}

const bullets = (items: string[]): string => (items.length ? items.map(i => `- ${i}`).join('\n') : 'None.')

export interface BundleReview {
  label: string
  parsed: ParsedReview
}

export interface MergedReview {
  markdown: string
  object: ReviewObject
  confidence: number | null
}

/** Combine per-bundle reviews into one in the reviewer/judge markdown shape, so downstream
 *  cleanup, truncation guard, and metrics parse it unchanged. Merge Confidence is the minimum
 *  across bundles — one risky module should not be averaged away. */
export function mergeReviews(reviews: BundleReview[], unreviewed: string[] = []): MergedReview {
  const findings = dedupeFindings(reviews.flatMap(r => r.parsed.findings))
  const behavioral = dedupeStrings(reviews.flatMap(r => r.parsed.behavioral))
  const risk = dedupeStrings(reviews.flatMap(r => r.parsed.risk))
  const questions = dedupeStrings([
    ...reviews.flatMap(r => r.parsed.questions),
    ...unreviewed.map(f => `\`${f}\` was too large for one review pass and was not reviewed.`),
  ])
  const scores = reviews.map(r => r.parsed.confidence).filter((c): c is number => c !== null)
  const confidence = scores.length ? Math.min(...scores) : null

  const summary = `Large PR reviewed in ${reviews.length} bundle(s).\n` +
    reviews.filter(r => r.parsed.summary).map(r => `- **${r.label}**: ${r.parsed.summary}`).join('\n')

  const findingsMd = findings.length
    ? findings.map(f => {
        const loc = f.file ? ` (\`${f.file}${f.lines ? `:${f.lines}` : ''}\`)` : ''
        return `- **${f.severity} – ${f.title}**${loc}\n  ${f.body}`
      }).join('\n\n')
    : 'No findings.'

  let markdown = [
    `### Summary\n${summary}`,
    `### Findings\n${findingsMd}`,
    `### Behavioral Diff\n${bullets(behavioral)}`,
    `### Production Risk\n${bullets(risk)}`,
    `### Unresolved Questions\n${bullets(questions)}`,
  ].join('\n\n')
  if (confidence !== null) {
    markdown += `\n\n### Merge Confidence: ${confidence}%\n\n*"This verdict is opinionated and must be validated by a human reviewer."*`
  }

  return {
    markdown,
    confidence,
    object: { summary, findings, behavioral_diff: behavioral, production_risk: risk, unresolved_questions: questions },
  }
}
