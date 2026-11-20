import { describe, it, expect } from 'vitest'
import { anchorFor } from '../anchor.js'
import { planRun, type PlanFinding } from '../plan.js'
import { createDeltaMapper, mapEntries } from '../match.js'
import type { ThreadEntry } from '../types.js'

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'
const C = 'cccccccccccc'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -8,3 +8,4 @@', ' c8', ' c9', '+added10', ' c11',
  'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-x',
  'diff --git a/src/big.ts b/src/big.ts', '--- a/src/big.ts', '+++ b/src/big.ts', '@@ -1,1 +1,2 @@', ' k', '+m', '',
].join('\n')

const insertDiff = (file: string, atOld: number, count: number): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${atOld},0 +${atOld + 1},${count} @@\n${Array.from({ length: count }, (_, i) => `+n${i}`).join('\n')}\n`

const entry = (o: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id: 'F1', k: 1, severity: 'HIGH', title: 'Null user crashes profile load', gist: '', file: 'src/a.ts', lines: '100',
  openedAt: A, rootId: '1', url: 'u', resolved: false, humanComments: 0, ...o,
})
const find = (o: Partial<PlanFinding> = {}): PlanFinding => ({ severity: 'HIGH', title: 'Null user crashes profile page', body: 'b', file: 'src/a.ts', lines: '100', ...o })
const run = async (entries: ThreadEntry[], findings: PlanFinding[], fetch: (b: string, h: string) => Promise<string>, head = C, extra: Partial<Parameters<typeof planRun>[0]> = {}) => {
  const mapped = await mapEntries(entries, createDeltaMapper(fetch, head))
  return planRun({ findings, entries: mapped, diff: DIFF, nextK: 5, lowThreads: false, ...extra })
}
const bigDiff = (lines: number): string => `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => ` c${i}`).join('\n')}\n`

describe('anchorFor', () => {
  it('accepts added and context lines of a hunk, uses the range start', () => {
    expect(anchorFor(DIFF, 'src/a.ts', '10')).toEqual({ ok: true, path: 'src/a.ts', line: 10 })
    expect(anchorFor(DIFF, 'src/a.ts', '9-11')).toEqual({ ok: true, path: 'src/a.ts', line: 9 })
  })

  it('classifies the failures', () => {
    expect(anchorFor(DIFF, undefined, '10')).toEqual({ ok: false, reason: 'no_line' })
    expect(anchorFor(DIFF, 'src/a.ts', undefined)).toEqual({ ok: false, reason: 'no_line' })
    expect(anchorFor(DIFF, 'src/a.ts', '500')).toEqual({ ok: false, reason: 'out_of_hunk' })
    expect(anchorFor(DIFF, 'src/other.ts', '1')).toEqual({ ok: false, reason: 'out_of_hunk' })
    expect(anchorFor(DIFF, 'gone.ts', '1')).toEqual({ ok: false, reason: 'old_side' })
  })
})

describe('planRun', () => {
  const noDelta = async (): Promise<string> => ''

  it('after a partial write at B, the run at C maps from B and matches a 0.65 repeat', async () => {
    const e = entry({ openedAt: B })
    const fetch = async (b: string): Promise<string> => (b === B ? '' : insertDiff('src/a.ts', 1, 50))
    const p = await run([e], [find()], fetch)
    expect(p.create).toHaveLength(0)
    expect(p.suppressed.open).toHaveLength(1)
  })

  it('a row kept at 100@A is mapped A to C and matches the repeat at 150', async () => {
    const e = entry({ openedAt: A })
    const fetch = async (b: string): Promise<string> => { expect(b).toBe(A); return insertDiff('src/a.ts', 10, 50) }
    const p = await run([e], [find({ lines: '150' })], fetch)
    expect(p.suppressed.open.map(s => s.id)).toEqual(['F1'])
    expect(p.create).toHaveLength(0)
  })

  it('an unmapped (failed) base needs 0.8, so a 0.65 repeat is raised', async () => {
    const fetch = async (): Promise<string> => { throw new Error('x') }
    const d = bigDiff(300)
    const mapped = await mapEntries([entry()], createDeltaMapper(fetch, C))
    const p = planRun({ findings: [find()], entries: mapped, diff: d, nextK: 2, lowThreads: false })
    expect(p.create).toHaveLength(1)
  })

  it('an unmapped rename is raised', async () => {
    const e = entry({ file: 'src/old.ts' })
    const mapped = await mapEntries([e], createDeltaMapper(noDelta, C))
    const p = planRun({ findings: [find({ file: 'src/a.ts', lines: '9' })], entries: mapped, diff: DIFF, nextK: 2, lowThreads: false })
    expect(p.create).toHaveLength(1)
  })

  it('a resolved match below 0.8 is not suppressed; same severity suppressed; higher raised with was', async () => {
    const resolved = entry({ resolved: true, severity: 'MEDIUM', openedAt: C, lines: '10' })
    const below = await run([resolved], [find({ severity: 'MEDIUM', lines: '10' })], noDelta)
    expect(below.create).toHaveLength(1)
    const same = await run([resolved], [find({ severity: 'MEDIUM', title: resolved.title, lines: '10' })], noDelta)
    expect(same.create).toHaveLength(0)
    expect(same.suppressed.resolved.map(s => s.id)).toEqual(['F1'])
    const higher = await run([resolved], [find({ severity: 'HIGH', title: resolved.title, lines: '10' })], noDelta, C, { nextK: 7 })
    expect(higher.create).toEqual([expect.objectContaining({ id: 'F7', was: 'F1' })])
  })

  it('more than 5 bases leaves resolved threads unmapped and nothing suppressed', async () => {
    const bases = ['111111111111', '222222222222', '333333333333', '444444444444', '555555555555', '666666666666']
    const es = bases.map((b, i) => entry({ id: `F${i + 1}`, k: i + 1, openedAt: b, resolved: true, lines: '10' }))
    const mapped = await mapEntries(es, createDeltaMapper(noDelta, C))
    expect(mapped.filter(m => !m.loc.mapped)).toHaveLength(1)
    const p = planRun({ findings: [find({ title: es[0].title, lines: '10' })], entries: [mapped[5]], diff: DIFF, nextK: 9, lowThreads: false })
    expect(p.suppressed.resolved).toHaveLength(0)
  })

  it('eligibility: LOW off, anchor reasons, and the per-run cap', async () => {
    const mk = (n: number): PlanFinding[] => Array.from({ length: n }, (_, i) => find({ title: `Distinct problem number ${i + 10}`, lines: '9' }))
    const p = await run([], [find({ severity: 'LOW', title: 'low one' }), find({ title: 'noline', lines: undefined }), find({ title: 'oop', lines: '500' }), find({ title: 'old', file: 'gone.ts', lines: '1' })], noDelta)
    expect(p.summaryOnly.map(s => s.reason).sort()).toEqual(['low', 'no_line', 'old_side', 'out_of_hunk'])
    const capped = await run([], mk(22), noDelta)
    expect(capped.create).toHaveLength(20)
    expect(capped.summaryOnly.filter(s => s.reason === 'over_cap')).toHaveLength(2)
    expect(capped.create.map(c => c.id)[0]).toBe('F5')
    const low = await run([], [find({ severity: 'LOW', title: 'low one', lines: '9' })], noDelta, C, { lowThreads: true })
    expect(low.create).toHaveLength(1)
  })

  it('reports open threads whose lines changed in the push', async () => {
    const e = entry({ lines: '10', openedAt: A })
    const d = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,1 +10,1 @@\n-old\n+new\n'
    const p = await run([e], [], async () => d)
    expect([...p.changedInPush]).toEqual(['F1'])
  })
  it('plans an identical finding of the same run once, without a second id, and keeps the twin as a duplicate summary-only row', async () => {
    const f = find({ lines: '10' })
    const p = await run([], [f, { ...f, body: 'same finding again' }], noDelta)
    expect(p.create.map(r => r.id)).toEqual(['F5'])
    expect(p.suppressed.open).toEqual([])
    expect(p.suppressed.sameRun).toEqual([{ finding: expect.objectContaining({ body: 'same finding again' }), id: 'F5' }])
    expect(p.summaryOnly).toEqual([{ finding: expect.objectContaining({ body: 'same finding again' }), reason: 'duplicate' }])
  })

  it('plans both of two findings in one run whose titles are only about 0.6 similar', async () => {
    const p = await run([], [find({ lines: '10', title: 'Distinct problem number 11' }), find({ lines: '10', title: 'Distinct problem number 12' })], noDelta)
    expect(p.create.map(r => r.id)).toEqual(['F5', 'F6'])
    expect(p.suppressed.sameRun).toEqual([])
  })

  it('still plans a different finding at another location of the same run', async () => {
    const p = await run([], [find({ lines: '10' }), find({ lines: '10', title: 'Unrelated race in token refresh' })], noDelta)
    expect(p.create.map(r => r.id)).toEqual(['F5', 'F6'])
  })
})
