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
import { runReview, runCommentResponse, runJudge } from '../client.js'
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
const FILES = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']
const pr: PRInfo = { id: '100', title: 'Test PR', description: 'd', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'abc123abc123abc' }
const MERGE_TAIL = '\n\n### Merge Confidence: 80%'
const obj = (file = 'src/app.ts'): ReviewObject => ({ summary: 's', findings: [{ severity: 'MEDIUM', title: 'Issue', file, lines: '3', body: 'bad' }], behavioral_diff: [], production_risk: [], unresolved_questions: [] })
const NO_CHANGE = { summary: '', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [], no_change: true } as ReviewObject

const PRIOR = '### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.'
const footer = (commit: string) => `\n\n---\n*Reviewed by test-bot (claude-haiku-5-5) | Prompt: repo | Review #1 | Commit: ${commit}*`
const priorComment = (commit: string): ReviewComment => ({ id: '200', body: PRIOR + footer(commit), createdOn: '2026-03-09T10:00:00Z' })
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
const single = () => adapter(DIFF, ['src/app.ts'])
const big = () => adapter(BIG_DIFF, FILES)
const reReview = () => adapter(DIFF, ['src/app.ts'], {
  getPreviousReviewComments: async () => [priorComment('aabbcc112233')],
  getRepliesToReviewComments: async () => ({ replies: [devReply()], agentReplyCount: 0 }),
  getCommitDiff: async () => DIFF,
})
const replyOnly = () => adapter(DIFF, ['src/app.ts'], {
  getPreviousReviewComments: async () => [priorComment('abc123abc123')],
  getRepliesToReviewComments: async () => ({ replies: [devReply()], agentReplyCount: 0 }),
})

type JudgeUsage = { input_tokens: number; output_tokens: number; cost_usd?: number }
type Rec = Record<string, any>
interface Run { logged: Rec | null }

async function run(on: boolean, a: VCSAdapter, setup: () => void): Promise<Run> {
  vi.clearAllMocks()
  cfg.tokenMetrics = on
  cfg.anthropic.model = 'claude-haiku-5-5'
  cfg.reply.model = ''
  cfg.review.bundledReview = false
  cfg.anthropic.maxInputTokens = 150000
  cfg.judge.model = ''
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
  setup()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  remainderProbe.fallbacks = 0
  try { await review(a, '100', false, undefined, 'off', true, 'repo') } catch { /* ERROR runs are read from the logged record */ }
  const logged = (vi.mocked(logUsageRecord).mock.calls.at(-1)?.[0] ?? null) as Rec | null
  vi.restoreAllMocks()
  expect(remainderProbe.fallbacks, 'every remainder token must be listed, or the old whole-bucket price was used').toBe(0)
  return { logged }
}

const costs = (r: Run) => { const x = r.logged!; return { cost_usd: x.cost_usd, judge_cost_usd: x.judge_cost_usd, breadth_cost_usd: x.breadth_cost_usd, second_look_cost_usd: x.second_look_cost_usd } }

// Each scenario runs with the metrics setting on and off; the cost fields must agree with each other and, when rows exist, with the per-call rows.
async function both(a: () => VCSAdapter, setup: () => void): Promise<Run> {
  const on = await run(true, a(), setup)
  const off = await run(false, a(), setup)
  expect(costs(on)).toEqual(costs(off))
  return on
}

const rowsAgree = (r: Run) => expect(Math.abs(r.logged!.cost_usd - r.logged!.token_metrics.calls_cost_usd)).toBeLessThan(0.0001)

const reviewer = (input: number, output: number) => () => vi.mocked(runReview).mockImplementation(async () => ({ text: renderReview(obj()), usage: { input_tokens: input, output_tokens: output }, review: obj() }))
const bundleReviewer = (input: number, output: number) => {
  vi.mocked(runReview).mockImplementation(async (...args: unknown[]) => {
    const o = obj((args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
    return { text: renderReview(o), usage: { input_tokens: input, output_tokens: output }, review: o }
  })
}
const judgeWith = (usageOf: () => JudgeUsage) => vi.mocked(runJudge).mockImplementation(async (_k, _m, _r, _t, _e, _d, rv) => ({ text: renderReview(rv) + MERGE_TAIL, usage: usageOf(), scores: [] }) as never)
const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 4)

beforeEach(() => { vi.restoreAllMocks() })

describe('bundled review (P1, P2)', () => {
  const bundled = (judgeUsage: () => JudgeUsage) => () => {
    cfg.review.bundledReview = true
    cfg.anthropic.maxInputTokens = 2000
    cfg.judge.model = 'claude-haiku-5-5'
    bundleReviewer(60_000, 2_000)
    judgeWith(judgeUsage)
  }

  it('prices each bundle reviewer request alone when there is no judge', async () => {
    const r = await both(big, () => {
      cfg.review.bundledReview = true
      cfg.anthropic.maxInputTokens = 2000
      bundleReviewer(60_000, 2_000)
    })
    expect(vi.mocked(runReview).mock.calls).toHaveLength(2)
    close(r.logged!.cost_usd, 0.014)
    rowsAgree(r)
  })

  it('prices every bundle alone against the long-context tier', async () => {
    const r = await both(big, bundled(() => ({ input_tokens: 55_000, output_tokens: 1_500 })))
    const n = vi.mocked(runReview).mock.calls.length
    expect(n).toBeGreaterThan(1)
    close(r.logged!.judge_cost_usd, n * 0.00625)
    close(r.logged!.cost_usd, n * (0.007 + 0.00625))
    rowsAgree(r)
  })

  it('adds the table price of an unreported judge to the reported one', async () => {
    const r = await both(big, () => {
      let n = 0
      bundled(() => (n++ === 0 ? { input_tokens: 400, output_tokens: 50, cost_usd: 0.006 } : { input_tokens: 55_000, output_tokens: 1_000 }))()
    })
    close(r.logged!.judge_cost_usd, 0.006 + 0.006)
    close(r.logged!.cost_usd, 0.014 + 0.006 + 0.006)
    rowsAgree(r)
  })
})

describe('legacy reply (P3, P4, P6)', () => {
  const noChange = (input: number, output: number) => vi.mocked(runReview).mockImplementation(async () => ({ text: 'NO_CHANGE', usage: { input_tokens: input, output_tokens: output }, review: NO_CHANGE }))

  it('prices a reply after a re-review as its own request', async () => {
    const r = await both(reReview, () => { noChange(90_000, 1_500); vi.mocked(runCommentResponse).mockResolvedValue({ text: 'Thanks.', usage: { input_tokens: 15_000, output_tokens: 300 } }) })
    expect(r.logged!.action).toBe('REPLY')
    close(r.logged!.cost_usd, 0.00975 + 0.00165)
    rowsAgree(r)
  })

  it('prices the reviewer at its model and the reply at REPLY_MODEL', async () => {
    const r = await both(reReview, () => {
      cfg.anthropic.model = 'claude-sonnet-5-5'
      cfg.reply.model = 'claude-haiku-5-5'
      noChange(80_000, 3_000)
      vi.mocked(runCommentResponse).mockResolvedValue({ text: 'Thanks.', usage: { input_tokens: 10_000, output_tokens: 400 } })
    })
    close(r.logged!.cost_usd, 0.19 + 0.0012)
    rowsAgree(r)
  })

  it('prices a failed reply at the reply model, not the reviewer model', async () => {
    const failure = Object.assign(new Error('reply truncated'), { usage: { input_tokens: 20_000, output_tokens: 4_096 } })
    const r = await both(replyOnly, () => {
      cfg.anthropic.model = 'claude-sonnet-5-5'
      cfg.reply.model = 'claude-haiku-5-5'
      vi.mocked(runCommentResponse).mockRejectedValue(failure)
    })
    expect(r.logged!.action).toBe('ERROR')
    close(r.logged!.cost_usd, 0.002 + 0.002048)
    rowsAgree(r)
  })
})

describe('failed judge (P5)', () => {
  const setup = (model: string) => () => {
    cfg.anthropic.model = model
    cfg.judge.model = 'claude-haiku-5-5'
    reviewer(50_000, 2_000)()
    vi.mocked(runJudge).mockRejectedValue(Object.assign(new Error('judge cut off'), { usage: { input_tokens: 60_000, output_tokens: 64_000 } }))
  }

  it('prices the failed judge request at the judge model beside a Haiku reviewer', async () => {
    const r = await both(single, setup('claude-haiku-5-5'))
    expect(r.logged!.action).toBe('ERROR')
    close(r.logged!.cost_usd, 0.006 + 0.038)
    rowsAgree(r)
  })

  it('prices the failed judge request at the judge model beside a Sonnet reviewer', async () => {
    const r = await both(single, setup('claude-sonnet-5-5'))
    close(r.logged!.cost_usd, 0.12 + 0.038)
    rowsAgree(r)
  })
})

describe('mixed reported costs (P7)', () => {
  it('table-prices the unreported reviewer beside a reported judge', async () => {
    const r = await both(single, () => {
      cfg.judge.model = 'claude-haiku-5-5'
      reviewer(80_000, 2_000)()
      judgeWith(() => ({ input_tokens: 400, output_tokens: 50, cost_usd: 0.01 }))
    })
    close(r.logged!.judge_cost_usd, 0.01)
    close(r.logged!.cost_usd, 0.009 + 0.01)
    rowsAgree(r)
  })

  it('keeps the reported total when every call reported a cost', async () => {
    const r = await both(single, () => {
      cfg.judge.model = 'claude-haiku-5-5'
      vi.mocked(runReview).mockImplementation(async () => ({ text: renderReview(obj()), usage: { input_tokens: 80_000, output_tokens: 2_000, cost_usd: 0.0123 }, review: obj() }))
      judgeWith(() => ({ input_tokens: 400, output_tokens: 50, cost_usd: 0.01 }))
    })
    expect(r.logged!.cost_usd).toBe(0.0123 + 0.01)
  })

  it('keeps the old aggregate arithmetic, not a per-request sum, for an all-reported bundled run', async () => {
    const reviewerCosts = [0.4348, 0.5646]
    const judgeCosts = [0.7008, 0.9083]
    const aggregate = 0 + reviewerCosts[0] + judgeCosts[0] + reviewerCosts[1] + judgeCosts[1]
    const judgeSum = 0 + judgeCosts[0] + judgeCosts[1]
    const oldWay = (aggregate - judgeSum) + judgeSum
    const perRequest = (0 + reviewerCosts[0] + reviewerCosts[1]) + judgeSum
    expect(oldWay).not.toBe(perRequest)
    let rn = 0
    let jn = 0
    const r = await both(big, () => {
      cfg.review.bundledReview = true
      cfg.anthropic.maxInputTokens = 2000
      cfg.judge.model = 'claude-haiku-5-5'
      vi.mocked(runReview).mockImplementation(async (...args: unknown[]) => {
        const o = obj((args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
        return { text: renderReview(o), usage: { input_tokens: 600, output_tokens: 50, cost_usd: reviewerCosts[rn++ % 2] }, review: o }
      })
      judgeWith(() => ({ input_tokens: 400, output_tokens: 50, cost_usd: judgeCosts[jn++ % 2] }))
    })
    expect(r.logged!.cost_usd).toBe(oldWay)
  })
})

describe('bundled run that ends in an error after a judged bundle (P5)', () => {
  const setup = (failAt: 'judge' | 'reviewer') => () => {
    cfg.review.bundledReview = true
    cfg.anthropic.maxInputTokens = 2000
    cfg.judge.model = 'claude-haiku-5-5'
    let rn = 0
    vi.mocked(runReview).mockImplementation(async (...args: unknown[]) => {
      if (failAt === 'reviewer' && rn++ === 1) throw Object.assign(new Error('reviewer cut off'), { usage: { input_tokens: 60_000, output_tokens: 32_000 } })
      const o = obj((args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
      return { text: renderReview(o), usage: { input_tokens: 60_000, output_tokens: 2_000 }, review: o }
    })
    let jn = 0
    vi.mocked(runJudge).mockImplementation(async (_k, _m, _r, _t, _e, _d, rv) => {
      if (failAt === 'judge' && jn++ === 1) throw Object.assign(new Error('judge cut off'), { usage: { input_tokens: 60_000, output_tokens: 64_000 } })
      return { text: renderReview(rv) + MERGE_TAIL, usage: { input_tokens: 55_000, output_tokens: 1_500 }, scores: [] } as never
    })
  }

  it('prices every request alone when the second bundle judge fails', async () => {
    const r = await both(big, setup('judge'))
    expect(r.logged!.action).toBe('ERROR')
    expect(r.logged!.judge_cost_usd).toBeNull()
    expect(r.logged!.judge_tokens).toBeNull()
    expect(r.logged!.cost_usd).toBe(0.0583)
  })

  it('prices every request alone when the second bundle reviewer fails', async () => {
    const r = await both(big, setup('reviewer'))
    expect(r.logged!.action).toBe('ERROR')
    expect(r.logged!.judge_cost_usd).toBeNull()
    expect(r.logged!.cost_usd).toBe(0.0352)
  })
})
