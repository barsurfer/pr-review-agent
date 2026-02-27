// ---------------------------------------------------------------------------
// Pure parsing & diff helpers — no side effects, no I/O
// ---------------------------------------------------------------------------

const DIFF_EXCLUDED_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.lock$/,
]

/** Strip diff sections for files that add noise without review value (lock files, etc.). */
export function filterDiff(diff: string): { filtered: string; removedCount: number } {
  const sections = diff.split(/(?=^diff --git )/m)
  const kept = sections.filter(section => {
    const match = section.match(/^diff --git a\/(.+?) b\//)
    if (!match) return true
    return !DIFF_EXCLUDED_PATTERNS.some(p => p.test(match[1]))
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

/** Extract verdict percentage from review text. Returns null if not found. */
export function parseVerdictScore(text: string): number | null {
  const match = text.match(/#{1,4}\s*Verdict:\s*(\d+)%/)
  return match ? parseInt(match[1], 10) : null
}

/** Count HIGH, MEDIUM, LOW findings from the Findings section only. */
export function parseFindings(text: string): { high: number; medium: number; low: number } {
  const findingsMatch = text.match(/#{1,4}\s*Findings\b([\s\S]*?)(?=#{1,4}\s|\z)/i)
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
