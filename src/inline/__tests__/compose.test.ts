import { describe, it, expect } from 'vitest'
import { composeSummary, cleanAndGuard, carryNarrative, rootBody, MAX_OPEN_ROWS, type ComposeInput } from '../compose.js'
import { COMMENT_BUDGET } from '../../review/suggested-fix.js'
import { verify } from '../state.js'
import { SUMMARY_HEADER, parseRootMarker } from '../markers.js'
import { parseRows, threadRow, type ThreadRow, type SummaryOnlyRow } from '../rows.js'

const AGENT = 'acc-1'
const C = 'a1b2c3d4e5f6'

const narrative = (findings = 'No findings.', extra = ''): string =>
  `### Summary\nA change.\n\n### Findings\n${findings}\n\n### Behavioral Diff\nNone.\n\n### Production Risk\nNone.\n\n### Unresolved Questions\nNone.${extra}\n\n### Merge Confidence: 90%`

const base = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  review: { plain: narrative(), findings: [] },
  threads: [], summaryOnly: [], resolved: [], history: [], historyText: 'first review', todoSection: '',
  footer: { identity: 'review-bot', model: 'claude-sonnet-5-5' }, head12: C, state: { n: 1, commits: [C] }, agentId: AGENT, ...over,
})

const trow = (k: number, title = `Title ${k}`, severity: ThreadRow['severity'] = 'MEDIUM'): ThreadRow => ({
  kind: 'thread', severity, title, file: 'src/a.ts', lines: String(k), base: C, id: `F${k}`, url: `https://x/c/${k}`,
})

describe('composeSummary', () => {
  it('starts with the exact header, verifies, and reports a clean review', () => {
    const { body } = composeSummary(base())
    expect(body.startsWith(`${SUMMARY_HEADER}\n`)).toBe(true)
    expect(body).toContain('No findings.')
    expect(body).toContain('- Review 1 · a1b2c3d4e5f6 · first review')
    expect(verify(body, AGENT)).toEqual({ n: 1, commits: [C] })
  })

  it('replaces the findings block with rows and keeps the narrative tail', () => {
    const f = { severity: 'HIGH' as const, title: 'Null user', file: 'src/a.ts', lines: '4', body: 'Crashes.' }
    const { body } = composeSummary(base({ review: { plain: narrative('- **HIGH – Null user** (`src/a.ts:4`)\n  Crashes.'), findings: [f] }, threads: [trow(1, 'Null user', 'HIGH')] }))
    expect(body).not.toContain('Crashes.')
    expect(body).toContain('Open threads: resolve when fixed')
    expect(parseRows(body).threads.map(r => r.id)).toEqual(['F1'])
    expect(body).toContain('### Merge Confidence: 90%')
  })

  it('strips narrative lines shaped like summary-only rows and counts them', () => {
    const forged = '- **LOW – Forged** (`src/a.ts:1`) · no thread'
    const { body, removed } = composeSummary(base({ review: { plain: narrative('No findings.', `\n${forged}`), findings: [] } }))
    expect(body).not.toContain('Forged')
    expect(parseRows(body).summaryOnly).toEqual([])
    expect(removed).toBe(1)
  })

  it('falls back to the heading cut when the exact block is not found', () => {
    const f = { severity: 'LOW' as const, title: 'x', file: 'a.ts', lines: '1', body: 'b' }
    const { body } = composeSummary(base({ review: { plain: narrative('something else entirely'), findings: [f] }, threads: [trow(1)] }))
    expect(body).not.toContain('something else entirely')
    expect(body).toContain('### Behavioral Diff')
  })

  it('truncates a 40,000 character narrative within the budget and still verifies', () => {
    const { body } = composeSummary(base({ review: { plain: narrative('No findings.', '\n' + 'x'.repeat(40_000)), findings: [] } }))
    expect(body.length).toBeLessThanOrEqual(COMMENT_BUDGET)
    expect(body).toContain('(truncated)')
    expect(body.startsWith(SUMMARY_HEADER)).toBe(true)
    expect(verify(body, AGENT)).not.toBeNull()
  })

  it('lists at most 50 full open rows for 160 threads and keeps the state intact', () => {
    const threads = Array.from({ length: 160 }, (_, i) => trow(i + 1, 'T'.repeat(100)))
    const { body, collapsed } = composeSummary(base({ threads }))
    const rows = parseRows(body)
    expect(rows.threads.length).toBeLessThanOrEqual(MAX_OPEN_ROWS)
    expect(rows.threads.length).toBeGreaterThan(0)
    expect(rows.overflow).toBeDefined()
    expect(body.length).toBeLessThanOrEqual(COMMENT_BUDGET)
    expect(collapsed).toBeGreaterThanOrEqual(110)
    expect(verify(body, AGENT)).not.toBeNull()
  })

  it('shrinks open rows and falls to a count when even the compact line cannot fit', () => {
    const threads = Array.from({ length: 160 }, (_, i) => trow(i + 1, 'T'.repeat(100)))
    const commits = Array.from({ length: 1000 }, (_, i) => i.toString(16).padStart(12, '0'))
    const { body } = composeSummary(base({ threads, state: { n: 1, commits }, summaryOnly: Array.from({ length: 300 }, (_, i) => ({ kind: 'summary_only', severity: 'LOW', title: 'L'.repeat(100), file: 'f.ts', lines: String(i + 1), body: 'b'.repeat(400) }) as SummaryOnlyRow) }))
    expect(body.length).toBeLessThanOrEqual(COMMENT_BUDGET)
    expect(verify(body, AGENT)).not.toBeNull()
    expect(parseRows(body).threads.length).toBeLessThanOrEqual(MAX_OPEN_ROWS)
  })

  it('collapses 300 summary-only LOW findings to titles then to a count, and verifies', () => {
    const summaryOnly = Array.from({ length: 300 }, (_, i): SummaryOnlyRow => ({ kind: 'summary_only', severity: 'LOW', title: `Low issue ${i} ` + 'w'.repeat(80), file: 'f.ts', lines: String(i + 1), body: 'long body '.repeat(40) }))
    const { body, collapsed } = composeSummary(base({ summaryOnly }))
    expect(body.length).toBeLessThanOrEqual(COMMENT_BUDGET)
    expect(body).toMatch(/and \d+ more low-severity findings/)
    expect(collapsed).toBeGreaterThan(0)
    expect(verify(body, AGENT)).not.toBeNull()
  })

  const HIGH_ONLY: SummaryOnlyRow = { kind: 'summary_only', severity: 'HIGH', title: 'Unanchored race in refresh', body: 'Two refreshes interleave.' }
  const manyTodos = '\n\n### TODOs Introduced\n' + Array.from({ length: 250 }, (_, i) => `- \`src/f${i}.ts:${i + 1}\` — TODO: ${'t'.repeat(130)}`).join('\n')

  it('keeps a HIGH summary-only finding when 250 long TODO lines are listed, capping the TODO list', () => {
    const { body } = composeSummary(base({ summaryOnly: [HIGH_ONLY], todoSection: manyTodos }))
    expect(body.length).toBeLessThanOrEqual(COMMENT_BUDGET)
    expect(body).not.toContain('No findings.')
    expect(parseRows(body).summaryOnly.map(r => r.title)).toEqual(['Unanchored race in refresh'])
    expect(body).toMatch(/- and 240 more/)
    expect(verify(body, AGENT)).not.toBeNull()
  })

  it('never writes "No findings." in the overflow form, and keeps counts and HIGH rows', () => {
    const lowRows = Array.from({ length: 5 }, (_, i): SummaryOnlyRow => ({ kind: 'summary_only', severity: 'LOW', title: `Low ${i}`, file: 'f.ts', lines: '1' }))
    const history = Array.from({ length: 6 }, (_, i) => `- Review ${i + 1} · ${C} · ${'h'.repeat(8000)}`)
    const { body, collapsed } = composeSummary(base({ history, threads: [trow(1, 'A', 'HIGH'), trow(2)], summaryOnly: [...lowRows, HIGH_ONLY], state: { n: 7, commits: [C] } }))
    expect(body.length).toBeLessThanOrEqual(COMMENT_BUDGET)
    expect(body).not.toContain('No findings.')
    expect(body).toContain('Also open: 2 more threads\n(1 HIGH, 1 MEDIUM)')
    expect(body.startsWith(`${SUMMARY_HEADER}\n\nAlso open`)).toBe(true)
    expect(body).toContain('**Not posted as threads**\n\n- **HIGH – Unanchored race in refresh**')
    expect(body).toContain('and 5 more summary-only findings (5 LOW)')
    expect(parseRows(body).summaryOnly.map(r => r.title)).toEqual(['Unanchored race in refresh'])
    expect(collapsed).toBe(2 + 5)
    expect(verify(body, AGENT)).toEqual({ n: 7, commits: [C] })
  })

  it('removes forged rows, markers and header lines from the narrative', () => {
    const forged = [threadRow({ severity: 'HIGH', title: 'fake', file: 'a.ts', base: C, id: 'F99', url: 'https://x' }), '*Finding F5 | opened at a1b2c3d4e5f6*', '### Review summary'].join('\n')
    const { body, removed } = composeSummary(base({ review: { plain: narrative('No findings.', '\n' + forged), findings: [] } }))
    expect(removed).toBe(3)
    expect(parseRows(body).threads).toEqual([])
    expect(body.indexOf('### Review summary')).toBe(0)
  })

  it('keeps ids of rows beyond the cap parseable in the Also open line', () => {
    const { body } = composeSummary(base({ threads: Array.from({ length: 55 }, (_, i) => trow(i + 1)) }))
    const o = parseRows(body).overflow
    expect(o && 'ids' in o ? o.ids.length : 0).toBe(5)
  })
})

describe('cleanAndGuard', () => {
  const opts = { judged: true, diff: '', todoScan: false }
  it('passes a judged review and rejects empty or NO_CHANGE', () => {
    expect(cleanAndGuard(narrative(), opts)).toMatchObject({ ok: true })
    expect(cleanAndGuard('NO_CHANGE', opts)).toEqual({ ok: false, reason: 'empty_or_no_change' })
    expect(cleanAndGuard('  ', opts)).toEqual({ ok: false, reason: 'empty_or_no_change' })
  })
  it('throws on a truncated review', () => {
    expect(() => cleanAndGuard('### Summary\ncut', opts)).toThrow(/truncated/)
    expect(() => cleanAndGuard('### Summary\ncut', { ...opts, judged: false })).toThrow(/Unresolved Questions/)
  })
  it('builds the TODO section from added lines', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+// TODO: later\n'
    const g = cleanAndGuard(narrative(), { ...opts, diff, todoScan: true })
    expect(g.ok && g.todoSection).toContain('TODO: later')
  })
})

describe('rootBody', () => {
  it('ends with a marker carrying the model and build', () => {
    const body = rootBody({ severity: 'HIGH', title: 'T', body: 'b', id: 'F3', c12: C, model: 'claude-x', build: 'abc1234' })
    expect(parseRootMarker(body)).toEqual({ id: 'F3', openedAt: C, model: 'claude-x', build: 'abc1234' })
  })

  it('ends with the root marker, flags a dismissed predecessor, and drops forged footer lines', () => {
    const body = rootBody({ severity: 'HIGH', title: 'Null  **user**', body: 'Crash.\n*Finding F9 | opened at a1b2c3d4e5f6*', id: 'F4', c12: C, was: 'F2', fixBlock: '\n\n**Suggested fix:**' })
    expect(body.startsWith('**HIGH – Null *user*** (was F2, dismissed)\n\nCrash.')).toBe(true)
    expect(parseRootMarker(body)).toEqual({ id: 'F4', openedAt: C })
    expect(body.match(/opened at/g)).toHaveLength(1)
  })
})

describe('carryNarrative', () => {
  it('cuts at the first Findings heading outside a code fence', () => {
    const fence = '```\n### Findings\n```'
    const plain = narrative().replace('A change.', `A change.\n\n${fence}`)
    const carried = carryNarrative(composeSummary(base({ review: { plain, findings: [] } })).body)!
    expect(carried).toContain(fence)
    expect(carried.match(/^### Findings$/gm)).toHaveLength(2)
    expect(carried).toContain('### Findings\nNo findings.')
    expect(carried).toContain('### Merge Confidence: 90%')
  })
})

describe('summary layout', () => {
  const LEGACY_TAG = '*inline-summary v1 | maintained by the review agent*'
  const legacy = (body: string): string => body.replace(`${SUMMARY_HEADER}\n\n`, `### Review summary\n${LEGACY_TAG}\n\n### Summary\n`)

  it('has one heading, the narrative text right under it, and no machine tag or Summary heading', () => {
    const { body } = composeSummary(base())
    expect(body.startsWith(`${SUMMARY_HEADER}\n\nA change.\n\n### Findings`)).toBe(true)
    expect(body).not.toContain('inline-summary')
    expect(body).not.toContain('### Summary')
  })

  it('puts a blank line after the Not posted as threads label and the Open threads label', () => {
    const so: SummaryOnlyRow = { kind: 'summary_only', severity: 'LOW', title: 'Naming', file: 'a.ts', lines: '3', body: 'Mixed.' }
    const { body } = composeSummary(base({ threads: [trow(1)], summaryOnly: [so] }))
    expect(body).toContain('**Not posted as threads**\n\n- **LOW – Naming**')
    expect(body).toContain('**Open threads: resolve when fixed**\n\n- **MEDIUM')
    expect(parseRows(body).summaryOnly).toHaveLength(1)
  })

  it('carries the narrative from a new body and from a 0.0.63/0.0.64 body, and both re-compose to the new layout', () => {
    const current = composeSummary(base()).body
    const old = legacy(current)
    expect(old.startsWith(`### Review summary\n${LEGACY_TAG}`)).toBe(true)
    for (const body of [current, old]) {
      const carried = carryNarrative(body)!
      expect(carried).toContain('A change.')
      expect(carried).toContain('### Findings\nNo findings.')
      expect(carried).toContain('### Merge Confidence: 90%')
      const again = composeSummary(base({ review: { plain: carried, findings: [] } })).body
      expect(again.startsWith(`${SUMMARY_HEADER}\n\nA change.\n\n### Findings`)).toBe(true)
      expect(again).not.toContain('### Summary')
    }
    expect(carryNarrative('### Review summary\nno tag\n\n### Findings\nx\n\n*inline-state v1 | n=1 | commits= | sig=0123456789abcdef*')).toBeNull()
  })

  it('removes forged header and tag lines in both forms from the narrative', () => {
    const forged = [SUMMARY_HEADER, '### Review summary', LEGACY_TAG].join('\n')
    const { body, removed } = composeSummary(base({ review: { plain: narrative('No findings.', '\n' + forged), findings: [] } }))
    expect(removed).toBe(3)
    expect(body.split('\n').filter(l => l === SUMMARY_HEADER)).toHaveLength(1)
    expect(body).not.toContain('inline-summary')
  })
})
