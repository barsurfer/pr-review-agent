import { describe, it, expect } from 'vitest'
import {
  sanitizeTitle, threadRow, summaryOnlyRow, resolvedRow, overflowLine, parseRows, parseThreadRow, parseResolvedRow, parseOverflow,
  historyLine, parseHistoryLine, parseHistory, capHistory, MAX_TITLE,
} from '../rows.js'

const base = { severity: 'HIGH' as const, file: 'src/a.ts', lines: '42-47', base: 'a1b2c3d4e5f6', id: 'F9', url: 'https://bitbucket.org/ws/r/pull-requests/1#comment-5' }

describe('thread rows', () => {
  it('round-trips with the @<c12> base, was and each code note, and still parses the old push suffix', () => {
    const plain = threadRow({ ...base, title: 'Null user' })
    expect(plain).toBe('- **HIGH – Null user** (`src/a.ts:42-47@a1b2c3d4e5f6`) · F9 · [thread](https://bitbucket.org/ws/r/pull-requests/1#comment-5)')
    expect(parseThreadRow(plain)).toEqual({ kind: 'thread', ...base, title: 'Null user' })
    const full = threadRow({ ...base, title: 'Null user', was: 'F3', note: { kind: 'line', since: 'abc1234' } })
    expect(full.endsWith(' · line changed since abc1234')).toBe(true)
    expect(parseThreadRow(full)).toEqual({ kind: 'thread', ...base, title: 'Null user', was: 'F3', note: { kind: 'line', since: 'abc1234' } })
    for (const [kind, text] of [['file', 'file changed'], ['deleted', 'file deleted']] as const) {
      const row = threadRow({ ...base, title: 'T', note: { kind, since: '1234567' } })
      expect(row.endsWith(` · ${text} since 1234567`)).toBe(true)
      expect(parseThreadRow(row)).toEqual({ kind: 'thread', ...base, title: 'T', note: { kind, since: '1234567' } })
    }
    const old = parseThreadRow(plain + ' · changed in this push')
    expect(old).toEqual({ kind: 'thread', ...base, title: 'Null user' })
    expect(parseRows(`${plain} · changed in this push\n${full}`).threads.map(t => t.id)).toEqual(['F9', 'F9'])
  })

  it('round-trips a row without lines and a path containing a colon', () => {
    const noLines = parseThreadRow(threadRow({ ...base, lines: undefined, title: 'T' }))!
    expect(noLines).toMatchObject({ file: 'src/a.ts', base: base.base })
    expect(noLines.lines).toBeUndefined()
    expect(parseThreadRow(threadRow({ ...base, file: 'dir/a:b.ts', lines: '7', title: 'T' }))).toMatchObject({ file: 'dir/a:b.ts', lines: '7' })
  })

  it('unicode, tab and backslash titles round-trip as their sanitized form', () => {
    for (const t of ['Zażółć gęślą jaźń ✓', 'tab\there', 'back\\slash \\n', 'multi\nline', 'bold ** marks **', '`code` title']) {
      const row = threadRow({ ...base, title: t })
      expect(parseThreadRow(row)!.title).toBe(sanitizeTitle(t))
      expect(sanitizeTitle(sanitizeTitle(t))).toBe(sanitizeTitle(t))
    }
    expect(sanitizeTitle('tab\there')).toBe('tab here')
  })

  it('caps titles at 100 characters', () => {
    expect(sanitizeTitle('x'.repeat(300))).toHaveLength(MAX_TITLE)
  })
})

describe('other rows', () => {
  it('summary-only rows round-trip with and without a body, a location and titles only', () => {
    const r = summaryOnlyRow({ severity: 'LOW', title: 'Unused', file: 'src/b.ts', lines: '12', body: 'It is\nnever called.' })
    expect(r).toBe('- **LOW – Unused** (`src/b.ts:12`) · no thread\n  It is never called.')
    expect(parseRows(r).summaryOnly).toEqual([{ kind: 'summary_only', severity: 'LOW', title: 'Unused', file: 'src/b.ts', lines: '12', body: 'It is never called.' }])
    expect(summaryOnlyRow({ severity: 'LOW', title: 'Unused', file: 'src/b.ts', body: 'b' }, true)).toBe('- **LOW – Unused** (`src/b.ts`) · no thread')
    expect(parseRows(summaryOnlyRow({ severity: 'MEDIUM', title: 'No file' })).summaryOnly).toEqual([{ kind: 'summary_only', severity: 'MEDIUM', title: 'No file' }])
  })

  it('resolved rows round-trip', () => {
    const r = resolvedRow({ id: 'F2', severity: 'MEDIUM', title: 'Loop' })
    expect(r).toBe('- F2 · resolved by a developer · MEDIUM – Loop')
    expect(parseResolvedRow(r)).toEqual({ kind: 'resolved', id: 'F2', severity: 'MEDIUM', title: 'Loop' })
  })

  it('the overflow line lists ids, or falls back to a count when too long', () => {
    expect(overflowLine(['F12', 'F13'])).toBe('Also open: F12, F13')
    expect(parseOverflow('Also open: F12, F13')).toEqual({ kind: 'overflow', ids: ['F12', 'F13'] })
    const ids = Array.from({ length: 87 }, (_, i) => `F${i + 12}`)
    const capped = overflowLine(ids, 100)
    expect(capped).toBe('Also open: 87 more threads')
    expect(parseOverflow(capped)).toEqual({ kind: 'overflow', count: 87 })
  })

  it('parseRows sorts a mixed body and ignores prose', () => {
    const body = ['## Findings', threadRow({ ...base, title: 'A' }), summaryOnlyRow({ severity: 'LOW', title: 'B' }), 'Also open: F20', resolvedRow({ id: 'F2', severity: 'LOW', title: 'C' }), 'prose'].join('\n')
    const p = parseRows(body)
    expect([p.threads.length, p.summaryOnly.length, p.resolved.length, p.overflow]).toEqual([1, 1, 1, { kind: 'overflow', ids: ['F20'] }])
  })
})

describe('history', () => {
  it('round-trips and caps to the newest lines', () => {
    const l = historyLine(3, 'a1b2c3d4e5f6', 'no change')
    expect(parseHistoryLine(l)).toEqual({ n: 3, c12: 'a1b2c3d4e5f6', text: 'no change' })
    const lines = Array.from({ length: 25 }, (_, i) => historyLine(i + 1, 'a1b2c3d4e5f6', 't'))
    expect(capHistory(lines)).toHaveLength(20)
    expect(capHistory(lines)[0]).toBe(lines[5])
    expect(capHistory(lines, 5)).toHaveLength(5)
    expect(parseHistory(['x', ...lines.slice(0, 2), 'y'].join('\n'))).toEqual(lines.slice(0, 2))
  })
})
