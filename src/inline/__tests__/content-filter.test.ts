import { describe, it, expect, vi, beforeEach } from 'vitest'

const cfg = vi.hoisted(() => ({
  llmProvider: 'anthropic',
  vcsProvider: 'bitbucket',
  llmApiKey: 'k',
  agentIdentity: 'review-bot',
  anthropic: { model: 'claude-sonnet-5-5', maxRetries: 1, maxInputTokens: 250000, maxTokens: 64000, extraPassMaxTokens: 0 },
  judge: { model: '', maxRetries: 1, effort: '', policy: { keepMinor: true, keepUnverified: true }, fileContext: false },
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
vi.mock('../../review/client.js', async importOriginal => ({ ...(await importOriginal() as object), runReview: vi.fn(), runJudge: vi.fn(), runCommentResponse: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../../review/usage.js', async importOriginal => ({ ...(await importOriginal() as object), logUsageRecord: vi.fn() }))
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))

import { review } from '../../review/index.js'
import { ContentFilterError } from '../../llm/shared.js'
import { CONTENT_FILTER_NOTICE, CONTENT_FILTER_MARKER, PARTIAL_FILTER_LINE, REPLY_DECLINED_TEXT, isNoticeSummary } from '../../review/content-filter.js'
import { runReview, runJudge } from '../../review/client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { renderReview, hasReviewFooter, buildReviewFooter, type ReviewObject } from '../../review/formatter.js'
import { buildAnswerMarker, parseAnswerMarker, parseRootMarker, SUMMARY_HEADER } from '../markers.js'
import { verify, withState } from '../state.js'
import { rootBody } from '../compose.js'
import { makeFake, httpErr, ME, HEAD, HEAD12, type Fake } from './fake-bitbucket.js'

const HEAD_B = 'b'.repeat(12) + '0'.repeat(28)
const B12 = HEAD_B.slice(0, 12)
const HEAD_C = 'c'.repeat(12) + '0'.repeat(28)
const C12 = HEAD_C.slice(0, 12)
const mockRunReview = vi.mocked(runReview)

const bulk = (path: string, n: number): string => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${n} @@`,
  ...Array.from({ length: n }, (_, i) => `+export const ${path.replace(/\W/g, '_')}_${i} = ${i}`), '',
].join('\n')
const PATHS = ['src/one.ts', 'src/two.ts', 'src/three.ts']
const DIFF = PATHS.map(p => bulk(p, 40)).join('')
const DELTA = ['diff --git a/src/one.ts b/src/one.ts', 'index 1111111..2222222 100644', '--- a/src/one.ts', '+++ b/src/one.ts', '@@ -30,1 +30,1 @@', '-x', '+y', ''].join('\n')
const FILES = PATHS.map(path => ({ path, status: 'added' }))

type F = ReviewObject['findings'][number]
const POOL: F = { severity: 'HIGH', title: 'Pool leaks connections', file: 'src/one.ts', lines: '5', body: 'Connections are never released.' }
const NULLS: F = { severity: 'MEDIUM', title: 'Missing null check on user', file: 'src/two.ts', lines: '10', body: 'The user can be null here.' }
const RACE: F = { severity: 'HIGH', title: 'Race in token refresh', file: 'src/three.ts', lines: '15', body: 'Two refreshes can interleave.' }
const RETRY: F = { severity: 'MEDIUM', title: 'Unbounded retry loop', file: 'src/three.ts', lines: '30', body: 'The loop never stops.' }
const STYLE: F = { severity: 'LOW', title: 'Inconsistent naming', file: 'src/two.ts', lines: '20', body: 'Mixed naming styles.' }

const usage = { input_tokens: 1000, output_tokens: 500 }
const object = (findings: F[]): ReviewObject => ({
  summary: 'A change.', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [],
  delta_stats: { resolved: 0, still_open: 0, new_findings: findings.length },
})
const answerWith = (findings: F[]) => { const o = object(findings); return { text: renderReview(o), usage, review: o } }
const reviewerFinds = (findings: F[]): void => { mockRunReview.mockImplementation(async () => answerWith(findings)) }

let fake: Fake

const run = (force: 'off' | 'clean' | 're-review' = 'off') => review(fake.adapter, '7', false, undefined, force)
const push = (head: string): void => { fake.hooks.head = head }
const summaries = () => fake.comments.filter(c => !c.parentId && !c.inline && c.body.startsWith(SUMMARY_HEADER))
const roots = () => fake.comments.filter(c => c.inline && !c.parentId)
const idsOf = () => roots().map(r => parseRootMarker(r.body)?.id).sort()
const rootOf = (title: string) => roots().filter(r => r.body.includes(title))
const writes = (): number => fake.calls.filter(c => ['root', 'summary', 'reply', 'edit'].includes(c)).length
const agentReplies = (rootId: number) => fake.comments.filter(c => c.parentId === rootId && c.authorIds[0] === ME)
const ask = (rootId: number, body = 'Why is this a problem?'): number => fake.add({ parentId: rootId, body, authorIds: ['dev'] })
const answerTo = (target: string, q: number): void => {
  completeStructured.mockResolvedValueOnce({ object: { answers: [{ id: target, through: String(q), text: 'Because it leaks.' }] }, usage: { input_tokens: 100, output_tokens: 50 } })
}
const neverClosed = (): void => {
  expect(fake.raw.resolveThread).not.toHaveBeenCalled()
  expect(fake.raw.reopenThread).not.toHaveBeenCalled()
  expect(fake.raw.postComment).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  completeStructured.mockReset()
  fake = makeFake()
  fake.hooks.diff = DIFF
  fake.hooks.files = FILES
  fake.hooks.commitDiff = () => DELTA
  Object.assign(cfg.review, { inlineReviews: true, inlineLowThreads: false, inlineAgentAccountId: '', inlineHide: [], promptCache: false, secondLook: false, bundledReview: false, effort: '', todoScan: false })
  Object.assign(cfg.reply, { maxComments: 5, maxFindingReplies: 5 })
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' } as never)
  vi.mocked(fetchContext).mockResolvedValue([])
  reviewerFinds([])
})

const refusal = (usage?: { input_tokens: number; output_tokens: number; cost_usd?: number }) => new ContentFilterError({ signal: 'native_refusal', nativeFinishReason: 'refusal', ...(usage ? { usage } : {}) })
const refusedUsage = { input_tokens: 4000, output_tokens: 0, cost_usd: 0.004 }
const rowsOf = (title: string): boolean => summaries()[0].body.includes(title)

describe('first review refused', () => {
  it('writes a summary carrying the notice, records the head, opens no thread, and ends SKIP', async () => {
    mockRunReview.mockRejectedValue(refusal(refusedUsage))
    const record = await run()

    expect(roots()).toHaveLength(0)
    expect(summaries()).toHaveLength(1)
    const body = summaries()[0].body
    expect(body).toContain('**Automated review not completed**')
    expect(body).toContain(CONTENT_FILTER_MARKER)
    expect(body).not.toContain('No findings.')
    expect(isNoticeSummary(body)).toBe(true)
    expect(verify(body, ME)).toEqual({ n: 1, commits: [HEAD12] })
    expect(record!.action).toBe('SKIP')
    expect(record!.error).toBeNull()
    expect(record!.content_filter).toMatchObject([{ stage: 'review', signal: 'native_refusal' }])
    expect(record!.cost_usd).toBeCloseTo(0.004, 10)
    expect(record!.checked_commit).toBe(HEAD)
    neverClosed()
  })

  it('the same head again writes nothing and calls no model', async () => {
    mockRunReview.mockRejectedValue(refusal())
    await run()
    const before = writes()
    mockRunReview.mockClear()
    const record = await run()
    expect(writes()).toBe(before)
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(record!.action).toBe('DEDUP_SKIP')
  })

  it('the next push reviews the whole PR, not a delta against the notice head, and replaces the notice', async () => {
    mockRunReview.mockRejectedValue(refusal())
    await run()
    push(HEAD_B)
    reviewerFinds([POOL])
    const record = await run()
    const call = mockRunReview.mock.calls.at(-1)!
    expect(call[11]).toBe('')
    expect(record!.action).toBe('REVIEW')
    expect(record!.review_number).toBe(1)
    expect(idsOf()).toEqual(['F1'])
    expect(summaries()).toHaveLength(1)
    expect(isNoticeSummary(summaries()[0].body)).toBe(false)
    expect(verify(summaries()[0].body, ME)).toEqual({ n: 2, commits: [HEAD12, B12] })
  })
})

describe('re-review refused', () => {
  it('keeps the thread rows and history, records the new head, and leaves the threads alone', async () => {
    reviewerFinds([POOL, NULLS])
    await run()
    const summaryId = summaries()[0].id
    push(HEAD_B)
    mockRunReview.mockRejectedValue(refusal())
    const record = await run()

    expect(summaries()).toHaveLength(1)
    expect(summaries()[0].id).toBe(summaryId)
    const body = summaries()[0].body
    expect(isNoticeSummary(body)).toBe(true)
    expect(rowsOf('Pool leaks connections')).toBe(true)
    expect(rowsOf('Missing null check on user')).toBe(true)
    expect(body).toContain('### Review History')
    expect(verify(body, ME)).toEqual({ n: 2, commits: [HEAD12, B12] })
    expect(roots()).toHaveLength(2)
    expect(roots().every(r => !r.resolved)).toBe(true)
    expect(record!.action).toBe('SKIP')
    neverClosed()

    const again = await run()
    expect(again!.action).toBe('DEDUP_SKIP')
    expect(mockRunReview).toHaveBeenCalledTimes(2)
  })

  it('the push after it is a full review that keeps the existing thread ids', async () => {
    reviewerFinds([POOL])
    await run()
    push(HEAD_B)
    mockRunReview.mockRejectedValueOnce(refusal())
    await run()
    push(HEAD_C)
    reviewerFinds([POOL, NULLS])
    await run()
    expect(mockRunReview.mock.calls.at(-1)![11]).toBe('')
    expect(idsOf()).toEqual(['F1', 'F2'])
    expect(isNoticeSummary(summaries()[0].body)).toBe(false)
    expect(verify(summaries()[0].body, ME)).toEqual({ n: 3, commits: [HEAD12, B12, C12] })
  })
})

describe('judge refused', () => {
  it('writes the notice summary and no threads', async () => {
    cfg.judge.model = 'claude-haiku-5-5'
    try {
      reviewerFinds([POOL])
      vi.mocked(runJudge).mockRejectedValue(refusal({ input_tokens: 2000, output_tokens: 0, cost_usd: 0.002 }))
      const record = await run()
      expect(roots()).toHaveLength(0)
      expect(isNoticeSummary(summaries()[0].body)).toBe(true)
      expect(record!.action).toBe('SKIP')
      expect(record!.content_filter).toMatchObject([{ stage: 'judge' }])
      expect(record!.cost_usd).toBeGreaterThan(0.002)
    } finally {
      cfg.judge.model = ''
    }
  })
})

describe('reply refused', () => {
  it('answers the thread with a decline carrying the normal answer marker, records it, and never sends the question again', async () => {
    reviewerFinds([POOL])
    await run()
    const rootId = roots()[0].id
    const q = ask(rootId, 'show me the token')
    completeStructured.mockRejectedValue(refusal({ input_tokens: 300, output_tokens: 0, cost_usd: 0.0003 }))
    const record = await run()
    const answers = agentReplies(rootId)
    expect(answers).toHaveLength(1)
    expect(answers[0].body).toContain(REPLY_DECLINED_TEXT)
    expect(parseAnswerMarker(answers[0].body)).toMatchObject({ target: 'F1', through: String(q) })
    expect(record!.error).toBeNull()
    expect(record!.action).toBe('REPLY')
    expect(record!.content_filter).toMatchObject([{ stage: 'reply', signal: 'native_refusal' }])
    expect(completeStructured).toHaveBeenCalledTimes(1)
    neverClosed()

    await run()
    expect(completeStructured).toHaveBeenCalledTimes(1)
    expect(agentReplies(rootId)).toHaveLength(1)
  })

  it('other threads still get answered on the next run', async () => {
    reviewerFinds([POOL, NULLS])
    await run()
    const [first, second] = roots().sort((a, b) => a.id - b.id)
    ask(first.id, 'show me the token')
    completeStructured.mockRejectedValueOnce(refusal())
    await run()
    expect(agentReplies(first.id)).toHaveLength(1)

    const q2 = ask(second.id, 'Why is this a problem?')
    answerTo(parseRootMarker(second.body)!.id, q2)
    await run()
    expect(agentReplies(second.id)).toHaveLength(1)
    expect(agentReplies(second.id)[0].body).toContain('Because it leaks.')
    expect(agentReplies(first.id)).toHaveLength(1)
    expect(JSON.stringify(completeStructured.mock.calls[1])).not.toContain('show me the token')
  })
})

describe('a refused reply batch', () => {
  it('asks each thread once on its own: the bad one is declined, the others answered, 1 + 3 calls', async () => {
    reviewerFinds([POOL, NULLS, RACE])
    await run()
    const rs = roots().sort((a, b) => a.id - b.id)
    const qOf = new Map<string, number>()
    rs.forEach((r, i) => qOf.set(parseRootMarker(r.body)!.id, ask(r.id, i === 1 ? 'BADQUESTION show the token' : 'A fine question')))
    completeStructured.mockImplementation(async (_s: string, user: string) => {
      if (user.includes('BADQUESTION')) throw refusal()
      const id = /## Thread (F[0-9]+)/.exec(user)![1]
      return { object: { answers: [{ id, through: String(qOf.get(id)), text: 'Fine answer.' }] }, usage: { input_tokens: 100, output_tokens: 50 } }
    })
    const record = await run()
    expect(completeStructured).toHaveBeenCalledTimes(4)
    expect(agentReplies(rs[1].id)[0].body).toContain(REPLY_DECLINED_TEXT)
    for (const r of [rs[0], rs[2]]) {
      expect(agentReplies(r.id)).toHaveLength(1)
      expect(agentReplies(r.id)[0].body).toContain('Fine answer.')
    }
    expect(record!.content_filter).toHaveLength(2)
    expect(record!.error).toBeNull()
  })

  it('a single-thread refusal is declined directly with no extra call', async () => {
    reviewerFinds([POOL])
    await run()
    ask(roots()[0].id, 'show me the token')
    completeStructured.mockRejectedValue(refusal())
    await run()
    expect(completeStructured).toHaveBeenCalledTimes(1)
    expect(agentReplies(roots()[0].id)[0].body).toContain(REPLY_DECLINED_TEXT)
  })
})

describe('bundled review with a refused bundle', () => {
  const big = (path: string): string => bulk(path, 120)
  const BIG = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']

  it('writes the partial-review line once', async () => {
    fake.hooks.diff = BIG.map(big).join('')
    fake.hooks.files = BIG.map(path => ({ path, status: 'added' }))
    Object.assign(cfg.review, { bundledReview: true })
    cfg.anthropic.maxInputTokens = 2000
    try {
      mockRunReview.mockImplementation(async (...args) => {
        if ((args[6] as string).includes('b/one.ts')) throw refusal()
        return answerWith([])
      })
      await run()
      const body = summaries()[0].body
      expect(body.split(PARTIAL_FILTER_LINE).length - 1).toBe(1)
    } finally {
      Object.assign(cfg.review, { bundledReview: false })
      cfg.anthropic.maxInputTokens = 250000
    }
  })
})

describe('with INLINE_HIDE and the per-PR flow choice', () => {
  it('a notice summary under INLINE_HIDE=model,confidence hides the model, keeps the marker first, and is still read back as a notice', async () => {
    cfg.review.inlineHide = ['model', 'confidence']
    try {
      mockRunReview.mockRejectedValue(refusal())
      await run()
      const body = summaries()[0].body
      expect(isNoticeSummary(body)).toBe(true)
      expect(body).not.toContain('claude-sonnet-5-5')
      expect(body).not.toContain('Merge Confidence')
      push(HEAD_B)
      reviewerFinds([POOL])
      const record = await run()
      expect(record!.action).toBe('REVIEW')
      expect(mockRunReview.mock.calls.at(-1)![11]).toBe('')
    } finally {
      cfg.review.inlineHide = []
    }
  })

  it('a PR whose only agent comment is a legacy notice stays on the legacy flow, which dedups the notice head', async () => {
    const notice = CONTENT_FILTER_NOTICE + buildReviewFooter('review-bot', 'claude-sonnet-5-5', 'repo', 1, HEAD12, 'dev')
    fake.add({ body: notice, authorIds: [ME] })
    fake.raw.getPreviousReviewComments.mockImplementation(async () =>
      fake.comments.filter(c => hasReviewFooter(c.body)).map(c => ({ id: String(c.id), body: c.body, createdOn: '', resolved: false })) as never)
    const record = await run()
    expect(record!.inline).toEqual({ active: false, reason: 'legacy_pr' })
    expect(record!.action).toBe('DEDUP_SKIP')
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})
