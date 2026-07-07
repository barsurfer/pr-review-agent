// ---------------------------------------------------------------------------
// Pure parsing & diff helpers — no side effects, no I/O
// ---------------------------------------------------------------------------

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

/** Count added/removed lines in a unified diff (excludes --- and +++ headers). */
export function countChangedLines(diff: string): number {
  let count = 0
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))) {
      count++
    }
  }
  return count
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

export interface TodoItem {
  file: string
  line: number
  text: string
}

/** Scan added (`+`) lines in a unified diff for TODO/FIXME/HACK markers, tracking the
 *  new-file line number from hunk headers. Deterministic — catches breadcrumbs the model
 *  might miss. */
export function scanTodos(diff: string): TodoItem[] {
  const todos: TodoItem[] = []
  const marker = /\b(TODO|FIXME|HACK)\b:?\s*(.*)/i
  let file = ''
  let newLine = 0

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) { file = ''; continue }
    if (raw.startsWith('+++ b/')) { file = raw.slice(6).trim(); continue }
    if (raw.startsWith('--- ')) continue
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) { newLine = parseInt(hunk[1], 10); continue }
    if (raw.startsWith('-')) continue                // removed — new-file counter unchanged
    if (raw.startsWith('+')) {                       // added line
      const m = raw.slice(1).match(marker)
      if (m && file) {
        const body = m[2].trim()
        todos.push({ file, line: newLine, text: (body ? `${m[1].toUpperCase()}: ${body}` : m[1].toUpperCase()).slice(0, 140) })
      }
      newLine++
      continue
    }
    newLine++                                        // context line advances the counter
  }
  return todos
}
