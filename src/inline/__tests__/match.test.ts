import { describe, it, expect, vi } from 'vitest'
import { titleSimilarity, parseDeltaMap, mapLine, createDeltaMapper, mapEntries, matches, type MappedEntry } from '../match.js'
import type { ThreadEntry } from '../types.js'

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'
const C = 'cccccccccccc'

const insertDiff = (file: string, atOld: number, count: number): string => {
  const added = Array.from({ length: count }, (_, i) => `+new${i}`).join('\n')
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${atOld},0 +${atOld + 1},${count} @@\n${added}\n`
}

const entry = (o: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id: 'F1', k: 1, severity: 'HIGH', title: 'Null user crashes profile load', gist: '', file: 'src/a.ts', lines: '100',
  openedAt: A, rootId: '1', url: 'u', resolved: false, humanComments: 0, ...o,
})

describe('titleSimilarity', () => {
  it('is Jaccard over content words', () => {
    expect(titleSimilarity('Null user crashes profile load', 'Null user crashes profile load')).toBe(1)
    expect(titleSimilarity('Null user crashes profile load', 'Null user crashes profile page')).toBeCloseTo(4 / 6)
    expect(titleSimilarity('abc', '')).toBe(0)
  })
})

describe('mapLine', () => {
  it('shifts lines after an insertion and leaves earlier ones', () => {
    const m = parseDeltaMap(insertDiff('src/a.ts', 10, 50))
    expect(mapLine(m, 'src/a.ts', '100')).toMatchObject({ line: 150 })
    expect(mapLine(m, 'src/a.ts', '10')).toMatchObject({ line: 10 })
  })

  it('maps a context line inside a hunk past an insertion (42 to 43)', () => {
    const d = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -40,5 +40,6 @@\n c40\n c41\n+added\n c42\n c43\n c44\n'
    const r = mapLine(parseDeltaMap(d), 'f', '42')!
    expect(r.line).toBe(43)
    expect(r.g).toBe(1)
  })

  it('follows renames and treats a deleted file as unmapped', () => {
    const rename = 'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n'
    expect(mapLine(parseDeltaMap(rename), 'old.ts', '7')).toMatchObject({ file: 'new.ts', line: 7 })
    const del = 'diff --git a/x.ts b/x.ts\ndeleted file mode 100644\n--- a/x.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n'
    expect(mapLine(parseDeltaMap(del), 'x.ts', '1')).toBeNull()
  })

  it('flags a changed line only when removed or split by an insertion', () => {
    const d = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -5,3 +5,3 @@\n c5\n-old6\n+new6\n c7\n'
    const m = parseDeltaMap(d)
    expect(mapLine(m, 'f', '6')!.changed).toBe(true)
    expect(mapLine(m, 'f', '5')!.changed).toBe(false)
    expect(mapLine(m, 'f', '5-7')!.changed).toBe(true)
  })
})

describe('createDeltaMapper', () => {
  it('fetches once per base, skips base === head, and caps distinct bases', async () => {
    const fetch = vi.fn(async (b: string) => insertDiff('src/a.ts', 10, b === A ? 50 : 1))
    const mp = createDeltaMapper(fetch, C, 2)
    expect((await mp.map('src/a.ts', '100', C))!.line).toBe(100)
    expect(fetch).not.toHaveBeenCalled()
    expect((await mp.map('src/a.ts', '100', A))!.line).toBe(150)
    expect((await mp.map('src/a.ts', '200', A))!.line).toBe(250)
    expect(fetch).toHaveBeenCalledTimes(1)
    await mp.map('src/a.ts', '1', B)
    expect(await mp.map('src/a.ts', '1', 'dddddddddddd')).toBeNull()
  })

  it('maps open threads before resolved ones when the base cap is hit, keeping the input order', async () => {
    const bases = ['111111111111', '222222222222', '333333333333', '444444444444', '555555555555']
    const fetch = vi.fn(async () => insertDiff('src/a.ts', 10, 5))
    const mp = createDeltaMapper(fetch, C)
    const resolved = bases.map((b, i) => entry({ id: `F${i + 1}`, k: i + 1, resolved: true, openedAt: b }))
    const open = entry({ id: 'F6', k: 6, openedAt: B })
    const out = await mapEntries([...resolved, open], mp)
    expect(out.map(m => m.entry.id)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6'])
    expect(out[5].loc).toMatchObject({ line: 105, mapped: true })
    expect(out.filter(m => m.entry.resolved && m.loc.mapped)).toHaveLength(4)
  })

  it('a failed fetch is unmapped and keeps the old location', async () => {
    const mp = createDeltaMapper(async () => { throw new Error('boom') }, C)
    expect(await mp.map('src/a.ts', '100', A)).toBeNull()
    const [m] = await mapEntries([entry({ openedAt: A })], mp)
    expect(m.loc).toMatchObject({ file: 'src/a.ts', line: 100, mapped: false })
  })
})

describe('matches', () => {
  const mapped = (e: ThreadEntry, line = 100, g = 0, mappedOk = true): MappedEntry => ({ entry: e, loc: { file: e.file, line, g, mapped: mappedOk }, changed: false })
  const repeat = { title: 'Null user crashes profile page', file: 'src/a.ts', lines: '100' }

  it('open: similarity 0.65 plus a nearby line matches; far line does not', () => {
    expect(matches(mapped(entry()), repeat, 'open')).toBe(true)
    expect(matches(mapped(entry()), { ...repeat, lines: '150' }, 'open')).toBe(false)
    expect(matches(mapped(entry(), 100, 45), { ...repeat, lines: '150' }, 'open')).toBe(true)
  })

  it('open: 0.8 matches anywhere in the file, 0.6 when a line is missing, other file never', () => {
    expect(matches(mapped(entry()), { ...repeat, title: entry().title, lines: '900' }, 'open')).toBe(true)
    expect(matches(mapped(entry()), { ...repeat, lines: undefined }, 'open')).toBe(true)
    expect(matches(mapped(entry()), { ...repeat, file: 'src/b.ts' }, 'open')).toBe(false)
  })

  it('open: an unmapped location needs 0.8', () => {
    expect(matches(mapped(entry(), 100, 0, false), repeat, 'open')).toBe(false)
    expect(matches(mapped(entry(), 100, 0, false), { ...repeat, title: entry().title }, 'open')).toBe(true)
  })

  it('resolved: strict 0.8 plus nearby line, never when unmapped', () => {
    const r = entry({ resolved: true })
    expect(matches(mapped(r), repeat, 'resolved')).toBe(false)
    expect(matches(mapped(r), { ...repeat, title: r.title, lines: '105' }, 'resolved')).toBe(true)
    expect(matches(mapped(r), { ...repeat, title: r.title, lines: '150' }, 'resolved')).toBe(false)
    expect(matches(mapped(r, 100, 0, false), { ...repeat, title: r.title }, 'resolved')).toBe(false)
  })
})
