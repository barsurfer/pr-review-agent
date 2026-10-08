import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VCSAdapter, PRInfo } from '../../vcs/adapter.js'

vi.mock('../../config.js', () => ({
  config: {
    anthropic: { apiKey: 'k', model: 'claude-haiku-4-5-20251001', maxRetries: 1, maxInputTokens: 2000, maxTokens: 32000 },
    judge: { model: 'judge-model', maxRetries: 1, effort: '' },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3 },
    review: { maxFindings: 0, splitCheck: false, todoScan: false, effort: '', bundledReview: true, maxBundles: 8 },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [],
    skipTargetBranches: [],
    diffExcludePatterns: [],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 2, minChangedLines: 0, maxChangedLines: 10 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
  modelContextWindow: () => 200_000,
}))

vi.mock('../../claude/client.js', () => ({ runReview: vi.fn(), runCommentResponse: vi.fn(), runJudge: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../usage.js', async (importOriginal) => ({ ...(await importOriginal() as any), logUsageRecord: vi.fn() }))

import { review } from '../index.js'
import { config } from '../../config.js'
import { runReview, runJudge } from '../../claude/client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { renderReview, type ReviewObject } from '../formatter.js'

const mockRunReview = vi.mocked(runReview)
const mockRunJudge = vi.mocked(runJudge)
const cfg = config as any

const body = (n: number) => Array.from({ length: n }, (_, i) => `+const line${i} = ${i}`).join('\n')
const section = (path: string, lines: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n${body(lines)}\n`
const BIG_DIFF = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts'].map(p => section(p, 120)).join('')
const SMALL_DIFF = section('a/one.ts', 2)

const pr: PRInfo = { id: '1', title: 'Big', description: '', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'abc123abc123abc' }

function adapter(diff: string, files: string[]): VCSAdapter {
  return {
    getPullRequestInfo: vi.fn().mockResolvedValue(pr),
    getDiff: vi.fn().mockResolvedValue(diff),
    getChangedFiles: vi.fn().mockResolvedValue(files.map(path => ({ path, status: 'modified' }))),
    getFileContent: vi.fn(), getRepoFileContent: vi.fn(),
    postComment: vi.fn().mockResolvedValue(undefined),
    getPreviousReviewComments: vi.fn().mockResolvedValue([]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
    postReply: vi.fn(), getCommitDiff: vi.fn().mockResolvedValue(''),
  } as unknown as VCSAdapter
}

const usage = { input_tokens: 100, output_tokens: 10 }
const obj = (title: string, file: string): ReviewObject => ({
  summary: `s ${file}`, findings: [{ severity: 'MEDIUM', title, file, lines: '5', body: 'bad' }],
  behavioral_diff: [], production_risk: [], unresolved_questions: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  cfg.review.bundledReview = true
  cfg.review.maxBundles = 8
  cfg.judge.model = 'judge-model'
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
  mockRunJudge.mockImplementation(async (_k, _m, _r, _t, _e, _diff, text) => ({
    text: text + '\n\n### Merge Confidence: 80%\n\n*"x"*', usage, scores: [{ title: 't', severity: 'MEDIUM', score: 8 }],
  }))
})

describe('bundled review', () => {
  it('over budget + enabled: one reviewer+judge per bundle, one combined review', async () => {
    mockRunReview.mockImplementation(async (...args) => {
      const diff = args[6] as string
      const o = obj(diff.includes('a/one.ts') ? 'Alpha problem' : 'Beta problem', diff.includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
      return { text: renderReview(o), usage, review: o }
    })
    const a = adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts'])
    const record = await review(a, '1', false)

    expect(mockRunReview).toHaveBeenCalledTimes(2)
    expect(mockRunJudge).toHaveBeenCalledTimes(2)
    // each bundle's reviewer and judge see only that bundle's files
    const diffs = mockRunReview.mock.calls.map(c => c[6] as string)
    expect(diffs[0]).toContain('a/two.ts'); expect(diffs[0]).not.toContain('diff --git a/b/')
    expect(diffs[1]).toContain('b/two.ts'); expect(diffs[1]).not.toContain('diff --git a/a/')
    expect((mockRunJudge.mock.calls[0][5] as string)).not.toContain('diff --git a/b/')

    expect(a.postComment).toHaveBeenCalledTimes(1)
    const posted = vi.mocked(a.postComment).mock.calls[0][1] as string
    expect(posted).toContain('Alpha problem')
    expect(posted).toContain('Beta problem')
    expect(posted).toContain('### Merge Confidence: 80%')
    expect(record!.action).toBe('REVIEW')
    expect(record!.judge_tokens).toEqual({ input: 200, output: 20 })
    expect(record!.review_findings).toEqual({ high: 0, medium: 2, low: 0 })
  })

  it('dedupes the same finding reported by two bundles', async () => {
    mockRunReview.mockImplementation(async () => {
      const o = obj('Shared issue', 'a/one.ts')
      return { text: renderReview(o), usage, review: o }
    })
    const a = adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts'])
    await review(a, '1', false)
    const posted = vi.mocked(a.postComment).mock.calls[0][1] as string
    expect(posted.match(/Shared issue/g)).toHaveLength(1)
  })

  it('skips when the plan needs more than MAX_BUNDLES', async () => {
    cfg.review.maxBundles = 1
    const record = await review(adapter(BIG_DIFF, ['a/one.ts']), '1', false)
    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toContain('MAX_BUNDLES')
    expect(mockRunReview).not.toHaveBeenCalled()
  })

  it('flag off: over-budget PR still skips (no regression)', async () => {
    cfg.review.bundledReview = false
    cfg.thresholds.maxChangedFiles = 200
    cfg.thresholds.maxChangedLines = 3000
    const record = await review(adapter(BIG_DIFF, ['a/one.ts']), '1', false)
    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toContain('exceeds the input budget')
    expect(mockRunReview).not.toHaveBeenCalled()
  })

  it('small PR with the flag on takes the single-pass path', async () => {
    cfg.thresholds.maxChangedFiles = 200
    cfg.thresholds.maxChangedLines = 3000
    const o = obj('Only issue', 'a/one.ts')
    mockRunReview.mockResolvedValue({ text: renderReview(o), usage, review: o })
    const a = adapter(SMALL_DIFF, ['a/one.ts'])
    const record = await review(a, '1', false)
    expect(mockRunReview).toHaveBeenCalledTimes(1)
    expect(mockRunJudge).toHaveBeenCalledTimes(1)
    expect(vi.mocked(a.postComment).mock.calls[0][1]).not.toContain('bundle(s)')
    expect(record!.action).toBe('REVIEW')
  })

  it('a bundle judge failure rethrows in normal mode (CI retries)', async () => {
    const o = obj('X', 'a/one.ts')
    mockRunReview.mockResolvedValue({ text: renderReview(o), usage, review: o })
    mockRunJudge.mockRejectedValue(new Error('judge boom'))
    await expect(review(adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']), '1', false))
      .rejects.toThrow(/judge boom/)
  })

  it('a bundle judge failure falls back to unjudged findings with an outcome sink', async () => {
    const o = obj('X', 'a/one.ts')
    mockRunReview.mockResolvedValue({ text: renderReview(o), usage, review: o })
    mockRunJudge.mockRejectedValue(new Error('judge boom'))
    const sink = vi.fn().mockResolvedValue(undefined)
    await review(adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']), '1', false, undefined, 'off', false, '', sink)
    expect(sink).toHaveBeenCalledTimes(1)
    const arg = sink.mock.calls[0][0] as { judged: boolean; review: ReviewObject }
    expect(arg.judged).toBe(false)
    expect(arg.review.findings.length).toBeGreaterThan(0)
  })

  it('all bundles NO_CHANGE is treated as NO_CHANGE, not an overflow skip', async () => {
    mockRunReview.mockResolvedValue({
      text: 'NO_CHANGE', usage,
      review: { summary: '', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [], no_change: true },
    })
    // First review + NO_CHANGE hits the shared CHECK_NO_CHANGE guard (throws), which proves it took
    // the NO_CHANGE path — not the all-overflow skip (which would SKIP with "left unreviewed").
    await expect(review(adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']), '1', false))
      .rejects.toThrow(/NO_CHANGE on a first review/)
  })

  it('skips (not NO_CHANGE) when every bundle overflows the model context', async () => {
    mockRunReview.mockImplementation(async () => {
      const e = new Error('prompt is too long') as Error & { status: number }
      e.status = 400
      throw e
    })
    const record = await review(adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']), '1', false)
    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toMatch(/left unreviewed/i)
  })

  it('a bundle that overflows the model context is left unreviewed, not failed', async () => {
    mockRunReview.mockImplementation(async (...args) => {
      const diff = args[6] as string
      if (diff.includes('a/two.ts')) { const e = new Error('prompt is too long') as Error & { status: number }; e.status = 400; throw e }
      const o = obj('Beta problem', 'b/one.ts')
      return { text: renderReview(o), usage, review: o }
    })
    const a = adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts'])
    const record = await review(a, '1', false)
    const posted = vi.mocked(a.postComment).mock.calls[0][1] as string
    expect(posted).toContain('Beta problem')
    expect(posted).toMatch(/was not reviewed/i)
    expect(record!.action).toBe('REVIEW')
  })
})
