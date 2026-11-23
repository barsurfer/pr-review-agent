import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VCSAdapter, PRInfo, ReviewComment, CommentReply } from '../../vcs/adapter.js'

vi.mock('../../config.js', () => ({
  config: {
    llmApiKey: 'test-key',
    tokenMetrics: true,
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-5-5', maxRetries: 1, maxInputTokens: 150000, maxTokens: 32000, modelContextTokens: 0 },
    judge: { model: '', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false, quality: false, shownAnchors: false, proposals: false },
    breadth: { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3, benchmarkDeadlineSeconds: 840, priorityTargets: false },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3, model: '', skipDirectedElsewhere: false },
    review: { maxFindings: 0, splitCheck: false, todoScan: false, effort: '', enableNitpicks: false, secondLook: false, secondLookBreadthTargets: false, bundledReview: false, maxBundles: 8, lineNumbers: false },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [],
    skipTargetBranches: [],
    onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: [],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
  modelContextWindow: () => 200_000,
}))

vi.mock('../client.js', () => ({ runReview: vi.fn(), runCommentResponse: vi.fn(), runJudge: vi.fn(), runBreadth: vi.fn(), runLens: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../usage.js', async (importOriginal) => ({ ...(await importOriginal() as any), getBuildCommit: () => 'testbuild', logUsageRecord: vi.fn() }))

import { review } from '../index.js'
import { config } from '../../config.js'
import { runReview, runCommentResponse, runJudge, runBreadth } from '../client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { renderReview, type ReviewObject } from '../formatter.js'
import { logUsageRecord, remainderProbe } from '../usage.js'
import { DeadlineAbortError, TruncatedResponseError } from '../../llm/shared.js'

const cfg = config as any

const body = (n: number) => Array.from({ length: n }, (_, i) => `+const line${i} = ${i}`).join('\n')
const section = (path: string, lines: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n${body(lines)}\n`
const DIFF = section('src/app.ts', 5)
const BIG_DIFF = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts'].map(p => section(p, 120)).join('')
const pr: PRInfo = { id: '100', title: 'Test PR', description: 'd', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'abc123abc123abc' }
const usage = { input_tokens: 1000, output_tokens: 200 }
const MERGE_TAIL = '\n\n### Merge Confidence: 80%'
const obj = (file = 'src/app.ts'): ReviewObject => ({ summary: 's', findings: [{ severity: 'MEDIUM', title: 'Issue', file, lines: '3', body: 'bad' }], behavioral_diff: [], production_risk: [], unresolved_questions: [] })

const PRIOR = '### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.'
const footer = (commit: string) => `

---
*Reviewed by test-bot (claude-haiku-5-5) | Prompt: repo | Review #1 | Commit: ${commit}*`
const priorComment = (commit = 'aabbcc112233'): ReviewComment => ({ id: '200', body: PRIOR + footer(commit), createdOn: '2026-03-09T10:00:00Z' })
const devReply = (): CommentReply => ({ id: 'd1', parentId: '200', author: 'Fernando', body: 'Fixed in d4f2b43e.', createdOn: '2026-03-09T12:00:00Z' })

function adapter(diff: string, files: string[], over: Record<string, unknown> = {}): VCSAdapter {
  return {
    getPullRequestInfo: async () => pr,
    getDiff: async () => diff,
    getChangedFiles: async () => files.map(path => ({ path, status: 'modified' })),
    getFileContent: async () => '', getRepoFileContent: async () => null,
    postComment: async () => undefined,
    getPreviousReviewComments: async () => [],
    getRepliesToReviewComments: async () => ({ replies: [], agentReplyCount: 0 }),
    postReply: async () => undefined, getCommitDiff: async () => '',
    ...over,
  } as unknown as VCSAdapter
}
const reReview = (): VCSAdapter => adapter(DIFF, ['src/app.ts'], {
  getPreviousReviewComments: async () => [priorComment()],
  getRepliesToReviewComments: async () => ({ replies: [devReply()], agentReplyCount: 0 }),
  getCommitDiff: async () => DIFF,
})

type Rec = Record<string, any>
interface Run { record: Rec | null; thrown: unknown; lines: string[]; warns: string[]; logged: Rec | null }

async function run(on: boolean, a: VCSAdapter, setup: () => void = () => {}): Promise<Run> {
  vi.clearAllMocks()
  cfg.tokenMetrics = on
  cfg.reply.model = ''
  cfg.review.bundledReview = false
  cfg.anthropic.maxInputTokens = 150000
  cfg.judge.model = ''
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
  vi.mocked(runReview).mockImplementation(async () => ({ text: renderReview(obj()), usage, review: obj() }))
  vi.mocked(runCommentResponse).mockResolvedValue({ text: 'Thanks.', usage: { input_tokens: 500, output_tokens: 100 } })
  setup()
  const lines: string[] = []
  const warns: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...x: unknown[]) => { lines.push(x.map(String).join(' ')) })
  vi.spyOn(console, 'warn').mockImplementation((...x: unknown[]) => { warns.push(x.map(String).join(' ')) })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let record: Rec | null = null
  let thrown: unknown = null
  remainderProbe.fallbacks = 0
  try { record = await review(a, '100', false, undefined, 'off', true, 'repo') as unknown as Rec } catch (e) { thrown = e }
  const logged = (vi.mocked(logUsageRecord).mock.calls.at(-1)?.[0] ?? null) as Rec | null
  vi.restoreAllMocks()
  expect(remainderProbe.fallbacks, 'every remainder token must be listed, or the old whole-bucket price was used').toBe(0)
  return { record, thrown, lines, warns, logged }
}

const stable = (r: Rec | null) => { const { timestamp, duration_ms, token_metrics, ...rest } = r ?? {}; return rest }
const metricsLines = (r: Run) => r.lines.filter(l => l.startsWith('Token metrics:') || l.startsWith('  Long-context tier:'))
const withoutMetricsLines = (r: Run) => r.lines.filter(l => !l.startsWith('Token metrics:') && !l.startsWith('  Long-context tier:') && !l.startsWith('\n=== Usage ==='))

beforeEach(() => { vi.restoreAllMocks() })

describe('token metrics through review()', () => {
  it('records the estimate breakdown and a reviewer row for a single pass, and prints the summary after the usage dump', async () => {
    const on = await run(true, adapter(DIFF, ['src/app.ts']))
    const m = on.record!.token_metrics
    expect(m.estimate.total).toBe(on.record!.tokens.estimated_input)
    expect(m.estimate).toMatchObject({ file_count: 0, prev_review_count: 0, reply_count: 0 })
    expect(m.estimate_initial).toBeUndefined()
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0]).toMatchObject({ stage: 'review', end: 'ok', estimated_input_tokens: m.estimate.total, prompt_tokens: 1000, output_tokens: 200 })
    expect(m.calls[0].contexts_dropped).toBeUndefined()
    expect(m.reviewer).toEqual({ estimated_input_tokens: m.estimate.total, prompt_tokens: 1000, ratio: Math.round(1000 / m.estimate.total * 1000) / 1000, calls: 1 })
    const summary = on.lines.filter(l => l.startsWith('Token metrics:'))
    expect(summary).toHaveLength(1)
    expect(summary[0]).toContain(`Token metrics: repo#100 | reviewer input 1,000 vs estimate ~${m.estimate.total.toLocaleString()}`)
    expect(on.lines.findIndex(l => l.startsWith('\n=== Usage ==='))).toBe(on.lines.indexOf(summary[0]) - 1)
  })

  it('leaves the record and console untouched with the setting off', async () => {
    const off = await run(false, adapter(DIFF, ['src/app.ts']))
    const on = await run(true, adapter(DIFF, ['src/app.ts']))
    expect(off.record).not.toHaveProperty('token_metrics')
    expect(metricsLines(off)).toEqual([])
    expect(stable(on.record)).toEqual(stable(off.record))
    expect(withoutMetricsLines(on)).toEqual(withoutMetricsLines(off))
  })

  it('stores the first estimate when a re-estimate follows a budget drop and marks the reviewer row', async () => {
    const setup = () => {
      cfg.anthropic.maxInputTokens = 600
      vi.mocked(fetchContext).mockResolvedValue([{ path: 'src/app.ts', content: 'x'.repeat(8000) }])
    }
    const on = await run(true, adapter(DIFF, ['src/app.ts']), setup)
    const m = on.record!.token_metrics
    expect(m.estimate_initial.files).toBeGreaterThan(1000)
    expect(m.estimate_initial.file_count).toBe(1)
    expect(m.estimate).toMatchObject({ files: 0, file_count: 0, total: on.record!.tokens.estimated_input })
    expect(m.calls[0]).toMatchObject({ stage: 'review', contexts_dropped: true, estimated_input_tokens: m.estimate.total })
  })

  it('keeps the rejected row estimate, marks the diff-only retry, and nulls the reviewer ratio', async () => {
    const setup = () => {
      vi.mocked(fetchContext).mockResolvedValue([{ path: 'src/app.ts', content: 'x'.repeat(400) }])
      let n = 0
      vi.mocked(runReview).mockImplementation(async () => {
        if (n++ === 0) throw Object.assign(new Error('prompt is too long'), { status: 400 })
        return { text: renderReview(obj()), usage, review: obj() }
      })
    }
    const on = await run(true, adapter(DIFF, ['src/app.ts']), setup)
    const m = on.record!.token_metrics
    expect(m.calls.map((c: any) => [c.end, c.estimated_input_tokens === null, c.contexts_dropped ?? false])).toEqual([['error', false, false], ['ok', true, true]])
    expect(m.calls[0]).toMatchObject({ input_tokens: null, cost_usd: null, tier_cost_usd: null })
    expect(m.reviewer).toBeNull()
  })

  it('records the packer estimate and its parts per bundle, with the judge row of each bundle', async () => {
    const setup = () => {
      cfg.review.bundledReview = true
      cfg.anthropic.maxInputTokens = 2000
      cfg.judge.model = 'claude-haiku-5-5'
      vi.mocked(runReview).mockImplementation(async (...args: unknown[]) => {
        const o = obj((args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
        return { text: renderReview(o), usage, review: o }
      })
      vi.mocked(runJudge).mockImplementation(async (_k, _m, _r, _t, _e, _d, rv) => ({ text: renderReview(rv) + '\n\n### Merge Confidence: 80%', usage: { input_tokens: 400, output_tokens: 50 }, scores: [{ title: 't', severity: 'MEDIUM', score: 8 }] }) as never)
    }
    const on = await run(true, adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']), setup)
    const m = on.record!.token_metrics
    const reviews = m.calls.filter((c: any) => c.stage === 'review')
    expect(reviews.length).toBeGreaterThan(1)
    expect(reviews.map((c: any) => c.bundle)).toEqual(reviews.map((_: unknown, i: number) => i + 1))
    for (const c of reviews) expect(c.estimated_input_tokens).toBe(c.estimate_parts.overhead + c.estimate_parts.diff + c.estimate_parts.files)
    const judges = m.calls.filter((c: any) => c.stage === 'judge')
    expect(judges.map((c: any) => c.bundle)).toEqual(reviews.map((c: any) => c.bundle))
    expect(judges.every((c: any) => c.estimated_input_tokens === null && c.estimate_parts === undefined)).toBe(true)
    expect(m.reviewer.calls).toBe(reviews.length)
    expect(m.estimate.total).toBeGreaterThan(2000)
  })

  it('marks a bundle retry as diff-only with no estimate', async () => {
    const setup = () => {
      cfg.review.bundledReview = true
      cfg.anthropic.maxInputTokens = 2000
      vi.mocked(fetchContext).mockResolvedValue([{ path: 'a/one.ts', content: 'y'.repeat(200) }])
      let n = 0
      vi.mocked(runReview).mockImplementation(async (...args: unknown[]) => {
        if (n++ === 0) throw Object.assign(new Error('prompt is too long'), { status: 400 })
        const o = obj((args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
        return { text: renderReview(o), usage, review: o }
      })
    }
    const on = await run(true, adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']), setup)
    const reviews = on.record!.token_metrics.calls.filter((c: any) => c.stage === 'review')
    expect(reviews[0]).toMatchObject({ bundle: 1, end: 'error' })
    expect(reviews[0].estimate_parts.file_count).toBe(1)
    expect(reviews[1]).toMatchObject({ bundle: 1, end: 'ok', estimated_input_tokens: null, contexts_dropped: true })
    expect(reviews[1].estimate_parts).toBeUndefined()
    expect(on.record!.token_metrics.reviewer).toBeNull()
  })

  it('stores the breadth estimate for the breadth row, in call order after the reviewer', async () => {
    const setup = () => {
      cfg.breadth.enabled = true
      cfg.breadth.minFiles = 1
      cfg.breadth.minUntouched = 0
      cfg.judge.model = 'claude-haiku-5-5'
      vi.mocked(runJudge).mockImplementation(async (_k, _m, _r, _t, _e, _d, rv) => ({ text: renderReview(rv) + MERGE_TAIL, usage: { input_tokens: 400, output_tokens: 50 }, scores: [] }) as never)
      vi.mocked(runBreadth).mockResolvedValue({ findings: [], usage: { input_tokens: 600, output_tokens: 80 }, promptHash: 'h' } as never)
    }
    try {
      const on = await run(true, adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']), setup)
      const calls = on.record!.token_metrics.calls
      expect(calls.map((c: any) => c.stage)).toEqual(['review', 'breadth', 'judge'])
      expect(calls[1].estimated_input_tokens).toBeGreaterThan(on.record!.token_metrics.estimate.total)
      expect(calls[2].estimated_input_tokens).toBeNull()
    } finally {
      cfg.breadth.enabled = false
    }
  })

  it('keeps the key with no calls on a budget skip and prints the summary', async () => {
    const setup = () => { cfg.anthropic.maxInputTokens = 20 }
    const on = await run(true, adapter(DIFF, ['src/app.ts']), setup)
    expect(on.record!.action).toBe('SKIP')
    expect(on.record!.token_metrics).toMatchObject({ calls: [], tier_calls: 0, reviewer: null })
    expect(on.record!.token_metrics.estimate.total).toBe(on.record!.tokens.estimated_input)
    expect(on.lines.find(l => l.startsWith('Token metrics:'))).toContain('reviewer ratio n/a, estimate ~')
  })

  it('lists the same calls as pass_calls on a cache-on run, and their rows add up to the record cost', async () => {
    const setup = () => {
      cfg.review.promptCache = true
      cfg.judge.model = 'claude-haiku-5-5'
      vi.mocked(runJudge).mockImplementation(async (_k, _m, _r, _t, _e, _d, rv) => ({ text: renderReview(rv) + MERGE_TAIL, usage: { input_tokens: 400, output_tokens: 50 }, scores: [] }) as never)
    }
    try {
      const on = await run(true, adapter(DIFF, ['src/app.ts']), setup)
      const m = on.record!.token_metrics
      expect(on.record!.pass_calls.length).toBeGreaterThan(1)
      expect(m.calls.map((c: any) => [c.stage, c.end])).toEqual(on.record!.pass_calls.map((p: any) => [p.stage, p.end]))
      expect(Math.abs(on.record!.cost_usd - m.calls_cost_usd)).toBeLessThan(0.0001)
    } finally {
      cfg.review.promptCache = false
    }
  })

  it('leaves no key and no summary when the run ends before any estimate or call', async () => {
    const dup = adapter(DIFF, ['src/app.ts'], { getPreviousReviewComments: async () => [priorComment(pr.sourceCommit.slice(0, 12))] })
    const on = await run(true, dup)
    expect(on.record).not.toHaveProperty('token_metrics')
    expect(metricsLines(on)).toEqual([])
  })
})

describe('legacy reply rows', () => {
  it('records a reply row priced at the reply model beside the reviewer row', async () => {
    const setup = () => {
      cfg.reply.model = 'claude-sonnet-5-5'
      vi.mocked(runReview).mockImplementation(async () => ({ text: 'NO_CHANGE', usage, review: { summary: '', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [], no_change: true } as ReviewObject }))
    }
    const on = await run(true, reReview(), setup)
    expect(on.record!.action).toBe('REPLY')
    const reply = on.record!.token_metrics.calls.find((c: any) => c.stage === 'reply')
    expect(reply).toMatchObject({ model: 'claude-sonnet-5-5', end: 'ok', input_tokens: 500, output_tokens: 100, estimated_input_tokens: null })
    expect(on.record!.token_metrics.calls.map((c: any) => c.stage)).toEqual(['review', 'reply'])
  })

  it('records a failed reply with its usage and rethrows the same error', async () => {
    const failure = Object.assign(new Error('reply broke'), { usage: { input_tokens: 700, output_tokens: 0 } })
    const setup = () => {
      vi.mocked(runReview).mockImplementation(async () => ({ text: 'NO_CHANGE', usage, review: { summary: '', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [], no_change: true } as ReviewObject }))
      vi.mocked(runCommentResponse).mockRejectedValue(failure)
    }
    const on = await run(true, reReview(), setup)
    const off = await run(false, reReview(), setup)
    expect((on.thrown as Error).message).toBe('reply broke')
    expect((off.thrown as Error).message).toBe('reply broke')
  })
})

describe('error-path invariant', () => {
  const cases: [string, unknown][] = [['null', null], ['a string', 'plain string'], ['an Error without usage', new Error('no usage here')]]
  const noChange = () => vi.mocked(runReview).mockImplementation(async () => ({ text: 'NO_CHANGE', usage, review: { summary: '', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [], no_change: true } as ReviewObject }))
  const outcome = (r: Run) => ({ message: (r.thrown as Error | null)?.message ?? null, type: r.thrown === null ? null : typeof r.thrown, record: r.record && stable(r.record) })

  for (const [name, value] of cases) {
    it(`rethrows ${name} from the reply call identically with the setting on and off`, async () => {
      const setup = () => { noChange(); vi.mocked(runCommentResponse).mockRejectedValue(value) }
      const on = await run(true, reReview(), setup)
      const off = await run(false, reReview(), setup)
      expect(outcome(on)).toEqual(outcome(off))
      expect(on.thrown).not.toBeNull()
      expect(on.warns.filter(w => w.startsWith('Token metrics skipped'))).toEqual([])
    })

    it(`rethrows ${name} from the reviewer call identically with the setting on and off`, async () => {
      const setup = () => { vi.mocked(runReview).mockRejectedValue(value) }
      const on = await run(true, adapter(DIFF, ['src/app.ts']), setup)
      const off = await run(false, adapter(DIFF, ['src/app.ts']), setup)
      expect(outcome(on)).toEqual(outcome(off))
      expect(on.warns.filter(w => w.startsWith('Token metrics skipped'))).toEqual([])
    })
  }
})

describe('ON and OFF are the same run', () => {
  const noChange = () => vi.mocked(runReview).mockImplementation(async () => ({ text: 'NO_CHANGE', usage, review: { summary: '', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [], no_change: true } as ReviewObject }))
  const FILES = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']
  const judgeOk = () => vi.mocked(runJudge).mockImplementation(async (_k, _m, _r, _t, _e, _d, rv) => ({ text: renderReview(rv) + MERGE_TAIL, usage: { input_tokens: 400, output_tokens: 50 }, scores: [] }) as never)
  const breadthOn = (reject?: unknown) => () => {
    cfg.breadth.enabled = true
    cfg.breadth.minFiles = 1
    cfg.breadth.minUntouched = 0
    cfg.judge.model = 'claude-haiku-5-5'
    judgeOk()
    if (reject !== undefined) vi.mocked(runBreadth).mockRejectedValue(reject)
  }
  const deadline = (completed?: object) => Object.assign(new DeadlineAbortError('aborted', { input_tokens: 9, output_tokens: 3 }), completed ? { completed } : {})

  async function same(a: () => VCSAdapter, setup: () => void, check: (on: Run) => void = () => {}) {
    try {
      const on = await run(true, a(), setup)
      const off = await run(false, a(), setup)
      expect(on.thrown === null).toBe(off.thrown === null)
      expect((on.thrown as Error | null)?.message).toBe((off.thrown as Error | null)?.message)
      expect(stable(on.record)).toEqual(stable(off.record))
      expect(stable(on.logged)).toEqual(stable(off.logged))
      expect(withoutMetricsLines(on)).toEqual(withoutMetricsLines(off))
      expect(on.warns).toEqual(off.warns)
      expect(off.record === null || !('token_metrics' in off.record)).toBe(true)
      check(on)
    } finally {
      cfg.breadth.enabled = false
    }
  }
  const single = () => adapter(DIFF, ['src/app.ts'])
  const big = () => adapter(BIG_DIFF, FILES)

  it('a context-length retry', async () => {
    await same(single, () => {
      vi.mocked(fetchContext).mockResolvedValue([{ path: 'src/app.ts', content: 'x'.repeat(400) }])
      let n = 0
      vi.mocked(runReview).mockImplementation(async () => {
        if (n++ === 0) throw Object.assign(new Error('prompt is too long'), { status: 400 })
        return { text: renderReview(obj()), usage, review: obj() }
      })
    }, on => expect(on.record!.token_metrics.calls).toHaveLength(2))
  })

  it('a truncated reviewer ERROR', async () => {
    const truncated = new TruncatedResponseError('cut off', { input_tokens: 900, output_tokens: 300 } as never)
    await same(single, () => { vi.mocked(runReview).mockRejectedValue(truncated) }, on => {
      expect(on.logged!.action).toBe('ERROR')
      expect(on.logged!.token_metrics.calls[0]).toMatchObject({ stage: 'review', end: 'truncated', input_tokens: 900 })
    })
  })

  it('a judge failure', async () => {
    await same(single, () => {
      cfg.judge.model = 'claude-haiku-5-5'
      vi.mocked(runJudge).mockRejectedValue(new Error('judge down'))
    }, on => expect(on.logged!.token_metrics.calls.some((c: any) => c.stage === 'judge' && c.end === 'error')).toBe(true))
  })

  it('a deadline-aborted breadth without completed attempts', async () => {
    await same(big, breadthOn(deadline()), on => {
      expect(on.record!.breadth_status).toBe('aborted_time')
      expect(on.record!.token_metrics.calls.find((c: any) => c.stage === 'breadth')).toMatchObject({ end: 'aborted_time' })
    })
  })

  it('a deadline-aborted breadth with a completed attempt', async () => {
    const completed = { input_tokens: 500, output_tokens: 70 }
    await same(big, breadthOn(deadline(completed)), on => {
      const rows = on.record!.token_metrics.calls.filter((c: any) => c.stage === 'breadth')
      expect(rows.map((c: any) => c.end)).toEqual(['error', 'aborted_time'])
    })
  })

  it('a legacy reply, succeeding and failing', async () => {
    const failure = Object.assign(new Error('reply broke'), { usage: { input_tokens: 700, output_tokens: 0 } })
    await same(reReview, () => { noChange(); cfg.reply.model = 'claude-sonnet-5-5' })
    await same(reReview, () => { noChange(); vi.mocked(runCommentResponse).mockRejectedValue(failure) })
  })

  it('an unpriced judge model without a reported cost adds no warning', async () => {
    await same(single, () => {
      cfg.judge.model = 'openai/gpt-5'
      judgeOk()
    }, on => expect(on.warns.some(w => w.startsWith('Token metrics'))).toBe(false))
  })
})
