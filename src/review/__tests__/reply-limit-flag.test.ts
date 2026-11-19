import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VCSAdapter, PRInfo, CommentReply } from '../../vcs/adapter.js'

vi.mock('../../config.js', () => ({
  config: {
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', maxRetries: 1, maxInputTokens: 150000, maxTokens: 32000 },
    judge: { model: '', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3, benchmarkDeadlineSeconds: 840 },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3, limitPerReview: false },
    review: { maxFindings: 0, splitCheck: false, todoScan: true, effort: '', enableNitpicks: false, secondLook: false },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: ['main', 'master'],
    skipTargetBranches: ['main', 'master'],
    onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: ['*.lock'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
  modelContextWindow: vi.fn(() => 200_000),
}))

vi.mock('../client.js', () => ({
  runReview: vi.fn(), runCommentResponse: vi.fn(), runJudge: vi.fn(), runBreadth: vi.fn(), runLens: vi.fn(),
}))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../usage.js', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, logUsageRecord: vi.fn() }
})

import { review } from '../index.js'
import { config } from '../../config.js'
import { runReview, runCommentResponse } from '../client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { renderReview, buildReplyFooter, hasReplyFooter, type ReviewObject } from '../formatter.js'

const cfg = config as any
const COMMIT_A = 'aaa111222333'
const PRIOR_COMMIT = 'aabbcc112233'
const LIMIT = 3
const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,5 @@
+import { foo } from './foo'
+foo()
`
const CLEAN_PRIOR = '### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.'
const footer = (n: number, commit: string) => `\n\n---\n*Reviewed by test-bot (claude-haiku-4-5-20251001) | Prompt: repo | Review #${n} | Commit: ${commit}*`
const reviewWith = (findings: ReviewObject['findings'] = [], extra: Partial<ReviewObject> = {}): ReviewObject =>
  ({ summary: 'ok', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [], ...extra })
const NOTE_TEXT = 'Reply limit of 3 reached for this review. New questions will be answered under the next review.'

const agentAt = (id: string, createdOn: string, body = 'Confirmed.'): CommentReply =>
  ({ id, parentId: '200', author: 'Agent (prior reply)', body: body + buildReplyFooter('test-bot', 'claude-haiku-4-5-20251001'), createdOn })
const devAt = (id: string, createdOn: string, parentId = '200'): CommentReply =>
  ({ id, parentId, author: 'Fernando', body: 'Why?', createdOn })

interface Custom { reviews: Array<{ id: string; createdOn: string; commit: string }>; all: CommentReply[]; unanswered: CommentReply[] }

function customAdapter(c: Custom): VCSAdapter {
  const info: PRInfo = { id: '100', title: 'T', description: 'd', author: 'dev', sourceBranch: 'feature/t', targetBranch: 'develop', sourceCommit: COMMIT_A }
  const pastCount = c.all.filter(r => r.author.startsWith('Agent')).length
  return {
    getPullRequestInfo: vi.fn().mockResolvedValue(info),
    getDiff: vi.fn().mockResolvedValue(DIFF),
    getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/app.ts', status: 'modified' }]),
    getFileContent: vi.fn().mockResolvedValue(''),
    getRepoFileContent: vi.fn().mockResolvedValue(null),
    postComment: vi.fn().mockResolvedValue(undefined),
    getPreviousReviewComments: vi.fn().mockResolvedValue(c.reviews.map(r => ({ id: r.id, body: CLEAN_PRIOR + footer(1, r.commit), createdOn: r.createdOn }))),
    getRepliesToReviewComments: vi.fn().mockImplementation(async (_pr: string, _ids: string[], includeAnswered?: boolean) =>
      ({ replies: includeAnswered ? c.all : c.unanswered, agentReplyCount: pastCount })),
    postReply: vi.fn().mockResolvedValue(undefined),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),
  } as unknown as VCSAdapter
}

async function runCustom(adapter: VCSAdapter, reviewer: 'none' | 'nochange', opts: { flag: boolean; dryRun?: boolean; limit?: number }) {
  cfg.reply.maxComments = opts.limit ?? LIMIT
  cfg.reply.limitPerReview = opts.flag
  const obj = reviewer === 'nochange' ? reviewWith([], { summary: '', no_change: true }) : reviewWith()
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
  vi.mocked(runReview).mockResolvedValue({ text: renderReview(obj), usage: { input_tokens: 1000, output_tokens: 200 }, review: obj })
  vi.mocked(runCommentResponse).mockResolvedValue({ text: 'Answer.', usage: { input_tokens: 500, output_tokens: 100 } })
  const logs: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.map(String).join(' ')) })
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => { logs.push(a.map(String).join(' ')) })
  try {
    const record = await review(adapter, '100', opts.dryRun ?? false)
    return { record: record!, logs }
  } finally {
    log.mockRestore(); warn.mockRestore()
  }
}

beforeEach(() => { vi.clearAllMocks() })

describe('per-review reply count and limit note (flag on)', () => {
  const OLD = '2026-03-08T10:00:00Z'
  const NEW = '2026-03-10T10:00:00Z'
  const threeOldReplies = [agentAt('a1', '2026-03-08T11:00:00Z'), agentAt('a2', '2026-03-08T12:00:00Z'), agentAt('a3', '2026-03-08T13:00:00Z')]
  const question = devAt('q1', '2026-03-10T12:00:00Z', '201')
  const twoReviews = [{ id: '200', createdOn: OLD, commit: PRIOR_COMMIT }, { id: '201', createdOn: NEW, commit: COMMIT_A }]
  const oldHistory = () => customAdapter({ reviews: twoReviews, all: [...threeOldReplies, question], unanswered: [question] })

  it('replies under an older review do not count: the question is answered in-thread', async () => {
    const adapter = oldHistory()
    const { record } = await runCustom(adapter, 'none', { flag: true })
    expect(record.action).toBe('REPLY')
    expect(adapter.postReply).toHaveBeenCalledTimes(1)
    expect(vi.mocked(adapter.postReply).mock.calls[0][1]).toBe('201')
    expect(record).not.toHaveProperty('reply_limit_note')
  })

  it('the same history is a limit skip with the flag off', async () => {
    const adapter = oldHistory()
    const { record } = await runCustom(adapter, 'none', { flag: false })
    expect(record.action).toBe('DEDUP_SKIP')
    expect(record.skip_reason).toBe('reply limit reached (3/3)')
    expect(adapter.postReply).not.toHaveBeenCalled()
  })

  it('flag off makes no extra discussion call', async () => {
    const adapter = oldHistory()
    await runCustom(adapter, 'none', { flag: false })
    expect(adapter.getRepliesToReviewComments).toHaveBeenCalledTimes(1)
  })

  const mine = [agentAt('b1', '2026-03-10T10:30:00Z'), agentAt('b2', '2026-03-10T11:00:00Z'), agentAt('b3', '2026-03-10T11:30:00Z')]
  const atLimit = () => customAdapter({ reviews: twoReviews, all: [...mine, question], unanswered: [question] })

  it('posts one note under the newest question parent, with the reply footer, no model call', async () => {
    const adapter = atLimit()
    const { record, logs } = await runCustom(adapter, 'none', { flag: true })
    expect(adapter.postReply).toHaveBeenCalledTimes(1)
    const [prId, parent, body] = vi.mocked(adapter.postReply).mock.calls[0]
    expect(prId).toBe('100')
    expect(parent).toBe('201')
    expect(body.startsWith(NOTE_TEXT)).toBe(true)
    expect(hasReplyFooter(body)).toBe(true)
    expect(runCommentResponse).not.toHaveBeenCalled()
    expect(record.reply_limit_note).toBe(true)
    expect(record.action).toBe('DEDUP_SKIP')
    expect(logs.some(l => l.includes('agent already posted 3/3 replies'))).toBe(true)
  })

  it('a failed note post warns and the run still ends normally', async () => {
    const adapter = atLimit()
    vi.mocked(adapter.postReply).mockRejectedValue(new Error('403'))
    const { record, logs } = await runCustom(adapter, 'none', { flag: true })
    expect(record.action).toBe('DEDUP_SKIP')
    expect(record).not.toHaveProperty('reply_limit_note')
    expect(logs.some(l => l.includes('Reply limit note not posted (403)'))).toBe(true)
  })

  it('dry-run prints the note, posts nothing, and still records it', async () => {
    const adapter = atLimit()
    const { record, logs } = await runCustom(adapter, 'none', { flag: true, dryRun: true })
    expect(adapter.postReply).not.toHaveBeenCalled()
    expect(adapter.postComment).not.toHaveBeenCalled()
    expect(logs.some(l => l.includes('DRY RUN — Reply limit note (not posted)'))).toBe(true)
    expect(record.reply_limit_note).toBe(true)
  })

  it('MAX_REPLY_COMMENTS=0 stays unlimited: answers, no extra call', async () => {
    const adapter = atLimit()
    const { record } = await runCustom(adapter, 'none', { flag: true, limit: 0 })
    expect(record.action).toBe('REPLY')
    expect(adapter.getRepliesToReviewComments).toHaveBeenCalledTimes(1)
  })

  it('a failed per-review count falls back to the PR-wide count: no error, no note', async () => {
    const adapter = atLimit()
    const fetchReplies = vi.mocked(adapter.getRepliesToReviewComments)
    const original = fetchReplies.getMockImplementation() as typeof adapter.getRepliesToReviewComments
    fetchReplies.mockImplementation(async (pr, ids, includeAnswered) => {
      if (includeAnswered) throw new Error('boom')
      return original(pr, ids, includeAnswered)
    })
    const { record, logs } = await runCustom(adapter, 'none', { flag: true })
    expect(record.action).toBe('DEDUP_SKIP')
    expect(record.error).toBeNull()
    expect(adapter.postReply).not.toHaveBeenCalled()
    expect(record).not.toHaveProperty('reply_limit_note')
    expect(logs.join(' ')).toContain('Per-review reply count unavailable (boom)')
  })

  it('a note already posted (count above the limit) posts nothing more', async () => {
    const withNote = [...mine, agentAt('n1', '2026-03-10T11:40:00Z', NOTE_TEXT)]
    const adapter = customAdapter({ reviews: twoReviews, all: [...withNote, question], unanswered: [question] })
    const { record } = await runCustom(adapter, 'none', { flag: true })
    expect(adapter.postReply).not.toHaveBeenCalled()
    expect(record.skip_reason).toBe('reply limit reached (4/3)')
    expect(record).not.toHaveProperty('reply_limit_note')
  })

  describe('0-finding re-review gate', () => {
    const pushReviews = [{ id: '200', createdOn: OLD, commit: PRIOR_COMMIT }, { id: '201', createdOn: NEW, commit: PRIOR_COMMIT }]

    it('counts replies per review: replies under an older review leave budget for the question', async () => {
      const adapter = customAdapter({ reviews: pushReviews, all: [...threeOldReplies, question], unanswered: [question] })
      const { record } = await runCustom(adapter, 'none', { flag: true })
      expect(record.action).toBe('REPLY')
      expect(adapter.postReply).toHaveBeenCalledTimes(1)
    })

    it('with the flag off the same history finishes the re-review without answering', async () => {
      const adapter = customAdapter({ reviews: pushReviews, all: [...threeOldReplies, question], unanswered: [question] })
      const { record } = await runCustom(adapter, 'none', { flag: false })
      expect(record.action).toBe('NO_NEW_FINDINGS')
      expect(adapter.postReply).not.toHaveBeenCalled()
    })

    it('at the per-review limit it finishes the re-review and posts no note', async () => {
      const adapter = customAdapter({ reviews: pushReviews, all: [...mine, question], unanswered: [question] })
      const { record } = await runCustom(adapter, 'none', { flag: true })
      expect(record.action).toBe('NO_NEW_FINDINGS')
      expect(adapter.postReply).not.toHaveBeenCalled()
      expect(record).not.toHaveProperty('reply_limit_note')
    })
  })

  it('a NO_CHANGE re-review at the limit keeps the label and posts the note', async () => {
    const adapter = customAdapter({ reviews: [{ id: '200', createdOn: OLD, commit: PRIOR_COMMIT }, { id: '201', createdOn: NEW, commit: PRIOR_COMMIT }], all: [...mine, question], unanswered: [question] })
    const { record } = await runCustom(adapter, 'nochange', { flag: true })
    expect(record.action).toBe('NO_CHANGE')
    expect(record.reply_limit_note).toBe(true)
    expect(adapter.postReply).toHaveBeenCalledTimes(1)
  })
})
