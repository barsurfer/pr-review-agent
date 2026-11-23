import { describe, it, expect } from 'vitest'
import { buildPrior, MAX_LIST_ROWS, type PriorItems } from '../reviewer-list.js'
import type { ThreadEntry, Listed } from '../types.js'

const e = (k: number, o: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id: `F${k}`, k, severity: 'HIGH', title: `Title ${k}`, gist: '', file: 'src/api/user.ts', lines: '42-47', openedAt: 'a1b2c3d4e5f6', rootId: String(k), url: 'u', resolved: false, humanComments: 0, ...o,
})
const l = (o: Partial<Listed> = {}): Listed => ({ severity: 'LOW', title: 'Unused helper', gist: 'formatDate is no longer called.', file: 'src/util/fmt.ts', lines: '12', ...o })
const items = (o: Partial<PriorItems> = {}): PriorItems => ({ n: 3, commit: 'a1b2c3d4e5f6', entries: [], summaryOnly: [], ...o })
const rows = (b: string): string[] => b.split('\n').filter(x => x.startsWith('[F') || x.startsWith('- '))

describe('buildPrior', () => {
  it('renders the golden list', () => {
    const p = buildPrior(items({
      entries: [e(3, { title: 'Null user crashes profile load' }), e(2, { severity: 'MEDIUM', title: 'Unbounded render loop', file: 'src/ui/list.tsx', lines: '10', resolved: true })],
      summaryOnly: [l()],
    }))
    expect(p!.block).toBe([
      '## Already Reported on This PR (Review #3, commit a1b2c3d4e5f6):',
      'These findings already have threads; do not report them again, even if still present:',
      '[F3] HIGH · src/api/user.ts:42-47 · Null user crashes profile load',
      'Noted earlier without a thread; report each again in findings if it is still present:',
      '- LOW · src/util/fmt.ts:12 · Unused helper: formatDate is no longer called.',
      'Resolved by a developer; report one again only if it is now more severe than listed:',
      '[F2] MEDIUM · src/ui/list.tsx:10 · Unbounded render loop',
    ].join('\n'))
  })

  it('is undefined with nothing to list and omits empty sections', () => {
    expect(buildPrior(items())).toBeUndefined()
    expect(buildPrior(items({ entries: [e(1)] }))!.block).not.toContain('Noted earlier')
  })

  it('caps at 40 rows, dropping resolved first, then summary-only, keeping severe and newest open rows', () => {
    const open = Array.from({ length: 30 }, (_, i) => e(i + 1))
    const resolved = Array.from({ length: 10 }, (_, i) => e(100 + i, { resolved: true }))
    const noted = Array.from({ length: 10 }, (_, i) => l({ title: `n${i}` }))
    const a = buildPrior(items({ entries: [...open, ...resolved], summaryOnly: noted }))!.block
    expect(rows(a)).toHaveLength(MAX_LIST_ROWS)
    expect(a).toContain('n9')
    expect(a).not.toContain('[F100]')

    const many = Array.from({ length: 45 }, (_, i) => e(i + 1, { severity: i === 0 ? 'HIGH' : 'LOW' }))
    const b = buildPrior(items({ entries: many, summaryOnly: noted }))!.block
    expect(rows(b)).toHaveLength(MAX_LIST_ROWS)
    expect(b).not.toContain('n0')
    expect(b).toContain('[F1] ')
    expect(b).toContain('[F45] ')
    expect(b).not.toContain('[F2] ')
  })

  it("filters rows to a bundle's files and returns undefined when none match", () => {
    const it2 = items({ entries: [e(1), e(2, { file: 'src/other.ts' })], summaryOnly: [l(), l({ file: undefined, title: 'floating' })] })
    const p = buildPrior(it2, ['src/other.ts'])!.block
    expect(p).toContain('[F2]')
    expect(p).not.toContain('[F1]')
    expect(p).not.toContain('Unused helper')
    expect(p).not.toContain('floating')
    expect(buildPrior(it2, ['nothing.ts'])).toBeUndefined()
  })

  it('omits the location for a summary-only item without a file', () => {
    expect(buildPrior(items({ summaryOnly: [l({ file: undefined, lines: undefined, gist: '' })] }))!.block).toContain('\n- LOW · Unused helper')
  })
})
