import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VCSAdapter, PRInfo, ReviewComment, CommentReply } from '../../vcs/adapter.js'

// ---------------------------------------------------------------------------
// Mocks — vi.mock factories are hoisted, so no external refs allowed
// ---------------------------------------------------------------------------

vi.mock('../../config.js', () => ({
  config: {
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', maxRetries: 1, maxInputTokens: 150000, maxTokens: 32000 },
    judge: { model: '', maxRetries: 1, effort: '' },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3 },
    review: { maxFindings: 0, splitCheck: false, todoScan: true, effort: '' },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: ['main', 'master', 'release/*', 'hotfix/*'],
    skipTargetBranches: ['main', 'master'],
    diffExcludePatterns: ['*.lock', 'package-lock.json', '*.spec.ts'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
}))

vi.mock('../../claude/client.js', () => ({
  runReview: vi.fn(),
  runCommentResponse: vi.fn(),
  runJudge: vi.fn(),
}))

vi.mock('../../prompt/loader.js', () => ({
  loadPrompt: vi.fn(),
}))

vi.mock('../../context/fetcher.js', () => ({
  fetchContext: vi.fn(),
}))

vi.mock('../usage.js', async (importOriginal) => {
  const actual = await importOriginal() as any
  return { ...actual, logUsageRecord: vi.fn() }
})

// Import after mocks
import { review } from '../index.js'
import { config } from '../../config.js'
import { runReview, runCommentResponse, runJudge } from '../../claude/client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { logUsageRecord } from '../usage.js'
import { renderReview, buildReplyFooter, hasReplyFooter, extractCommitHash, markdownHasFindings, type ReviewObject } from '../formatter.js'

const mockRunReview = vi.mocked(runReview)
const mockRunCommentResponse = vi.mocked(runCommentResponse)
const mockRunJudge = vi.mocked(runJudge)
const mockLoadPrompt = vi.mocked(loadPrompt)
const mockFetchContext = vi.mocked(fetchContext)
const cfg = config as any

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMMIT_A = 'aaa111222333'

const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,5 @@
+import { foo } from './foo'
+foo()
`

function footer(reviewNum: number, commit: string): string {
  return `\n\n---\n*Reviewed by test-bot (claude-haiku-4-5-20251001) | Prompt: repo | Review #${reviewNum} | Commit: ${commit}*`
}

function makePRInfo(sourceCommit = COMMIT_A): PRInfo {
  return {
    id: '100', title: 'Test PR', description: 'A test PR', author: 'dev',
    sourceBranch: 'feature/test', targetBranch: 'develop', sourceCommit,
  }
}

function makeAdapter(overrides: Partial<VCSAdapter> = {}): VCSAdapter {
  return {
    getPullRequestInfo: vi.fn().mockResolvedValue(makePRInfo()),
    getDiff: vi.fn().mockResolvedValue(DIFF),
    getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/app.ts', status: 'modified' }]),
    getFileContent: vi.fn().mockResolvedValue(''),
    getRepoFileContent: vi.fn().mockResolvedValue(null),
    postComment: vi.fn().mockResolvedValue(undefined),
    getPreviousReviewComments: vi.fn().mockResolvedValue([]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
    postReply: vi.fn().mockResolvedValue(undefined),
    getCommitDiff: vi.fn().mockResolvedValue(''),
    ...overrides,
  }
}

// The reviewer now returns a structured object; the FSM/metrics read it (not regex over text).
// Tests that only care about posted text pass the default empty-findings object.
const reviewWith = (findings: ReviewObject['findings'] = [], extra: Partial<ReviewObject> = {}): ReviewObject =>
  ({ summary: 'ok', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [], ...extra })

function setupClaudeMocks(
  reviewText = '### Summary\nAll good.\n\n### Findings\n\nNo findings.\n\n### Unresolved Questions\nNone.',
  review: ReviewObject = reviewWith(),
) {
  mockLoadPrompt.mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  mockFetchContext.mockResolvedValue([])
  mockRunReview.mockResolvedValue({ text: reviewText, usage: { input_tokens: 1000, output_tokens: 200 }, review })
  mockRunCommentResponse.mockResolvedValue({ text: 'Thanks for clarifying.', usage: { input_tokens: 500, output_tokens: 100 } })
}

// Rendered text and typed object must agree, as they do in production (runReview renders the object).
const mockReviewer = (obj: ReviewObject) => setupClaudeMocks(renderReview(obj), obj)

const PRIOR_COMMIT = 'aabbcc112233'
const PRIOR_AT = '2026-03-09T10:00:00Z'
const CLEAN_PRIOR = '### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.'
const FLAGGED_PRIOR = '### Summary\nOne issue.\n\n### Findings\n- **MEDIUM – Prior issue** (`a.ts:1`)\n  desc\n\n### Unresolved Questions\nNone.'
const NEW_FINDING: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'New issue', file: 'src/app.ts', lines: '11', body: 'desc' }

const devReply = (createdOn: string, parentId = '200'): CommentReply =>
  ({ id: `dev-${createdOn}`, parentId, author: 'Fernando', body: 'Fixed in d4f2b43e.', createdOn })
const agentReply = (createdOn: string, jobUrl?: string): CommentReply =>
  ({ id: `agent-${createdOn}`, parentId: '200', author: 'Agent (prior reply)', body: 'Confirmed.' + buildReplyFooter('test-bot', 'claude-haiku-4-5-20251001', jobUrl), createdOn })

// One prior review on an older commit + a reviewable delta → the JUDGE_REVIEW gate is reached on review #2.
function reReviewAdapter(priorBody: string, replies: CommentReply[] = [], overrides: Partial<VCSAdapter> = {}): VCSAdapter {
  return makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '200', body: priorBody + footer(1, PRIOR_COMMIT), createdOn: PRIOR_AT }]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies, agentReplyCount: 0 }),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset mock implementations (clearAllMocks only clears call records)
  setupClaudeMocks()
  cfg.judge.model = ''
  cfg.reply.maxComments = 3
  cfg.anthropic.maxInputTokens = 150000
  cfg.review = { maxFindings: 0, splitCheck: false, todoScan: true, effort: '' }
  cfg.skipSourceBranches = ['main', 'master', 'release/*', 'hotfix/*']
  cfg.skipTargetBranches = ['main', 'master']
  cfg.diffExcludePatterns = ['*.lock', 'package-lock.json', '*.spec.ts']
  cfg.thresholds = { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 }
})

// ===========================================================================
// Scenario 1: First review on a new PR
// ===========================================================================

describe('first review (new PR)', () => {
  it('posts review → action=REVIEW, review_number=1', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks()

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('REVIEW')
    expect(record!.review_number).toBe(1)
    expect(mockRunReview).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Scenario 2: Same commit, no replies → dedup skip
// ===========================================================================

describe('same commit, no replies → DEDUP_SKIP', () => {
  it('skips without calling Claude', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.skip_reason).toContain('no new commits')
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 3: Same commit + new human reply → REPLY
// ===========================================================================

describe('same commit + new reply → REPLY', () => {
  it('responds to developer question', async () => {
    const reviewDate = '2026-03-10T10:00:00Z'
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: reviewDate },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [{
          id: '300', parentId: '200', author: 'Vadim',
          body: 'Can you explain the HIGH severity?',
          createdOn: '2026-03-10T14:00:00Z', // after review
        }],
        agentReplyCount: 0,
      }),
    })
    setupClaudeMocks()

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('REPLY')
    expect(mockRunCommentResponse).toHaveBeenCalledTimes(1)
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 3b: Real (non-dry-run) reply — threaded under the newest reply, answers the
// latest review, and carries the footer the agent uses to recognize its own replies
// ===========================================================================

describe('REPLY posts a threaded, self-recognizable reply', () => {
  it('posts once under the newest reply thread with a reply footer, never a top-level comment', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: FLAGGED_PRIOR + footer(1, PRIOR_COMMIT), createdOn: '2026-03-09T10:00:00Z' },
        { id: '201', body: '### Summary\nLatest.' + footer(2, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [devReply('2026-03-10T11:00:00Z', '201'), devReply('2026-03-10T12:00:00Z', 'agent-77')],
        agentReplyCount: 1,
      }),
    })

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REPLY')
    expect(adapter.postComment).not.toHaveBeenCalled()
    expect(adapter.postReply).toHaveBeenCalledTimes(1)
    const [prId, parentId, body] = vi.mocked(adapter.postReply).mock.calls[0]
    expect(prId).toBe('100')
    expect(parentId).toBe('agent-77')
    expect(body.startsWith('Thanks for clarifying.')).toBe(true)
    // Without this footer the next run would treat our own reply as a developer question → reply loop
    expect(hasReplyFooter(body)).toBe(true)
    const [, , , diffArg, reviewBodyArg, repliesArg] = mockRunCommentResponse.mock.calls[0]
    expect(diffArg).toBe(DIFF)
    expect(reviewBodyArg).toContain('Latest.')
    expect(repliesArg).toHaveLength(2)
  })

  it('CHECK_REPLIES asks the adapter for unanswered replies only (answered ones would re-trigger replies)', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
      ]),
    })

    await review(adapter, '100', true)

    expect(adapter.getRepliesToReviewComments).toHaveBeenCalledTimes(1)
    expect(adapter.getRepliesToReviewComments).toHaveBeenCalledWith('100', ['200'])
  })
})

// ===========================================================================
// Scenario 4: Stale reply (older than latest review) → DEDUP_SKIP
// Regression: PR 712 — old replies triggered infinite reply loop
// ===========================================================================

describe('stale reply older than latest review → DEDUP_SKIP', () => {
  it('filters old replies and skips', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Old' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
        { id: '201', body: '### Delta' + footer(2, COMMIT_A), createdOn: '2026-03-10T11:42:00Z' },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [{
          id: '300', parentId: '200', author: 'Vadim',
          body: 'What about the cache?',
          createdOn: '2026-03-10T11:18:00Z', // BEFORE review #2
        }],
        agentReplyCount: 0,
      }),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.skip_reason).toContain('no new commits')
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 4b: A human-RESOLVED later review must not supersede an earlier unanswered
// dev reply — the reply is still answered (PR 579: a resolved re-review buried the reply)
// ===========================================================================

describe('resolved later review does not supersede an unanswered dev reply', () => {
  it('answers the dev reply even though a newer review exists, because that review is resolved', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
        { id: '201', body: '### Delta' + footer(2, COMMIT_A), createdOn: '2026-03-09T14:00:00Z', resolved: true },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [{ id: '300', parentId: '200', author: 'Fernando', body: 'Fixed in d4f2b43e.', createdOn: '2026-03-09T12:00:00Z' }],
        agentReplyCount: 0,
      }),
    })

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REPLY')
    expect(adapter.postReply).toHaveBeenCalled()
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 5: Reply limit reached → DEDUP_SKIP
// ===========================================================================

describe('reply limit reached → DEDUP_SKIP', () => {
  it('skips when agent hit max replies', async () => {
    cfg.reply.maxComments = 2

    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [{
          id: '300', parentId: '200', author: 'Vadim',
          body: 'Still disagree',
          createdOn: '2026-03-10T14:00:00Z',
        }],
        agentReplyCount: 2,
      }),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.skip_reason).toContain('reply limit')
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 5b: Stale + fresh replies mixed, and reply-limit boundaries
// ===========================================================================

describe('CHECK_REPLIES filtering and limit boundaries', () => {
  const sameCommitAdapter = (replies: CommentReply[], agentReplyCount: number) => makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([
      { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
    ]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies, agentReplyCount }),
  })

  it('answers only the replies newer than the latest review', async () => {
    const stale = devReply('2026-03-10T09:00:00Z')
    const fresh = devReply('2026-03-10T14:00:00Z')
    const adapter = sameCommitAdapter([stale, fresh], 0)

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('REPLY')
    expect(mockRunCommentResponse.mock.calls[0][5]).toEqual([fresh])
  })

  it('still replies one below the limit', async () => {
    cfg.reply.maxComments = 3
    const adapter = sameCommitAdapter([devReply('2026-03-10T14:00:00Z')], 2)

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('REPLY')
  })

  it('treats MAX_REPLY_COMMENTS=0 as unlimited', async () => {
    cfg.reply.maxComments = 0
    const adapter = sameCommitAdapter([devReply('2026-03-10T14:00:00Z')], 50)

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('REPLY')
    expect(mockRunCommentResponse).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Scenario 6: New commit → delta RE_REVIEW
// ===========================================================================

describe('new commit → RE_REVIEW', () => {
  it('produces delta review with discussion', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Summary\nx\n\n### Findings\n- **MEDIUM – Prior issue** (`a.ts:1`)\n  desc' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
      getCommitDiff: vi.fn().mockResolvedValue(DIFF),
    })
    // Prior review flagged a finding, now resolved, no open discussion → one delta confirmation (RE_REVIEW)
    setupClaudeMocks(undefined, reviewWith([], { delta_stats: { resolved: 1, still_open: 0, new_findings: 0 } }))

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('RE_REVIEW')
    expect(record!.review_number).toBe(2)
    expect(mockRunReview).toHaveBeenCalledTimes(1)
    // delta + touch_rate now come from the reviewer object, not a DELTA_STATS markdown comment
    expect(record!.delta).toMatchObject({ resolved: 1, still_open: 0, new_findings: 0 })
    expect(record!.touch_rate).toBe(100)
  })
})

// ===========================================================================
// Scenario 6b: Re-review clears to 0 findings AND prior review was already clean →
// suppress the repeat "still clean" comment (PR 133 noise bug)
// ===========================================================================

describe('re-review, no findings, prior review already clean → NO_NEW_FINDINGS (not posted)', () => {
  it('does not post a repeat "nothing to report" comment', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Summary\nAll good.\n\n### Findings\nNo findings.' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
      ]),
      getCommitDiff: vi.fn().mockResolvedValue(DIFF),
    })
    setupClaudeMocks(undefined, reviewWith([]))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('NO_NEW_FINDINGS')
    expect(record!.review_number).toBe(2)
    expect(mockRunReview).toHaveBeenCalledTimes(1)
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 6c: Re-review with 0 findings + prior "No findings" (open finding in prose),
// but a dev replied after the last review → answer the reply in-thread (PR 579 regression)
// ===========================================================================

describe('re-review, no findings, prior clean, BUT unanswered dev reply → answers in-thread (not re-reviewed)', () => {
  it('answers the developer with a threaded reply instead of posting another review', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Summary\nprior MEDIUM still open (described in prose)\n\n### Findings\nNo findings.' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
      ]),
      getCommitDiff: vi.fn().mockResolvedValue(DIFF),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [{ id: '300', parentId: '200', author: 'Fernando', body: 'Fixed in d4f2b43e.', createdOn: '2026-03-09T12:00:00Z' }],
        agentReplyCount: 0,
      }),
    })
    setupClaudeMocks(undefined, reviewWith([]))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REPLY')
    expect(adapter.postReply).toHaveBeenCalled()
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 6d: Prior review's "### Findings" says "No findings." but a finding is still open
// (mentioned only in prose); no dev reply → the reviewer's still_open alone must force a post
// ===========================================================================

describe('re-review, no findings, prior looks clean, still_open > 0, no reply → posts', () => {
  it('posts on still_open alone even though the prior markdown has no finding bullets', async () => {
    const prior = '### Summary\nPrior MEDIUM (cache key collision) is still open — see thread.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.'
    // Precondition: the markdown check is blind to this prior, so only still_open can save the post
    expect(markdownHasFindings(prior)).toBe(false)
    const adapter = reReviewAdapter(prior)
    mockReviewer(reviewWith([], { delta_stats: { resolved: 0, still_open: 1, new_findings: 0 } }))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('RE_REVIEW')
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
    expect(record!.delta).toMatchObject({ resolved: 0, still_open: 1, new_findings: 0 })
    expect(record!.touch_rate).toBe(0)
  })
})

// ===========================================================================
// Scenario 6e: NO_NEW_FINDINGS gate truth table — suppress ONLY when every input says
// "nothing to say"; any single signal (finding, prior finding, still open, dev reply) posts
// ===========================================================================

describe('NO_NEW_FINDINGS gate — full truth table', () => {
  const cases = [0, 1].flatMap(findings =>
    (['clean', 'had findings'] as const).flatMap(prior =>
      [0, 1].flatMap(stillOpen =>
        (['none', 'unanswered'] as const).map(reply => ({
          findings, prior, stillOpen, reply,
          expected: findings === 0 && reply === 'unanswered' ? 'reply'
            : findings === 0 && prior === 'clean' && stillOpen === 0 ? 'suppress'
            : 'post',
        })))))

  it('covers all 16 combinations: 1 suppress, 4 reply, 11 post', () => {
    expect(cases).toHaveLength(16)
    expect(cases.filter(c => c.expected === 'suppress')).toHaveLength(1)
    expect(cases.filter(c => c.expected === 'reply')).toHaveLength(4)
    expect(cases.filter(c => c.expected === 'post')).toHaveLength(11)
  })

  it.each(cases)('findings=$findings prior=$prior still_open=$stillOpen reply=$reply → $expected', async ({ findings, prior, stillOpen, reply, expected }) => {
    const adapter = reReviewAdapter(
      prior === 'had findings' ? FLAGGED_PRIOR : CLEAN_PRIOR,
      reply === 'unanswered' ? [devReply('2026-03-09T12:00:00Z')] : [],
    )
    mockReviewer(reviewWith(findings ? [NEW_FINDING] : [], { delta_stats: { resolved: 0, still_open: stillOpen, new_findings: findings } }))

    const record = await review(adapter, '100', false)

    expect(record!.review_number).toBe(2)
    expect(mockRunReview).toHaveBeenCalledTimes(1)
    if (expected === 'suppress') {
      expect(record!.action).toBe('NO_NEW_FINDINGS')
      expect(adapter.postComment).not.toHaveBeenCalled()
    } else if (expected === 'reply') {
      expect(record!.action).toBe('REPLY')
      expect(adapter.postReply).toHaveBeenCalledTimes(1)
      expect(adapter.postComment).not.toHaveBeenCalled()
    } else {
      expect(record!.action).toBe('RE_REVIEW')
      expect(adapter.postComment).toHaveBeenCalledTimes(1)
    }
  })
})

// ===========================================================================
// Scenario 6f: What counts as an "unanswered dev reply" for the gate — prior clean,
// 0 findings, nothing still open, so the discussion state alone decides
// ===========================================================================

describe('NO_NEW_FINDINGS gate — open-discussion detection', () => {
  async function gateWith(replies: CommentReply[]) {
    const adapter = reReviewAdapter(CLEAN_PRIOR, replies)
    mockReviewer(reviewWith([], { delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } }))
    const record = await review(adapter, '100', false)
    return {
      record: record!,
      posted: vi.mocked(adapter.postComment).mock.calls.length,
      replied: vi.mocked(adapter.postReply).mock.calls.length,
    }
  }

  it('suppresses when the only dev reply predates the last review (stale thread)', async () => {
    const { record, posted } = await gateWith([devReply('2026-03-09T09:00:00Z')])
    expect(record.action).toBe('NO_NEW_FINDINGS')
    expect(posted).toBe(0)
  })

  it.each([
    ['plain', undefined],
    ['CI-linked', 'https://ci/job/pr-review/42/'],
  ])('suppresses when a %s agent reply already answered the dev reply', async (_label, jobUrl) => {
    const { record, posted } = await gateWith([devReply('2026-03-09T11:00:00Z'), agentReply('2026-03-09T11:30:00Z', jobUrl)])
    expect(record.action).toBe('NO_NEW_FINDINGS')
    expect(posted).toBe(0)
  })

  it('suppresses when the only reply after the last review is our own agent reply', async () => {
    const { record, posted } = await gateWith([agentReply('2026-03-09T11:30:00Z')])
    expect(record.action).toBe('NO_NEW_FINDINGS')
    expect(posted).toBe(0)
  })

  it('answers in-thread when the dev replied again after our last agent reply', async () => {
    const { record, posted, replied } = await gateWith([
      devReply('2026-03-09T11:00:00Z'), agentReply('2026-03-09T11:30:00Z'), devReply('2026-03-09T12:00:00Z'),
    ])
    expect(record.action).toBe('REPLY')
    expect(replied).toBe(1)
    expect(posted).toBe(0)
  })
})

// ===========================================================================
// Scenario 6g: Gate judges the LAST posted review — one resolution confirmation, then silence
// ===========================================================================

describe('NO_NEW_FINDINGS gate — reads the latest prior review, not any earlier one', () => {
  const twoReviews = (first: string, second: string) => makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([
      { id: '200', body: first + footer(1, '111111111111'), createdOn: '2026-03-08T10:00:00Z' },
      { id: '201', body: second + footer(2, PRIOR_COMMIT), createdOn: PRIOR_AT },
    ]),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),
  })

  it('suppresses after the clean confirmation already went out (flagged → clean → clean)', async () => {
    const adapter = twoReviews(FLAGGED_PRIOR, CLEAN_PRIOR)
    mockReviewer(reviewWith([]))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('NO_NEW_FINDINGS')
    expect(record!.review_number).toBe(3)
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  it('posts the confirmation when the latest prior review was the flagged one (clean → flagged → clean)', async () => {
    const adapter = twoReviews(CLEAN_PRIOR, FLAGGED_PRIOR)
    mockReviewer(reviewWith([]))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('RE_REVIEW')
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Scenario 6h: Gate × judge — 0-finding reviews skip the judge whether posted or suppressed,
// and the gate never touches a first review
// ===========================================================================

describe('gate and judge interaction', () => {
  it('posts a 0-finding re-review without calling the judge (reviewer-only cut guard applies)', async () => {
    cfg.judge.model = 'judge-model'
    const adapter = reReviewAdapter(FLAGGED_PRIOR)
    mockReviewer(reviewWith([], { delta_stats: { resolved: 1, still_open: 0, new_findings: 0 } }))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('RE_REVIEW')
    expect(mockRunJudge).not.toHaveBeenCalled()
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
  })

  it('suppresses a noise re-review without calling the judge', async () => {
    cfg.judge.model = 'judge-model'
    const adapter = reReviewAdapter(CLEAN_PRIOR)
    mockReviewer(reviewWith([]))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('NO_NEW_FINDINGS')
    expect(mockRunJudge).not.toHaveBeenCalled()
  })

  it('always posts a 0-finding FIRST review (gate is re-review only), judge skipped', async () => {
    cfg.judge.model = 'judge-model'
    const adapter = makeAdapter()
    mockReviewer(reviewWith([]))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REVIEW')
    expect(record!.review_number).toBe(1)
    expect(mockRunJudge).not.toHaveBeenCalled()
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Scenario 6i: Delta re-review plumbing — what the reviewer actually receives
// ===========================================================================

describe('delta re-review feeds the reviewer the right inputs', () => {
  it('passes the filtered changes-since-last-review diff and the full discussion', async () => {
    const delta = 'diff --git a/src/app.spec.ts b/src/app.spec.ts\n--- a/src/app.spec.ts\n+++ b/src/app.spec.ts\n@@ -1 +1,2 @@\n+spec only\n' + DIFF
    const discussion = [devReply('2026-03-09T11:00:00Z'), agentReply('2026-03-09T11:30:00Z')]
    const adapter = reReviewAdapter(FLAGGED_PRIOR, discussion, { getCommitDiff: vi.fn().mockResolvedValue(delta) })
    mockReviewer(reviewWith([NEW_FINDING]))

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('RE_REVIEW')
    expect(adapter.getCommitDiff).toHaveBeenCalledWith(PRIOR_COMMIT, COMMIT_A)
    expect(adapter.getRepliesToReviewComments).toHaveBeenCalledWith('100', ['200'], true)
    const args = mockRunReview.mock.calls[0]
    expect((args[9] as unknown[]).length).toBe(1)
    expect(args[10]).toEqual(discussion)
    const deltaArg = args[11] as string
    expect(deltaArg).toContain('src/app.ts')
    expect(deltaArg).not.toContain('app.spec.ts')
  })

  it('falls back to a full re-review when the delta diff fetch fails', async () => {
    const adapter = reReviewAdapter(FLAGGED_PRIOR, [], { getCommitDiff: vi.fn().mockRejectedValue(new Error('404 commit gone after force-push')) })
    mockReviewer(reviewWith([NEW_FINDING]))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('RE_REVIEW')
    expect(mockRunReview.mock.calls[0][11]).toBe('')
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Scenario 7: New commit but delta only excluded files → reply check → dedup skip
// ===========================================================================

describe('delta only excluded files → dedup skip', () => {
  it('skips without calling Claude', async () => {
    const specDiff = `diff --git a/src/app.spec.ts b/src/app.spec.ts
--- a/src/app.spec.ts
+++ b/src/app.spec.ts
@@ -1,3 +1,5 @@
+it('works', () => {})
`
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Old' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
      ]),
      getCommitDiff: vi.fn().mockResolvedValue(specDiff),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 7b: Zero reviewable delta must still route through CHECK_REPLIES — a dev who
// pushed only test/lock changes and asked a question still gets an answer
// ===========================================================================

describe('zero reviewable delta → CHECK_REPLIES (not a blind skip)', () => {
  const specOnly = 'diff --git a/src/app.spec.ts b/src/app.spec.ts\n--- a/src/app.spec.ts\n+++ b/src/app.spec.ts\n@@ -1 +1,2 @@\n+spec only\n'
  const zeroDeltaAdapter = (delta: string, replies: CommentReply[], agentReplyCount = 0) => makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([
      { id: '200', body: FLAGGED_PRIOR + footer(1, PRIOR_COMMIT), createdOn: PRIOR_AT },
    ]),
    getCommitDiff: vi.fn().mockResolvedValue(delta),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies, agentReplyCount }),
  })

  it('answers an unanswered dev reply instead of skipping', async () => {
    const adapter = zeroDeltaAdapter(specOnly, [devReply('2026-03-09T12:00:00Z')])

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REPLY')
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(adapter.postReply).toHaveBeenCalledTimes(1)
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  it('respects the reply limit on this path too', async () => {
    cfg.reply.maxComments = 2
    const adapter = zeroDeltaAdapter(specOnly, [devReply('2026-03-09T12:00:00Z')], 2)

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.skip_reason).toContain('reply limit')
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
  })

  it('skips an empty delta (rebase with no content change) when nothing is unanswered', async () => {
    const adapter = zeroDeltaAdapter('', [])

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.skip_reason).toContain('no new commits')
    expect(record!.review_number).toBe(1)
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 8: Claude returns NO_CHANGE → skip (never post)
// ===========================================================================

describe('Claude returns NO_CHANGE on a re-review → skip', () => {
  // NO_CHANGE is only valid when a prior review exists — set up a re-review (old-commit footer
  // + a delta diff) so CALL_CLAUDE is reached with previousReviews populated.
  const reReviewAdapter = () => makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([
      { id: '200', body: '### Old' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
    ]),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),
  })

  it('does not post NO_CHANGE as a comment', async () => {
    const adapter = reReviewAdapter()
    setupClaudeMocks('NO_CHANGE')

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('NO_CHANGE')
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  it('does not post summary + standalone NO_CHANGE line (PR 8718 regression)', async () => {
    const adapter = reReviewAdapter()
    setupClaudeMocks('### Summary\n\nNo new findings. New commits contain only cosmetic changes.\n\nNO_CHANGE')

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('NO_CHANGE')
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  it('errors instead of silently skipping when NO_CHANGE fires on a FIRST review (build 10233 bug)', async () => {
    const adapter = makeAdapter()   // no previous reviews → first review
    setupClaudeMocks('NO_CHANGE')

    await expect(review(adapter, '100', false)).rejects.toThrow(/NO_CHANGE on a first review/i)
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 8b: Judge leaks validation reasoning before the review → stripped
// ===========================================================================

describe('judge preamble leak → stripped before posting', () => {
  it('posts only from ### Summary onward (PR 45 regression)', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks('### Summary\nRisky refactor.\n\n### Findings\n\n- **MEDIUM – Substring matching** (a.ts:1)\n  Over-matches rows.', reviewWith([{ severity: 'MEDIUM', title: 'Substring matching', body: 'Over-matches rows.' }]))
    cfg.judge.model = 'judge-model'
    mockRunJudge.mockResolvedValue({
      text: 'I need to validate each finding against the actual diff. Let me check each one carefully.\n\n**Finding 1: MEDIUM** — visible in the diff, keep.\n\n### Summary\nRisky refactor, validated.\n\n### Findings\n\n- **MEDIUM – Substring matching** (a.ts:1)\n  Over-matches rows.\n\n### Merge Confidence: 78%',
      usage: { input_tokens: 800, output_tokens: 300 },
    })

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REVIEW')
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
    const body = vi.mocked(adapter.postComment).mock.calls[0][1] as string
    expect(body.startsWith('### Summary')).toBe(true)
    expect(body).not.toContain('I need to validate')
  })

  it('strips JUDGE_NOTES from the posted comment (PR 8722 regression)', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks('### Summary\nRisky.\n\n### Findings\n\n- **MEDIUM – Something** (a.ts:1)\n  Desc.', reviewWith([{ severity: 'MEDIUM', title: 'Something', body: 'Desc.' }]))
    cfg.judge.model = 'judge-model'
    mockRunJudge.mockResolvedValue({
      text: '### Summary\nLow-risk change.\n\n### Findings\n\n- **LOW – Fragile helper** (a.ts:1)\n  Desc.\n\n### Merge Confidence: 80%\n\n<!-- JUDGE_NOTES: Dropped MEDIUM — convention claim not verifiable from diff. -->',
      usage: { input_tokens: 800, output_tokens: 300 },
      scores: [{ title: 'Fragile helper', severity: 'LOW', score: 6 }],
    })

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REVIEW')
    const body = vi.mocked(adapter.postComment).mock.calls[0][1] as string
    expect(body).not.toContain('JUDGE_NOTES')
    expect(body).not.toContain('Dropped MEDIUM')
    expect(body).toContain('LOW – Fragile helper')
    // per-finding scores are logged to results.jsonl, never in the posted body
    expect(body).not.toContain('6/10')
    expect(record!.finding_scores).toEqual([{ title: 'Fragile helper', severity: 'LOW', score: 6 }])
    expect(record!.min_finding_score).toBe(6)
  })
})

// ===========================================================================
// Scenario 8c: Cut guard — truncated review must not be posted (PR 8722)
// ===========================================================================

describe('cut guard — truncated review not posted', () => {
  it('rejects a judged review missing the Merge Confidence tail', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks('### Summary\nRisky.\n\n### Findings\n\n- **MEDIUM – X** (a.ts:1)\n  Desc.', reviewWith([{ severity: 'MEDIUM', title: 'X', body: 'Desc.' }]))
    cfg.judge.model = 'judge-model'
    // Judge output truncated mid-Behavioral-Diff — no Merge Confidence section
    mockRunJudge.mockResolvedValue({
      text: '### Summary\nRisky.\n\n### Findings\n\n- **LOW – Y** (a.ts:1)\n  Desc.\n\n### Behavioral Diff\n- changed the thing and it cuts off here',
      usage: { input_tokens: 800, output_tokens: 300 },
    })

    await expect(review(adapter, '100', false)).rejects.toThrow(/truncated/i)
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  it('rejects a reviewer-only review missing the Unresolved Questions tail', async () => {
    const adapter = makeAdapter()
    // No judge; reviewer output cut off before Unresolved Questions
    setupClaudeMocks('### Summary\nAll good.\n\n### Findings\n\n- **LOW – Z** (a.ts:1)\n  Desc.\n\n### Behavioral Diff\n- cut off here')

    await expect(review(adapter, '100', false)).rejects.toThrow(/truncated/i)
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 8d: Jenkins metadata appended to posted comment
// ===========================================================================

describe('CI job link in footer', () => {
  it('links Review #N to the build URL when a CI URL is present', async () => {
    const prev = process.env.BUILD_URL
    process.env.BUILD_URL = 'https://ci/job/pr-review/709/'
    try {
      const adapter = makeAdapter()
      setupClaudeMocks()

      await review(adapter, '100', false)

      const body = vi.mocked(adapter.postComment).mock.calls[0][1] as string
      expect(body).toContain('[Review #1](https://ci/job/pr-review/709/)')
      expect(body).not.toContain('<!-- jenkins')   // no visible HTML comment
    } finally {
      if (prev === undefined) delete process.env.BUILD_URL
      else process.env.BUILD_URL = prev
    }
  })

  it('uses a plain Review #N when no CI URL is present', async () => {
    const prev = process.env.BUILD_URL
    delete process.env.BUILD_URL
    try {
      const adapter = makeAdapter()
      setupClaudeMocks()

      await review(adapter, '100', false)

      const body = vi.mocked(adapter.postComment).mock.calls[0][1] as string
      expect(body).toContain('| Review #1 |')
      expect(body).not.toContain('[Review #1]')
    } finally {
      if (prev !== undefined) process.env.BUILD_URL = prev
    }
  })
})

// ===========================================================================
// Scenario 8e: MAX_FINDINGS cap injects a findings limit into the reviewer prompt
// ===========================================================================

describe('MAX_FINDINGS cap', () => {
  it('appends a findings limit to the reviewer prompt when set', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks()
    cfg.review.maxFindings = 3

    await review(adapter, '100', true)

    const promptArg = mockRunReview.mock.calls[0][8] as { content: string }
    expect(promptArg.content).toContain('FINDINGS LIMIT')
    expect(promptArg.content).toContain('at most 3')
  })

  it('does not append anything when MAX_FINDINGS is 0', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks()

    await review(adapter, '100', true)

    const promptArg = mockRunReview.mock.calls[0][8] as { content: string }
    expect(promptArg.content).not.toContain('FINDINGS LIMIT')
  })
})

// ===========================================================================
// Scenario 8f: TODO scan appends a deterministic section
// ===========================================================================

describe('TODO scan', () => {
  it('appends a TODOs Introduced section for markers in added lines', async () => {
    const todoDiff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n+const x = 1 // TODO: handle error\n'
    const adapter = makeAdapter({ getDiff: vi.fn().mockResolvedValue(todoDiff) })
    setupClaudeMocks()

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REVIEW')
    const body = vi.mocked(adapter.postComment).mock.calls[0][1] as string
    expect(body).toContain('### TODOs Introduced')
    expect(body).toContain('`src/app.ts:1`')
    expect(body).toContain('TODO: handle error')
  })

  it('omits the section when todoScan is disabled', async () => {
    const todoDiff = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n+const x = 1 // TODO: handle error\n'
    const adapter = makeAdapter({ getDiff: vi.fn().mockResolvedValue(todoDiff) })
    setupClaudeMocks()
    cfg.review.todoScan = false

    await review(adapter, '100', false)

    const body = vi.mocked(adapter.postComment).mock.calls[0][1] as string
    expect(body).not.toContain('TODOs Introduced')
  })
})

// ===========================================================================
// Scenario 8g: Token-budget degradation — drop file contexts before skipping
// ===========================================================================

describe('token-budget degradation', () => {
  it('drops file contexts and reviews diff-only when over MAX_INPUT_TOKENS', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks()
    mockFetchContext.mockResolvedValue([{ path: 'big.ts', content: 'x'.repeat(8000) }])
    cfg.anthropic.maxInputTokens = 100   // tiny budget — contexts blow it

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REVIEW')            // reviewed, not skipped
    expect(record!.degraded).toBe(true)
    expect(record!.context_files_fetched).toBe(0)    // contexts dropped
    expect(mockRunReview).toHaveBeenCalledTimes(1)
  })

  it('skips only when even the diff alone exceeds the budget', async () => {
    const bigDiff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,6 @@\n' + Array(6).fill('+' + 'a'.repeat(80)).join('\n') + '\n'
    const adapter = makeAdapter({ getDiff: vi.fn().mockResolvedValue(bigDiff) })
    setupClaudeMocks()
    mockFetchContext.mockResolvedValue([{ path: 'big.ts', content: 'y'.repeat(8000) }])
    cfg.anthropic.maxInputTokens = 100

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('SKIP')              // diff alone still over budget
    expect(record!.degraded).toBe(true)              // it tried degrading first
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 9: Claude returns empty → skip (never post)
// ===========================================================================

describe('Claude returns empty → skip', () => {
  it('does not post empty comment', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks('')

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('NO_CHANGE')
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 9b: Size thresholds count reviewable lines only (excluded bulk ignored)
// ===========================================================================

const SPEC_BULK = [
  'diff --git a/src/big.spec.ts b/src/big.spec.ts',
  '--- a/src/big.spec.ts',
  '+++ b/src/big.spec.ts',
  '@@ -1,3 +1,15 @@',
  ...Array.from({ length: 12 }, (_, i) => `+spec line ${i}`),
].join('\n')

const SMALL_APP_CHANGE = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,3 +10,6 @@',
  '+const a = 1',
  '+const b = 2',
  '+const c = 3',
].join('\n')

describe('size thresholds after exclusions', () => {
  it('reviews a PR whose raw size exceeds the max but reviewable size does not', async () => {
    const adapter = makeAdapter({
      getDiff: vi.fn().mockResolvedValue(SPEC_BULK + '\n' + SMALL_APP_CHANGE),
      getChangedFiles: vi.fn().mockResolvedValue([
        { path: 'src/big.spec.ts', status: 'modified' },
        { path: 'src/app.ts', status: 'modified' },
      ]),
    })
    cfg.thresholds = { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 10 }

    const record = await review(adapter, '100', true)

    // raw = 15 lines (> max 10), reviewable = 3 → must NOT skip
    expect(record!.action).toBe('REVIEW')
    expect(mockRunReview).toHaveBeenCalledTimes(1)
  })

  it('skips a PR with only excluded files without calling Claude', async () => {
    const adapter = makeAdapter({
      getDiff: vi.fn().mockResolvedValue(SPEC_BULK),
      getChangedFiles: vi.fn().mockResolvedValue([
        { path: 'src/big.spec.ts', status: 'modified' },
      ]),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toBe('no reviewable changes after exclusions')
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 10: Pre-post dedup — concurrent run already posted
// ===========================================================================

describe('pre-post dedup catches race condition', () => {
  it('skips when another run posted first', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn()
        .mockResolvedValueOnce([])  // CHECK_PREVIOUS_REVIEWS: no reviews yet
        .mockResolvedValueOnce([    // POST_REVIEW pre-post check: a concurrent run posted
          { id: '999', body: '### Concurrent' + footer(1, COMMIT_A), createdOn: '2026-03-11T11:42:00Z' },
        ]),
    })
    setupClaudeMocks()

    // NOT dry run — pre-post dedup only fires on real posts
    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.skip_reason).toContain('race condition')
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 10b: --force re-review on an already-reviewed commit must actually post —
// the pre-post dedup would otherwise swallow the very run the user forced
// ===========================================================================

describe('--force re-review (real run) bypasses pre-post dedup', () => {
  it('posts even though the commit is already reviewed', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: FLAGGED_PRIOR + footer(1, COMMIT_A), createdOn: PRIOR_AT },
      ]),
    })
    mockReviewer(reviewWith([NEW_FINDING]))

    const record = await review(adapter, '100', false, undefined, 're-review')

    expect(record!.action).toBe('RE_REVIEW')
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
    expect(adapter.getCommitDiff).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 11: --force clean → fresh review, no context
// ===========================================================================

describe('--force clean → fresh review', () => {
  it('ignores previous reviews', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
      ]),
    })
    setupClaudeMocks()

    const record = await review(adapter, '100', true, undefined, 'clean')

    expect(record!.action).toBe('REVIEW')
    expect(record!.review_number).toBe(1)
    expect(adapter.getRepliesToReviewComments).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 12: --force re-review → bypass dedup, keep context
// ===========================================================================

describe('--force re-review → bypass dedup with context', () => {
  it('re-reviews same commit with discussion', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Summary\nx\n\n### Findings\n- **MEDIUM – Prior issue** (`a.ts:1`)\n  desc' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [{ id: '300', parentId: '200', author: 'Vadim', body: 'False positive', createdOn: '2026-03-10T12:00:00Z' }],
        agentReplyCount: 0,
      }),
    })
    setupClaudeMocks()

    const record = await review(adapter, '100', true, undefined, 're-review')

    expect(record!.action).toBe('RE_REVIEW')
    expect(record!.review_number).toBe(2)
    expect(adapter.getRepliesToReviewComments).toHaveBeenCalledWith('100', ['200'], true)
  })
})

// ===========================================================================
// Scenario 13: Branch exclusion
// ===========================================================================

describe('branch exclusion', () => {
  it('skips source=main (merge-back PR)', async () => {
    const adapter = makeAdapter({
      getPullRequestInfo: vi.fn().mockResolvedValue({ ...makePRInfo(), sourceBranch: 'main', targetBranch: 'develop' }),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toContain('source branch')
  })

  it('skips target=main (release PR)', async () => {
    const adapter = makeAdapter({
      getPullRequestInfo: vi.fn().mockResolvedValue({ ...makePRInfo(), sourceBranch: 'feature/x', targetBranch: 'main' }),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toContain('target branch')
  })

  it('skips a wildcard source match (release/*) without fetching the diff', async () => {
    const adapter = makeAdapter({
      getPullRequestInfo: vi.fn().mockResolvedValue({ ...makePRInfo(), sourceBranch: 'release/1.2.0', targetBranch: 'develop' }),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toContain('SKIP_SOURCE_BRANCHES')
    expect(adapter.getDiff).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 15: Dedup round-trip with a real 40-char SHA — the footer the agent posts must
// be the exact key the next run dedups on, or every trigger re-reviews the same commit
// ===========================================================================

describe('dedup round-trip: posted footer → next run skips', () => {
  it('second run on the same 40-char commit is a DEDUP_SKIP without calling Claude', async () => {
    const fullSha = COMMIT_A + '4444555566667777888899990000'
    expect(fullSha).toHaveLength(40)
    const prInfo = vi.fn().mockResolvedValue(makePRInfo(fullSha))

    const first = makeAdapter({ getPullRequestInfo: prInfo })
    expect((await review(first, '100', false))!.action).toBe('REVIEW')
    const posted = vi.mocked(first.postComment).mock.calls[0][1] as string
    expect(extractCommitHash(posted)).toBe(COMMIT_A)

    const second = makeAdapter({
      getPullRequestInfo: prInfo,
      getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '200', body: posted, createdOn: '2026-03-10T10:00:00Z' }]),
    })
    const record = await review(second, '100', false)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.review_number).toBe(1)
    expect(second.getCommitDiff).not.toHaveBeenCalled()
    expect(mockRunReview).toHaveBeenCalledTimes(1)
    expect(second.postComment).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 16: Any thrown error → action=ERROR, still logged, rethrown for CI
// ===========================================================================

describe('error path → ERROR', () => {
  it('logs an ERROR usage record and rethrows', async () => {
    const adapter = makeAdapter({ getDiff: vi.fn().mockRejectedValue(new Error('Bitbucket 503')) })

    await expect(review(adapter, '100', false, undefined, 'off', true)).rejects.toThrow('Bitbucket 503')

    expect(logUsageRecord).toHaveBeenCalledTimes(1)
    const logged = vi.mocked(logUsageRecord).mock.calls[0][0]
    expect(logged.action).toBe('ERROR')
    expect(logged.error).toMatchObject({ message: 'Bitbucket 503' })
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})
