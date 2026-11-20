import { parseLineRange } from '../review/findings-output.js'
import type { ThreadEntry } from './types.js'

export const MAX_BASES = 5
const NEAR = 10

const STOP = new Set(['the', 'an', 'is', 'are', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'with', 'be', 'it', 'this', 'that'])

function tokens(title: string): Set<string> {
  const out = new Set<string>()
  for (const t of title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) if (t.length > 1 && !STOP.has(t)) out.add(t)
  return out
}

export function titleSimilarity(a: string, b: string): number {
  const x = tokens(a)
  const y = tokens(b)
  if (x.size === 0 || y.size === 0) return 0
  let both = 0
  for (const t of x) if (y.has(t)) both++
  return both / (x.size + y.size - both)
}

interface DeltaHunk { firstOld: number; lastOld: number; delta: number; lineMap: Map<number, number>; removed: Set<number>; insertAfter: number[] }
interface DeltaFile { newPath: string; deleted: boolean; hunks: DeltaHunk[] }
export type DeltaMap = Map<string, DeltaFile>

export interface Mapped { file: string; line?: number; end?: number; g: number; changed: boolean }

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseDeltaMap(diff: string): DeltaMap {
  const out: DeltaMap = new Map()
  for (const section of diff.split(/(?=^diff --git )/m)) {
    const header = section.match(/^diff --git a\/(.+?) b\/(.+)$/m)
    if (!header) continue
    const meta = section.split(/^@@/m)[0]
    const renameFrom = meta.match(/^rename from (.+)$/m)?.[1]
    const renameTo = meta.match(/^rename to (.+)$/m)?.[1]
    const deleted = /^deleted file mode /m.test(meta)
    const oldPath = (renameFrom ?? header[1]).replace(/\t.*$/, '')
    const newPath = (renameTo ?? header[2]).replace(/\t.*$/, '')
    const hunks: DeltaHunk[] = []
    let cur: DeltaHunk | undefined
    let o = 0
    let n = 0
    let inHunks = false
    for (const raw of section.split('\n')) {
      const m = HUNK_RE.exec(raw)
      if (m) {
        inHunks = true
        const oldStart = Number(m[1])
        const oldLen = m[2] === undefined ? 1 : Number(m[2])
        const newLen = m[4] === undefined ? 1 : Number(m[4])
        // A zero-length old side means "insert after line oldStart".
        const firstOld = oldLen === 0 ? oldStart + 1 : oldStart
        cur = { firstOld, lastOld: firstOld + oldLen - 1, delta: newLen - oldLen, lineMap: new Map(), removed: new Set(), insertAfter: [] }
        hunks.push(cur)
        o = firstOld
        n = Number(m[3])
        continue
      }
      if (!inHunks || !cur) continue
      if (raw.startsWith('\\')) continue
      if (raw.startsWith('-')) { cur.removed.add(o); cur.lineMap.set(o, n); o++ }
      else if (raw.startsWith('+')) { cur.insertAfter.push(o - 1); n++ }
      else if (raw.startsWith(' ')) { cur.lineMap.set(o, n); o++; n++ }
    }
    out.set(oldPath, { newPath, deleted, hunks })
  }
  return out
}

function mapOne(f: DeltaFile, line: number): { line: number; g: number } {
  let offset = 0
  for (const h of f.hunks) {
    if (line < h.firstOld) return { line: line + offset, g: 0 }
    if (line <= h.lastOld) return { line: h.lineMap.get(line) ?? line + offset, g: Math.max(0, h.delta) }
    offset += h.delta
  }
  return { line: line + offset, g: 0 }
}

export function mapLine(map: DeltaMap, file: string, lines: string | undefined): Mapped | null {
  const f = map.get(file)
  if (!f) {
    const r = parseLineRange(lines)
    return { file, ...(r ? { line: r.start, end: r.end } : {}), g: 0, changed: false }
  }
  if (f.deleted) return null
  const r = parseLineRange(lines)
  if (!r) return { file: f.newPath, g: 0, changed: false }
  const a = mapOne(f, r.start)
  const b = mapOne(f, r.end)
  const changed = f.hunks.some(h =>
    [...h.removed].some(x => x >= r.start && x <= r.end) || h.insertAfter.some(p => p >= r.start && p < r.end))
  return { file: f.newPath, line: a.line, end: b.line, g: Math.max(a.g, b.g), changed }
}

export interface DeltaMapper {
  map(file: string, lines: string | undefined, base: string): Promise<Mapped | null>
}

// Unmapped (null) covers a failed fetch, the 5-base cap and a deleted file; callers keep the old line and base then.
export function createDeltaMapper(fetchDelta: (base: string, head: string) => Promise<string>, head: string, maxBases = MAX_BASES): DeltaMapper {
  const cache = new Map<string, Promise<DeltaMap | null>>()
  const load = (base: string): Promise<DeltaMap | null> => {
    const hit = cache.get(base)
    if (hit) return hit
    if (cache.size >= maxBases) return Promise.resolve(null)
    const p = fetchDelta(base, head).then(parseDeltaMap, () => null)
    cache.set(base, p)
    return p
  }
  return {
    async map(file, lines, base) {
      if (base === head) {
        const r = parseLineRange(lines)
        return { file, ...(r ? { line: r.start, end: r.end } : {}), g: 0, changed: false }
      }
      const dm = await load(base)
      return dm ? mapLine(dm, file, lines) : null
    },
  }
}

export interface Loc { file: string; line?: number; g: number; mapped: boolean }
export interface MappedEntry { entry: ThreadEntry; loc: Loc; changed: boolean }

export async function mapEntries(entries: readonly ThreadEntry[], mapper: DeltaMapper): Promise<MappedEntry[]> {
  const out: MappedEntry[] = new Array(entries.length)
  // The base cap is first come, first served, so open threads (the main dedup target) map before resolved ones.
  const order = entries.map((_, i) => i).sort((a, b) => Number(entries[a].resolved) - Number(entries[b].resolved) || a - b)
  for (const i of order) {
    const entry = entries[i]
    const m = entry.file ? await mapper.map(entry.file, entry.lines, entry.openedAt) : null
    if (m) out[i] = { entry, loc: { file: m.file, ...(m.line !== undefined ? { line: m.line } : {}), g: m.g, mapped: true }, changed: m.changed }
    else out[i] = { entry, loc: { file: entry.file, ...(parseLineRange(entry.lines) ? { line: parseLineRange(entry.lines)!.start } : {}), g: 0, mapped: false }, changed: false }
  }
  return out
}

export interface Candidate { title: string; file?: string; lines?: string }

export function matches(m: MappedEntry, c: Candidate, kind: 'open' | 'resolved'): boolean {
  if (!c.file || !m.loc.file || c.file !== m.loc.file) return false
  const sim = titleSimilarity(m.entry.title, c.title)
  const cl = parseLineRange(c.lines)?.start
  if (kind === 'resolved') {
    if (!m.loc.mapped || m.loc.line === undefined || cl === undefined) return false
    return sim >= 0.8 && Math.abs(cl - m.loc.line) <= NEAR + m.loc.g
  }
  if (!m.loc.mapped) return sim >= 0.8
  if (m.loc.line === undefined || cl === undefined) return sim >= 0.6
  return sim >= 0.8 || (sim >= 0.5 && Math.abs(cl - m.loc.line) <= NEAR + m.loc.g)
}
