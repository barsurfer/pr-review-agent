import { describe, it, expect, vi } from 'vitest'
import { fetchContext } from '../fetcher.js'
import type { VCSAdapter, ChangedFile } from '../../vcs/adapter.js'

function makeAdapter(contents: Record<string, string>): VCSAdapter {
  return { getFileContent: vi.fn(async (p: string) => contents[p] ?? '') } as unknown as VCSAdapter
}
const changed = (...paths: string[]): ChangedFile[] => paths.map(p => ({ path: p, status: 'modified' as const }))

describe('fetchContext (concurrency-bounded)', () => {
  it('fetches all changed files up to maxFiles', async () => {
    const adapter = makeAdapter({ 'a.ts': '1', 'b.ts': '2', 'c.ts': '3' })
    const res = await fetchContext(adapter, changed('a.ts', 'b.ts', 'c.ts'), 'sha', 'diff', 20, 500)
    expect(res.map(r => r.path).sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(adapter.getFileContent).toHaveBeenCalledTimes(3)
  })

  it('respects the maxFiles cap', async () => {
    const adapter = makeAdapter({ 'a.ts': '1', 'b.ts': '2', 'c.ts': '3', 'd.ts': '4' })
    const res = await fetchContext(adapter, changed('a.ts', 'b.ts', 'c.ts', 'd.ts'), 'sha', 'diff', 2, 500)
    expect(res.length).toBe(2)
  })

  it('skips large low-churn files (over maxFileLines, not in diff)', async () => {
    const adapter = makeAdapter({ 'big.ts': Array(600).fill('line').join('\n') })
    const res = await fetchContext(adapter, changed('big.ts'), 'sha', 'unrelated diff', 20, 500)
    expect(res.length).toBe(0)
  })

  it('never fetches deleted or excluded files', async () => {
    const adapter = makeAdapter({})
    const files: ChangedFile[] = [{ path: 'gone.ts', status: 'deleted' }, { path: 'pkg.lock', status: 'modified' }]
    const res = await fetchContext(adapter, files, 'sha', 'diff', 20, 500)
    expect(res.length).toBe(0)
    expect(adapter.getFileContent).not.toHaveBeenCalled()
  })

  it('continues past a failed fetch', async () => {
    const adapter = {
      getFileContent: vi.fn(async (p: string) => {
        if (p === 'bad.ts') throw new Error('404')
        return 'ok'
      }),
    } as unknown as VCSAdapter
    const res = await fetchContext(adapter, changed('bad.ts', 'good.ts'), 'sha', 'diff', 20, 500)
    expect(res.map(r => r.path)).toEqual(['good.ts'])
  })
})
