import { splitDiffByFile } from './bundler.js'

const INDEX = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/

const prefixed = (x: string, y: string): boolean => (x.length <= y.length ? y.startsWith(x) : x.startsWith(y))

// Abbreviated blob ids grow with the repository, so two diffs of the same blob can print different lengths; below git's 7-character minimum a shared prefix proves nothing.
const sameBlob = (x: string, y: string): boolean => Math.min(x.length, y.length) >= 7 && prefixed(x, y)

const baseBlob = (section: string): string | undefined => section.match(/^index ([0-9a-f]+)\.\./m)?.[1]

const headBlob = (section: string): string | undefined => section.match(/^index [0-9a-f]+\.\.([0-9a-f]+)/m)?.[1]

function sectionPaths(key: string, section: string): string[] {
  const meta = section.split(/^@@/m)[0]
  const path = (named: RegExp, unified: RegExp) => (meta.match(named)?.[1] ?? meta.match(unified)?.[1])?.replace(/\t.*$/, '')
  return [key, path(/^rename from (.+)$/m, /^--- a\/(.+)$/m), path(/^rename to (.+)$/m, /^\+\+\+ b\/(.+)$/m)].filter((p): p is string => !!p)
}

// The splitter skips quoted and combined (`--cc`) headers and mis-keys a path holding " b/", so such a diff cannot prove a file unchanged.
export function readableDiff(diff: string): boolean {
  const headers = diff.match(/^diff .*$/gm) ?? []
  return headers.length === splitDiffByFile(diff).size && headers.every(h => h.startsWith('diff --git a/') && h.split(' b/').length === 2)
}

// A delta file must end at the same blob as in the PR diff pinned to the delta's head, or the two do not describe the same commit.
export function sameHead(delta: string, curr: string): boolean {
  const after = splitDiffByFile(curr)
  return [...splitDiffByFile(delta)].every(([key, section]) => {
    const other = after.get(key)
    if (other === undefined) return true
    const x = headBlob(section)
    const y = headBlob(other)
    return x && y ? sameBlob(x, y) : !x && !y
  })
}

function identical(prev: string, curr: string): boolean {
  const a = prev.split('\n')
  const b = curr.split('\n')
  if (a.length !== b.length) return false
  // Without hunks the index line is the only evidence, so blob ids that merely share a prefix must not count as one.
  const tolerant = /^@@/m.test(prev) && /^@@/m.test(curr)
  return a.every((line, i) => {
    if (line === b[i]) return true
    const x = tolerant && line.match(INDEX)
    const y = tolerant && b[i].match(INDEX)
    return !!x && !!y && sameBlob(x[1], y[1]) && sameBlob(x[2], y[2]) && (x[3] ?? '') === (y[3] ?? '')
  })
}

export const diffPaths = (diff: string): string[] => [...splitDiffByFile(diff)].flatMap(([key, section]) => sectionPaths(key, section))

export function outsideSections(delta: string, prPaths: readonly string[]): string[] {
  const pr = new Set(prPaths)
  return [...splitDiffByFile(delta)].filter(([key, section]) => !sectionPaths(key, section).some(p => pr.has(p))).map(([key]) => key)
}

// "Unchanged" must be provable, so only an exact match counts; a file the target also edited differs in its base blob and is always changed.
export function changedPrFiles(prev: string, curr: string): { changed: Set<string>; baseChanged: Set<string> } {
  const before = splitDiffByFile(prev)
  const after = splitDiffByFile(curr)
  const changed = new Set<string>()
  const baseChanged = new Set<string>()
  const mark = (set: Set<string>, key: string) => {
    for (const s of [before.get(key), after.get(key)]) if (s !== undefined) for (const p of sectionPaths(key, s)) set.add(p)
  }
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const p = before.get(key)
    const c = after.get(key)
    if (p === undefined || c === undefined || !identical(p, c)) mark(changed, key)
    const bp = p && baseBlob(p)
    const bc = c && baseBlob(c)
    // Only provably different base blobs count as a target edit, because this set can silence a confirmation.
    if (bp && bc && !prefixed(bp, bc)) mark(baseChanged, key)
  }
  return { changed, baseChanged }
}

export function narrowDelta(delta: string, changed: ReadonlySet<string>): { diff: string; kept: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  const parts: string[] = []
  for (const [key, section] of splitDiffByFile(delta)) {
    if (sectionPaths(key, section).some(p => changed.has(p))) { kept.push(key); parts.push(section) }
    else dropped.push(key)
  }
  return { diff: dropped.length ? parts.join('') : delta, kept, dropped }
}
