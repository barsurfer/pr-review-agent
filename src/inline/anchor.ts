import { parseLineRange } from '../review/findings-output.js'
import type { SummaryOnlyReason } from './types.js'

// Flip to true if Phase 0 (P3) shows Bitbucket rejects inline comments on context lines.
export const ADDED_LINES_ONLY = false

interface FileLines { deleted: boolean; lines: Map<number, 'added' | 'context'> }

function indexDiff(diff: string): Map<string, FileLines> {
  const out = new Map<string, FileLines>()
  for (const section of diff.split(/(?=^diff --git )/m)) {
    const header = section.match(/^diff --git a\/(.+?) b\/(.+)$/m)
    if (!header) continue
    const meta = section.split(/^@@/m)[0]
    const deleted = /^deleted file mode /m.test(meta) || /^\+\+\+ \/dev\/null$/m.test(meta)
    const path = (meta.match(/^rename to (.+)$/m)?.[1] ?? meta.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? header[2]).replace(/\t.*$/, '')
    const lines = new Map<number, 'added' | 'context'>()
    let n = 0
    let inHunk = false
    for (const raw of section.split('\n')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
      if (h) { n = Number(h[1]); inHunk = true; continue }
      if (!inHunk || raw.startsWith('\\') || raw.startsWith('-')) continue
      if (raw.startsWith('+')) { lines.set(n, 'added'); n++ }
      else if (raw.startsWith(' ')) { lines.set(n, 'context'); n++ }
    }
    out.set(path, { deleted, lines })
  }
  return out
}

export type Anchor = { ok: true; path: string; line: number } | { ok: false; reason: SummaryOnlyReason }

export function createAnchorer(diff: string): (file: string | undefined, lines: string | undefined) => Anchor {
  const idx = indexDiff(diff)
  return (file, lines) => {
    const range = parseLineRange(lines)
    if (!file || !range) return { ok: false, reason: 'no_line' }
    const f = idx.get(file)
    if (!f) return { ok: false, reason: 'out_of_hunk' }
    if (f.deleted) return { ok: false, reason: 'old_side' }
    const kind = f.lines.get(range.start)
    if (!kind || (ADDED_LINES_ONLY && kind !== 'added')) return { ok: false, reason: 'out_of_hunk' }
    return { ok: true, path: file, line: range.start }
  }
}

export const anchorFor = (diff: string, file: string | undefined, lines: string | undefined): Anchor => createAnchorer(diff)(file, lines)
