// Breadth lens: a second reviewer pass aimed at changed files the first pass left without a finding.

import { parseChangedFiles, countDiffLines } from './parsers.js'
import { splitDiffByFile } from './bundler.js'
import { normalizeFindingPath } from './findings-output.js'
import type { ReviewFinding } from './formatter.js'

// Not the fetcher's context-exclusion list: migrations are real review targets, while lockfiles and generated code only pad the trigger counts.
const GENERATED_OR_LOCK = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$/, /\.lock$/,
  /-generated\./, /\.min\.(js|css)$/, /\.snap$/, /\.map$/, /\.pb\.go$/, /_pb2(_grpc)?\.py$/,
]
const isGeneratedOrLock = (path: string): boolean => GENERATED_OR_LOCK.some(re => re.test(path))

export type BreadthStatus =
  | 'disabled' | 'skipped_no_judge' | 'skipped_rereview' | 'skipped_bundled'
  | 'skipped_small' | 'skipped_few_untouched' | 'skipped_limit' | 'skipped_budget' | 'skipped_time' | 'succeeded' | 'failed'

export type CandidateOrigin = 'review' | 'breadth'

export const MAX_UNTOUCHED_LISTED = 40

export interface FileCoverage {
  reviewable: string[]
  untouched: string[]
}

// Binary and pure-rename entries carry no +/- line, so there is nothing on them for a breadth pass to anchor to.
export function fileCoverage(filteredDiff: string, findings: readonly ReviewFinding[]): FileCoverage {
  const sections = splitDiffByFile(filteredDiff)
  const reviewable = [...new Set(parseChangedFiles(filteredDiff)
    .filter(f => f.status !== 'deleted' && !isGeneratedOrLock(f.path))
    .map(f => f.path))]
    .filter(path => {
      const { added, removed } = countDiffLines(sections.get(path) ?? '')
      return added + removed > 0
    })
  // An ambiguous basename (index.ts in two dirs) covers every candidate, so a flagged file is never listed as untouched.
  const covered = new Set<string>()
  for (const f of findings) {
    if (!f.file) continue
    const path = normalizeFindingPath(f.file, reviewable)
    if (reviewable.includes(path)) covered.add(path)
    else for (const p of reviewable) if (p.endsWith('/' + path)) covered.add(p)
  }
  return { reviewable, untouched: reviewable.filter(p => !covered.has(p)) }
}

// The base prompt forbids reviewing unchanged code and files outside the diff, so every ask here stays on added/modified lines.
export const BREADTH_LENS = `## BREADTH LENS
A first review pass already ran; its findings are listed in the message. Your job is to find what it missed — not to re-review what it reported. Work through, in order:
1. Every file listed under "Files with no finding yet": review its added or modified lines as carefully as a first pass would.
2. The same defect at another place: for each first-pass finding, look for the same pattern on other added or modified lines. Each other place is its own finding.
3. Things that should have changed together: an inconsistency this change introduces between changed code and other code visible in the diff or file context — a caller not updated for a new parameter, an interface missing what its implementation adds, a sibling copy left behind. Anchor the finding on the added or modified line, and report it only when both sides are visible in what you were shown.
4. Incomplete changes on added or modified lines: stubs, placeholder returns, options parsed but ignored, a capability added at one layer but never wired up. A diff segment that ends at an opening brace or \`if\` is a hunk boundary, not an incomplete change.
Do not repeat a first-pass finding (same root cause at the same place). Every finding needs a concrete failing scenario, a file, and a numeric line on an added or modified line. Return an empty list if you find nothing.`

// `limit` is what MAX_FINDINGS leaves after the first pass; the breadth pass is only told this remaining budget, as the reviewer is told the cap.
export function breadthSystemPrompt(reviewerPrompt: string, limit: number): string {
  const limitSection = limit > 0
    ? `\n\n## FINDINGS LIMIT\nReport at most ${limit} findings, prioritized by severity and impact. If more exist, include only the most important and omit the rest.`
    : ''
  return `${reviewerPrompt}${limitSection}\n\n${BREADTH_LENS}`
}

// Titles and anchors only: enough to avoid repeats and seed the same-defect search without re-sending every body.
export function breadthBriefing(firstPass: readonly ReviewFinding[], untouched: readonly string[]): string {
  const located = (f: ReviewFinding) => (f.file ? `${f.file}${f.lines ? `:${f.lines}` : ''}` : '(no file)')
  const findings = firstPass.length ? firstPass.map(f => `- ${located(f)} — ${f.title}`).join('\n') : 'None.'
  const shown = untouched.slice(0, MAX_UNTOUCHED_LISTED)
  const more = untouched.length > shown.length ? `\n- …and ${untouched.length - shown.length} more` : ''
  return `## First-pass findings (already reported — do not repeat):\n${findings}\n\n## Files with no finding yet:\n${shown.map(p => `- ${p}`).join('\n')}${more}`
}
