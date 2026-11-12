import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VCSAdapter, PRInfo } from '../../vcs/adapter.js'

vi.mock('../../config.js', () => ({
  config: {
    anthropic: { apiKey: 'k', model: 'claude-haiku-4-5-20251001', maxRetries: 1, maxInputTokens: 2000, maxTokens: 32000 },
    judge: { model: 'judge-model', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3 },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3 },
    review: { maxFindings: 0, splitCheck: false, todoScan: false, effort: '', bundledReview: true, maxBundles: 8, enableNitpicks: false },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [],
    skipTargetBranches: [],
    onlyTargetBranches: [],
    diffExcludePatterns: [],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 2, minChangedLines: 0, maxChangedLines: 10 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
  modelContextWindow: () => 200_000,
}))

vi.mock('../client.js', () => ({ runReview: vi.fn(), runCommentResponse: vi.fn(), runJudge: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../usage.js', async (importOriginal) => ({ ...(await importOriginal() as any), logUsageRecord: vi.fn() }))
// Reached only by the test that routes runReview to the real client, to feed it a raw provider object.
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn() }))

import { review } from '../index.js'
import { config } from '../../config.js'
import { runReview, runJudge } from '../client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { renderReview, buildReviewFooter, type ReviewObject } from '../formatter.js'
import { renderFixBlock, SUGGESTED_FIX_MARKER } from '../suggested-fix.js'
import { applyJudgeDecisions } from '../judge-decisions.js'
import { createProvider } from '../../llm/provider.js'
import { logUsageRecord } from '../usage.js'

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
  mockRunJudge.mockImplementation(async (_k, _m, _r, _t, _e, _diff, review) => ({
    text: renderReview(review) + '\n\n### Merge Confidence: 80%\n\n*"x"*', usage, scores: [{ title: 't', severity: 'MEDIUM', score: 8 }],
  }))
})

describe('bundled review', () => {
  it('passes ENABLE_LINE_NUMBERS to every bundle reviewer and judge call', async () => {
    cfg.review.lineNumbers = true
    mockRunReview.mockImplementation(async (...args) => {
      const o = obj('Alpha problem', (args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
      return { text: renderReview(o), usage, review: o }
    })
    try {
      await review(adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']), '1', false)
      // The gutter is counted in the bundle budget, so the split may differ from the unnumbered case; every call must carry the flag.
      expect(mockRunReview.mock.calls.length).toBeGreaterThan(1)
      expect(mockRunReview.mock.calls.every(c => c[12] === true)).toBe(true)
      expect(mockRunJudge.mock.calls.length).toBe(mockRunReview.mock.calls.length)
      expect(mockRunJudge.mock.calls.every(c => c[9] === true)).toBe(true)
    } finally {
      cfg.review.lineNumbers = false
    }
  })

  it('never requests a lens recommendation from a bundle reviewer, and records null when the flag is on', async () => {
    mockRunReview.mockImplementation(async (...args) => {
      const o = obj('Alpha problem', (args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
      return { text: renderReview(o), usage, review: o }
    })
    cfg.lenses.recommend = true
    try {
      const record = await review(adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']), '1', false)
      expect(mockRunReview.mock.calls.length).toBeGreaterThan(1)
      expect(mockRunReview.mock.calls.every(c => c.length === 13)).toBe(true)
      expect(record!.lens_recommendations).toBeNull()
    } finally {
      cfg.lenses.recommend = false
    }
  })

  it('forwards the quality flag to each bundle judge only when on, leaving off-call arguments unchanged', async () => {
    mockRunReview.mockImplementation(async (...args) => {
      const o = obj('Alpha problem', (args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
      return { text: renderReview(o), usage, review: o }
    })
    const files = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']
    await review(adapter(BIG_DIFF, files), '1', false)
    expect(mockRunJudge.mock.calls.every(c => c.length === 10 && c[10] === undefined && c[11] === undefined)).toBe(true)

    vi.clearAllMocks()
    cfg.judge.quality = true
    try {
      await review(adapter(BIG_DIFF, files), '1', false)
      expect(mockRunJudge.mock.calls.length).toBeGreaterThan(1)
      expect(mockRunJudge.mock.calls.every(c => c[10] === undefined && (c[11] as { quality?: boolean }).quality === true)).toBe(true)
    } finally {
      cfg.judge.quality = false
    }
  })

  it('a per-file expansion row emitted by a quality judge survives bundled parsing and merge, with usage counted once per judge result', async () => {
    const parent = { severity: 'MEDIUM' as const, title: 'Shared bug', file: 'a/one.ts', lines: '5', body: 'Wrong in a/one.ts and also in a/two.ts.' }
    const other = { severity: 'MEDIUM' as const, title: 'Beta problem', file: 'b/one.ts', lines: '5', body: 'bad' }
    mockRunReview.mockImplementation(async (...args) => {
      const o: ReviewObject = { ...obj('x', 'x'), findings: [(args[6] as string).includes('a/one.ts') ? parent : other] }
      return { text: renderReview(o), usage, review: o }
    })
    mockRunJudge.mockImplementation(async (_k, _m, _r, _t, _e, diff, review, _ctx, policy, _ln, _s, options) => {
      const withExpansion = review.findings[0].file === 'a/one.ts'
      const judged = applyJudgeDecisions(review.findings, {
        decisions: [{
          candidate_id: 'c0', reason_category: 'validated', evidence: 'x', note: 'real', score: 8,
          ...(withExpansion ? { additional_locations: [{ file: 'a/two.ts', lines: '5', anchor_quote: 'const line4 = 4', candidate_excerpt: 'also in a/two.ts', body: 'Same defect in a/two.ts.' }] } : {}),
        }],
        summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80,
      }, policy, [], diff, Infinity, options)
      return { text: judged.markdown, usage, scores: judged.scores }
    })
    cfg.judge.quality = true
    try {
      const a = adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts'])
      const record = await review(a, '1', false)

      const posted = vi.mocked(a.postComment).mock.calls[0][1] as string
      expect(posted).toContain('a/one.ts:5')
      expect(posted).toContain('a/two.ts:5')
      expect(posted).toContain('Same defect in a/two.ts.')
      expect(posted).toContain('Beta problem')
      expect(record!.review_findings).toEqual({ high: 0, medium: 3, low: 0 })
      expect(record!.judge_tokens).toEqual({ input: 200, output: 20 })
    } finally {
      cfg.judge.quality = false
    }
  })

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

describe('bundled review: checked_commit mark', () => {
  const FILES = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']
  const HUGE = section('c/huge.ts', 700)
  const CLEAN_PRIOR = '### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.'
  const reReview = (diff: string, files: string[]) => ({
    ...adapter(diff, files),
    getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '200', body: CLEAN_PRIOR + '\n\n---\n*Reviewed by test-bot (m) | Prompt: repo | Review #1 | Commit: 111111111111*', createdOn: '2026-03-09T10:00:00Z' }]),
    getCommitDiff: vi.fn().mockResolvedValue(SMALL_DIFF),
  }) as unknown as VCSAdapter
  const quiet = (extra: Partial<ReviewObject> = {}): ReviewObject =>
    ({ summary: 'ok', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [], delta_stats: { resolved: 0, still_open: 0, new_findings: 0 }, ...extra })
  const every = (o: ReviewObject, text = renderReview(o)) => mockRunReview.mockResolvedValue({ text, usage, review: o })
  const quietRun = (fn: () => Promise<unknown>) => async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try { return await fn() } finally { log.mockRestore() }
  }

  it('BR1 NO_NEW_FINDINGS with every file reviewed → present', quietRun(async () => {
    every(quiet())
    const record = await review(reReview(BIG_DIFF, FILES), '1', false)

    expect(mockRunReview.mock.calls.length).toBeGreaterThan(1)
    expect(record!.action).toBe('NO_NEW_FINDINGS')
    expect(record!.checked_commit).toBe(pr.sourceCommit)
  }))

  it('BR2 NO_NEW_FINDINGS with an oversized file left unreviewed → absent', quietRun(async () => {
    every(quiet())
    const record = await review(reReview(BIG_DIFF + HUGE, [...FILES, 'c/huge.ts']), '1', false)

    expect(record!.action).toBe('NO_NEW_FINDINGS')
    expect('checked_commit' in record!).toBe(false)
  }))

  it('BR3 coherent no_change in every bundle → present', quietRun(async () => {
    every(quiet({ summary: '', no_change: true, delta_stats: undefined }))
    const record = await review(reReview(BIG_DIFF, FILES), '1', false)

    expect(record!.action).toBe('NO_CHANGE')
    expect(record!.checked_commit).toBe(pr.sourceCommit)
  }))

  it('BR3 a regex-only NO_CHANGE bundle, or no_change with findings, → absent', quietRun(async () => {
    const finding = { severity: 'MEDIUM' as const, title: 'x', file: 'a/one.ts', lines: '5', body: 'bad' }
    const variants: Array<[string, () => void]> = [
      ['regex-only in every bundle', () => every(quiet({ findings: [finding] }), 'NO_CHANGE')],
      ['no_change plus a finding', () => every(quiet({ no_change: true, findings: [finding] }), 'NO_CHANGE')],
      ['one coherent bundle and one regex-only', () => {
        mockRunReview.mockImplementation(async (...args) => (args[6] as string).includes('a/one.ts')
          ? { text: 'NO_CHANGE', usage, review: quiet({ summary: '', no_change: true }) }
          : { text: 'Summary\nNO_CHANGE', usage, review: quiet() })
      }],
    ]
    for (const [name, setup] of variants) {
      vi.clearAllMocks(); mockRunReview.mockReset(); setup()
      const record = await review(reReview(BIG_DIFF, FILES), '1', false)
      expect(mockRunReview.mock.calls.length, name).toBeGreaterThan(1)
      expect(record!.action, name).toBe('NO_CHANGE')
      expect('checked_commit' in record!, name).toBe(false)
    }
  }))

  it('BR3 merged path: a regex-only NO_CHANGE bundle beside a reviewed 0-finding bundle → NO_NEW_FINDINGS, absent', quietRun(async () => {
    mockRunReview.mockImplementation(async (...args) => (args[6] as string).includes('a/one.ts')
      ? { text: 'Summary\nNO_CHANGE', usage, review: quiet() }
      : { text: renderReview(quiet()), usage, review: quiet() })
    const record = await review(reReview(BIG_DIFF, FILES), '1', false)

    expect(mockRunReview.mock.calls.length).toBeGreaterThan(1)
    expect(record!.action).toBe('NO_NEW_FINDINGS')
    expect('checked_commit' in record!).toBe(false)
  }))

  it('BR4 a posted bundled review with an unreviewed file → absent; with every file reviewed → present', quietRun(async () => {
    mockRunReview.mockImplementation(async (...args) => {
      const o = obj('Alpha problem', (args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
      return { text: renderReview(o), usage, review: o }
    })
    const partial = adapter(BIG_DIFF + HUGE, [...FILES, 'c/huge.ts'])
    const uncertain = await review(partial, '1', false)
    expect(partial.postComment).toHaveBeenCalledTimes(1)
    expect(vi.mocked(partial.postComment).mock.calls[0][1]).toMatch(/was not reviewed/i)
    expect('checked_commit' in uncertain!).toBe(false)

    const full = adapter(BIG_DIFF, FILES)
    const certain = await review(full, '1', false)
    expect(full.postComment).toHaveBeenCalledTimes(1)
    expect(certain!.checked_commit).toBe(pr.sourceCommit)
  }))

  it('BR5 a later bundle whose findings come back null (real runReview) → ERROR with every bundle\'s tokens, nothing posted, absent', quietRun(async () => {
    const MISSING = 'Structured output missing required field(s): findings'
    const actual = await vi.importActual<typeof import('../client.js')>('../client.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const [name, make] of [['first review', () => adapter(BIG_DIFF, FILES)], ['re-review', () => reReview(BIG_DIFF, FILES)]] as const) {
        vi.clearAllMocks(); mockRunReview.mockReset().mockImplementation(actual.runReview)
        vi.mocked(createProvider).mockReturnValue({ complete: vi.fn(), completeStructured: vi.fn()
          .mockResolvedValueOnce({ object: quiet(), usage })
          .mockResolvedValue({ object: { ...quiet(), findings: null }, usage }) })
        const a = make()
        await expect(review(a, '1', false, undefined, 'off', true), name).rejects.toThrow(MISSING)
        const record = vi.mocked(logUsageRecord).mock.calls[0][0]
        expect(mockRunReview.mock.calls.length, name).toBe(2)
        expect(record.action, name).toBe('ERROR')
        expect(record.error, name).toEqual({ type: 'Error', message: MISSING, status: null })
        expect(record.tokens, name).toMatchObject({ input: 200, output: 20 })
        expect(a.postComment, name).not.toHaveBeenCalled()
        expect('checked_commit' in record, name).toBe(false)
      }
    } finally {
      warn.mockRestore()
    }
  }))

  it('BR6 suggested fixes on: bundle judges get no proposal options, nothing is spliced in, and every bundle reviewer sees the prior review stripped', quietRun(async () => {
    const actual = await vi.importActual<typeof import('../client.js')>('../client.js')
    const completeStructured = vi.fn().mockResolvedValue({ object: obj('Alpha problem', 'a/one.ts'), usage })
    vi.mocked(createProvider).mockReturnValue({ complete: vi.fn(), completeStructured } as never)
    mockRunReview.mockReset().mockImplementation(actual.runReview)
    const prior = '### Summary\ns\n\n### Findings\n- **MEDIUM – Old** (`a/one.ts:5`)\n  bad' + renderFixBlock('fix()', '```') + buildReviewFooter('test-bot', 'm', 'repo', 1, '111111111111', 'b')
    const a = { ...reReview(BIG_DIFF, FILES), getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '200', body: prior, createdOn: '2026-03-09T10:00:00Z' }]) } as unknown as VCSAdapter
    cfg.judge.suggestedFixes = true
    try {
      const record = await review(a, '1', false)
      const inputs = completeStructured.mock.calls.map(c => c[1] as string)
      expect(inputs.length).toBeGreaterThan(1)
      expect(inputs.every(m => m.includes('- **MEDIUM – Old** (`a/one.ts:5`)\n  bad\n\n---\n*Reviewed by') && !m.includes(SUGGESTED_FIX_MARKER))).toBe(true)
      expect(mockRunJudge.mock.calls.length).toBe(inputs.length)
      expect(mockRunJudge.mock.calls.every(c => c.length === 10)).toBe(true)
      expect(vi.mocked(a.postComment).mock.calls[0][1]).not.toContain(SUGGESTED_FIX_MARKER)
      expect(record!.suggested_fixes).toBeNull()
    } finally {
      cfg.judge.suggestedFixes = false
    }
  }))
})
