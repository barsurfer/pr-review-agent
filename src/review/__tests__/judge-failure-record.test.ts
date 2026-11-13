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
const judgeUsage = { input_tokens: 50_015, output_tokens: 3_002, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0.002 }
const missingFieldError = () => Object.assign(new Error('Structured output missing required field(s): decisions[1].note, decisions[1].score'), { usage: judgeUsage })

const lastRecord = (): UsageRecord => vi.mocked(logUsageRecord).mock.calls.at(-1)![0]

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
  vi.mocked(runReview).mockResolvedValue({ text: renderReview(REVIEW), usage: { input_tokens: 52_252, output_tokens: 12_585, cost_usd: 0.007 }, review: REVIEW })
})
afterEach(() => { vi.restoreAllMocks() })

describe('ERROR record when the judge throws', () => {
  it('keeps the never-judged reviewer candidates and the failed judge call\'s paid usage', async () => {
    vi.mocked(runJudge).mockRejectedValue(missingFieldError())

    await expect(review(adapter(), '9', true, undefined, 'off', true)).rejects.toThrow('decisions[1].note')

    const record = lastRecord()
    expect(record.action).toBe('ERROR')
    expect(record.judge_status).toBe('failed')
    expect(record.review_candidates).toBeNull()
    expect(record.unjudged_candidates).toEqual([
      { id: 'c0', origin: 'review', severity: 'MEDIUM', title: 'Footer regex drifts from the builder', file: 'src/app.ts', lines: '1', body: 'The parser no longer matches.' },
      { id: 'c1', origin: 'review', severity: 'LOW', title: 'Stale doc line', file: null, lines: null, body: 'Docs still say 200K.' },
    ])
    expect(record.tokens.input).toBe(52_252 + 50_015)
    expect(record.tokens.output).toBe(12_585 + 3_002)
    expect(record.cost_usd).toBeCloseTo(0.009, 10)
    expect(Object.keys(record).indexOf('unjudged_candidates')).toBe(Object.keys(record).indexOf('review_candidates') + 1)
  })

  it('is absent when the judge succeeds, so a normal record serializes as before', async () => {
    vi.mocked(runJudge).mockResolvedValue({ text: '### Summary\nok\n\n### Findings\n\nNo findings.\n\n### Merge Confidence: 90%', usage: judgeUsage, decisions: [] })
    await review(adapter(), '9', true, undefined, 'off', true)
    expect(lastRecord().action).toBe('REVIEW')
    expect('unjudged_candidates' in lastRecord()).toBe(false)
  })

  it('is absent when the run fails before the judge', async () => {
    vi.mocked(runReview).mockRejectedValue(Object.assign(new Error('Structured output missing required field(s): findings[0].severity'), { usage: judgeUsage }))
    await expect(review(adapter(), '9', true, undefined, 'off', true)).rejects.toThrow('findings[0].severity')
    expect(lastRecord().action).toBe('ERROR')
    expect(lastRecord().tokens.input).toBe(50_015)
    expect('unjudged_candidates' in lastRecord()).toBe(false)
  })

  it('is absent when a judge failure is absorbed (benchmark sink keeps the unjudged findings itself)', async () => {
    vi.mocked(runJudge).mockRejectedValue(missingFieldError())
    await review(adapter(), '9', false, undefined, 'off', true, '', () => {})
    expect(lastRecord().judge_status).toBe('failed')
    expect(lastRecord().error).toBeNull()
    expect('unjudged_candidates' in lastRecord()).toBe(false)
  })
})
