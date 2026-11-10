// Breadth lens: a second reviewer pass aimed at changed files the first pass left without a finding.

import { parseChangedFiles, countDiffLines } from './parsers.js'
import { splitDiffByFile } from './bundler.js'
import { normalizeFindingPath } from './findings-output.js'
import type { ReviewFinding } from './formatter.js'

const SHOWN_LINE_CLAUSE = 'a numeric line on an added or modified line.'

// Not the fetcher's context-exclusion list: migrations are real review targets, while lockfiles and generated code only pad the trigger counts.
const GENERATED_OR_LOCK = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$/, /\.lock$/,
  /-generated\./, /\.min\.(js|css)$/, /\.snap$/, /\.map$/, /\.pb\.go$/, /_pb2(_grpc)?\.py$/,
]
const isGeneratedOrLock = (path: string): boolean => GENERATED_OR_LOCK.some(re => re.test(path))

export type BreadthStatus =
  | 'disabled' | 'skipped_no_judge' | 'skipped_rereview' | 'skipped_bundled'
  | 'skipped_small' | 'skipped_few_untouched' | 'skipped_limit' | 'skipped_budget' | 'skipped_time' | 'succeeded' | 'failed'

export type CandidateOrigin = 'review' | 'breadth' | 'second_look'

export type SecondLookStatus =
  | 'disabled' | 'skipped_no_judge' | 'skipped_rereview' | 'skipped_bundled'
  | 'skipped_no_findings' | 'skipped_limit' | 'skipped_budget' | 'skipped_time' | 'succeeded' | 'failed'

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
// Lets a pass cite an unchanged line it was shown while the introduced-by-change requirement stays.
function allowShownContext(lens: string): string {
  if (!lens.includes(SHOWN_LINE_CLAUSE)) throw new Error('Lens anchor clause not found')
  return lens.replace(SHOWN_LINE_CLAUSE, () => 'a numeric line on an added or modified line, or on an unchanged line you were shown when it explains a defect this change introduces.')
}

export function breadthSystemPrompt(reviewerPrompt: string, limit: number, shownAnchors = false): string {
  const limitSection = limit > 0
    ? `\n\n## FINDINGS LIMIT\nReport at most ${limit} findings, prioritized by severity and impact. If more exist, include only the most important and omit the rest.`
    : ''
  return `${reviewerPrompt}${limitSection}\n\n${shownAnchors ? allowShownContext(BREADTH_LENS) : BREADTH_LENS}`
}

export interface BreadthPlan {
  selected: string[]
  deprioritizedReleaseEntries: number
  omitted: number
}

const DOC_SLOTS = 8
const DOC_EXT = /\.(md|markdown|rst|txt|adoc|asciidoc)$/i
// Per-release changeset entries are near-identical prose; README.md in that folder is real documentation.
const isReleaseEntry = (path: string): boolean => /^\.changeset\/[^/]+\.md$/i.test(path) && !/^\.changeset\/readme\.md$/i.test(path)

function subsystem(path: string): string {
  const pkg = path.match(/^(?:packages|apps)\/[^/]+/)
  if (pkg) return pkg[0]
  const slash = path.indexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')))

// Round-robin across subsystems so one package or folder cannot take every slot; ranking is fully deterministic regardless of input order.
function pickDiverse(paths: readonly string[], slots: number, rank: (path: string) => [number, number, string]): string[] {
  const cmp = (a: string, b: string): number => {
    const [pa, la, na] = rank(a)
    const [pb, lb, nb] = rank(b)
    return pa - pb || lb - la || (na < nb ? -1 : na > nb ? 1 : 0)
  }
  const groups = new Map<string, string[]>()
  for (const p of paths) groups.set(subsystem(p), [...(groups.get(subsystem(p)) ?? []), p])
  for (const list of groups.values()) list.sort(cmp)
  const out: string[] = []
  while (out.length < slots) {
    const live = [...groups.entries()].filter(([, list]) => list.length > 0).sort(([ka, a], [kb, b]) => cmp(a[0], b[0]) || (ka < kb ? -1 : 1))
    if (live.length === 0) break
    for (const [, list] of live) {
      if (out.length >= slots) break
      out.push(list.shift()!)
    }
  }
  return out
}

// Spends the fixed listing cap on substantive, diverse files; the diff payload is unchanged and omitted files stay in it.
export function prioritizeUntouched(untouched: readonly string[], filteredDiff: string, findings: readonly ReviewFinding[]): BreadthPlan {
  const eligible = untouched.filter(p => !isReleaseEntry(p))
  const docs = eligible.filter(p => DOC_EXT.test(p))
  const other = eligible.filter(p => !DOC_EXT.test(p))
  const sections = splitDiffByFile(filteredDiff)
  const size = (p: string): number => { const { added, removed } = countDiffLines(sections.get(p) ?? ''); return added + removed }
  const changed = parseChangedFiles(filteredDiff).map(f => f.path)
  const found = findings.filter(f => f.file).map(f => normalizeFindingPath(f.file!, changed))
  const foundDirs = new Set(found.map(dirOf))
  const foundSystems = new Set(found.map(subsystem))
  const rank = (p: string): [number, number, string] => [foundDirs.has(dirOf(p)) ? 0 : foundSystems.has(subsystem(p)) ? 1 : 2, size(p), p]

  const otherSlots = Math.min(other.length, MAX_UNTOUCHED_LISTED - DOC_SLOTS + Math.max(0, DOC_SLOTS - docs.length))
  const docSlots = Math.min(docs.length, MAX_UNTOUCHED_LISTED - otherSlots)
  const selected = [...pickDiverse(other, otherSlots, rank), ...pickDiverse(docs, docSlots, rank)]
  return { selected, deprioritizedReleaseEntries: untouched.length - eligible.length, omitted: eligible.length - selected.length }
}

// Titles and anchors only: enough to avoid repeats and seed the same-defect search without re-sending every body.
export function breadthBriefing(firstPass: readonly ReviewFinding[], untouched: readonly string[], plan?: BreadthPlan): string {
  const located = (f: ReviewFinding) => (f.file ? `${f.file}${f.lines ? `:${f.lines}` : ''}` : '(no file)')
  const findings = firstPass.length ? firstPass.map(f => `- ${located(f)} — ${f.title}`).join('\n') : 'None.'
  if (plan) {
    const more = plan.omitted > 0 ? `\n- …and ${plan.omitted} more eligible file(s) not listed` : ''
    return `## First-pass findings (already reported — do not repeat):\n${findings}\n\n## Files with no finding yet (prioritized targets; unlisted files remain in the supplied diff):\n${plan.selected.length ? plan.selected.map(p => `- ${p}`).join('\n') : 'None.'}${more}`
  }
  const shown = untouched.slice(0, MAX_UNTOUCHED_LISTED)
  const more = untouched.length > shown.length ? `\n- …and ${untouched.length - shown.length} more` : ''
  return `## First-pass findings (already reported — do not repeat):\n${findings}\n\n## Files with no finding yet:\n${shown.length ? shown.map(p => `- ${p}`).join('\n') : 'None.'}${more}`
}

// Reviewable diff sections that already carry a finding — second-look's targets, the inverse of breadth's untouched.
export function flaggedFiles(filteredDiff: string, findings: readonly ReviewFinding[]): string[] {
  const { reviewable, untouched } = fileCoverage(filteredDiff, findings)
  const untouchedSet = new Set(untouched)
  return reviewable.filter(p => !untouchedSet.has(p))
}

// Findings that land in the target files, by the same path mapping as fileCoverage — breadth findings can too.
export function findingsInFiles(findings: readonly ReviewFinding[], files: readonly string[]): ReviewFinding[] {
  const set = new Set(files)
  return findings.filter(f => {
    if (!f.file) return false
    const path = normalizeFindingPath(f.file, files)
    return set.has(path) || files.some(p => p.endsWith('/' + path))
  })
}

// Breadth lens minus its untouched-files item: hunt for what the first pass missed in the files it already flagged.
export const SECOND_LOOK_LENS = `## SECOND LOOK
A first review pass already ran; its findings are listed in the message. You are re-reading the SAME files it already flagged, to find real problems it MISSED — not to re-report what it found. Work through, in order:
1. The same defect at another place: for each first-pass finding, look for the same pattern on other added or modified lines in these files. Each other place is its own finding.
2. Things that should have changed together: an inconsistency this change introduces between changed code and other code visible in the diff or file context — a caller not updated for a new parameter, an interface missing what its implementation adds, a sibling copy left behind. Anchor the finding on the added or modified line, and report it only when both sides are visible in what you were shown.
3. Incomplete changes on added or modified lines: stubs, placeholder returns, options parsed but ignored, a capability added at one layer but never wired up. A diff segment that ends at an opening brace or \`if\` is a hunk boundary, not an incomplete change.
Do not repeat a first-pass finding (same root cause at the same place). Every finding needs a concrete failing scenario, a file, and a numeric line on an added or modified line. Return an empty list if you find nothing.`

export function secondLookSystemPrompt(reviewerPrompt: string, limit: number, shownAnchors = false): string {
  const limitSection = limit > 0
    ? `\n\n## FINDINGS LIMIT\nReport at most ${limit} findings, prioritized by severity and impact. If more exist, include only the most important and omit the rest.`
    : ''
  return `${reviewerPrompt}${limitSection}\n\n${shownAnchors ? allowShownContext(SECOND_LOOK_LENS) : SECOND_LOOK_LENS}`
}

// Known findings (review + breadth) in the target files — titles + anchors only, so the pass avoids repeats.
export function secondLookBriefing(known: readonly ReviewFinding[]): string {
  const located = (f: ReviewFinding) => (f.file ? `${f.file}${f.lines ? `:${f.lines}` : ''}` : '(no file)')
  const findings = known.length ? known.map(f => `- ${located(f)} — ${f.title}`).join('\n') : 'None.'
  return `## Findings already reported (do NOT repeat — find additional distinct problems in these files):\n${findings}`
}
