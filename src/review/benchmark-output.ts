// ReviewBench findings file: structured review findings → { pr, agent, findings[] } at RB_OUT.

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { ReviewFinding } from './formatter.js'

export interface BenchmarkFinding {
  file: string
  start_line: number
  end_line: number
  message: string
  producer: string
}

export interface BenchmarkOutput {
  pr: { repo: string; pr_number: number; base: string; head: string }
  agent: string
  findings: BenchmarkFinding[]
}

export interface BenchmarkPR {
  repo: string
  prNumber: string
  base: string
  head: string
}

// Lenient on the model's notation: any line numbers present ("L10-L12", "40, 12") collapse to their min..max span.
export function parseLineRange(lines: string | undefined): { start: number; end: number } | null {
  const nums = (lines ?? '').match(/\d+/g)?.map(Number).filter(n => n > 0) ?? []
  if (nums.length === 0) return null
  return { start: Math.min(...nums), end: Math.max(...nums) }
}

// ReviewBench matches paths exactly, so a model-cited variant (b/ prefix, basename) is snapped to the diff's path.
export function normalizeFindingPath(file: string, changedPaths: readonly string[] = []): string {
  const path = file.trim().replace(/^`+|`+$/g, '').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '')
  if (changedPaths.length === 0 || changedPaths.includes(path)) return path
  const unprefixed = path.replace(/^[ab]\//, '')
  if (changedPaths.includes(unprefixed)) return unprefixed
  const bySuffix = changedPaths.filter(p => p.endsWith('/' + path))
  return bySuffix.length === 1 ? bySuffix[0] : path
}

// Pull `path:lines` citations from a finding's location paren — backtick-quoted items first (so a
// multi-file finding keeps every file), else comma-split.
function citations(parens: string): { path: string; lines: string }[] {
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

// Read the kept findings straight from the judge's final review_markdown — its own titles, bodies
// and location citations — instead of re-matching them onto the reviewer's findings, which silently
// drops a finding whenever the judge reframes its title and re-cites its lines.
export function findingsFromJudgedMarkdown(judgedText: string, producer: string, changedPaths: readonly string[] = []): BenchmarkFinding[] {
  const section = judgedText.match(/#{1,4}\s*Findings\b([\s\S]*?)(?=\n#{1,4}\s|$)/i)?.[1] ?? ''
  const out: BenchmarkFinding[] = []
  const seen = new Set<string>()
  for (const block of section.split(/\n(?=[ \t]*[-*]\s*\*\*(?:HIGH|MEDIUM|LOW)\b)/i)) {
    const head = block.match(/^[ \t]*[-*]\s*\*\*(?:HIGH|MEDIUM|LOW)\s*[–—-]\s*([\s\S]+?)\*\*[ \t]*(\([^\n]*\))?/i)
    if (!head) continue
    const title = head[1].replace(/\s+/g, ' ').trim()
    const body = block.slice(head[0].length).replace(/\s+/g, ' ').trim()
    const message = body ? `${title}: ${body}` : title
    for (const c of citations(head[2] ?? '')) {
      const file = normalizeFindingPath(c.path, changedPaths)
      const range = parseLineRange(c.lines)
      if (!file || !range) continue
      const key = `${file}:${range.start}-${range.end}:${title}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ file, start_line: range.start, end_line: range.end, message, producer })
    }
  }
  return out
}

// The schema requires file + line range, so PR-level findings have no place in it and are dropped.
export function mapFindings(findings: ReviewFinding[], producer: string, changedPaths: readonly string[] = []): BenchmarkFinding[] {
  const out: BenchmarkFinding[] = []
  for (const f of findings) {
    const file = f.file ? normalizeFindingPath(f.file, changedPaths) : ''
    const range = parseLineRange(f.lines)
    if (!file || !range) continue
    out.push({ file, start_line: range.start, end_line: range.end, message: `${f.title.trim()}: ${f.body.trim()}`, producer })
  }
  return out
}

export function buildBenchmarkOutput(pr: BenchmarkPR, agent: string, findings: BenchmarkFinding[]): BenchmarkOutput {
  return {
    pr: { repo: pr.repo, pr_number: Number(pr.prNumber), base: pr.base, head: pr.head },
    agent,
    findings,
  }
}

// Write-then-rename so a run killed mid-write never leaves a truncated findings file behind.
export function writeBenchmarkOutput(path: string, output: BenchmarkOutput): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(output, null, 2) + '\n')
  renameSync(tmp, path)
}
