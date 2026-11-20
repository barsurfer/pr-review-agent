import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PRInfo } from '../../vcs/adapter.js'

const completeStructured = vi.fn()

vi.mock('../../config.js', () => ({
  config: {
    llmApiKey: 'k',
    anthropic: { model: 'claude-sonnet-5-5', maxRetries: 1, maxInputTokens: 100000, maxTokens: 32000 },
    judge: { model: '' },
    review: { maxFindings: 0, effort: '', lineNumbers: false, maxBundles: 8, promptCache: false },
    context: { maxFiles: 20, maxFileLines: 500 },
  },
}))
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn().mockResolvedValue([]) }))
// bundled.ts imports runReview from client.js, so the mock must be swappable for the real one.
vi.mock('../../review/client.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return { ...actual, runReview: vi.fn(), realRunReview: actual.runReview }
})

import * as client from '../../review/client.js'
import { runBundledReview } from '../../review/bundled.js'

const realRunReview = (client as unknown as { realRunReview: typeof client.runReview }).realRunReview
const mockRun = vi.mocked(client.runReview)

const pr: PRInfo = { id: '1', title: 'T', description: '', author: 'd', sourceBranch: 's', targetBranch: 't', sourceCommit: 'abc123abc123abc' }
const BLOCK = '## Already Reported on This PR (Review #2, commit a1b2c3d4e5f6):\n[F1] HIGH · a.ts:1 · Thing'
const usage = { input_tokens: 1, output_tokens: 1 }
const object = { summary: 's', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [] }
const cacheSchema = { type: 'object', properties: { shared: {} } }
const prompt = { content: 'SYS', source: 'repo' } as never

beforeEach(() => {
  completeStructured.mockReset()
  completeStructured.mockResolvedValue({ object, usage })
  mockRun.mockReset()
  mockRun.mockResolvedValue({ text: 'NO_CHANGE', usage, review: { ...object, no_change: true } } as never)
})

const call = (rec: boolean, cache: { schema: Record<string, unknown>; sessionId?: string } | undefined, prior?: { block: string }, previous: never[] = []) =>
  realRunReview('k', 'claude-sonnet-5-5', 1, 1000, '', pr, 'diff', [], prompt, previous, [], 'delta-text', false, rec, cache, prior)

describe('runReview argument order (14 lens recommendation, 15 cache, 16 prior)', () => {
  for (const rec of [false, true]) {
    for (const withCache of [false, true]) {
      it(`recommendation=${rec} cache=${withCache}: prior is in the message, schema and cache path unchanged`, async () => {
        await call(rec, withCache ? { schema: cacheSchema, sessionId: 's1' } : undefined, { block: BLOCK })
        const [system, message, schema, opts] = completeStructured.mock.calls[0]
        expect(system).toBe('SYS')
        const text = withCache ? (message as { text: string }[])[0].text : (message as string)
        if (withCache) expect((message as { cache: boolean }[])[0].cache).toBe(true)
        expect(text).toContain(BLOCK)
        expect(text).toContain('## Changes Since Your Last Review')
        expect(text).not.toContain('Previous Review by This Agent')
        if (withCache) {
          expect(schema).toBe(cacheSchema)
          expect(opts.sessionId).toBe('s1')
        } else {
          expect(schema).toEqual(client.reviewOutputSchema(rec))
          expect(opts.sessionId).toBeUndefined()
        }
        expect(Array.isArray(opts.tolerateMissing) && opts.tolerateMissing.includes('lens_recommendations')).toBe(rec)
      })
    }
  }

  it('without prior the message is the legacy one', async () => {
    await call(false, undefined, undefined, [{ id: '1', body: 'old review', createdOn: 'then', author: 'bot' }] as never[])
    const text = completeStructured.mock.calls[0][1] as string
    expect(text).toContain('Previous Review by This Agent')
    expect(text).not.toContain('Already Reported')
  })

  it('tags developer discussion with the finding id only when set', async () => {
    const replies = [{ author: 'dev', body: 'why', createdOn: 't1', findingId: 'F3' }, { author: 'dev2', body: 'ok', createdOn: 't2' }]
    await realRunReview('k', 'm', 1, 1000, '', pr, 'diff', [], prompt, [], replies as never, '', false, false, undefined, { block: BLOCK })
    const text = completeStructured.mock.calls[0][1] as string
    expect(text).toContain('**dev** [F3] (t1):')
    expect(text).toContain('**dev2** (t2):')
  })
})

describe('bundled call', () => {
  const section = (p: string, n: number): string => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+l${i}`).join('\n')}\n`
  const FILES = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']
  const mkCtx = (inline: unknown) => ({
    prInfo: pr, prompt, previousReviews: [], replies: [],
    filteredDiff: FILES.map(p => section(p, 100)).join(''), deltaDiff: '',
    changedFiles: FILES.map(path => ({ path, status: 'modified' })),
    adapter: {}, usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 }, inline,
  }) as never

  it('passes false, undefined, prior at positions 14 to 16 when the engine has a prior', async () => {
    const prior = { block: BLOCK }
    const priorFor = vi.fn(() => prior)
    const outcome = await runBundledReview(mkCtx({ priorFor }), 1000)
    expect(outcome.ok).toBe(true)
    expect(priorFor).toHaveBeenCalled()
    expect(mockRun.mock.calls.length).toBeGreaterThan(1)
    for (const c of mockRun.mock.calls) {
      expect(c).toHaveLength(16)
      expect(c.slice(13)).toEqual([false, undefined, prior])
    }
  })

  it('passes exactly the legacy 13 arguments with no engine, or when priorFor gives nothing', async () => {
    await runBundledReview(mkCtx(undefined), 1000)
    await runBundledReview(mkCtx({ priorFor: () => undefined }), 1000)
    expect(mockRun.mock.calls.length).toBeGreaterThan(2)
    expect(mockRun.mock.calls.every(c => c.length === 13)).toBe(true)
  })

  it('packs smaller bundles when the list is present', async () => {
    await runBundledReview(mkCtx(undefined), 1000)
    const without = mockRun.mock.calls.length
    mockRun.mockClear()
    await runBundledReview(mkCtx({ prior: { block: 'x'.repeat(1000) }, priorFor: () => undefined }), 1000)
    expect(mockRun.mock.calls.length).toBeGreaterThan(without)
  })
})
