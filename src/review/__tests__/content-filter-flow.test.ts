import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VCSAdapter } from '../../vcs/adapter.js'

vi.mock('../../config.js', () => ({
  config: {
    vcsProvider: 'bitbucket', llmApiKey: 'k',
    anthropic: { model: 'claude-haiku-5-5', maxRetries: 1, maxInputTokens: 150_000, maxTokens: 32_000, modelContextTokens: 0 },
    judge: { model: 'claude-haiku-5-5', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3, benchmarkDeadlineSeconds: 840 },
    lenses: { enabled: false, list: 'rel', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3, model: '' },
    review: { maxFindings: 0, splitCheck: false, todoScan: false, effort: '', enableNitpicks: false, secondLook: false, lineNumbers: false, bundledReview: false, maxBundles: 8 },
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
import { config } from '../../config.js'
import { runReview, runJudge, runCommentResponse, runLens } from '../client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { logUsageRecord, type UsageRecord } from '../usage.js'
import { renderReview, buildReviewFooter, hasReviewFooter, hasReplyFooter, extractCommitHash, type ReviewObject } from '../formatter.js'
import { ContentFilterError } from '../../llm/shared.js'
import { CONTENT_FILTER_NOTICE, CONTENT_FILTER_MARKER, PARTIAL_FILTER_LINE, REPLY_DECLINED_TEXT, isContentFilterNotice } from '../content-filter.js'

const cfg = config as unknown as { review: Record<string, unknown>; lenses: Record<string, unknown>; anthropic: Record<string, unknown> }
const HEAD = 'b'.repeat(40)
const HEAD12 = HEAD.slice(0, 12)
const OLD12 = 'a'.repeat(12)
const DIFF = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n+foo()\n+bar()\n'
const section = (path: string, lines: number): string => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+const line${i} = ${i}`).join('\n')}\n`
const BIG_DIFF = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts'].map(p => section(p, 120)).join('')

const REVIEW: ReviewObject = {
  summary: 'risky', behavioral_diff: [], production_risk: [], unresolved_questions: [],
  findings: [{ severity: 'MEDIUM', title: 'Footer regex drifts', file: 'src/app.ts', lines: '1', body: 'The parser no longer matches.' }],
}
const refusalUsage = { input_tokens: 4_000, output_tokens: 0, cost_usd: 0.004 }
const refusal = (extra: Partial<ConstructorParameters<typeof ContentFilterError>[0]> = {}) => new ContentFilterError({ signal: 'native_refusal', nativeFinishReason: 'refusal', usage: refusalUsage, ...extra })
const reviewerAnswer = (o: ReviewObject = REVIEW) => ({ text: renderReview(o), usage: { input_tokens: 1_000, output_tokens: 500, cost_usd: 0.003 }, review: o })
const judged = (text: string) => ({ text: `${text}\n\n### Merge Confidence: 80%\n\n*"x"*`, usage: { input_tokens: 500, output_tokens: 50, cost_usd: 0.001 }, scores: [{ title: 't', severity: 'MEDIUM' as const, score: 8 }] })

let posted: Array<{ id: string; body: string; createdOn: string }>
function adapter(diff = DIFF, files = ['src/app.ts']): VCSAdapter {
  return {
    getPullRequestInfo: vi.fn().mockResolvedValue({ id: '9', title: 'T', description: '', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: HEAD }),
    getDiff: vi.fn().mockResolvedValue(diff),
    getChangedFiles: vi.fn().mockResolvedValue(files.map(path => ({ path, status: 'modified' }))),
    getFileContent: vi.fn().mockResolvedValue(''),
    getRepoFileContent: vi.fn().mockResolvedValue(null),
    postComment: vi.fn(async (_id: string, body: string) => { posted.push({ id: String(posted.length + 1), body, createdOn: `2026-01-0${posted.length + 1}T00:00:00Z` }) }),
    getPreviousReviewComments: vi.fn(async () => posted.map(p => ({ ...p, resolved: false }))),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
    postReply: vi.fn(),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),
  } as unknown as VCSAdapter
}

const lastRecord = (): UsageRecord => vi.mocked(logUsageRecord).mock.calls.at(-1)![0]
const footerFor = (head12: string, n = 1): string => buildReviewFooter('test-bot', 'claude-haiku-5-5', 'repo', n, head12, 'dev')
const noticeFor = (head12: string): { id: string; body: string; createdOn: string } => ({ id: '1', body: CONTENT_FILTER_NOTICE + footerFor(head12), createdOn: '2026-01-01T00:00:00Z' })

beforeEach(() => {
  vi.clearAllMocks()
  posted = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Object.assign(cfg.review, { bundledReview: false })
  Object.assign(cfg.lenses, { enabled: false })
  Object.assign(cfg.anthropic, { maxInputTokens: 150_000 })
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
  vi.mocked(runReview).mockResolvedValue(reviewerAnswer())
  vi.mocked(runJudge).mockImplementation(async (_k, _m, _r, _t, _e, _d, rev) => judged(renderReview(rev as ReviewObject)))
})
afterEach(() => { vi.restoreAllMocks() })

describe('reviewer refused (legacy)', () => {
  it('posts the approved notice once with the review footer, ends SKIP without throwing, and keeps the refused request\'s cost', async () => {
    vi.mocked(runReview).mockRejectedValue(refusal())
    const a = adapter()
    const record = await review(a, '9', false, undefined, 'off', true)

    expect(a.postComment).toHaveBeenCalledTimes(1)
    const body = posted[0].body
    expect(body.startsWith('**Automated review not completed**\n\nThe review model\'s safety filters declined to process this pull request, so no review was produced.')).toBe(true)
    expect(body).toContain('The next push will be reviewed again.')
    expect(hasReviewFooter(body)).toBe(true)
    expect(extractCommitHash(body)).toBe(HEAD12)
    expect(isContentFilterNotice(body)).toBe(true)
    expect(runJudge).not.toHaveBeenCalled()

    expect(record!.action).toBe('SKIP')
    expect(record!.error).toBeNull()
    expect(record!.content_filter).toEqual([{ stage: 'review', signal: 'native_refusal', native_finish_reason: 'refusal' }])
    expect(record!.tokens.input).toBe(4_000)
    expect(record!.cost_usd).toBeCloseTo(0.004, 10)
    expect(record!.checked_commit).toBe(HEAD)
    expect(lastRecord().content_filter).toHaveLength(1)
  })

  it('does not post on a dry run, but still ends SKIP', async () => {
    vi.mocked(runReview).mockRejectedValue(refusal())
    const a = adapter()
    const record = await review(a, '9', true, undefined, 'off', true)
    expect(a.postComment).not.toHaveBeenCalled()
    expect(record!.action).toBe('SKIP')
  })

  it('a moderation refusal (no usage) is handled the same way, with its reasons and status recorded', async () => {
    vi.mocked(runReview).mockRejectedValue(new ContentFilterError({ signal: 'moderation', httpStatus: 403, reasons: ['harassment'] }))
    const record = await review(adapter(), '9', false, undefined, 'off', true)
    expect(record!.action).toBe('SKIP')
    expect(record!.content_filter).toEqual([{ stage: 'review', signal: 'moderation', reasons: ['harassment'], http_status: 403 }])
    expect(record!.cost_usd).toBe(0)
  })

  it('the same head again posts no second notice and makes no model call', async () => {
    vi.mocked(runReview).mockRejectedValue(refusal())
    await review(adapter(), '9', false, undefined, 'off', true)
    vi.mocked(runReview).mockClear()
    const a = adapter()
    const record = await review(a, '9', false, undefined, 'off', true)
    expect(a.postComment).not.toHaveBeenCalled()
    expect(runReview).not.toHaveBeenCalled()
    expect(posted).toHaveLength(1)
    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.checked_commit).toBe(HEAD)
  })

  it('a comment-triggered run on the same head dedups too', async () => {
    posted = [noticeFor(HEAD12)]
    const a = adapter()
    const record = await review(a, '9', false, undefined, 'off', true, '', undefined, { event: 'pullrequest:comment_created', commentAuthor: 'dev' })
    expect(a.postComment).not.toHaveBeenCalled()
    expect(runReview).not.toHaveBeenCalled()
    expect(record!.action).toBe('DEDUP_SKIP')
  })

  it('the next push gets a full first review: the notice is neither the previous review nor a delta base', async () => {
    posted = [noticeFor(OLD12)]
    const a = adapter()
    const record = await review(a, '9', false, undefined, 'off', true)
    const call = vi.mocked(runReview).mock.calls[0]
    expect(call[9]).toEqual([])
    expect(call[11]).toBe('')
    expect(a.getCommitDiff).not.toHaveBeenCalled()
    expect(record!.action).toBe('REVIEW')
    expect(record!.review_number).toBe(1)
    expect(posted).toHaveLength(2)
    expect(isContentFilterNotice(posted[1].body)).toBe(false)
    expect(extractCommitHash(posted[1].body)).toBe(HEAD12)
  })

  it('a real review followed by a notice: the next push is a delta against the real review', async () => {
    const real = { id: '1', body: `### Summary\nok\n${footerFor(OLD12)}`, createdOn: '2026-01-01T00:00:00Z' }
    posted = [real, { ...noticeFor('c'.repeat(12)), id: '2', createdOn: '2026-01-02T00:00:00Z' }]
    const a = adapter()
    await review(a, '9', false, undefined, 'off', true)
    expect(a.getCommitDiff).toHaveBeenCalledWith(OLD12, HEAD)
    const call = vi.mocked(runReview).mock.calls[0]
    expect((call[9] as Array<{ id: string }>).map(r => r.id)).toEqual(['1'])
  })

  it('a notice is not the review a pending reply is answered from', async () => {
    const real = { id: '1', body: `### Summary\nreal review\n${footerFor(HEAD12)}`, createdOn: '2026-01-01T00:00:00Z' }
    posted = [real, { ...noticeFor(HEAD12), id: '2', createdOn: '2026-01-02T00:00:00Z' }]
    const a = adapter()
    vi.mocked(a.getRepliesToReviewComments).mockResolvedValue({ replies: [{ id: '7', parentId: '1', author: 'dev', body: 'why?', createdOn: '2026-01-03T00:00:00Z' }], agentReplyCount: 0 } as never)
    vi.mocked(runCommentResponse).mockResolvedValue({ text: 'because', usage: { input_tokens: 10, output_tokens: 5 } })
    await review(a, '9', false, undefined, 'off', true)
    expect(vi.mocked(runCommentResponse).mock.calls[0][4]).toContain('real review')
    expect(vi.mocked(a.getRepliesToReviewComments).mock.calls.every(c => (c[1] as string[]).join() === '1')).toBe(true)
  })
})

describe('judge refused (legacy)', () => {
  it('posts the notice, ends SKIP, and keeps both calls\' cost', async () => {
    vi.mocked(runJudge).mockRejectedValue(refusal({ usage: { input_tokens: 2_000, output_tokens: 0, cost_usd: 0.002 } }))
    const a = adapter()
    const record = await review(a, '9', false, undefined, 'off', true)
    expect(posted).toHaveLength(1)
    expect(isContentFilterNotice(posted[0].body)).toBe(true)
    expect(record!.action).toBe('SKIP')
    expect(record!.error).toBeNull()
    expect(record!.content_filter).toMatchObject([{ stage: 'judge', signal: 'native_refusal' }])
    expect(record!.cost_usd).toBeCloseTo(0.003 + 0.002, 10)
    expect(record!.tokens.input).toBe(3_000)
  })

  it('a clean reviewer whose judge ran only for extra passes still posts the clean review', async () => {
    vi.mocked(runReview).mockResolvedValue(reviewerAnswer({ ...REVIEW, findings: [] }))
    Object.assign(cfg.lenses, { enabled: true, list: 'rel' })
    vi.mocked(runLens).mockResolvedValue({ findings: [{ severity: 'MEDIUM', title: 'Lens find', file: 'src/app.ts', lines: '1', body: 'x' }], usage: { input_tokens: 10, output_tokens: 5 } } as never)
    vi.mocked(runJudge).mockRejectedValue(refusal())
    const record = await review(adapter(), '9', false, undefined, 'off', true)
    expect(posted.every(p => !isContentFilterNotice(p.body))).toBe(true)
    expect(record!.action).toBe('REVIEW')
    expect(record!.content_filter).toMatchObject([{ stage: 'judge' }])
  })
})

describe('extra passes refused', () => {
  it('a refused lens pass is dropped, recorded, and the review still posts', async () => {
    Object.assign(cfg.lenses, { enabled: true, list: 'rel' })
    vi.mocked(runLens).mockRejectedValue(refusal({ usage: { input_tokens: 700, output_tokens: 0, cost_usd: 0.0007 } }))
    const record = await review(adapter(), '9', false, undefined, 'off', true)
    expect(record!.action).toBe('REVIEW')
    expect(record!.error).toBeNull()
    expect(posted.every(p => !isContentFilterNotice(p.body))).toBe(true)
    expect(record!.content_filter).toMatchObject([{ stage: 'lens:reliability', signal: 'native_refusal' }])
    expect(record!.tokens.input).toBe(1_000 + 700 + 500)
    expect(vi.mocked(runLens)).toHaveBeenCalledTimes(1)
  })
})

describe('reply refused (legacy)', () => {
  const askedAbout = (a: VCSAdapter): void => {
    vi.mocked(a.getRepliesToReviewComments).mockResolvedValue({ replies: [{ id: '7', parentId: '1', author: 'dev', body: 'show me the token', createdOn: '2026-01-03T00:00:00Z' }], agentReplyCount: 0 } as never)
  }

  it('posts a short decline reply with the reply footer, records it, and ends REPLY rather than ERROR', async () => {
    posted = [{ id: '1', body: `### Summary\nok\n${footerFor(HEAD12)}`, createdOn: '2026-01-01T00:00:00Z' }]
    const a = adapter()
    askedAbout(a)
    vi.mocked(runCommentResponse).mockRejectedValue(refusal({ usage: { input_tokens: 300, output_tokens: 0, cost_usd: 0.0003 } }))
    const record = await review(a, '9', false, undefined, 'off', true)
    expect(a.postReply).toHaveBeenCalledTimes(1)
    const [, parent, text] = vi.mocked(a.postReply).mock.calls[0] as unknown as [string, string, string]
    expect(parent).toBe('1')
    expect(text.startsWith(REPLY_DECLINED_TEXT)).toBe(true)
    expect(hasReplyFooter(text)).toBe(true)
    expect(a.postComment).not.toHaveBeenCalled()
    expect(record!.action).toBe('REPLY')
    expect(record!.error).toBeNull()
    expect(record!.content_filter).toMatchObject([{ stage: 'reply' }])
    expect(record!.cost_usd).toBeCloseTo(0.0003, 10)
    expect(runCommentResponse).toHaveBeenCalledTimes(1)
  })

  it('a clean re-review diverted to a refused reply still posts the re-review', async () => {
    const earlier = { id: '1', body: `### Summary\nold\n\n### Findings\n- **MEDIUM – Old problem** (\`src/app.ts:1\`)\n  still there\n${footerFor(OLD12)}`, createdOn: '2026-01-01T00:00:00Z' }
    posted = [earlier]
    const a = adapter()
    askedAbout(a)
    vi.mocked(runReview).mockResolvedValue(reviewerAnswer({ ...REVIEW, findings: [], delta_stats: { resolved: 0, still_open: 1, new_findings: 0 } }))
    vi.mocked(runCommentResponse).mockRejectedValue(refusal())
    const record = await review(a, '9', false, undefined, 'off', true)
    expect(a.postReply).toHaveBeenCalledTimes(1)
    expect(a.postComment).toHaveBeenCalledTimes(1)
    expect(record!.action).toBe('RE_REVIEW')
    expect(record!.content_filter).toMatchObject([{ stage: 'reply' }])
    expect(runCommentResponse).toHaveBeenCalledTimes(1)
  })

  it('a decline that cannot be posted ends SKIP and the run still succeeds', async () => {
    posted = [{ id: '1', body: `### Summary\nok\n${footerFor(HEAD12)}`, createdOn: '2026-01-01T00:00:00Z' }]
    const a = adapter()
    askedAbout(a)
    vi.mocked(a.postReply).mockRejectedValue(new Error('403'))
    vi.mocked(runCommentResponse).mockRejectedValue(refusal())
    const record = await review(a, '9', false, undefined, 'off', true)
    expect(record!.action).toBe('SKIP')
    expect(record!.error).toBeNull()
  })
})

describe('bundled review', () => {
  beforeEach(() => {
    Object.assign(cfg.review, { bundledReview: true })
    Object.assign(cfg.anthropic, { maxInputTokens: 2_000 })
  })
  const files = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']
  const obj = (file: string): ReviewObject => ({ summary: `s ${file}`, findings: [{ severity: 'MEDIUM', title: `Problem in ${file}`, file, lines: '5', body: 'bad' }], behavioral_diff: [], production_risk: [], unresolved_questions: [] })
  const reviewerFor = (refuseWhen: (diff: string) => boolean) => vi.mocked(runReview).mockImplementation(async (...args) => {
    const diff = args[6] as string
    if (refuseWhen(diff)) throw refusal({ usage: { input_tokens: 400, output_tokens: 0, cost_usd: 0.0004 } })
    const o = obj(diff.includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
    return { text: renderReview(o), usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.0001 }, review: o }
  })

  it('a refused bundle is skipped, the others go on, and the posted review carries the one-line note at the end of Findings', async () => {
    reviewerFor(d => d.includes('b/one.ts'))
    const record = await review(adapter(BIG_DIFF, files), '9', false, undefined, 'off', true)
    expect(vi.mocked(runReview).mock.calls.length).toBeGreaterThan(1)
    expect(record!.action).toBe('REVIEW')
    const body = posted[0].body
    expect(isContentFilterNotice(body)).toBe(false)
    expect(body).toContain('Problem in a/one.ts')
    expect(body).toContain(PARTIAL_FILTER_LINE)
    expect(body.indexOf(PARTIAL_FILTER_LINE)).toBeGreaterThan(body.indexOf('Problem in a/one.ts'))
    expect(body.indexOf(PARTIAL_FILTER_LINE)).toBeLessThan(body.indexOf('### Behavioral Diff'))
    expect(record!.content_filter!.every(f => f.stage === 'review' && typeof f.bundle === 'number')).toBe(true)
    expect(record!.cost_usd).toBeGreaterThan(0.0004)
  })

  it('a refused bundle judge drops that bundle too', async () => {
    vi.mocked(runReview).mockImplementation(async (...args) => {
      const o = obj((args[6] as string).includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts')
      return { text: renderReview(o), usage: { input_tokens: 100, output_tokens: 10 }, review: o }
    })
    vi.mocked(runJudge).mockImplementation(async (_k, _m, _r, _t, _e, _d, rev) => {
      if ((rev as ReviewObject).findings[0].file === 'b/one.ts') throw refusal()
      return judged(renderReview(rev as ReviewObject))
    })
    const record = await review(adapter(BIG_DIFF, files), '9', false, undefined, 'off', true)
    expect(record!.action).toBe('REVIEW')
    expect(posted[0].body).toContain(PARTIAL_FILTER_LINE)
    expect(posted[0].body).not.toContain('Problem in b/one.ts')
    expect(record!.content_filter).toMatchObject([{ stage: 'judge' }])
  })

  it('every bundle refused posts the notice and ends SKIP', async () => {
    reviewerFor(() => true)
    const record = await review(adapter(BIG_DIFF, files), '9', false, undefined, 'off', true)
    expect(posted).toHaveLength(1)
    expect(isContentFilterNotice(posted[0].body)).toBe(true)
    expect(posted[0].body).not.toContain(PARTIAL_FILTER_LINE)
    expect(record!.action).toBe('SKIP')
    expect(record!.error).toBeNull()
    expect(record!.content_filter!.length).toBe(vi.mocked(runReview).mock.calls.length)
  })

  it('a refused bundle is never re-sent', async () => {
    reviewerFor(() => true)
    await review(adapter(BIG_DIFF, files), '9', false, undefined, 'off', true)
    const diffs = vi.mocked(runReview).mock.calls.map(c => c[6])
    expect(new Set(diffs).size).toBe(diffs.length)
  })
})

describe('notice text', () => {
  it('is the owner-approved wording plus the fixed marker line', () => {
    expect(CONTENT_FILTER_NOTICE).toBe(`**Automated review not completed**

The review model's safety filters declined to process this pull request, so no review was produced. This usually happens when a change includes code that resembles security-sensitive behaviour, for example collecting credentials from browser storage or replaying authentication headers.

Please take a look at those areas and consider a different approach, such as authenticating through the API layer or test fixtures. The next push will be reviewed again.

${CONTENT_FILTER_MARKER}`)
  })
})

describe('bundled re-review with a refused bundle', () => {
  beforeEach(() => {
    Object.assign(cfg.review, { bundledReview: true })
    Object.assign(cfg.anthropic, { maxInputTokens: 2_000 })
  })

  it('does not let the quiet gate swallow the partial note, and does not mark the head fully checked', async () => {
    posted = [{ id: '1', body: `### Summary\nok\n\n### Findings\nNo findings.\n${footerFor(OLD12)}`, createdOn: '2026-01-01T00:00:00Z' }]
    const a = adapter(BIG_DIFF, ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts'])
    vi.mocked(a.getCommitDiff).mockResolvedValue(BIG_DIFF)
    vi.mocked(runReview).mockImplementation(async (...args) => {
      if ((args[6] as string).includes('b/one.ts')) throw refusal()
      const o: ReviewObject = { summary: 's', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [], delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } }
      return { text: renderReview(o), usage: { input_tokens: 100, output_tokens: 10 }, review: o }
    })
    const record = await review(a, '9', false, undefined, 'off', true)
    expect(record!.action).toBe('RE_REVIEW')
    expect(posted).toHaveLength(2)
    expect(posted[1].body).toContain(PARTIAL_FILTER_LINE)
    expect(record!.checked_commit).toBeUndefined()
  })
})

describe('pre-post race check', () => {
  it('a concurrent notice for the same head does not make a real review look already posted', async () => {
    const a = adapter()
    let first = true
    vi.mocked(a.getPreviousReviewComments).mockImplementation(async () => {
      if (first) { first = false; return [] }
      return [noticeFor(HEAD12)] as never
    })
    const record = await review(a, '9', false, undefined, 'off', true)
    expect(a.postComment).toHaveBeenCalledTimes(1)
    expect(record!.action).toBe('REVIEW')
  })
})

describe('notice detection', () => {
  it('ignores a review that merely prints the marker line', () => {
    const echoed = `### Summary\nok\n\n${CONTENT_FILTER_MARKER}\n${footerFor(HEAD12)}`
    expect(isContentFilterNotice(echoed)).toBe(false)
    expect(isContentFilterNotice(`**Automated review not completed**\n\nx\n\n${CONTENT_FILTER_MARKER}\n\nmore${footerFor(HEAD12)}`)).toBe(false)
    expect(isContentFilterNotice(CONTENT_FILTER_NOTICE + footerFor(HEAD12))).toBe(true)
  })
})
