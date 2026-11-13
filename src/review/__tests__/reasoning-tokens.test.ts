import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VCSAdapter } from '../../vcs/adapter.js'

vi.mock('../../config.js', () => ({
  config: {
    vcsProvider: 'bitbucket', llmApiKey: 'k',
    anthropic: { model: 'openai/gpt-5-nano', maxRetries: 1, maxInputTokens: 150_000, maxTokens: 32_000, modelContextTokens: 0 },
    judge: { model: 'openai/gpt-5-nano', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3, benchmarkDeadlineSeconds: 840 },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3, model: '' },
    review: { maxFindings: 0, splitCheck: false, todoScan: false, effort: '', enableNitpicks: false, secondLook: false, lineNumbers: false },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [], skipTargetBranches: [], onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: [],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 0, minChangedLines: 0, maxChangedLines: 0 },
    bitbucket: { workspace: 'test' },
  },
  modelContextWindow: () => 200_000,
}))
vi.mock('../client.js', () => ({ runReview: vi.fn(), runCommentResponse: vi.fn(), runJudge: vi.fn(), runBreadth: vi.fn(), runLens: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../usage.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../usage.js')>()), logUsageRecord: vi.fn() }))

import { review } from '../index.js'
import { runReview, runJudge } from '../client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { logUsageRecord, type UsageRecord } from '../usage.js'
import { renderReview, type ReviewObject } from '../formatter.js'

const DIFF = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n+foo()\n+bar()\n'

function adapter(): VCSAdapter {
  return {
    getPullRequestInfo: vi.fn().mockResolvedValue({ id: '9', title: 'T', description: '', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'b'.repeat(40) }),
    getDiff: vi.fn().mockResolvedValue(DIFF),
    getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/app.ts', status: 'modified' }]),
    getFileContent: vi.fn().mockResolvedValue(''),
    getRepoFileContent: vi.fn().mockResolvedValue(null),
    postComment: vi.fn(),
    getPreviousReviewComments: vi.fn().mockResolvedValue([]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
    postReply: vi.fn(),
    getCommitDiff: vi.fn().mockResolvedValue(''),
  }
}

const REVIEW: ReviewObject = {
  summary: 'risky', behavioral_diff: [], production_risk: [], unresolved_questions: [],
  findings: [
    { severity: 'MEDIUM', title: 'Footer regex drifts from the builder', file: 'src/app.ts', lines: '1', body: 'The parser no longer matches.' },
    { severity: 'LOW', title: 'Stale doc line', body: 'Docs still say 200K.' },
  ],
}
const JUDGE_TEXT = ['### Summary','ok','','### Findings','','No findings.','','### Merge Confidence: 90%'].join(String.fromCharCode(10))
const usageOf = (output: number, reasoning?: number) => ({ input_tokens: 1000, output_tokens: output, cost_usd: 0.01, ...(reasoning === undefined ? {} : { reasoning_tokens: reasoning }) })
const lastRecord = (): UsageRecord => vi.mocked(logUsageRecord).mock.calls.at(-1)![0]
const judgeOk = (usage: ReturnType<typeof usageOf>) => ({ text: JUDGE_TEXT, usage, decisions: [] })

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
})
afterEach(() => { vi.restoreAllMocks() })

const run = () => review(adapter(), '9', true, undefined, 'off', true)

describe('tokens.reasoning in the usage record', () => {
  it('sums reasoning over reviewer and judge, leaving output and cost as the plain totals', async () => {
    vi.mocked(runReview).mockResolvedValue({ text: renderReview(REVIEW), usage: usageOf(800, 300), review: REVIEW })
    vi.mocked(runJudge).mockResolvedValue(judgeOk(usageOf(200, 50)))
    await run()
    const r = lastRecord()
    expect(r.tokens.reasoning).toBe(350)
    expect(r.tokens.output).toBe(1000)
    expect(r.cost_usd).toBeCloseTo(0.02, 10)
  })

  it('is absent when no call reports it, with the existing tokens keys in order', async () => {
    vi.mocked(runReview).mockResolvedValue({ text: renderReview(REVIEW), usage: usageOf(800), review: REVIEW })
    vi.mocked(runJudge).mockResolvedValue(judgeOk(usageOf(200)))
    await run()
    expect(Object.keys(lastRecord().tokens)).toEqual(['input', 'output', 'cache_read', 'cache_write', 'estimated_input'])
  })

  it('is kept on an ERROR run whose error carries usage', async () => {
    vi.mocked(runReview).mockRejectedValue(Object.assign(new Error('Structured output missing required field(s): findings'), { usage: usageOf(500, 120) }))
    await expect(run()).rejects.toThrow('findings')
    expect(lastRecord().action).toBe('ERROR')
    expect(lastRecord().tokens.reasoning).toBe(120)
    expect(lastRecord().tokens.output).toBe(500)
  })
})
