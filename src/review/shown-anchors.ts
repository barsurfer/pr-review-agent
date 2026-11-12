import { normalizeFindingPath, parseLineRange } from './findings-output.js'
import type { FileContext } from '../context/fetcher.js'

// New-side line text by path, for exactly what one model pass was shown; location validity is separate from whether the defect is PR-introduced.
export type ShownSource = Map<string, Map<number, string>>

export interface ShownAnchors {
  judge: ShownSource
  breadth?: ShownSource
  secondLook?: ShownSource
  secondLookFrom?: number
  lens?: ShownSource
  lensFrom?: number
}

// A range wider than this is a fabricated span, not a location.
const MAX_RANGE = 500

export function buildShownSource(diff: string, contexts: readonly FileContext[] = []): ShownSource {
  const out: ShownSource = new Map()
  const put = (file: string, line: number, text: string) => {
    const key = normalizeFindingPath(file)
    const lines = out.get(key) ?? new Map<number, string>()
    lines.set(line, text)
    out.set(key, lines)
  }

  let file = ''
  let newLine = 0
  let inHunk = false
  const rows = diff.split('\n')
  rows.forEach((raw, i) => {
    if (raw.startsWith('diff --git')) { file = ''; inHunk = false; return }
    if (!inHunk && raw.startsWith('+++ b/')) { file = raw.slice(6).trim(); return }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (hunk) { newLine = parseInt(hunk[1], 10); inHunk = true; return }
    if (!inHunk || !file || raw.startsWith('-') || raw.startsWith('\\')) return
    if (raw === '' && i === rows.length - 1) return
    put(file, newLine++, raw.slice(1))
  })

  for (const c of contexts) {
    const lines = c.content.split('\n')
    if (lines.at(-1) === '') lines.pop()
    lines.forEach((text, i) => put(c.path, i + 1, text))
  }
  return out
}

export function shownFile(src: ShownSource, file: string): Map<number, string> | undefined {
  return src.get(normalizeFindingPath(file, [...src.keys()]))
}

// Every line of the range must have been shown, so a wide fabricated range cannot ride on one real line.
export function coversRange(src: ShownSource, file: string, lines: string): boolean {
  const range = parseLineRange(lines)
  const shown = shownFile(src, file)
  if (!range || !shown || range.end - range.start > MAX_RANGE) return false
  for (let n = range.start; n <= range.end; n++) if (!shown.has(n)) return false
  return true
}
