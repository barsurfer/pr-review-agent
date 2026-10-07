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

// The judge returns prose, not structured findings, so its kept set is recovered by title (scores + rendered headings).
export function keptByJudge(findings: ReviewFinding[], judgedText: string, scores: FindingScore[] = []): ReviewFinding[] {
  const rendered = [...judgedText.matchAll(/^[ \t]*-\s*\*\*(?:HIGH|MEDIUM|LOW)\s*[–—-]\s*(.+?)\*\*/gim)].map(m => m[1])
  const kept = new Set([...scores.map(s => s.title), ...rendered].map(normTitle))
  return findings.filter(f => kept.has(normTitle(f.title)))
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
