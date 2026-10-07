// ReviewBench findings file: structured review findings → { pr, agent, findings[] } at RB_OUT.

import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { ReviewFinding, FindingScore } from './formatter.js'

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

const normTitle = (title: string): string => title.toLowerCase().replace(/[`*_"']/g, '').replace(/\s+/g, ' ').trim()

const pathsMatch = (a: string, b: string): boolean => a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
const rangesOverlap = (x: { start: number; end: number }, y: { start: number; end: number }): boolean => x.start <= y.end && y.start <= x.end

// The judge rewrites titles and may narrow a range or cite a basename, so match its kept set by
// location (path suffix + line-range overlap) within the Findings section, with title as fallback.
export function keptByJudge(findings: ReviewFinding[], judgedText: string, scores: FindingScore[] = []): ReviewFinding[] {
  const section = judgedText.match(/#{1,4}\s*Findings\b([\s\S]*?)(?=\n#{1,4}\s|$)/i)?.[1] ?? judgedText
  const locs = [...section.matchAll(/\(\s*`?([^`()\n]+?):([0-9][0-9,\s–—L-]*?)`?\s*\)/gi)]
    .map(m => ({ path: normalizeFindingPath(m[1]), range: parseLineRange(m[2]) }))
    .filter((l): l is { path: string; range: { start: number; end: number } } => l.range !== null)
  const titles = new Set([
    ...scores.map(s => s.title),
    ...[...section.matchAll(/\*\*(?:HIGH|MEDIUM|LOW)\s*[–—-]\s*(.+?)\*\*/gi)].map(m => m[1]),
  ].map(normTitle))
  return findings.filter(f => {
    if (titles.has(normTitle(f.title))) return true
    const range = parseLineRange(f.lines)
    if (!f.file || !range) return false
    const path = normalizeFindingPath(f.file)
    return locs.some(l => pathsMatch(path, l.path) && rangesOverlap(range, l.range))
  })
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
