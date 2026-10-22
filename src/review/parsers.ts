// ---------------------------------------------------------------------------
// Pure parsing & diff helpers — no side effects, no I/O
// ---------------------------------------------------------------------------

import type { ChangedFile } from '../vcs/adapter.js'

// The API's context-length rejection — so the caller can degrade (drop file contexts) or skip rather than error.
export function isContextLengthError(err: unknown): boolean {
  const e = err as { status?: number; message?: string }
  // Match genuine input/context overflow only — not a max_tokens-above-output-limit 400 (a config bug to surface, not degrade past).
  return e?.status === 400 && /prompt is too long|exceed context limit|context (window|length)/i.test(e?.message ?? '')
}

/** Convert a glob-like pattern (e.g. "*.json", "package-lock.json") to a regex. */
function patternToRegex(pattern: string): RegExp {
  // Exact filename match
  if (!pattern.includes('*')) return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
  // *.ext → match any file ending with .ext
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
  return new RegExp(escaped + '$')
}

/** Check whether a file path matches any exclusion pattern. */
export function isPathExcluded(path: string, excludePatterns: string[]): boolean {
  return excludePatterns.some(p => patternToRegex(p).test(path))
}

/** Strip diff sections for files matching exclusion patterns. */
export function filterDiff(diff: string, excludePatterns: string[]): { filtered: string; removedCount: number } {
  const regexes = excludePatterns.map(patternToRegex)
  const sections = diff.split(/(?=^diff --git )/m)
  const kept = sections.filter(section => {
    const match = section.match(/^diff --git a\/(.+?) b\//)
    if (!match) return true
    return !regexes.some(r => r.test(match[1]))
  })
  return { filtered: kept.join(''), removedCount: sections.length - kept.length }
}

/** Changed files of a git unified diff, keyed by the new-side path (old side for deletions). */
export function parseChangedFiles(diff: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const section of diff.split(/(?=^diff --git )/m)) {
    const header = section.match(/^diff --git a\/(.+?) b\/(.+)$/m)
    if (!header) continue
    // Only the extended header — a hunk line can itself start with "+++ b/".
    const meta = section.split(/^@@/m)[0]
    const renamedTo = meta.match(/^rename to (.+)$/m)?.[1]
    const newPath = meta.match(/^\+\+\+ b\/(.+)$/m)?.[1]
    const oldPath = meta.match(/^--- a\/(.+)$/m)?.[1]
    const status: ChangedFile['status'] = /^new file mode /m.test(meta) ? 'added'
      : /^deleted file mode /m.test(meta) ? 'deleted'
      : renamedTo ? 'renamed'
      : 'modified'
    // git appends a TAB (+ similarity/rename info) when a path contains spaces — drop it.
    const path = (renamedTo ?? newPath ?? oldPath ?? header[2]).replace(/\t.*$/, '')
    files.push({ path, status })
  }
  return files
}

// Hunk-aware: file headers only precede a file's first @@, so a removed `---` YAML rule or an added `+++i;` is still content.
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0, inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) inHunk = false
    else if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) added++
    else if (inHunk && line.startsWith('-')) removed++
  }
  return { added, removed }
}

/** Count added/removed lines in a unified diff (excludes --- and +++ headers). */
export function countChangedLines(diff: string): number {
  const { added, removed } = countDiffLines(diff)
  return added + removed
}

const GUTTER = 5

// Budget estimates must count the gutter the model actually sees, or a near-budget PR overflows once numbering is on.
export function shownLength(s: string, numbered: boolean): number {
  return s.length + (numbered && s ? (GUTTER + 1) * s.split('\n').length : 0)
}

// Models can't reliably count lines from @@ headers, so ~40% of findings came back with no line; show the new-file number on every added/context line.
export function numberDiffLines(diff: string): string {
  let newLine = 0
  let inHunk = false
  const lines = diff.split('\n')
  return lines.map((raw, i) => {
    if (raw.startsWith('diff --git')) { inHunk = false; return raw }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) { newLine = parseInt(hunk[1], 10); inHunk = true; return raw }
    // A blank line mid-hunk is context (as addedLines counts it); only the trailing newline's empty tail is not.
    if (!inHunk || raw.startsWith('\\') || (raw === '' && i === lines.length - 1)) return raw
    if (raw.startsWith('-')) return `${''.padStart(GUTTER)} ${raw}`
    return `${String(newLine++).padStart(GUTTER)} ${raw}`
  }).join('\n')
}

export function numberFileLines(content: string): string {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((l, i) => `${String(i + 1).padStart(GUTTER)} ${l}`).join('\n')
}

/** Extract merge confidence / verdict percentage from review text. Returns null if not found. */
export function parseVerdictScore(text: string): number | null {
  const match = text.match(/#{1,4}\s*(?:Merge Confidence|Verdict):\s*(\d+)%/)
  return match ? parseInt(match[1], 10) : null
}

/** Count HIGH, MEDIUM, LOW findings from the Findings section only. */
export function parseFindings(text: string): { high: number; medium: number; low: number } {
  const findingsMatch = text.match(/#{1,4}\s*Findings\b([\s\S]*?)(?=#{1,4}\s|$)/i)
  const section = findingsMatch?.[1] ?? ''
  return {
    high: (section.match(/\*\*HIGH\b/gi) ?? []).length,
    medium: (section.match(/\*\*MEDIUM\b/gi) ?? []).length,
    low: (section.match(/\*\*LOW\b/gi) ?? []).length,
  }
}

/** Parse DELTA_STATS comment from re-review text. Returns null if not found. */
export function parseDeltaStats(text: string): { resolved: number; still_open: number; new_findings: number } | null {
  const match = text.match(/<!--\s*DELTA_STATS:\s*resolved=(\d+)\s+still_open=(\d+)\s+new=(\d+)\s*-->/)
  if (!match) return null
  return {
    resolved: parseInt(match[1], 10),
    still_open: parseInt(match[2], 10),
    new_findings: parseInt(match[3], 10),
  }
}

export interface AddedLine {
  file: string
  line: number
  text: string   // the added line's content, without the leading '+'
}

// Added (`+`) lines with their new-file line numbers — the single hunk walk shared by scanTodos and the anchor resolver.
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = []
  let file = ''
  let newLine = 0

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) { file = ''; continue }
    if (raw.startsWith('+++ b/')) { file = raw.slice(6).trim(); continue }
    if (raw.startsWith('--- ')) continue
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) { newLine = parseInt(hunk[1], 10); continue }
    if (raw.startsWith('-')) continue                // removed — new-file counter unchanged
    if (raw.startsWith('+')) {
      if (file) out.push({ file, line: newLine, text: raw.slice(1) })
      newLine++
      continue
    }
    if (raw.startsWith('\\')) continue               // "\ No newline at end of file" is a marker, not a line
    newLine++                                        // context line advances the counter
  }
  return out
}

export interface TodoItem {
  file: string
  line: number
  text: string
}

// Deterministic TODO/FIXME/HACK scan of added lines — catches breadcrumbs a model might miss.
export function scanTodos(diff: string): TodoItem[] {
  const marker = /\b(TODO|FIXME|HACK)\b:?\s*(.*)/i
  const todos: TodoItem[] = []
  for (const { file, line, text } of addedLines(diff)) {
    const m = text.match(marker)
    if (!m) continue
    const body = m[2].trim()
    todos.push({ file, line, text: (body ? `${m[1].toUpperCase()}: ${body}` : m[1].toUpperCase()).slice(0, 140) })
  }
  return todos
}
