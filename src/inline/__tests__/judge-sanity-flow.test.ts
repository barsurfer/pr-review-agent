import { describe, it, expect, vi, beforeEach } from 'vitest'

const cfg = vi.hoisted(() => ({
  llmProvider: 'anthropic',
  vcsProvider: 'bitbucket',
  llmApiKey: 'k',
  tokenMetrics: true,
  agentIdentity: 'review-bot',
  anthropic: { model: 'claude-sonnet-5-5', maxRetries: 1, maxInputTokens: 250000, maxTokens: 64000, extraPassMaxTokens: 0 },
  judge: { model: 'claude-haiku-5-5', maxRetries: 1, effort: '', policy: { keepMinor: true, keepUnverified: true }, fileContext: false },
  breadth: { enabled: false, model: '', effort: '', minFiles: 1, minUntouched: 0, benchmarkDeadlineSeconds: 840, judgeReserveSeconds: 270, passDeadline: false },
  lenses: { enabled: false, list: 'rel', model: '', recommend: false },
  reply: { maxComments: 5, maxFindingReplies: 5, model: 'claude-haiku-5-5', skipDirectedElsewhere: false },
  review: {
    inlineReviews: true, inlineLowThreads: false, inlineAgentAccountId: '', inlineHide: [] as string[],
    maxFindings: 0, splitCheck: false, todoScan: false, effort: '', enableNitpicks: false, secondLook: false, lineNumbers: false, promptCache: false,
    targetMergeCheck: false, bundledReview: false, maxBundles: 8, cachedPassEffort: '',
  },
  context: { maxFiles: 20, maxFileLines: 500 },
  skipSourceBranches: [] as string[], skipTargetBranches: [] as string[], onlyTargetBranches: [] as string[],
  trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] as string[] },
  diffExcludePatterns: [] as string[],
  thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
  bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  azure: { org: '' },
  usageRecordFile: '',
}))
vi.mock('../../config.js', () => ({ config: cfg, modelContextWindow: () => 1_000_000 }))
// Only the reviewer is mocked: the real runJudge runs so the retry reaches the provider mock.
vi.mock('../../review/client.js', async importOriginal => ({ ...(await importOriginal() as object), runReview: vi.fn(), runCommentResponse: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../../review/usage.js', async importOriginal => ({ ...(await importOriginal() as object), logUsageRecord: vi.fn() }))
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))

import { review } from '../../review/index.js'
import { runReview } from '../../review/client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { estimateCost } from '../../review/usage.js'
import { renderReview, hasReviewFooter, type ReviewObject } from '../../review/formatter.js'
import { ContentFilterError } from '../../llm/shared.js'
import { SUMMARY_HEADER } from '../markers.js'
import { makeFake, ME, type Fake } from './fake-bitbucket.js'

const bulk = (path: string, n: number): string => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${n} @@`,
  ...Array.from({ length: n }, (_, i) => `+export const ${path.replace(/\W/g, '_')}_${i} = ${i}`), '',
].join('\n')
const PATHS = ['src/one.ts', 'src/two.ts']
const FILES = PATHS.map(path => ({ path, status: 'added' }))
const POOL = { severity: 'HIGH' as const, title: 'Pool leaks connections', file: 'src/one.ts', lines: '5', body: 'Connections are never released.' }
const NULLS = { severity: 'MEDIUM' as const, title: 'Missing null check on user', file: 'src/two.ts', lines: '10', body: 'The user can be null here.' }
const REVIEW: ReviewObject = { summary: 'The reviewer narrative here.', findings: [POOL, NULLS], behavioral_diff: [], production_risk: [], unresolved_questions: [], delta_stats: { resolved: 0, still_open: 0, new_findings: 2 } }
const reviewUsage = { input_tokens: 1000, output_tokens: 500 }
const judgeUsage = { input_tokens: 50000, output_tokens: 7000 }
const DELTA = ['diff --git a/src/one.ts b/src/one.ts', 'index 1111111..2222222 100644', '--- a/src/one.ts', '+++ b/src/one.ts', '@@ -30,1 +30,1 @@', '-x', '+y', ''].join('\n')
const HEAD_B = 'b'.repeat(12) + '0'.repeat(28)
const HEAD_C = 'c'.repeat(12) + '0'.repeat(28)

const decision = (id: string, file: string, line: number) => ({ candidate_id: id, reason_category: 'validated', evidence: `${file}:${line}`, note: 'ok', score: 8 })
const GOOD = { decisions: [decision('c0', 'src/one.ts', 5), decision('c1', 'src/two.ts', 10)], summary: 'A judged summary long enough.', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80 }
const STUB = { ...GOOD, summary: 'x' }
const judgeCalls = (): number => completeStructured.mock.calls.filter(c => (c[2] as { properties: Record<string, unknown> }).properties.decisions).length

let fake: Fake
let last: Record<string, any> | undefined
const run = async () => { last = (await review(fake.adapter, '7', false, undefined, 'off')) as unknown as Record<string, any> }
const record = (): Record<string, any> => last!

beforeEach(() => {
  vi.clearAllMocks()
  completeStructured.mockReset()
  fake = makeFake()
  fake.hooks.diff = PATHS.map(p => bulk(p, 40)).join('')
  fake.hooks.files = FILES
  fake.hooks.commitDiff = () => DELTA
  cfg.review.inlineReviews = true
  cfg.judge.model = 'claude-haiku-5-5'
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' } as never)
  vi.mocked(fetchContext).mockResolvedValue([])
  vi.mocked(runReview).mockImplementation(async () => ({ text: renderReview(REVIEW), usage: reviewUsage, review: REVIEW }) as never)
})

describe('judge sanity check through review()', () => {
  it('inline run: a stub judge is retried once, both requests are priced once, and judge_sanity is recorded', async () => {
    completeStructured.mockResolvedValueOnce({ object: STUB, usage: judgeUsage }).mockResolvedValueOnce({ object: GOOD, usage: judgeUsage })
    await run()
    expect(judgeCalls()).toBe(2)
    const r = record()
    expect(r.judge_sanity).toEqual({ retried: true, degenerate_after_retry: false, reasons: ['summary stub'] })
    const judgeOnce = estimateCost({ input: 50000, output: 7000 }, 'claude-haiku-5-5')
    expect(r.judge_cost_usd).toBeCloseTo(2 * judgeOnce, 4)
    expect(r.cost_usd).toBeCloseTo(estimateCost({ input: 1000, output: 500 }, 'claude-sonnet-5-5') + 2 * judgeOnce, 4)
    expect(r.judge_tokens).toMatchObject({ input: 100000, output: 14000 })
    expect(r.tokens).toMatchObject({ input: 101000, output: 14500 })
    const rows = r.token_metrics.calls.filter((c: { stage: string }) => c.stage === 'judge')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ input_tokens: 100000, output_tokens: 14000, attempts: 2 })
    expect(r.token_metrics.calls_cost_usd).toBeCloseTo(r.cost_usd, 3)
  })

  it('a clean judge output is not retried and carries no judge_sanity key', async () => {
    completeStructured.mockResolvedValue({ object: GOOD, usage: judgeUsage })
    await run()
    expect(judgeCalls()).toBe(1)
    expect('judge_sanity' in record()).toBe(false)
  })

  it('a content-filter refusal on the first judge call is not retried', async () => {
    completeStructured.mockRejectedValue(new ContentFilterError({ signal: 'native_refusal' }))
    await run()
    expect(judgeCalls()).toBe(1)
    expect(record().content_filter).toHaveLength(1)
  })

  it('a content-filter refusal on the retry keeps the first output and is recorded as a judge refusal', async () => {
    completeStructured.mockResolvedValueOnce({ object: STUB, usage: judgeUsage }).mockRejectedValueOnce(new ContentFilterError({ signal: 'native_refusal' }))
    await run()
    expect(judgeCalls()).toBe(2)
    expect(record().content_filter).toMatchObject([{ stage: 'judge' }])
    expect(record().judge_sanity).toMatchObject({ retried: true, degenerate_after_retry: true })
  })

  it('a legacy_pr hand-back run keeps the legacy flow: the same stub output is not retried', async () => {
    fake.add({ body: '### Summary\nOld review.\n\n*Reviewed by review-bot (claude-sonnet-5-5) | Prompt: repo | Review #1 | Commit: abcdef123456*', authorIds: [ME] })
    fake.raw.getPreviousReviewComments.mockImplementation(async () =>
      fake.comments.filter(c => hasReviewFooter(c.body)).map(c => ({ id: String(c.id), body: c.body, createdOn: '', resolved: false })) as never)
    completeStructured.mockResolvedValue({ object: STUB, usage: judgeUsage })
    await run()
    expect(record().inline).toEqual({ active: false, reason: 'legacy_pr' })
    expect(judgeCalls()).toBe(1)
    expect('judge_sanity' in record()).toBe(false)
  })
})

describe('dev-resolved count in the history line', () => {
  const summaryComment = () => fake.comments.find(c => !c.parentId && !c.inline && c.body.startsWith(SUMMARY_HEADER))!
  const history = (): string[] => summaryComment().body.split('\n').filter(l => l.startsWith('- Review '))

  beforeEach(() => { cfg.judge.model = '' })

  it('omits the part when the previous summary cannot be read', async () => {
    await run()
    fake.comments.filter(c => c.inline && !c.parentId).forEach(c => { c.resolved = true })
    summaryComment().body += '\nedited by hand'
    fake.hooks.head = HEAD_B
    await run()
    expect(history()[history().length - 1]).not.toContain('resolved by developers')
  })

  it('counts only threads newly resolved since the previous summary', async () => {
    await run()
    const roots = fake.comments.filter(c => c.inline && !c.parentId)
    roots[0].resolved = true
    fake.hooks.head = HEAD_B
    await run()
    expect(history()[1]).toContain('1 resolved by developers')
    roots[1].resolved = true
    fake.hooks.head = HEAD_C
    await run()
    expect(history()[2]).toContain('1 resolved by developers')
    expect(history()[2]).not.toContain(' open')
  })
})
