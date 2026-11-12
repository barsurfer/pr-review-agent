import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PrTooLargeError } from '../../vcs/adapter.js'
import type { VCSAdapter, PRInfo, ReviewComment, CommentReply } from '../../vcs/adapter.js'
import type { TriggerInfo } from '../types.js'

// ---------------------------------------------------------------------------
// Mocks — vi.mock factories are hoisted, so no external refs allowed
// ---------------------------------------------------------------------------

vi.mock('../../config.js', () => ({
  config: {
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', maxRetries: 1, maxInputTokens: 150000, maxTokens: 32000 },
    judge: { model: '', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3, benchmarkDeadlineSeconds: 840 },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3 },
    review: { maxFindings: 0, splitCheck: false, todoScan: true, effort: '', enableNitpicks: false, secondLook: false },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: ['main', 'master', 'release/*', 'hotfix/*'],
    skipTargetBranches: ['main', 'master'],
    onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: ['*.lock', 'package-lock.json', '*.spec.ts'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
  modelContextWindow: vi.fn(() => 200_000),
}))

vi.mock('../client.js', () => ({
  runReview: vi.fn(),
  runCommentResponse: vi.fn(),
  runJudge: vi.fn(),
  runBreadth: vi.fn(),
  runLens: vi.fn(),
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

// Reached only by tests that route runReview to the real client, to feed it a raw provider object.
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn() }))

// Import after mocks
import { review } from '../index.js'
import { config, modelContextWindow } from '../../config.js'
import { runReview, runCommentResponse, runJudge, runBreadth, runLens } from '../client.js'
import { LENS_REGISTRY, lensSystemPrompt, lensBriefing } from '../lenses.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { logUsageRecord } from '../usage.js'
import { applyJudgeDecisions } from '../judge-decisions.js'
import { renderReview, buildReplyFooter, hasReplyFooter, extractCommitHash, markdownHasFindings, type ReviewObject } from '../formatter.js'
import { createProvider } from '../../llm/provider.js'

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

function setupModelMocks(
  reviewText = '### Summary\nAll good.\n\n### Findings\n\nNo findings.\n\n### Unresolved Questions\nNone.',
  review: ReviewObject = reviewWith(),
) {
  mockLoadPrompt.mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  mockFetchContext.mockResolvedValue([])
  mockRunReview.mockResolvedValue({ text: reviewText, usage: { input_tokens: 1000, output_tokens: 200 }, review })
  mockRunCommentResponse.mockResolvedValue({ text: 'Thanks for clarifying.', usage: { input_tokens: 500, output_tokens: 100 } })
}

// Rendered text and typed object must agree, as they do in production (runReview renders the object).
const mockReviewer = (obj: ReviewObject) => setupModelMocks(renderReview(obj), obj)

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
  setupModelMocks()
  cfg.judge.model = ''
  cfg.reply.maxComments = 3
  cfg.anthropic.maxInputTokens = 150000
  cfg.review = { maxFindings: 0, splitCheck: false, todoScan: true, effort: '' }
  cfg.skipSourceBranches = ['main', 'master', 'release/*', 'hotfix/*']
  cfg.skipTargetBranches = ['main', 'master']
  cfg.onlyTargetBranches = []
  cfg.trigger = { event: '', commentAuthor: '', ignoreCommentAuthors: [] }
  cfg.diffExcludePatterns = ['*.lock', 'package-lock.json', '*.spec.ts']
  cfg.thresholds = { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 }
})

// ===========================================================================
// Scenario 1: First review on a new PR
// ===========================================================================

describe('first review (new PR)', () => {
  it('posts review → action=REVIEW, review_number=1', async () => {
    const adapter = makeAdapter()
    setupModelMocks()

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
    setupModelMocks()

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('REPLY')
    expect(mockRunCommentResponse).toHaveBeenCalledTimes(1)
    expect(mockRunReview).not.toHaveBeenCalled()
  })

  it('routes the reply through REPLY_MODEL when set, else the reviewer model', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [{ id: '300', parentId: '200', author: 'Vadim', body: 'Why HIGH?', createdOn: '2026-03-10T14:00:00Z' }],
        agentReplyCount: 0,
      }),
    })
    setupModelMocks()
    cfg.reply.model = 'claude-haiku-5-5'
    try {
      await review(adapter, '100', true)
      expect(mockRunCommentResponse.mock.calls[0][1]).toBe('claude-haiku-5-5')
    } finally {
      cfg.reply.model = ''
    }
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
// Scenario 4c: EVERY review resolved → no unresolved boundary left, so the supersede
// boundary falls back to the latest review (not the first, not "no boundary")
// ===========================================================================

describe('all reviews resolved → supersede boundary falls back to the latest review', () => {
  const allResolvedAdapter = (reply: CommentReply) => makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([
      { id: '200', body: '### Review' + footer(1, PRIOR_COMMIT), createdOn: '2026-03-09T10:00:00Z', resolved: true },
      { id: '201', body: '### Delta' + footer(2, COMMIT_A), createdOn: '2026-03-09T14:00:00Z', resolved: true },
    ]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [reply], agentReplyCount: 0 }),
  })

  it('treats a reply between the two resolved reviews as superseded', async () => {
    const adapter = allResolvedAdapter(devReply('2026-03-09T12:00:00Z'))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.skip_reason).toContain('no new commits')
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
  })

  it('still answers a reply posted after the latest resolved review', async () => {
    const fresh = devReply('2026-03-09T15:00:00Z', '201')
    const adapter = allResolvedAdapter(fresh)

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REPLY')
    expect(mockRunCommentResponse.mock.calls[0][5]).toEqual([fresh])
    expect(adapter.postReply).toHaveBeenCalledWith('100', '201', expect.any(String))
  })
})

// ===========================================================================
// Scenario 4d: New-commit path — the JUDGE_REVIEW gate uses the same supersede boundary
// as CHECK_REPLIES, so a resolved later review doesn't bury a dev reply here either
// ===========================================================================

describe('gate (new-commit path): resolved later review does not bury an unanswered dev reply', () => {
  it('answers the dev reply instead of suppressing as NO_NEW_FINDINGS', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, '111111111111'), createdOn: '2026-03-09T10:00:00Z' },
        { id: '201', body: '### Delta' + footer(2, '222222222222'), createdOn: '2026-03-09T14:00:00Z', resolved: true },
      ]),
      getCommitDiff: vi.fn().mockResolvedValue(DIFF),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [{ id: '300', parentId: '200', author: 'Fernando', body: 'Fixed in d4f2b43e.', createdOn: '2026-03-09T12:00:00Z' }],
        agentReplyCount: 0,
      }),
    })
    setupModelMocks(undefined, reviewWith([]))

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
    setupModelMocks(undefined, reviewWith([], { delta_stats: { resolved: 1, still_open: 0, new_findings: 0 } }))

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
    setupModelMocks(undefined, reviewWith([]))

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
    setupModelMocks(undefined, reviewWith([]))

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
      replyParent: vi.mocked(adapter.postReply).mock.calls[0]?.[1],
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
    const followUp = devReply('2026-03-09T12:00:00Z', 'agent-2026-03-09T11:30:00Z')
    const { record, posted, replied, replyParent } = await gateWith([
      devReply('2026-03-09T09:00:00Z'), devReply('2026-03-09T11:00:00Z'), agentReply('2026-03-09T11:30:00Z'), followUp,
    ])
    expect(record.action).toBe('REPLY')
    expect(replied).toBe(1)
    expect(posted).toBe(0)
    // Only the open follow-up goes to the reply model — stale or already-answered replies would be re-answered
    expect(mockRunCommentResponse.mock.calls[0][5]).toEqual([followUp])
    expect(replyParent).toBe(followUp.parentId)
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

  it('never runs the breadth pass on a re-review, even when enabled', async () => {
    cfg.judge.model = 'judge-model'
    cfg.breadth.enabled = true
    try {
      const adapter = reReviewAdapter(FLAGGED_PRIOR)
      mockReviewer(reviewWith([], { delta_stats: { resolved: 1, still_open: 0, new_findings: 0 } }))

      const record = await review(adapter, '100', false)

      expect(vi.mocked(runBreadth)).not.toHaveBeenCalled()
      expect(record!.breadth_status).toBe('skipped_rereview')
    } finally {
      cfg.breadth.enabled = false
    }
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
// Scenario 6j: Reply-priority gate honors MAX_REPLY_COMMENTS — once the agent's reply
// budget is spent, an unanswered dev reply on a 0-finding re-review is skipped (0 = unlimited)
// ===========================================================================

describe('reply-priority gate — reply limit', () => {
  const agentRepliesThenDev = (n: number) => [
    ...Array.from({ length: n }, (_, i) => agentReply(`2026-03-09T10:1${i}:00Z`)),
    devReply('2026-03-09T12:00:00Z'),
  ]

  it.each([
    { maxComments: 3, agentReplies: 3, expected: 'DEDUP_SKIP' },
    { maxComments: 3, agentReplies: 2, expected: 'REPLY' },
    { maxComments: 0, agentReplies: 5, expected: 'REPLY' },
  ])('MAX_REPLY_COMMENTS=$maxComments with $agentReplies agent replies → $expected', async ({ maxComments, agentReplies, expected }) => {
    cfg.reply.maxComments = maxComments
    const adapter = reReviewAdapter(CLEAN_PRIOR, agentRepliesThenDev(agentReplies))
    mockReviewer(reviewWith([], { delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } }))

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe(expected)
    expect(adapter.postComment).not.toHaveBeenCalled()
    if (expected === 'DEDUP_SKIP') {
      expect(record!.skip_reason).toBe(`reply limit reached (${agentReplies}/${maxComments})`)
      expect(mockRunCommentResponse).not.toHaveBeenCalled()
      expect(adapter.postReply).not.toHaveBeenCalled()
    } else {
      expect(adapter.postReply).toHaveBeenCalledTimes(1)
    }
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
// Scenario 7c: PR too large to fetch completely → clean SKIP (never an ERROR, no Claude)
// ===========================================================================

describe('getDiff throws PrTooLargeError → SKIP', () => {
  it('skips cleanly without calling Claude or posting', async () => {
    const adapter = makeAdapter({
      getDiff: vi.fn().mockRejectedValue(new PrTooLargeError('100', 'diff exceeds 25MB')),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toContain('PR too large to review')
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  it('a generic getDiff error still ERRORs (guards against over-catching)', async () => {
    const adapter = makeAdapter({
      getDiff: vi.fn().mockRejectedValue(new Error('boom')),
    })

    await expect(review(adapter, '100', true)).rejects.toThrow('boom')
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 8: Claude returns NO_CHANGE → skip (never post)
// ===========================================================================

describe('Claude returns NO_CHANGE on a re-review → skip', () => {
  // NO_CHANGE is only valid when a prior review exists — set up a re-review (old-commit footer
  // + a delta diff) so CALL_MODEL is reached with previousReviews populated.
  const reReviewAdapter = () => makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([
      { id: '200', body: '### Old' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
    ]),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),
  })

  it('does not post NO_CHANGE as a comment', async () => {
    const adapter = reReviewAdapter()
    setupModelMocks('NO_CHANGE')

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('NO_CHANGE')
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  it('does not post summary + standalone NO_CHANGE line (PR 8718 regression)', async () => {
    const adapter = reReviewAdapter()
    setupModelMocks('### Summary\n\nNo new findings. New commits contain only cosmetic changes.\n\nNO_CHANGE')

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('NO_CHANGE')
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  const noChangeReReview = (replies: CommentReply[], agentReplyCount = 0) => makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '200', body: '### Old' + footer(1, PRIOR_COMMIT), createdOn: PRIOR_AT }]),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),   // new commits → delta re-review path
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies, agentReplyCount }),
  })

  it('answers an unanswered developer reply even when the re-review is NO_CHANGE (PR 8989 bug)', async () => {
    const adapter = noChangeReReview([devReply('2026-03-10T11:00:00Z', '200')])
    setupModelMocks('NO_CHANGE')   // reviewer finds no material change in the delta

    const record = await review(adapter, '100', false)

    expect(mockRunReview).toHaveBeenCalledTimes(1)   // the delta re-review actually ran
    expect(mockRunJudge).not.toHaveBeenCalled()      // NO_CHANGE → nothing to judge
    expect(record!.action).toBe('REPLY')
    expect(record!.skip_reason).toBeNull()           // a reply is not a skip
    expect(adapter.postReply).toHaveBeenCalledTimes(1)
    expect(vi.mocked(adapter.postReply).mock.calls[0][1]).toBe('200')   // threaded under the review
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  it('does not answer a stale reply after NO_CHANGE (older than the latest review)', async () => {
    const adapter = noChangeReReview([devReply('2026-03-08T10:00:00Z', '200')])   // before PRIOR_AT
    setupModelMocks('NO_CHANGE')

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('NO_CHANGE')
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
    expect(adapter.postReply).not.toHaveBeenCalled()
  })

  it('does not answer after NO_CHANGE once the reply limit is reached', async () => {
    cfg.reply.maxComments = 2
    const adapter = noChangeReReview([devReply('2026-03-10T11:00:00Z', '200')], 2)
    setupModelMocks('NO_CHANGE')

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.skip_reason).toMatch(/reply limit/i)
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
    expect(adapter.postReply).not.toHaveBeenCalled()
  })

  it('errors instead of silently skipping when NO_CHANGE fires on a FIRST review (build 10233 bug)', async () => {
    const adapter = makeAdapter()   // no previous reviews → first review
    setupModelMocks('NO_CHANGE')

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
    setupModelMocks('### Summary\nRisky refactor.\n\n### Findings\n\n- **MEDIUM – Substring matching** (a.ts:1)\n  Over-matches rows.', reviewWith([{ severity: 'MEDIUM', title: 'Substring matching', body: 'Over-matches rows.' }]))
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
    setupModelMocks('### Summary\nRisky.\n\n### Findings\n\n- **MEDIUM – Something** (a.ts:1)\n  Desc.', reviewWith([{ severity: 'MEDIUM', title: 'Something', body: 'Desc.' }]))
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
    setupModelMocks('### Summary\nRisky.\n\n### Findings\n\n- **MEDIUM – X** (a.ts:1)\n  Desc.', reviewWith([{ severity: 'MEDIUM', title: 'X', body: 'Desc.' }]))
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
    setupModelMocks('### Summary\nAll good.\n\n### Findings\n\n- **LOW – Z** (a.ts:1)\n  Desc.\n\n### Behavioral Diff\n- cut off here')

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
      setupModelMocks()

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
      setupModelMocks()

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
    setupModelMocks()
    cfg.review.maxFindings = 3

    await review(adapter, '100', true)

    const promptArg = mockRunReview.mock.calls[0][8] as { content: string }
    expect(promptArg.content).toContain('FINDINGS LIMIT')
    expect(promptArg.content).toContain('at most 3')
  })

  it('does not append anything when MAX_FINDINGS is 0', async () => {
    const adapter = makeAdapter()
    setupModelMocks()

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
    setupModelMocks()

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
    setupModelMocks()
    cfg.review.todoScan = false

    await review(adapter, '100', false)

    const body = vi.mocked(adapter.postComment).mock.calls[0][1] as string
    expect(body).not.toContain('TODOs Introduced')
  })
})

// ===========================================================================
// Scenario 8f: Normal mode — a judge failure must still error (benchmark's catch must not leak)
// ===========================================================================

describe('normal mode: judge failure surfaces as ERROR (not swallowed)', () => {
  it('rethrows a judge rejection when no outcome sink is set', async () => {
    cfg.judge.model = 'claude-sonnet-5'
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Summary\nx\n\n### Findings\n- **MEDIUM – Prior** (`a.ts:1`)\n  d' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
      ]),
      getCommitDiff: vi.fn().mockResolvedValue(DIFF),
    })
    setupModelMocks('### Summary\nRisky.\n\n### Findings\n- **MEDIUM – New** (`a.ts:1`)\n  desc', reviewWith([{ severity: 'MEDIUM', title: 'New', file: 'a.ts', lines: '1', body: 'desc' }]))
    mockRunJudge.mockRejectedValue(new Error('judge boom'))

    await expect(review(adapter, '100', false)).rejects.toThrow(/judge boom/)
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})

describe('breadth review and the judge in normal mode', () => {
  const NAMES = ['a', 'b', 'c', 'd', 'e']
  const MULTI_DIFF = NAMES.map(n => `diff --git a/src/${n}.ts b/src/${n}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/${n}.ts\n@@ -0,0 +1,2 @@\n+export const ${n} = 1\n+export const ${n}2 = 2\n`).join('')
  const bigAdapter = () => makeAdapter({
    getDiff: vi.fn().mockResolvedValue(MULTI_DIFF),
    getChangedFiles: vi.fn().mockResolvedValue(NAMES.map(n => ({ path: `src/${n}.ts`, status: 'added' }))),
  })
  const A_BUG: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'A bug', file: 'src/a.ts', lines: '1', body: 'a is wrong.' }
  const B_BUG: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'Same bug in b', file: 'src/b.ts', lines: '1', body: 'b repeats a.' }
  const posted = (adapter: VCSAdapter) => vi.mocked(adapter.postComment).mock.calls[0][1] as string

  const mockBreadth = (...findings: ReviewObject['findings']) =>
    vi.mocked(runBreadth).mockResolvedValue({ findings, usage: { input_tokens: 300, output_tokens: 100 }, promptHash: 'abc123' })

  // Real decision application, so what the judge "keeps" is rendered and anchored exactly as production does.
  const mockJudgeKeepsAll = () => mockRunJudge.mockImplementation(async (_k, _m, _r, _t, _e, diff, judgeInput, _f, policy, _l, breadthFrom) => {
    const judged = applyJudgeDecisions(judgeInput.findings, {
      decisions: judgeInput.findings.map((_, i) => ({ candidate_id: `c${i}`, reason_category: 'validated' as const, evidence: 'src/a.ts:1', note: 'n', score: 8 })),
      summary: 'ok', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80,
    }, policy, judgeInput.can_be_split, diff, breadthFrom)
    return { text: judged.markdown, usage: { input_tokens: 800, output_tokens: 300 }, scores: judged.scores, promptHash: 'judgehash', decisions: judged.decisions, anomalies: judged.anomalies, kept: judged.kept }
  })

  beforeEach(() => {
    cfg.judge.model = 'judge-model'
    cfg.breadth.enabled = true
  })
  afterEach(() => {
    cfg.breadth.enabled = false
    vi.useRealTimers()
  })

  it('posts the reviewer clean review when the judge fails on breadth-only candidates, as main would without a judge', async () => {
    const adapter = bigAdapter()
    const clean = reviewWith([])
    mockReviewer(clean)
    mockBreadth(B_BUG)
    mockRunJudge.mockRejectedValue(new Error('judge boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const record = await review(adapter, '100', false)

    expect(mockRunJudge).toHaveBeenCalledTimes(1)
    expect(record).toMatchObject({ action: 'REVIEW', judge_status: 'failed', breadth_status: 'succeeded' })
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
    const body = posted(adapter)
    expect(body).toContain(renderReview(clean))
    expect(body).not.toContain('Same bug in b')
    expect(body).not.toContain('Merge Confidence')
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('Judge failed (judge boom)')
    warnSpy.mockRestore()
  })

  it('still throws on a judge failure when the reviewer had findings, so CI retries', async () => {
    const adapter = bigAdapter()
    mockReviewer(reviewWith([A_BUG]))
    mockBreadth(B_BUG)
    mockRunJudge.mockRejectedValue(new Error('judge boom'))

    await expect(review(adapter, '100', false)).rejects.toThrow(/judge boom/)
    expect(adapter.postComment).not.toHaveBeenCalled()
  })

  it('posts a breadth finding the judge keeps, judged together with the reviewer findings', async () => {
    const adapter = bigAdapter()
    mockReviewer(reviewWith([A_BUG]))
    mockBreadth(B_BUG)
    mockJudgeKeepsAll()

    const record = await review(adapter, '100', false)

    const [judgeInput, breadthFrom] = [mockRunJudge.mock.calls[0][6], mockRunJudge.mock.calls[0][10]]
    expect(judgeInput.findings.map(f => f.title)).toEqual(['A bug', 'Same bug in b'])
    expect(breadthFrom).toBe(1)
    const body = posted(adapter)
    expect(body).toContain('**MEDIUM – A bug** (`src/a.ts:1`)')
    expect(body).toContain('**MEDIUM – Same bug in b** (`src/b.ts:1`)')
    expect(body).toContain('### Merge Confidence: 80%')
    expect(record!.review_candidates!.map(c => c.origin)).toEqual(['review', 'breadth'])
  })

  it('gates a breadth anchor on changed lines in the posted comment, but not the reviewer one', async () => {
    const adapter = bigAdapter()
    mockReviewer(reviewWith([{ ...A_BUG, lines: '99' }]))
    mockBreadth({ ...B_BUG, lines: '99' })
    mockJudgeKeepsAll()

    await review(adapter, '100', false)

    const body = posted(adapter)
    expect(body).toContain('**MEDIUM – A bug** (`src/a.ts:99`)')
    expect(body).toContain('**MEDIUM – Same bug in b** (`src/b.ts`)')
  })

  it('has no time guard outside benchmark mode: a slow first pass still gets breadth', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const clean = reviewWith([])
    mockReviewer(clean)
    mockRunReview.mockImplementation(async () => { vi.advanceTimersByTime(10_000_000); return { text: renderReview(clean), usage: { input_tokens: 1000, output_tokens: 200 }, review: clean } })
    mockBreadth(B_BUG)
    mockJudgeKeepsAll()

    const record = await review(bigAdapter(), '100', true)

    expect(record!.breadth_status).toBe('succeeded')
  })
})

// ===========================================================================
// Scenario 8f2: Second-look — re-read already-flagged files for additional issues
// ===========================================================================

describe('second-look review and the judge in normal mode', () => {
  const NAMES = ['a', 'b', 'c', 'd', 'e']
  const MULTI_DIFF = NAMES.map(n => `diff --git a/src/${n}.ts b/src/${n}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/${n}.ts\n@@ -0,0 +1,2 @@\n+export const ${n} = 1\n+export const ${n}2 = 2\n`).join('')
  const bigAdapter = () => makeAdapter({
    getDiff: vi.fn().mockResolvedValue(MULTI_DIFF),
    getChangedFiles: vi.fn().mockResolvedValue(NAMES.map(n => ({ path: `src/${n}.ts`, status: 'added' }))),
  })
  const A_BUG: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'A bug', file: 'src/a.ts', lines: '1', body: 'a is wrong.' }
  const A_BUG2: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'Second bug in a', file: 'src/a.ts', lines: '2', body: 'a2 is also wrong.' }
  const B_BUG: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'Same bug in b', file: 'src/b.ts', lines: '1', body: 'b repeats a.' }
  const posted = (adapter: VCSAdapter) => vi.mocked(adapter.postComment).mock.calls[0][1] as string
  const isSecondLook = (c: unknown[]) => c[11] === 'second-look'

  // runBreadth backs both the breadth and second-look passes; branch on the label arg (index 11).
  const mockPasses = (opts: { breadth?: ReviewObject['findings']; secondLook?: ReviewObject['findings'] }) =>
    vi.mocked(runBreadth).mockImplementation(async (...args) => ({
      findings: args[11] === 'second-look' ? (opts.secondLook ?? []) : (opts.breadth ?? []),
      usage: { input_tokens: 300, output_tokens: 100 }, promptHash: args[11] === 'second-look' ? 'slhash' : 'brhash',
    }))

  const mockJudgeKeepsAll = () => mockRunJudge.mockImplementation(async (_k, _m, _r, _t, _e, diff, judgeInput, _f, policy, _l, boundary) => {
    const judged = applyJudgeDecisions(judgeInput.findings, {
      decisions: judgeInput.findings.map((_, i) => ({ candidate_id: `c${i}`, reason_category: 'validated' as const, evidence: 'src/a.ts:1', note: 'n', score: 8 })),
      summary: 'ok', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80,
    }, policy, judgeInput.can_be_split, diff, boundary)
    return { text: judged.markdown, usage: { input_tokens: 800, output_tokens: 300 }, scores: judged.scores, promptHash: 'judgehash', decisions: judged.decisions, anomalies: judged.anomalies, kept: judged.kept }
  })

  beforeEach(() => {
    cfg.judge.model = 'judge-model'
    cfg.review.secondLook = true
  })
  afterEach(() => {
    cfg.review.secondLook = false
    cfg.breadth.enabled = false
    vi.useRealTimers()
  })

  it('re-reads only the flagged files, excludes known findings, and tags its output second_look', async () => {
    const adapter = bigAdapter()
    mockReviewer(reviewWith([A_BUG]))
    mockPasses({ secondLook: [A_BUG2] })
    mockJudgeKeepsAll()

    const record = await review(adapter, '100', false)

    // Breadth is off, so the only runBreadth call is second-look; its diff holds the flagged file alone.
    const slCall = vi.mocked(runBreadth).mock.calls.find(isSecondLook)!
    expect(slCall[6]).toContain('src/a.ts')
    expect(slCall[6]).not.toContain('src/b.ts')
    expect(slCall[9]).toContain('A bug')   // exclusion briefing names the known finding
    const [judgeInput, boundary] = [mockRunJudge.mock.calls[0][6], mockRunJudge.mock.calls[0][10]]
    expect(judgeInput.findings.map(f => f.title)).toEqual(['A bug', 'Second bug in a'])
    expect(boundary).toBe(1)
    expect(record!.review_candidates!.map(c => c.origin)).toEqual(['review', 'second_look'])
    expect(record!.second_look_status).toBe('succeeded')
    expect(posted(adapter)).toContain('**MEDIUM – Second bug in a** (`src/a.ts:2`)')
  })

  it('orders judge candidates review, breadth, second_look when all three produce findings', async () => {
    cfg.breadth.enabled = true
    const adapter = bigAdapter()
    mockReviewer(reviewWith([A_BUG]))
    mockPasses({ breadth: [B_BUG], secondLook: [A_BUG2] })
    mockJudgeKeepsAll()

    const record = await review(adapter, '100', false)

    expect(record!.review_candidates!.map(c => c.origin)).toEqual(['review', 'breadth', 'second_look'])
    // Boundary is the reviewer count: breadth + second_look are both held to changed lines.
    expect(mockRunJudge.mock.calls[0][10]).toBe(1)
  })

  it('skips when the reviewer flagged nothing to re-read', async () => {
    const adapter = bigAdapter()
    mockReviewer(reviewWith([]))
    mockPasses({ secondLook: [A_BUG2] })

    const record = await review(adapter, '100', false)

    expect(vi.mocked(runBreadth).mock.calls.some(isSecondLook)).toBe(false)
    expect(record!.second_look_status).toBe('skipped_no_findings')
  })

  it('skips without a judge, since its candidates are only posted after judging', async () => {
    cfg.judge.model = ''
    const adapter = bigAdapter()
    mockReviewer(reviewWith([A_BUG]))
    mockPasses({ secondLook: [A_BUG2] })

    const record = await review(adapter, '100', false)

    expect(vi.mocked(runBreadth).mock.calls.some(isSecondLook)).toBe(false)
    expect(record!.second_look_status).toBe('skipped_no_judge')
  })

  it('falls back to review + breadth when the second-look call fails', async () => {
    cfg.breadth.enabled = true
    const adapter = bigAdapter()
    mockReviewer(reviewWith([A_BUG]))
    vi.mocked(runBreadth).mockImplementation(async (...args) => {
      if (args[11] === 'second-look') throw new Error('second-look boom')
      return { findings: [B_BUG], usage: { input_tokens: 300, output_tokens: 100 }, promptHash: 'brhash' }
    })
    mockJudgeKeepsAll()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const record = await review(adapter, '100', false)

    expect(record!.second_look_status).toBe('failed')
    expect(record!.review_candidates!.map(c => c.origin)).toEqual(['review', 'breadth'])
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('Second-look FAILED')
    warnSpy.mockRestore()
  })

  it('is a byte-level pass-through when disabled: no call, status disabled, origins unchanged', async () => {
    cfg.review.secondLook = false
    const adapter = bigAdapter()
    mockReviewer(reviewWith([A_BUG]))
    mockPasses({ secondLook: [A_BUG2] })
    mockJudgeKeepsAll()

    const record = await review(adapter, '100', false)

    expect(vi.mocked(runBreadth).mock.calls.some(isSecondLook)).toBe(false)
    expect(record!.second_look_status).toBe('disabled')
    expect(record!.review_candidates!.map(c => c.origin)).toEqual(['review'])
  })

  it('never runs on a re-review, even when enabled', async () => {
    const adapter = reReviewAdapter(FLAGGED_PRIOR, [], {
      getDiff: vi.fn().mockResolvedValue(MULTI_DIFF),
      getChangedFiles: vi.fn().mockResolvedValue(NAMES.map(n => ({ path: `src/${n}.ts`, status: 'added' }))),
    })
    mockReviewer(reviewWith([A_BUG], { delta_stats: { resolved: 0, still_open: 1, new_findings: 1 } }))
    mockPasses({ secondLook: [A_BUG2] })
    mockJudgeKeepsAll()

    const record = await review(adapter, '100', false)

    expect(vi.mocked(runBreadth).mock.calls.some(isSecondLook)).toBe(false)
    expect(record!.second_look_status).toBe('skipped_rereview')
  })

  describe('recall levers (default off)', () => {
    afterEach(() => {
      cfg.review.secondLookBreadthTargets = false
      cfg.judge.shownAnchors = false
      cfg.judge.quality = false
      cfg.breadth.priorityTargets = false
    })

    it('SL_BREADTH on: re-reads review- and breadth-flagged files and briefs both known findings', async () => {
      cfg.breadth.enabled = true
      cfg.review.secondLookBreadthTargets = true
      mockReviewer(reviewWith([A_BUG]))
      mockPasses({ breadth: [B_BUG], secondLook: [A_BUG2] })
      mockJudgeKeepsAll()

      const record = await review(bigAdapter(), '100', false)

      const slCall = vi.mocked(runBreadth).mock.calls.find(isSecondLook)!
      expect(slCall[6]).toContain('src/a.ts')
      expect(slCall[6]).toContain('src/b.ts')
      expect(slCall[6]).not.toContain('src/c.ts')
      expect(slCall[9]).toContain('A bug')
      expect(slCall[9]).toContain('Same bug in b')
      expect(record!.review_candidates!.map(c => c.origin)).toEqual(['review', 'breadth', 'second_look'])
      expect(record!.recall_levers.sl_breadth).toBe(true)
    })

    it('SL_BREADTH on: a breadth-only finding still triggers second-look when the reviewer found nothing', async () => {
      cfg.breadth.enabled = true
      cfg.review.secondLookBreadthTargets = true
      mockReviewer(reviewWith([]))
      mockPasses({ breadth: [B_BUG], secondLook: [] })
      mockJudgeKeepsAll()

      const record = await review(bigAdapter(), '100', false)

      expect(record!.second_look_status).toBe('succeeded')
      const slCall = vi.mocked(runBreadth).mock.calls.find(isSecondLook)!
      expect(slCall[6]).toContain('src/b.ts')
      expect(slCall[6]).not.toContain('src/a.ts')
    })

    it('SL_BREADTH off: breadth-only findings do not trigger second-look and review-only targeting is unchanged', async () => {
      cfg.breadth.enabled = true
      mockReviewer(reviewWith([]))
      mockPasses({ breadth: [B_BUG], secondLook: [A_BUG2] })
      mockJudgeKeepsAll()

      const record = await review(bigAdapter(), '100', false)

      expect(record!.second_look_status).toBe('skipped_no_findings')
      expect(vi.mocked(runBreadth).mock.calls.some(isSecondLook)).toBe(false)
    })

    it('J_SHOWN_ANCHOR on: hands the judge per-pass shown sources; off: no options argument at all', async () => {
      cfg.breadth.enabled = true
      cfg.judge.shownAnchors = true
      mockReviewer(reviewWith([A_BUG]))
      mockPasses({ breadth: [B_BUG], secondLook: [A_BUG2] })
      mockJudgeKeepsAll()
      await review(bigAdapter(), '100', false)

      const options = mockRunJudge.mock.calls[0][11]
      expect(options?.shownAnchors?.secondLookFrom).toBe(2)
      expect([...options!.shownAnchors!.breadth!.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'])
      expect([...options!.shownAnchors!.secondLook!.keys()]).toEqual(['src/a.ts'])
      expect(vi.mocked(runBreadth).mock.calls.find(isSecondLook)![8]).toContain('unchanged line you were shown')

      mockRunJudge.mockClear()
      vi.mocked(runBreadth).mockClear()
      cfg.judge.shownAnchors = false
      mockJudgeKeepsAll()
      await review(bigAdapter(), '100', false)
      expect(mockRunJudge.mock.calls[0]).toHaveLength(11)
      expect(vi.mocked(runBreadth).mock.calls.find(isSecondLook)![8]).not.toContain('unchanged line you were shown')
    })

    it('J_QUALITY on: passes quality to the judge', async () => {
      cfg.judge.quality = true
      mockReviewer(reviewWith([A_BUG]))
      mockPasses({})
      mockJudgeKeepsAll()
      const record = await review(bigAdapter(), '100', false)

      expect(mockRunJudge.mock.calls[0][11]).toEqual({ quality: true, shownAnchors: undefined })
      expect(record!.recall_levers.j_quality).toBe(true)
    })

    it('B_PRIORITY on: briefs prioritized targets and logs the actual selection; off keeps diff order', async () => {
      cfg.breadth.enabled = true
      cfg.breadth.priorityTargets = true
      mockReviewer(reviewWith([A_BUG]))
      mockPasses({})
      mockJudgeKeepsAll()
      const on = await review(bigAdapter(), '100', false)
      const briefing = vi.mocked(runBreadth).mock.calls.find(c => !isSecondLook(c))![9] as string
      expect(briefing).toContain('prioritized targets')
      expect(on!.untouched_files).toMatchObject({ count: 4, cut: 0, deprioritized: 0 })

      vi.mocked(runBreadth).mockClear()
      cfg.breadth.priorityTargets = false
      const off = await review(bigAdapter(), '100', false)
      expect(vi.mocked(runBreadth).mock.calls.find(c => !isSecondLook(c))![9]).not.toContain('prioritized targets')
      expect(off!.untouched_files).toEqual({ count: 4, paths: ['src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'], cut: 0 })
    })
  })
})

describe('lens review and the judge in normal mode', () => {
  const NAMES = ['a', 'b', 'c', 'd', 'e']
  const MULTI_DIFF = NAMES.map(n => `diff --git a/src/${n}.ts b/src/${n}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/${n}.ts\n@@ -0,0 +1,2 @@\n+export const ${n} = 1\n+export const ${n}2 = 2\n`).join('')
  const CHANGED = NAMES.map(n => ({ path: `src/${n}.ts`, status: 'added' as const }))
  const CONTEXTS = NAMES.map(n => ({ path: `src/${n}.ts`, content: `export const ${n} = 1\nexport const ${n}2 = 2` }))
  const bigAdapter = () => makeAdapter({ getDiff: vi.fn().mockResolvedValue(MULTI_DIFF), getChangedFiles: vi.fn().mockResolvedValue(CHANGED) })
  const A_BUG: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'A bug', file: 'src/a.ts', lines: '1', body: 'a is wrong.' }
  const A_BUG2: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'Second bug in a', file: 'src/a.ts', lines: '2', body: 'a2 is also wrong.' }
  const B_BUG: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'Same bug in b', file: 'src/b.ts', lines: '1', body: 'b repeats a.' }
  const C_LEAK: ReviewObject['findings'][number] = { severity: 'HIGH', title: 'Leak in c', file: 'src/c.ts', lines: '2', body: 'c never closes.' }
  const D_INJECT: ReviewObject['findings'][number] = { severity: 'HIGH', title: 'Injection in d', file: 'src/d.ts', lines: '1', body: 'd builds SQL from input.' }
  const posted = (adapter: VCSAdapter) => vi.mocked(adapter.postComment).mock.calls[0][1] as string
  const mockRunLens = vi.mocked(runLens)
  const lensLabels = () => mockRunLens.mock.calls.map(c => c[11])

  const reviewWithContexts = (obj: ReviewObject) => { mockReviewer(obj); mockFetchContext.mockResolvedValue(CONTEXTS) }
  const mockLenses = (byName: Record<string, ReviewObject['findings'] | Error>) =>
    mockRunLens.mockImplementation(async (...args) => {
      const out = byName[String(args[11]).replace(/^lens:/, '')] ?? []
      if (out instanceof Error) throw out
      return { findings: out, usage: { input_tokens: 400, output_tokens: 120 }, promptHash: `hash-${args[11]}` }
    })
  const mockPasses = (opts: { breadth?: ReviewObject['findings']; secondLook?: ReviewObject['findings'] }) =>
    vi.mocked(runBreadth).mockImplementation(async (...args) => ({
      findings: args[11] === 'second-look' ? (opts.secondLook ?? []) : (opts.breadth ?? []),
      usage: { input_tokens: 300, output_tokens: 100 }, promptHash: 'passhash',
    }))
  const mockJudgeKeepsAll = () => mockRunJudge.mockImplementation(async (_k, _m, _r, _t, _e, diff, judgeInput, _f, policy, _l, boundary, options) => {
    const judged = applyJudgeDecisions(judgeInput.findings, {
      decisions: judgeInput.findings.map((_, i) => ({ candidate_id: `c${i}`, reason_category: 'validated' as const, evidence: 'src/a.ts:1', note: 'n', score: 8 })),
      summary: 'ok', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80,
    }, policy, judgeInput.can_be_split, diff, boundary, options)
    return { text: judged.markdown, usage: { input_tokens: 800, output_tokens: 300 }, scores: judged.scores, promptHash: 'judgehash', decisions: judged.decisions, anomalies: judged.anomalies, kept: judged.kept }
  })

  beforeEach(() => {
    cfg.judge.model = 'judge-model'
    cfg.lenses = { enabled: true, list: 'reliability+security', model: '' }
  })
  afterEach(() => {
    cfg.lenses = { enabled: false, list: '', model: '' }
    cfg.breadth.enabled = false
    cfg.judge.shownAnchors = false
    vi.useRealTimers()
  })

  it('runs each lens once, in list order, on the full PR with base prompt + overlay; a later lens is briefed on earlier lens findings', async () => {
    reviewWithContexts(reviewWith([A_BUG]))
    mockLenses({ reliability: [C_LEAK], security: [D_INJECT] })
    mockJudgeKeepsAll()

    await review(bigAdapter(), '100', false)

    expect(lensLabels()).toEqual(['lens:reliability', 'lens:security'])
    const reviewerCall = mockRunReview.mock.calls[0]
    for (const [i, name] of ['reliability', 'security'].entries()) {
      const call = mockRunLens.mock.calls[i]
      expect(call.slice(1, 5)).toEqual([cfg.anthropic.model, cfg.anthropic.maxRetries, cfg.anthropic.maxTokens, ''])
      expect(call[6]).toBe(reviewerCall[6])
      expect(call[7]).toEqual(CONTEXTS)
      expect(call[8]).toBe(`System prompt here\n\n${LENS_REGISTRY[name].overlay}`)
    }
    expect(mockRunLens.mock.calls[0][9]).toBe(lensBriefing([A_BUG]))
    expect(mockRunLens.mock.calls[1][9]).toBe(lensBriefing([A_BUG, C_LEAK]))
  })

  it('unions lens candidates after second-look into the one judge call: origin logged, never shown to the judge', async () => {
    cfg.breadth.enabled = true
    cfg.review.secondLook = true
    reviewWithContexts(reviewWith([A_BUG]))
    mockPasses({ breadth: [B_BUG], secondLook: [A_BUG2] })
    mockLenses({ reliability: [C_LEAK], security: [D_INJECT] })
    mockJudgeKeepsAll()

    const adapter = bigAdapter()
    const record = await review(adapter, '100', false)

    expect(mockRunJudge).toHaveBeenCalledTimes(1)
    const judgeInput = mockRunJudge.mock.calls[0][6]
    expect(judgeInput.findings.map(f => f.title)).toEqual(['A bug', 'Same bug in b', 'Second bug in a', 'Leak in c', 'Injection in d'])
    expect(judgeInput.findings.some(f => 'origin' in f)).toBe(false)
    expect(mockRunJudge.mock.calls[0][10]).toBe(1)
    expect(mockRunJudge.mock.calls[0]).toHaveLength(11)
    expect(record!.review_candidates!.map(c => c.origin)).toEqual(['review', 'breadth', 'second_look', 'lens:reliability', 'lens:security'])
    expect(posted(adapter)).toContain('**HIGH – Injection in d** (`src/d.ts:1`)')
  })

  it('runs the judge when the reviewer was clean but a lens found something', async () => {
    reviewWithContexts(reviewWith([]))
    mockLenses({ security: [D_INJECT] })
    mockJudgeKeepsAll()

    const adapter = bigAdapter()
    const record = await review(adapter, '100', false)

    expect(mockRunJudge).toHaveBeenCalledTimes(1)
    expect(record!.judge_status).toBe('succeeded')
    expect(posted(adapter)).toContain('Injection in d')
  })

  it('records lens_runs with model, prompt hash, tokens, cost and finding count', async () => {
    cfg.lenses.model = 'claude-haiku-5-5'
    reviewWithContexts(reviewWith([A_BUG]))
    mockLenses({ reliability: [C_LEAK, D_INJECT] })
    mockJudgeKeepsAll()

    const record = await review(bigAdapter(), '100', false)

    expect(mockRunLens.mock.calls[0].slice(1, 5)).toEqual(['claude-haiku-5-5', cfg.anthropic.maxRetries, cfg.anthropic.maxTokens, ''])
    expect(record!.lens_runs).toEqual([
      { name: 'reliability', status: 'succeeded', model: 'claude-haiku-5-5', prompt_hash: 'hash-lens:reliability', tokens: { input: 400, output: 120 }, cost_usd: expect.any(Number), findings: 2 },
      { name: 'security', status: 'succeeded', model: 'claude-haiku-5-5', prompt_hash: 'hash-lens:security', tokens: { input: 400, output: 120 }, cost_usd: expect.any(Number), findings: 0 },
    ])
    expect(record!.tokens).toMatchObject({ input: 1000 + 400 + 400 + 800, output: 200 + 120 + 120 + 300 })
  })

  it.each([
    ['skipped_no_judge', () => { cfg.judge.model = '' }],
    ['skipped_rereview', () => {}],
  ] as const)('records %s for every lens and makes no lens call', async (status, setup) => {
    setup()
    const adapter = status === 'skipped_rereview'
      ? reReviewAdapter(FLAGGED_PRIOR, [], { getDiff: vi.fn().mockResolvedValue(MULTI_DIFF), getChangedFiles: vi.fn().mockResolvedValue(CHANGED) })
      : bigAdapter()
    mockReviewer(reviewWith([A_BUG], status === 'skipped_rereview' ? { delta_stats: { resolved: 0, still_open: 1, new_findings: 1 } } : {}))
    mockLenses({ reliability: [C_LEAK] })
    mockJudgeKeepsAll()

    const record = await review(adapter, '100', false)

    expect(mockRunLens).not.toHaveBeenCalled()
    expect(record!.lens_runs!.map(r => [r.name, r.status])).toEqual([['reliability', status], ['security', status]])
  })

  it('MAX_FINDINGS: a lens gets what is left after every earlier pass, and the rest are skipped once it runs out', async () => {
    cfg.review.maxFindings = 2
    cfg.lenses.list = 'reliability+security+testing'
    reviewWithContexts(reviewWith([A_BUG]))
    mockLenses({ reliability: [C_LEAK] })
    mockJudgeKeepsAll()

    const record = await review(bigAdapter(), '100', false)

    expect(lensLabels()).toEqual(['lens:reliability'])
    expect(mockRunLens.mock.calls[0][8]).toContain('Report at most 1 findings')
    expect(record!.lens_runs!.map(r => r.status)).toEqual(['succeeded', 'skipped_limit', 'skipped_limit'])
  })

  it('skips only the lens whose input would exceed the budget, and still runs the next one', async () => {
    reviewWithContexts(reviewWith([A_BUG]))
    mockLenses({})
    mockJudgeKeepsAll()
    cfg.lenses.enabled = false
    const estimated = (await review(bigAdapter(), '100', true))!.tokens.estimated_input
    const estimate = (name: string) => estimated + Math.ceil((lensSystemPrompt('System prompt here', LENS_REGISTRY[name], 0).length - 'System prompt here'.length + lensBriefing([A_BUG]).length) / 4)
    const [big, small] = Object.keys(LENS_REGISTRY).sort((x, y) => estimate(y) - estimate(x)).filter((_, i, a) => i === 0 || i === a.length - 1)
    expect(estimate(small)).toBeLessThan(estimate(big))

    cfg.lenses = { enabled: true, list: `${big}+${small}`, model: '' }
    cfg.anthropic.maxInputTokens = estimate(big) - 1
    reviewWithContexts(reviewWith([A_BUG]))
    mockJudgeKeepsAll()
    const record = await review(bigAdapter(), '100', false)

    expect(lensLabels()).toEqual([`lens:${small}`])
    expect(record!.lens_runs!.map(r => [r.name, r.status])).toEqual([[big, 'skipped_budget'], [small, 'succeeded']])
  })

  it('benchmark deadline: once over half has elapsed, this lens and every remaining one is skipped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    cfg.lenses.list = 'reliability+security+testing'
    reviewWithContexts(reviewWith([A_BUG]))
    mockRunLens.mockImplementation(async () => {
      vi.advanceTimersByTime((cfg.breadth.benchmarkDeadlineSeconds / 2 + 1) * 1000)
      return { findings: [C_LEAK], usage: { input_tokens: 400, output_tokens: 120 }, promptHash: 'h' }
    })
    mockJudgeKeepsAll()
    const outcomes: unknown[] = []

    const record = await review(bigAdapter(), '100', false, undefined, 'off', false, '', o => { outcomes.push(o) })

    expect(lensLabels()).toEqual(['lens:reliability'])
    expect(record!.lens_runs!.map(r => r.status)).toEqual(['succeeded', 'skipped_time', 'skipped_time'])
    expect(mockRunJudge).toHaveBeenCalledTimes(1)
    expect(outcomes[0]).toMatchObject({ lensFindings: [C_LEAK] })
  })

  it('a lens failure never fails the review: later lenses still run and a truncated call is still costed', async () => {
    cfg.lenses.list = 'reliability+security+testing'
    reviewWithContexts(reviewWith([A_BUG]))
    mockLenses({
      reliability: new Error('lens boom'),
      security: Object.assign(new Error('max_tokens cut-off'), { usage: { input_tokens: 5000, output_tokens: 2000 } }),
      testing: [B_BUG],
    })
    mockJudgeKeepsAll()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const adapter = bigAdapter()
    const record = await review(adapter, '100', false)

    expect(lensLabels()).toEqual(['lens:reliability', 'lens:security', 'lens:testing'])
    expect(record!.action).toBe('REVIEW')
    expect(record!.lens_runs!.map(r => [r.status, r.tokens])).toEqual([
      ['failed', null], ['failed', { input: 5000, output: 2000 }], ['succeeded', { input: 400, output: 120 }],
    ])
    expect(record!.tokens).toMatchObject({ input: 1000 + 5000 + 400 + 800, output: 200 + 2000 + 120 + 300 })
    expect(record!.review_candidates!.map(c => c.origin)).toEqual(['review', 'lens:testing'])
    expect(posted(adapter)).toContain('Same bug in b')
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('Lens reliability FAILED (lens boom)')
    warnSpy.mockRestore()
  })

  it('ignores unknown lens names with one warning', async () => {
    cfg.lenses.list = 'reliability+bogus'
    reviewWithContexts(reviewWith([A_BUG]))
    mockLenses({})
    mockJudgeKeepsAll()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const record = await review(bigAdapter(), '100', false)

    expect(lensLabels()).toEqual(['lens:reliability'])
    expect(record!.lens_runs!.map(r => r.name)).toEqual(['reliability'])
    expect(warnSpy.mock.calls.filter(c => c.join(' ').includes('bogus'))).toHaveLength(1)
    warnSpy.mockRestore()
  })

  it('runs aliased lenses under their canonical names: run labels, lens_runs and candidate origins', async () => {
    cfg.lenses.list = 'rel+perf'
    reviewWithContexts(reviewWith([A_BUG]))
    mockLenses({ reliability: [C_LEAK] })
    mockJudgeKeepsAll()

    const record = await review(bigAdapter(), '100', false)

    expect(lensLabels()).toEqual(['lens:reliability', 'lens:performance'])
    expect(record!.lens_runs!.map(r => r.name)).toEqual(['reliability', 'performance'])
    expect(record!.review_candidates!.map(c => c.origin)).toEqual(['review', 'lens:reliability'])
  })

  it('J_SHOWN_ANCHOR on: hands the judge one full-PR lens source with lensFrom; no lens findings leaves the options unchanged', async () => {
    cfg.judge.shownAnchors = true
    reviewWithContexts(reviewWith([A_BUG]))
    mockLenses({ security: [D_INJECT] })
    mockJudgeKeepsAll()
    await review(bigAdapter(), '100', false)

    const shown = mockRunJudge.mock.calls[0][11]!.shownAnchors!
    expect(shown.lensFrom).toBe(1)
    expect([...shown.lens!.keys()].sort()).toEqual(CHANGED.map(f => f.path))
    expect(mockRunLens.mock.calls[0][8]).toContain('unchanged line you were shown')

    mockRunJudge.mockClear()
    mockLenses({})
    mockJudgeKeepsAll()
    await review(bigAdapter(), '100', false)
    expect(Object.keys(mockRunJudge.mock.calls[0][11]!.shownAnchors!)).toEqual(['judge', 'breadth', 'secondLook', 'secondLookFrom'])
  })

  it('flag-off pin: no lens call, no lens log, no lens_runs key, and judge args as before; ENABLE_LENSES with an empty list is off', async () => {
    const run = async (lenses: { enabled: boolean; list: string; model: string }) => {
      vi.clearAllMocks()
      cfg.lenses = lenses
      const reviewer = reviewWith([A_BUG])
      reviewWithContexts(reviewer)
      mockLenses({ reliability: [C_LEAK] })
      mockJudgeKeepsAll()
      const logSpy = vi.spyOn(console, 'log')
      const warnSpy = vi.spyOn(console, 'warn')
      const record = await review(bigAdapter(), '100', false)
      const logs = [...logSpy.mock.calls, ...warnSpy.mock.calls].map(c => c.join(' ')).join('\n')
      logSpy.mockRestore(); warnSpy.mockRestore()
      return { reviewer, record: record!, logs, lensCalls: mockRunLens.mock.calls.length, judgeArgs: mockRunJudge.mock.calls[0], diff: mockRunReview.mock.calls[0][6] }
    }
    const strip = ({ timestamp: _t, duration_ms: _d, ...rest }: Record<string, unknown>) => JSON.stringify(rest)

    const runs = [
      await run({ enabled: false, list: '', model: '' }),
      await run({ enabled: false, list: 'reliability+security', model: '' }),
      await run({ enabled: true, list: '', model: '' }),
      await run({ enabled: true, list: ' + , ', model: '' }),
    ]
    for (const r of runs) {
      expect(r.lensCalls).toBe(0)
      expect(r.judgeArgs).toHaveLength(11)
      expect(r.judgeArgs).toEqual([cfg.llmApiKey, 'judge-model', cfg.judge.maxRetries, cfg.anthropic.maxTokens, cfg.judge.effort, r.diff, r.reviewer, [], cfg.judge.policy, cfg.review.lineNumbers, undefined])
      expect(r.judgeArgs[6]).toBe(r.reviewer)
      expect('lens_runs' in r.record).toBe(false)
      expect(r.logs).not.toMatch(/lens/i)
      expect(strip(r.record as unknown as Record<string, unknown>)).toBe(strip(runs[0].record as unknown as Record<string, unknown>))
    }
  })

  it('flag-off pin (benchmark sink): ENABLE_LENSES with an empty or unknown-only list hands over an outcome with no lensFindings key', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const list of ['', 'bogus+nope']) {
      vi.clearAllMocks()
      cfg.lenses = { enabled: true, list, model: '' }
      reviewWithContexts(reviewWith([A_BUG]))
      mockLenses({ reliability: [C_LEAK] })
      mockJudgeKeepsAll()
      const outcomes: object[] = []

      const record = await review(bigAdapter(), '100', false, undefined, 'off', false, '', o => { outcomes.push(o) })

      expect(mockRunLens).not.toHaveBeenCalled()
      expect(outcomes).toHaveLength(1)
      expect('lensFindings' in outcomes[0]).toBe(false)
      expect('lens_runs' in record!).toBe(false)
    }
    warnSpy.mockRestore()
  })
})

describe('lens recommendation (log-only)', () => {
  const RECS = [{ lens: 'security', reason: 'new /login endpoint' }, { lens: 'reliability', reason: 'retry loop' }]
  const mockRunLens = vi.mocked(runLens)
  const posted = (adapter: VCSAdapter) => vi.mocked(adapter.postComment).mock.calls[0][1] as string
  const mockReviewerRecommending = (obj: ReviewObject, recs: typeof RECS | null = RECS) => {
    mockReviewer(obj)
    mockRunReview.mockImplementation(async (...args) => ({
      text: renderReview(obj), usage: { input_tokens: 1000, output_tokens: 200 }, review: obj,
      ...(args[13] === true ? { lensRecommendations: recs } : {}),
    }))
  }
  const mockJudgeKeepsAll = () => mockRunJudge.mockImplementation(async (_k, _m, _r, _t, _e, diff, judgeInput, _f, policy, _l, boundary, options) => {
    const judged = applyJudgeDecisions(judgeInput.findings, {
      decisions: judgeInput.findings.map((_, i) => ({ candidate_id: `c${i}`, reason_category: 'validated' as const, evidence: 'src/app.ts:11', note: 'n', score: 8 })),
      summary: 'ok', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80,
    }, policy, judgeInput.can_be_split, diff, boundary, options)
    return { text: judged.markdown, usage: { input_tokens: 800, output_tokens: 300 }, scores: judged.scores, promptHash: 'judgehash', decisions: judged.decisions, anomalies: judged.anomalies, kept: judged.kept }
  })
  const captureLogs = async <T>(fn: () => Promise<T>) => {
    const logSpy = vi.spyOn(console, 'log')
    try { return { value: await fn(), logs: logSpy.mock.calls.map(c => c.join(' ')).join('\n') } } finally { logSpy.mockRestore() }
  }

  beforeEach(() => {
    cfg.judge.model = 'judge-model'
    cfg.lenses = { enabled: false, list: '', model: '', recommend: true }
  })
  afterEach(() => {
    cfg.lenses = { enabled: false, list: '', model: '', recommend: false }
  })

  it('first review: requests it as one trailing arg, logs and records it, and keeps it out of the judge input and the posted review', async () => {
    mockReviewerRecommending(reviewWith([NEW_FINDING]))
    mockJudgeKeepsAll()
    const adapter = makeAdapter()

    const { value: record, logs } = await captureLogs(() => review(adapter, '100', false))

    expect(mockRunReview).toHaveBeenCalledTimes(1)
    const args = mockRunReview.mock.calls[0]
    expect(args).toHaveLength(14)
    expect(args[13]).toBe(true)
    expect(logs).toContain('  Lens recommendations: security (new /login endpoint), reliability (retry loop)')
    expect(record!.lens_recommendations).toEqual(RECS)
    const judgeInput = mockRunJudge.mock.calls[0][6]
    expect('lens_recommendations' in judgeInput).toBe(false)
    expect(JSON.stringify(mockRunJudge.mock.calls[0])).not.toMatch(/login endpoint|retry loop/)
    expect(posted(adapter)).not.toMatch(/login endpoint|retry loop|recommend/i)
  })

  it('records an empty list and logs none when the reviewer recommends nothing', async () => {
    mockReviewerRecommending(reviewWith([NEW_FINDING]), [])
    mockJudgeKeepsAll()

    const { value: record, logs } = await captureLogs(() => review(makeAdapter(), '100', true))

    expect(logs).toContain('  Lens recommendations: none')
    expect(record!.lens_recommendations).toEqual([])
  })

  it('records null and logs unavailable when the reviewer did not answer, and the review still posts', async () => {
    mockReviewerRecommending(reviewWith([NEW_FINDING]), null)
    mockJudgeKeepsAll()
    const adapter = makeAdapter()

    const { value: record, logs } = await captureLogs(() => review(adapter, '100', false))

    expect(logs).toContain('  Lens recommendations: unavailable')
    expect(record!.lens_recommendations).toBeNull()
    expect(record!.action).toBe('REVIEW')
    expect(posted(adapter)).toContain('New issue')
  })

  it('re-review: not requested (today\'s 13 args), null in the record, nothing logged', async () => {
    mockReviewerRecommending(reviewWith([NEW_FINDING], { delta_stats: { resolved: 0, still_open: 1, new_findings: 1 } }))
    mockJudgeKeepsAll()

    const { value: record, logs } = await captureLogs(() => review(reReviewAdapter(FLAGGED_PRIOR), '100', true))

    expect(record!.review_number).toBe(2)
    expect(mockRunReview.mock.calls[0]).toHaveLength(13)
    expect(record!.lens_recommendations).toBeNull()
    expect(logs).not.toContain('Lens recommendations')
  })

  it('skipped before CALL_MODEL: null in the record', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' }]),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(record!.lens_recommendations).toBeNull()
  })

  it('with lenses on, every listed lens still runs whatever the reviewer recommended', async () => {
    cfg.lenses = { enabled: true, list: 'reliability+security+testing', model: '', recommend: true }
    mockReviewerRecommending(reviewWith([NEW_FINDING]), [{ lens: 'security', reason: 'new /login endpoint' }])
    mockRunLens.mockResolvedValue({ findings: [], usage: { input_tokens: 400, output_tokens: 120 }, promptHash: 'h' })
    mockJudgeKeepsAll()

    const record = await review(makeAdapter(), '100', false)

    expect(mockRunLens.mock.calls.map(c => c[11])).toEqual(['lens:reliability', 'lens:security', 'lens:testing'])
    expect(record!.lens_runs!.map(r => [r.name, r.status])).toEqual([['reliability', 'succeeded'], ['security', 'succeeded'], ['testing', 'succeeded']])
    expect(record!.lens_recommendations).toEqual([{ lens: 'security', reason: 'new /login endpoint' }])
  })

  it('flag-off pin: absent or false makes the same 13-arg reviewer call, logs nothing and adds no record key', async () => {
    const run = async (lenses: Record<string, unknown>) => {
      vi.clearAllMocks()
      cfg.lenses = lenses
      mockReviewerRecommending(reviewWith([NEW_FINDING]))
      mockJudgeKeepsAll()
      const { value: record, logs } = await captureLogs(() => review(makeAdapter(), '100', false))
      return { record: record!, logs, args: mockRunReview.mock.calls[0], judgeArgs: mockRunJudge.mock.calls[0] }
    }
    const strip = ({ timestamp: _t, duration_ms: _d, ...rest }: Record<string, unknown>) => JSON.stringify(rest)

    const absent = await run({ enabled: false, list: '', model: '' })
    const off = await run({ enabled: false, list: '', model: '', recommend: false })
    for (const r of [absent, off]) {
      expect(r.args).toHaveLength(13)
      expect(r.args[12]).toBe(cfg.review.lineNumbers)
      expect('lens_recommendations' in r.record).toBe(false)
      expect(r.logs).not.toContain('Lens recommendations')
      expect(r.judgeArgs).toHaveLength(11)
    }
    expect(off.args).toEqual(absent.args)
    expect(strip(off.record as unknown as Record<string, unknown>)).toBe(strip(absent.record as unknown as Record<string, unknown>))
  })
})

// ===========================================================================
// Scenario 8g: Token-budget degradation — drop file contexts before skipping
// ===========================================================================

describe('token-budget degradation', () => {
  it('drops file contexts and reviews diff-only when over MAX_INPUT_TOKENS', async () => {
    const adapter = makeAdapter()
    setupModelMocks()
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
    setupModelMocks()
    mockFetchContext.mockResolvedValue([{ path: 'big.ts', content: 'y'.repeat(8000) }])
    cfg.anthropic.maxInputTokens = 100

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('SKIP')              // diff alone still over budget
    expect(record!.degraded).toBe(true)              // it tried degrading first
    expect(mockRunReview).not.toHaveBeenCalled()
  })

  it('drops a delta larger than the full PR diff (branch merged its target) and reviews the full diff', async () => {
    const mergeInflatedDelta = [
      'diff --git a/src/merged.ts b/src/merged.ts',
      '--- a/src/merged.ts',
      '+++ b/src/merged.ts',
      '@@ -1,1 +1,501 @@',
      ...Array.from({ length: 500 }, (_, i) => `+merged develop line ${i}`),
    ].join('\n')
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
      ]),
      getCommitDiff: vi.fn().mockResolvedValue(mergeInflatedDelta),   // delta >> the small full PR diff
    })
    setupModelMocks(undefined, reviewWith([{ severity: 'LOW', title: 'x', body: 'y' }]))

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('RE_REVIEW')               // reviewed, not skipped
    expect(mockRunReview.mock.calls[0][11]).toBe('')    // merge-inflated delta dropped before the model call
  })
})

// ===========================================================================
// Scenario 8g2: Context-length rejection — degrade to diff-only, then skip (estimate under-counts)
// ===========================================================================

describe('input budget from context window', () => {
  const overBudget = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,6 @@\n' + Array(6).fill('+' + 'a'.repeat(80)).join('\n') + '\n'

  afterEach(() => {
    cfg.anthropic.maxTokens = 32000
    cfg.anthropic.maxInputTokens = 150000
    cfg.anthropic.modelContextTokens = 0
    vi.mocked(modelContextWindow).mockReturnValue(200_000)
  })

  it('derives the reviewer window and skips a diff that exceeds it', async () => {
    const adapter = makeAdapter({ getDiff: vi.fn().mockResolvedValue(overBudget) })
    setupModelMocks()
    cfg.anthropic.maxInputTokens = 1_000_000   // not the binding limit
    cfg.anthropic.maxTokens = 10
    cfg.anthropic.modelContextTokens = 0        // derive from the model
    vi.mocked(modelContextWindow).mockReturnValue(100)   // window 100 → cap 90

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toMatch(/input budget/i)
    expect(mockRunReview).not.toHaveBeenCalled()
  })

  it('lets MODEL_CONTEXT_TOKENS override the derived cap', async () => {
    const adapter = makeAdapter({ getDiff: vi.fn().mockResolvedValue(overBudget) })
    setupModelMocks()
    cfg.anthropic.maxInputTokens = 1_000_000
    cfg.anthropic.maxTokens = 10
    cfg.anthropic.modelContextTokens = 100_000   // override wins over the tiny derived window below
    vi.mocked(modelContextWindow).mockReturnValue(100)

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REVIEW')
    expect(mockRunReview).toHaveBeenCalledTimes(1)
  })

  it('OpenRouter prod pair (anthropic/claude-sonnet-5.5 + anthropic/claude-haiku-5.5) at defaults budgets 250,000, not a 200K-window 168,000', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js')
    vi.unstubAllEnvs()
    vi.mocked(modelContextWindow).mockImplementation(actual.modelContextWindow)
    const diffOf = (lines: number, width: number) => 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,' + lines + ' @@\n' + Array(lines).fill('+' + 'a'.repeat(width)).join('\n') + '\n'
    const reviewerModel = cfg.anthropic.model
    cfg.anthropic.model = 'anthropic/claude-sonnet-5.5'
    cfg.judge.model = 'anthropic/claude-haiku-5.5'
    cfg.anthropic.maxInputTokens = 250_000
    cfg.anthropic.maxTokens = 32_000
    cfg.anthropic.modelContextTokens = 0
    try {
      setupModelMocks()
      const fits = await review(makeAdapter({ getDiff: vi.fn().mockResolvedValue(diffOf(100, 8_000)) }), '100', true)   // ~200K tokens
      expect(fits!.skip_reason).toBeNull()
      expect(fits!.action).toBe('REVIEW')

      vi.clearAllMocks(); setupModelMocks()
      const over = await review(makeAdapter({ getDiff: vi.fn().mockResolvedValue(diffOf(105, 10_000)) }), '100', true)   // ~263K tokens
      expect(over!.action).toBe('SKIP')
      expect(over!.skip_reason).toContain(`input budget (${(250_000).toLocaleString()};`)
    } finally {
      cfg.anthropic.model = reviewerModel
    }
  })
})

describe('context-length overflow (estimate under-counted)', () => {
  const tooLong = () => Object.assign(new Error('400 prompt is too long: 300000 tokens > 200000 maximum'), { status: 400 })

  it('drops file contexts and retries diff-only when the model rejects on context length', async () => {
    const adapter = makeAdapter()
    mockFetchContext.mockResolvedValue([{ path: 'big.ts', content: 'x'.repeat(8000) }])
    mockRunReview.mockReset()
      .mockRejectedValueOnce(tooLong())
      .mockResolvedValueOnce({ text: '### Summary\nok\n\n### Findings\n\nNo findings.\n\n### Unresolved Questions\nNone.', usage: { input_tokens: 1000, output_tokens: 200 }, review: reviewWith([]) })

    const record = await review(adapter, '100', false)

    expect(mockRunReview).toHaveBeenCalledTimes(2)
    expect(record!.degraded).toBe(true)
    expect(mockRunReview.mock.calls[1][7]).toEqual([])   // retry was diff-only
  })

  it('skips when the diff alone exceeds the context (no file contexts left to drop)', async () => {
    const adapter = makeAdapter()
    mockFetchContext.mockResolvedValue([])
    mockRunReview.mockReset().mockRejectedValue(tooLong())

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toMatch(/context window/i)
    expect(mockRunReview).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Scenario 8h: ENABLE_SPLIT_CHECK toggles the split-theme instruction in the reviewer prompt
// ===========================================================================

describe('ENABLE_SPLIT_CHECK add-on', () => {
  it.each([true, false])('splitCheck=%s', async (enabled) => {
    cfg.review.splitCheck = enabled

    await review(makeAdapter(), '100', true)

    const promptArg = mockRunReview.mock.calls[0][8] as { content: string }
    expect(promptArg.content.includes('## SPLIT CHECK')).toBe(enabled)
  })
})

// ===========================================================================
// Scenario 9: Claude returns empty → skip (never post)
// ===========================================================================

describe('Claude returns empty → skip', () => {
  it('does not post empty comment', async () => {
    const adapter = makeAdapter()
    setupModelMocks('')

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
// Scenario 9c: Each size bound skips on its own, before review history or the model is touched
// ===========================================================================

describe('size thresholds — each bound skips', () => {
  // Fixture size: DIFF has 2 reviewable lines; two reviewable files
  it.each([
    [{ minChangedFiles: 3 }, '2 reviewable file(s), minimum is 3'],
    [{ maxChangedFiles: 1 }, '2 reviewable file(s), maximum is 1'],
    [{ minChangedLines: 3 }, '2 reviewable line(s), minimum is 3'],
    [{ maxChangedLines: 1 }, '2 reviewable line(s), maximum is 1'],
  ])('%o → SKIP', async (bound, reason) => {
    cfg.thresholds = { ...cfg.thresholds, ...bound }
    const adapter = makeAdapter({
      getChangedFiles: vi.fn().mockResolvedValue([
        { path: 'src/app.ts', status: 'modified' },
        { path: 'src/foo.ts', status: 'added' },
      ]),
    })

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toBe(`PR has ${reason}`)
    expect(adapter.getPreviousReviewComments).not.toHaveBeenCalled()
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
    setupModelMocks()

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
    setupModelMocks()

    const record = await review(adapter, '100', true, undefined, 'clean')

    expect(record!.action).toBe('REVIEW')
    expect(record!.review_number).toBe(1)
    expect(adapter.getRepliesToReviewComments).not.toHaveBeenCalled()
  })

  it('real run posts on an already-reviewed commit — pre-post dedup is skipped too', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
      ]),
    })

    const record = await review(adapter, '100', false, undefined, 'clean')

    expect(record!.action).toBe('REVIEW')
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
    expect(adapter.getPreviousReviewComments).not.toHaveBeenCalled()
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
    setupModelMocks()

    const record = await review(adapter, '100', true, undefined, 're-review')

    expect(record!.action).toBe('RE_REVIEW')
    expect(record!.review_number).toBe(2)
    expect(adapter.getRepliesToReviewComments).toHaveBeenCalledWith('100', ['200'], true)
  })
})

// ===========================================================================
// Scenario 12b: --force re-review skips the 0-finding gate entirely — it always posts,
// even where an unforced run would suppress (clean prior) or answer in-thread (open reply)
// ===========================================================================

describe('--force re-review bypasses the 0-finding gate', () => {
  it.each([
    ['clean prior, no discussion (unforced: suppress)', [] as CommentReply[]],
    ['clean prior, unanswered dev reply (unforced: reply)', [devReply('2026-03-09T12:00:00Z')]],
  ])('%s → posts RE_REVIEW', async (_label, replies) => {
    const adapter = reReviewAdapter(CLEAN_PRIOR, replies)
    mockReviewer(reviewWith([], { delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } }))

    const record = await review(adapter, '100', false, undefined, 're-review')

    expect(record!.action).toBe('RE_REVIEW')
    expect(record!.review_number).toBe(2)
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
    expect(adapter.postReply).not.toHaveBeenCalled()
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
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

// ===========================================================================
// Scenario 17: skip replies @-directed at someone else (Bitbucket capability)
// Filter runs at BOTH inbound edges to RESPOND_TO_REPLIES; off / absent / throwing keeps all.
// ===========================================================================

describe('skip directed-elsewhere replies', () => {
  beforeEach(() => { cfg.reply.skipDirectedElsewhere = true })
  afterEach(() => { cfg.reply.skipDirectedElsewhere = false })

  const checkRepliesAdapter = (overrides: Partial<VCSAdapter> = {}) => makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([
      { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
    ]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [devReply('2026-03-10T14:00:00Z')], agentReplyCount: 0 }),
    ...overrides,
  })

  it('CHECK_REPLIES: all-directed-elsewhere → normal DEDUP_SKIP, not "reply limit"', async () => {
    const filter = vi.fn().mockResolvedValue([])
    const adapter = checkRepliesAdapter({ filterAddressedToAgent: filter })

    const record = await review(adapter, '100', true)

    expect(filter).toHaveBeenCalledTimes(1)
    expect(record!.action).toBe('DEDUP_SKIP')
    expect(record!.skip_reason).toContain('no unanswered questions')
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
  })

  it('config off → adapter capability is never called', async () => {
    cfg.reply.skipDirectedElsewhere = false
    const filter = vi.fn().mockResolvedValue([])
    const adapter = checkRepliesAdapter({ filterAddressedToAgent: filter })

    const record = await review(adapter, '100', true)

    expect(filter).not.toHaveBeenCalled()
    expect(record!.action).toBe('REPLY')
  })

  it('adapter without the capability → unchanged (replies answered)', async () => {
    const adapter = checkRepliesAdapter()

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('REPLY')
  })

  it('filter throws → keep all (fail-safe), reply still posts', async () => {
    const filter = vi.fn().mockRejectedValue(new Error('boom'))
    const adapter = checkRepliesAdapter({ filterAddressedToAgent: filter })

    const record = await review(adapter, '100', true)

    expect(filter).toHaveBeenCalledTimes(1)
    expect(record!.action).toBe('REPLY')
  })

  it('JUDGE_REVIEW (0-finding re-review): drops the only unanswered dev reply → no RESPOND', async () => {
    const filter = vi.fn().mockResolvedValue([])
    const adapter = reReviewAdapter(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')], { filterAddressedToAgent: filter })
    mockReviewer(reviewWith([], { delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } }))

    const record = await review(adapter, '100', false)

    expect(filter).toHaveBeenCalled()
    expect(record!.action).not.toBe('REPLY')
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
    expect(adapter.postReply).not.toHaveBeenCalled()
  })
})

describe('trigger pre-check (IGNORE_COMMENT_AUTHORS) runs before any VCS call', () => {
  const COMMENT_BY_BOT = { event: 'pullrequest:comment_created', commentAuthor: '{BOT}' }
  const run = (adapter: VCSAdapter, trigger?: { event: string; commentAuthor: string }, force: 'off' | 'clean' | 're-review' = 'off', dryRun = false) =>
    review(adapter, '100', dryRun, undefined, force, true, 'repo', undefined, trigger)
  const runCapturing = async (adapter: VCSAdapter, trigger?: { event: string; commentAuthor: string }, force: 'off' | 'clean' | 're-review' = 'off', dryRun = false) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const record = await run(adapter, trigger, force, dryRun)
      return { record: record!, logs: [...logSpy.mock.calls, ...warnSpy.mock.calls].map(c => c.join(' ')) }
    } finally {
      logSpy.mockRestore(); warnSpy.mockRestore()
    }
  }

  beforeEach(() => { cfg.trigger.ignoreCommentAuthors = ['bot'] })

  it('listed comment author → SKIP with no VCS or model call, record logged', async () => {
    const adapter = makeAdapter()

    const record = await run(adapter, COMMENT_BY_BOT)

    for (const fn of Object.values(adapter)) expect(fn).not.toHaveBeenCalled()
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(mockRunJudge).not.toHaveBeenCalled()
    expect(mockRunCommentResponse).not.toHaveBeenCalled()
    expect(vi.mocked(runBreadth)).not.toHaveBeenCalled()
    expect(vi.mocked(runLens)).not.toHaveBeenCalled()
    expect(mockLoadPrompt).not.toHaveBeenCalled()
    expect(mockFetchContext).not.toHaveBeenCalled()
    expect(logUsageRecord).toHaveBeenCalledTimes(1)
    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toBe('pullrequest:comment_created by "{BOT}" matches IGNORE_COMMENT_AUTHORS')
    expect(record!.trigger).toEqual({ event: 'pullrequest:comment_created', comment_author: '{BOT}' })
    expect(record!.pr_author).toBe('unknown')
    expect(record!.source_commit).toBe('unknown')
    expect(record!.diff_size).toBeNull()
    expect(record!.cost_usd).toBe(0)
    expect(record!.review_number).toBe(0)
    expect(record!.error).toBeNull()
    expect(record!.run_id).toBe('bitbucket-repo-100-unknown')
  })

  it('listed author on pullrequest:updated (a bot push) reviews normally', async () => {
    const adapter = makeAdapter()

    const record = await run(adapter, { event: 'pullrequest:updated', commentAuthor: '{BOT}' })

    expect(adapter.getPullRequestInfo).toHaveBeenCalledTimes(1)
    expect(record!.action).toBe('REVIEW')
    expect(record!.trigger).toEqual({ event: 'pullrequest:updated', comment_author: '{BOT}' })
  })

  it('unlisted author → normal flow, trigger recorded and logged', async () => {
    const { record, logs } = await runCapturing(makeAdapter(), { event: 'pullrequest:comment_created', commentAuthor: '{human}' })

    expect(record.action).toBe('REVIEW')
    expect(record.trigger).toEqual({ event: 'pullrequest:comment_created', comment_author: '{human}' })
    expect(logs).toContain('Trigger: pullrequest:comment_created by {human}')
  })

  it.each(['clean', 're-review'] as const)('--force %s overrides the ignore list', async (force) => {
    const adapter = makeAdapter()

    const { record, logs } = await runCapturing(adapter, COMMENT_BY_BOT, force, true)

    expect(adapter.getPullRequestInfo).toHaveBeenCalledTimes(1)
    expect(record.action).toBe('REVIEW')
    expect(record.force).toBe(force)
    expect(logs).toContain('  {BOT} matches IGNORE_COMMENT_AUTHORS - running anyway (--force)')
  })

  it('an empty --force (CI passes "" for an unset parameter) does not override the ignore list', async () => {
    const adapter = makeAdapter()

    const record = await run(adapter, COMMENT_BY_BOT, '' as never)

    expect(adapter.getPullRequestInfo).not.toHaveBeenCalled()
    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toContain('IGNORE_COMMENT_AUTHORS')
  })

  it('dry-run still skips', async () => {
    const adapter = makeAdapter()

    const record = await run(adapter, COMMENT_BY_BOT, 'off', true)

    expect(adapter.getPullRequestInfo).not.toHaveBeenCalled()
    expect(record!.action).toBe('SKIP')
    expect(record!.dry_run).toBe(true)
  })

  it('author without event is not skipped, warns, and records a null event', async () => {
    const { record, logs } = await runCapturing(makeAdapter(), { event: '', commentAuthor: '{BOT}' })

    expect(record.action).toBe('REVIEW')
    expect(record.trigger).toEqual({ event: null, comment_author: '{BOT}' })
    expect(logs).toContain('Trigger: unknown event by {BOT}')
    expect(logs.some(l => l.includes('Comment author given without an event'))).toBe(true)
  })

  it('event without author is not skipped and does not warn', async () => {
    const { record, logs } = await runCapturing(makeAdapter(), { event: 'pullrequest:comment_created', commentAuthor: '' })

    expect(record.action).toBe('REVIEW')
    expect(record.trigger).toEqual({ event: 'pullrequest:comment_created', comment_author: null })
    expect(logs).toContain('Trigger: pullrequest:comment_created')
    expect(logs.some(l => l.includes('without an event'))).toBe(false)
  })

  it('author without event and an empty ignore list does not warn', async () => {
    cfg.trigger.ignoreCommentAuthors = []

    const { logs } = await runCapturing(makeAdapter(), { event: '', commentAuthor: '{BOT}' })

    expect(logs.some(l => l.includes('without an event'))).toBe(false)
  })

  it('no trigger: no trigger key, no Trigger line, and the flow starts at FETCH_PR_INFO', async () => {
    const adapter = makeAdapter()

    const { record, logs } = await runCapturing(adapter)

    expect('trigger' in record).toBe(false)
    expect(Object.keys(record).slice(-2)).toEqual(['jenkins', 'error'])
    expect(logs.some(l => l.startsWith('Trigger:'))).toBe(false)
    expect(adapter.getPullRequestInfo).toHaveBeenCalledTimes(1)
    expect(record.action).toBe('REVIEW')
  })
})

describe('trigger pre-check: event kind override and provider comment names', () => {
  const runCapturing = async (adapter: VCSAdapter, trigger: TriggerInfo) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const record = await review(adapter, '100', false, undefined, 'off', true, 'repo', undefined, trigger)
      return { record: record!, logs: [...logSpy.mock.calls, ...warnSpy.mock.calls].map(c => c.join(' ')) }
    } finally {
      logSpy.mockRestore(); warnSpy.mockRestore()
    }
  }

  beforeEach(() => { cfg.trigger.ignoreCommentAuthors = ['bot'] })

  it('kind comment makes a non-comment-named event skippable for a listed author, before any VCS call', async () => {
    const adapter = makeAdapter()

    const { record, logs } = await runCapturing(adapter, { event: 'relay:mr-note', commentAuthor: '{BOT}', kind: 'comment' })

    for (const fn of Object.values(adapter)) expect(fn).not.toHaveBeenCalled()
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(record.action).toBe('SKIP')
    expect(record.skip_reason).toBe('relay:mr-note by "{BOT}" matches IGNORE_COMMENT_AUTHORS')
    expect(record.trigger).toEqual({ event: 'relay:mr-note', comment_author: '{BOT}', event_kind: 'comment' })
    expect(logs).toContain('Trigger: relay:mr-note by {BOT} (event kind: comment)')
  })

  it('kind other makes a comment-named event non-skippable for a listed author', async () => {
    const adapter = makeAdapter()

    const { record } = await runCapturing(adapter, { event: 'pullrequest:comment_created', commentAuthor: '{BOT}', kind: 'other' })

    expect(adapter.getPullRequestInfo).toHaveBeenCalledTimes(1)
    expect(record.action).toBe('REVIEW')
    expect(record.trigger).toEqual({ event: 'pullrequest:comment_created', comment_author: '{BOT}', event_kind: 'other' })
  })

  it('kind comment with no event name skips without the missing-event warning', async () => {
    const adapter = makeAdapter()

    const { record, logs } = await runCapturing(adapter, { event: '', commentAuthor: '{BOT}', kind: 'comment' })

    expect(adapter.getPullRequestInfo).not.toHaveBeenCalled()
    expect(record.skip_reason).toBe('comment event by "{BOT}" matches IGNORE_COMMENT_AUTHORS')
    expect(record.trigger).toEqual({ event: null, comment_author: '{BOT}', event_kind: 'comment' })
    expect(logs.some(l => l.includes('without an event'))).toBe(false)
  })

  it.each(['note', 'Note Hook', 'pull_request_review'])('without a kind, %s by a listed author is skipped and records no event_kind', async (event) => {
    const adapter = makeAdapter()

    const { record } = await runCapturing(adapter, { event, commentAuthor: '{BOT}' })

    expect(adapter.getPullRequestInfo).not.toHaveBeenCalled()
    expect(record.action).toBe('SKIP')
    expect(record.trigger).toEqual({ event, comment_author: '{BOT}' })
    expect('event_kind' in record.trigger!).toBe(false)
  })

  it.each(['merge_request_event', 'Merge Request Hook', 'pull_request_review_thread', 'pull_request'])('without a kind, %s by a listed author is reviewed', async (event) => {
    const adapter = makeAdapter()

    const { record } = await runCapturing(adapter, { event, commentAuthor: '{BOT}' })

    expect(adapter.getPullRequestInfo).toHaveBeenCalledTimes(1)
    expect(record.action).toBe('REVIEW')
  })
})

describe('checked_commit output: only a storable head', () => {
  it.each(['', 'HEAD', 'abc123', 'zz'.repeat(20)])('a marked run whose adapter reports head %j carries no checked_commit', async (sourceCommit) => {
    const adapter = makeAdapter({ getPullRequestInfo: vi.fn().mockResolvedValue(makePRInfo(sourceCommit)) })

    const record = await review(adapter, '100', false, undefined, 'off', true, 'repo')

    expect(record!.action).toBe('REVIEW')
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
    expect('checked_commit' in record!).toBe(false)
  })

  it('the same run on a hex head carries it unchanged', async () => {
    const record = await review(makeAdapter(), '100', false, undefined, 'off', true, 'repo')

    expect(record!.checked_commit).toBe(COMMIT_A)
  })
})

describe('ONLY_TARGET_BRANCHES allow-list: after both skip lists, before the diff', () => {
  const withBranches = (sourceBranch: string, targetBranch: string) =>
    makeAdapter({ getPullRequestInfo: vi.fn().mockResolvedValue({ ...makePRInfo(), sourceBranch, targetBranch }) })
  const runWithWarnings = async (adapter: VCSAdapter) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const record = await review(adapter, '100', true)
      return { record: record!, warnings: warnSpy.mock.calls.map(c => c.join(' ')) }
    } finally {
      warnSpy.mockRestore()
    }
  }

  it('empty: a develop target is reviewed as today', async () => {
    const record = await review(withBranches('feature/x', 'develop'), '100', true)

    expect(record!.action).toBe('REVIEW')
  })

  it('an unlisted target is skipped before the diff is fetched', async () => {
    cfg.onlyTargetBranches = ['develop', 'release/*']
    const adapter = withBranches('feature/x', 'feature/base')

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toBe('target branch "feature/base" is not in ONLY_TARGET_BRANCHES (develop,release/*)')
    expect(adapter.getDiff).not.toHaveBeenCalled()
  })

  it('release/* wildcard admits release/1.2', async () => {
    cfg.onlyTargetBranches = ['develop', 'release/*']

    const record = await review(withBranches('fix/y', 'release/1.2'), '100', true)

    expect(record!.action).toBe('REVIEW')
  })

  it('SKIP_TARGET_BRANCHES wins over ONLY_TARGET_BRANCHES, with a warning', async () => {
    cfg.onlyTargetBranches = ['main']

    const { record, warnings } = await runWithWarnings(withBranches('feature/x', 'main'))

    expect(record.action).toBe('SKIP')
    expect(record.skip_reason).toBe('target branch "main" matches SKIP_TARGET_BRANCHES')
    expect(warnings).toContain('  "main" is in both SKIP_TARGET_BRANCHES and ONLY_TARGET_BRANCHES - the skip list wins; set SKIP_TARGET_BRANCHES= to review it')
  })

  it('a SKIP_TARGET_BRANCHES match emits no ONLY_TARGET_BRANCHES warning when the allow-list is empty or does not list it', async () => {
    for (const only of [[], ['develop']]) {
      cfg.onlyTargetBranches = only
      const { record, warnings } = await runWithWarnings(withBranches('feature/x', 'main'))

      expect(record.skip_reason).toBe('target branch "main" matches SKIP_TARGET_BRANCHES')
      expect(warnings.some(w => w.includes('ONLY_TARGET_BRANCHES'))).toBe(false)
    }
  })

  it('SKIP_SOURCE_BRANCHES still wins', async () => {
    cfg.onlyTargetBranches = ['develop']

    const record = await review(withBranches('hotfix/x', 'develop'), '100', true)

    expect(record!.action).toBe('SKIP')
    expect(record!.skip_reason).toBe('source branch "hotfix/x" matches SKIP_SOURCE_BRANCHES')
  })

  it('main-only recipe: empty skip-target + ONLY=main reviews into main and skips a stacked PR', async () => {
    cfg.skipTargetBranches = []
    cfg.onlyTargetBranches = ['main']

    expect((await review(withBranches('feature/x', 'main'), '100', true))!.action).toBe('REVIEW')
    const stacked = await review(withBranches('feature/y', 'feature/x'), '100', true)
    expect(stacked!.action).toBe('SKIP')
    expect(stacked!.skip_reason).toContain('is not in ONLY_TARGET_BRANCHES')
  })
})

describe('checked commit from CI', () => {
  const HEAD40 = COMMIT_A + '4444555566667777888899990000'
  const DEDUP_REASON = 'head already checked by an earlier run and no unanswered questions'
  const MATCH_LINE = `  Source commit ${COMMIT_A} already checked by an earlier run (checked commit) — checking for unanswered replies...`
  const isCheckedLog = (l: string) => l.includes('(checked commit)') || l.startsWith('  Checked commit ')
  type RunOpts = { dryRun?: boolean; force?: 'off' | 'clean' | 're-review'; trigger?: { event: string; commentAuthor: string } }

  const runWith = async (adapter: VCSAdapter, checkedCommit: string | undefined, opts: RunOpts = {}) => {
    const logs: string[] = []
    const capture = (...a: unknown[]) => { const l = a.map(String).join(' '); if (!l.startsWith('\n=== Usage ===')) logs.push(l) }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(capture)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(capture)
    try {
      const record = await review(adapter, '100', opts.dryRun ?? false, undefined, opts.force ?? 'off', true, 'repo', undefined, opts.trigger, checkedCommit)
      return { record: record!, logs }
    } finally {
      logSpy.mockRestore(); warnSpy.mockRestore()
    }
  }
  const failWith = async (adapter: VCSAdapter, checkedCommit: string | undefined, message: string) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(review(adapter, '100', false, undefined, 'off', true, 'repo', undefined, undefined, checkedCommit)).rejects.toThrow(message)
    } finally {
      logSpy.mockRestore(); warnSpy.mockRestore()
    }
    return vi.mocked(logUsageRecord).mock.calls[0][0]
  }
  const sameHeadAdapter = (replies: CommentReply[] = [], agentReplyCount = 0, overrides: Partial<VCSAdapter> = {}) => makeAdapter({
    getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '200', body: CLEAN_PRIOR + footer(1, COMMIT_A), createdOn: PRIOR_AT }]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies, agentReplyCount }),
    ...overrides,
  })
  const quietZero = () => mockReviewer(reviewWith([], { delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } }))
  const noChange = (findings: ReviewObject['findings'] = []) => mockReviewer(reviewWith(findings, { summary: '', no_change: true }))

  describe('input: consulted only after a footer miss, with previous reviews, when not forced', () => {
    it('I1 match with an older footer → CHECK_REPLIES: no delta fetch, no model call, DEDUP_SKIP with its own reason', async () => {
      const adapter = reReviewAdapter(CLEAN_PRIOR)

      const { record, logs } = await runWith(adapter, COMMIT_A)

      expect(adapter.getCommitDiff).not.toHaveBeenCalled()
      expect(mockRunReview).not.toHaveBeenCalled()
      expect(adapter.getRepliesToReviewComments).toHaveBeenCalledTimes(1)
      expect(adapter.getRepliesToReviewComments).toHaveBeenCalledWith('100', ['200'])
      expect(logs).toContain(MATCH_LINE)
      expect(record.action).toBe('DEDUP_SKIP')
      expect(record.skip_reason).toBe(DEDUP_REASON)
      expect(record.review_number).toBe(1)
      expect(record.dedup_source).toBe('checked_commit')
      expect(record.checked_commit).toBe(COMMIT_A)
    })

    it('I2 match + unanswered reply → REPLY', async () => {
      const adapter = reReviewAdapter(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')])

      const { record } = await runWith(adapter, COMMIT_A)

      expect(mockRunReview).not.toHaveBeenCalled()
      expect(mockRunCommentResponse).toHaveBeenCalledTimes(1)
      expect(adapter.postReply).toHaveBeenCalledTimes(1)
      expect(record.action).toBe('REPLY')
      expect(record.skip_reason).toBeNull()
      expect(record.dedup_source).toBe('checked_commit')
      expect(record.checked_commit).toBe(COMMIT_A)
    })

    it('I3 match + reply limit → DEDUP_SKIP keeps the reply-limit reason', async () => {
      const adapter = reReviewAdapter(CLEAN_PRIOR, [], {
        getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [devReply('2026-03-09T12:00:00Z')], agentReplyCount: 3 }),
      })

      const { record } = await runWith(adapter, COMMIT_A)

      expect(record.action).toBe('DEDUP_SKIP')
      expect(record.skip_reason).toBe('reply limit reached (3/3)')
      expect(record.dedup_source).toBe('checked_commit')
      expect(record.checked_commit).toBe(COMMIT_A)
    })

    it('I4 prefix forms: a 12-char value against a 40-char head, and a 40-char value against a 12-char head', async () => {
      const longHead = reReviewAdapter(CLEAN_PRIOR, [], { getPullRequestInfo: vi.fn().mockResolvedValue(makePRInfo(HEAD40)) })
      const a = await runWith(longHead, COMMIT_A)
      expect(a.record.skip_reason).toBe(DEDUP_REASON)
      expect(a.record.checked_commit).toBe(HEAD40)

      vi.clearAllMocks(); setupModelMocks()
      const b = await runWith(reReviewAdapter(CLEAN_PRIOR), HEAD40)
      expect(b.record.skip_reason).toBe(DEDUP_REASON)
      expect(b.record.checked_commit).toBe(COMMIT_A)
    })

    it('I5 mismatch → one log line, and the delta and model input exactly as if unset', async () => {
      mockReviewer(reviewWith([NEW_FINDING]))
      const unsetAdapter = reReviewAdapter(CLEAN_PRIOR)
      const unset = await runWith(unsetAdapter, undefined, { dryRun: true })
      const unsetReview = structuredClone(mockRunReview.mock.calls)
      const unsetDelta = structuredClone(vi.mocked(unsetAdapter.getCommitDiff).mock.calls)

      vi.clearAllMocks(); mockReviewer(reviewWith([NEW_FINDING]))
      const adapter = reReviewAdapter(CLEAN_PRIOR)
      const mismatch = await runWith(adapter, 'bbbbbbbbbbbbcccc', { dryRun: true })

      expect(vi.mocked(adapter.getCommitDiff).mock.calls).toEqual(unsetDelta)
      expect(adapter.getCommitDiff).toHaveBeenCalledWith(PRIOR_COMMIT, COMMIT_A)
      expect(mockRunReview.mock.calls).toEqual(unsetReview)
      expect(mismatch.logs.filter(isCheckedLog)).toEqual([`  Checked commit bbbbbbbbbbbb is not the current head ${COMMIT_A} — ignoring it`])
      expect(mismatch.logs.filter(l => !isCheckedLog(l))).toEqual(unset.logs)
      expect('dedup_source' in mismatch.record).toBe(false)
      expect(mismatch.record.action).toBe(unset.record.action)
    })

    it('I6 no previous reviews → not consulted (first review runs)', async () => {
      const { record, logs } = await runWith(makeAdapter(), COMMIT_A)

      expect(logs.some(isCheckedLog)).toBe(false)
      expect(mockRunReview).toHaveBeenCalledTimes(1)
      expect(record.action).toBe('REVIEW')
      expect('dedup_source' in record).toBe(false)
    })

    it.each(['clean', 're-review'] as const)('I7 --force %s → not consulted', async (force) => {
      mockReviewer(reviewWith([NEW_FINDING]))
      const { record, logs } = await runWith(reReviewAdapter(CLEAN_PRIOR), COMMIT_A, { force, dryRun: true })

      expect(logs.some(isCheckedLog)).toBe(false)
      expect(mockRunReview).toHaveBeenCalledTimes(1)
      expect('dedup_source' in record).toBe(false)
    })

    it("I7 --force '' (CI's unset value) → consulted", async () => {
      const { record, logs } = await runWith(reReviewAdapter(CLEAN_PRIOR), COMMIT_A, { force: '' as never })

      expect(logs).toContain(MATCH_LINE)
      expect(mockRunReview).not.toHaveBeenCalled()
      expect(record.dedup_source).toBe('checked_commit')
    })

    it('I8 an older head as the value never changes the delta base (footer..head)', async () => {
      mockReviewer(reviewWith([NEW_FINDING]))
      const adapter = reReviewAdapter(CLEAN_PRIOR)

      await runWith(adapter, 'ddd444555666', { dryRun: true })

      expect(adapter.getCommitDiff).toHaveBeenCalledWith(PRIOR_COMMIT, COMMIT_A)
      expect(mockRunReview.mock.calls[0][11]).toContain('+foo()')
    })

    it('I9 footer already names the head → today\'s path, not consulted, no log', async () => {
      const { record, logs } = await runWith(sameHeadAdapter(), 'eeeeeeeeeeee')

      expect(logs.some(isCheckedLog)).toBe(false)
      expect(record.skip_reason).toBe('no new commits and no unanswered questions')
      expect('dedup_source' in record).toBe(false)
    })

    it('I10 known limitation: same head after a retarget still dedups on the checked commit', async () => {
      const adapter = reReviewAdapter(CLEAN_PRIOR, [], { getPullRequestInfo: vi.fn().mockResolvedValue({ ...makePRInfo(), targetBranch: 'release/2.0' }) })

      const { record } = await runWith(adapter, COMMIT_A)

      expect(record.target_branch).toBe('release/2.0')
      expect(record.action).toBe('DEDUP_SKIP')
      expect(record.skip_reason).toBe(DEDUP_REASON)
      expect(mockRunReview).not.toHaveBeenCalled()
    })
  })

  describe('mark rule: checked_commit present', () => {
    it('I11 a posted REVIEW and RE_REVIEW carry the full sourceCommit', async () => {
      mockReviewer(reviewWith([NEW_FINDING]))
      const first = await runWith(makeAdapter({ getPullRequestInfo: vi.fn().mockResolvedValue(makePRInfo(HEAD40)) }), undefined)
      expect(first.record.action).toBe('REVIEW')
      expect(first.record.checked_commit).toBe(HEAD40)

      vi.clearAllMocks(); mockReviewer(reviewWith([NEW_FINDING]))
      const again = await runWith(reReviewAdapter(CLEAN_PRIOR), undefined)
      expect(again.record.action).toBe('RE_REVIEW')
      expect(again.record.checked_commit).toBe(COMMIT_A)
      expect('dedup_source' in again.record).toBe(false)
    })

    it('I11 the new keys sit before jenkins, so trigger and error keep their place at the end', async () => {
      mockReviewer(reviewWith([NEW_FINDING]))
      const { record } = await runWith(makeAdapter(), COMMIT_A, { trigger: { event: 'pullrequest:updated', commentAuthor: '{dev}' } })

      expect(Object.keys(record).slice(-4)).toEqual(['checked_commit', 'jenkins', 'trigger', 'error'])
    })

    it('I13 JUDGE-gate NO_NEW_FINDINGS', async () => {
      quietZero()
      const { record } = await runWith(reReviewAdapter(CLEAN_PRIOR), undefined)

      expect(record.action).toBe('NO_NEW_FINDINGS')
      expect(record.checked_commit).toBe(COMMIT_A)
    })

    it('I14 coherent no_change with 0 findings: no reply, reply, reply limit', async () => {
      noChange()
      const none = await runWith(reReviewAdapter(CLEAN_PRIOR), undefined)
      expect(none.record.action).toBe('NO_CHANGE')
      expect(none.record.checked_commit).toBe(COMMIT_A)

      vi.clearAllMocks(); noChange()
      const reply = await runWith(reReviewAdapter(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')]), undefined)
      expect(reply.record.action).toBe('REPLY')
      expect(reply.record.checked_commit).toBe(COMMIT_A)

      vi.clearAllMocks(); noChange()
      const limited = await runWith(reReviewAdapter(CLEAN_PRIOR, [], {
        getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [devReply('2026-03-09T12:00:00Z')], agentReplyCount: 3 }),
      }), undefined)
      expect(limited.record.skip_reason).toBe('reply limit reached (3/3)')
      expect(limited.record.checked_commit).toBe(COMMIT_A)
    })

    it('I18 a quiet 0-finding re-review that answers a reply', async () => {
      quietZero()
      const { record } = await runWith(reReviewAdapter(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')]), undefined)

      expect(record.action).toBe('REPLY')
      expect(record.checked_commit).toBe(COMMIT_A)
    })

    it('I19 JUDGE-gate reply limit', async () => {
      cfg.reply.maxComments = 1
      quietZero()
      const { record } = await runWith(reReviewAdapter(CLEAN_PRIOR, [agentReply('2026-03-09T11:00:00Z'), devReply('2026-03-09T12:00:00Z')]), undefined)

      expect(record.action).toBe('DEDUP_SKIP')
      expect(record.skip_reason).toBe('reply limit reached (1/1)')
      expect(mockRunCommentResponse).not.toHaveBeenCalled()
      expect(record.checked_commit).toBe(COMMIT_A)
    })

    it('I20 footer same-commit and zero-reviewable delta, each ending DEDUP_SKIP or REPLY', async () => {
      const lockOnly = 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-"a"\n+"b"\n'
      const cases: Array<[string, () => VCSAdapter, string]> = [
        ['same-commit', () => sameHeadAdapter(), 'DEDUP_SKIP'],
        ['same-commit + reply', () => sameHeadAdapter([devReply('2026-03-09T12:00:00Z')]), 'REPLY'],
        ['zero delta', () => reReviewAdapter(CLEAN_PRIOR, [], { getCommitDiff: vi.fn().mockResolvedValue(lockOnly) }), 'DEDUP_SKIP'],
        ['zero delta + reply', () => reReviewAdapter(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')], { getCommitDiff: vi.fn().mockResolvedValue(lockOnly) }), 'REPLY'],
      ]
      for (const [name, make, action] of cases) {
        vi.clearAllMocks(); setupModelMocks()
        const { record } = await runWith(make(), undefined)
        expect(mockRunReview, name).not.toHaveBeenCalled()
        expect(record.action, name).toBe(action)
        expect(record.checked_commit, name).toBe(COMMIT_A)
        expect('dedup_source' in record, name).toBe(false)
      }
    })

    it('I21 pre-post race (another run posted for this head)', async () => {
      mockReviewer(reviewWith([NEW_FINDING]))
      const adapter = makeAdapter({
        getPreviousReviewComments: vi.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: '201', body: CLEAN_PRIOR + footer(1, COMMIT_A), createdOn: PRIOR_AT }]),
      })

      const { record } = await runWith(adapter, undefined)

      expect(adapter.postComment).not.toHaveBeenCalled()
      expect(record.skip_reason).toBe('Another agent run already reviewed this commit (race condition avoided)')
      expect(record.checked_commit).toBe(COMMIT_A)
    })

    it('I22 a delta dropped as larger than the PR diff still marks (deterministic)', async () => {
      const huge = 'diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,1 +1,80 @@\n' + Array.from({ length: 80 }, (_, i) => `+export const merged${i} = ${i}`).join('\n') + '\n'
      quietZero()
      const { record } = await runWith(reReviewAdapter(CLEAN_PRIOR, [], { getCommitDiff: vi.fn().mockResolvedValue(huge) }), undefined)

      expect(record.action).toBe('NO_NEW_FINDINGS')
      expect(record.checked_commit).toBe(COMMIT_A)
    })
  })

  describe('mark rule: checked_commit absent', () => {
    it('I12 dry-run never marks, though it still consults the checked commit', async () => {
      mockReviewer(reviewWith([NEW_FINDING]))
      const first = await runWith(makeAdapter(), undefined, { dryRun: true })
      expect(first.record.action).toBe('REVIEW')
      expect('checked_commit' in first.record).toBe(false)

      vi.clearAllMocks(); setupModelMocks()
      const footerHit = await runWith(sameHeadAdapter(), undefined, { dryRun: true })
      expect(footerHit.record.action).toBe('DEDUP_SKIP')
      expect('checked_commit' in footerHit.record).toBe(false)

      vi.clearAllMocks(); setupModelMocks()
      const consulted = await runWith(reReviewAdapter(CLEAN_PRIOR), COMMIT_A, { dryRun: true })
      expect(consulted.record.dedup_source).toBe('checked_commit')
      expect('checked_commit' in consulted.record).toBe(false)
    })

    it('I15 no_change true with a finding → action NO_CHANGE, not marked', async () => {
      noChange([NEW_FINDING])
      const { record } = await runWith(reReviewAdapter(CLEAN_PRIOR), undefined)

      expect(record.action).toBe('NO_CHANGE')
      expect('checked_commit' in record).toBe(false)
    })

    it('I16 a bare NO_CHANGE line inside a finding body → NO_CHANGE, not marked', async () => {
      mockReviewer(reviewWith([{ ...NEW_FINDING, body: 'desc\nNO_CHANGE\nmore' }]))
      const { record } = await runWith(reReviewAdapter(CLEAN_PRIOR), undefined)

      expect(record.action).toBe('NO_CHANGE')
      expect('checked_commit' in record).toBe(false)
    })

    it('I17 POST_REVIEW empty or NO_CHANGE after cleanup', async () => {
      for (const text of ['<!-- jenkins: build 7 -->', 'NO_CHANGE <!-- jenkins: build 7 -->']) {
        vi.clearAllMocks()
        setupModelMocks(text, reviewWith([NEW_FINDING]))
        const { record } = await runWith(reReviewAdapter(CLEAN_PRIOR), undefined)
        expect(record.skip_reason, text).toBe('Review text empty or NO_CHANGE after cleanup')
        expect('checked_commit' in record, text).toBe(false)
      }
    })

    it('I18 a non-quiet 0-finding re-review that answers a reply (prior had findings, or one still open)', async () => {
      quietZero()
      const flagged = await runWith(reReviewAdapter(FLAGGED_PRIOR, [devReply('2026-03-09T12:00:00Z')]), undefined)
      expect(flagged.record.action).toBe('REPLY')
      expect('checked_commit' in flagged.record).toBe(false)

      vi.clearAllMocks()
      mockReviewer(reviewWith([], { delta_stats: { resolved: 0, still_open: 1, new_findings: 0 } }))
      const open = await runWith(reReviewAdapter(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')]), undefined)
      expect(open.record.action).toBe('REPLY')
      expect('checked_commit' in open.record).toBe(false)
    })

    it('I18 non-quiet 0-finding re-review + reply: VCS and model calls are exactly the reply path', async () => {
      quietZero()
      const reply = devReply('2026-03-09T12:00:00Z')
      const priorBody = FLAGGED_PRIOR + footer(1, PRIOR_COMMIT)
      const adapter = reReviewAdapter(FLAGGED_PRIOR, [reply])

      const { record, logs } = await runWith(adapter, undefined)

      expect(vi.mocked(adapter.getPullRequestInfo).mock.calls).toEqual([['100']])
      expect(vi.mocked(adapter.getPreviousReviewComments).mock.calls).toEqual([['100']])
      expect(vi.mocked(adapter.getCommitDiff).mock.calls).toEqual([[PRIOR_COMMIT, COMMIT_A]])
      expect(vi.mocked(adapter.getRepliesToReviewComments).mock.calls).toEqual([['100', ['200'], true]])
      expect(mockRunReview).toHaveBeenCalledTimes(1)
      expect(mockRunReview.mock.calls[0][9]).toEqual([{ id: '200', body: priorBody, createdOn: PRIOR_AT }])
      expect(mockRunReview.mock.calls[0][10]).toEqual([reply])
      expect(mockRunJudge).not.toHaveBeenCalled()
      expect(mockRunCommentResponse.mock.calls).toEqual([[cfg.llmApiKey, 'claude-haiku-4-5-20251001', 1, mockRunReview.mock.calls[0][6], priorBody, [reply]]])
      expect(adapter.postComment).not.toHaveBeenCalled()
      expect(vi.mocked(adapter.postReply).mock.calls).toEqual([['100', '200', 'Thanks for clarifying.' + buildReplyFooter('test-bot', 'claude-haiku-4-5-20251001', process.env.BUILD_URL || undefined)]])
      expect(logs).toContain('  Re-review found nothing new, but a developer reply is unanswered — answering it in-thread')
      expect(logs.some(l => l.includes('Re-review with no new findings — posting'))).toBe(false)
      expect(record).toMatchObject({ action: 'REPLY', skip_reason: null, review_number: 2 })
      expect('checked_commit' in record).toBe(false)
    })

    it('I22 the delta fetch rejects, then NO_NEW_FINDINGS', async () => {
      quietZero()
      const { record } = await runWith(reReviewAdapter(CLEAN_PRIOR, [], { getCommitDiff: vi.fn().mockRejectedValue(new Error('404')) }), undefined)

      expect(record.action).toBe('NO_NEW_FINDINGS')
      expect('checked_commit' in record).toBe(false)
    })

    it('I22 the delta fetch rejects, then the full-diff fallback review is posted (H9 guard)', async () => {
      mockReviewer(reviewWith([NEW_FINDING]))
      const adapter = reReviewAdapter(CLEAN_PRIOR, [], { getCommitDiff: vi.fn().mockRejectedValue(new Error('404')) })

      const { record } = await runWith(adapter, undefined)

      expect(mockRunReview.mock.calls[0][11]).toBe('')
      expect(adapter.postComment).toHaveBeenCalledTimes(1)
      expect(record.action).toBe('RE_REVIEW')
      expect('checked_commit' in record).toBe(false)
    })

    it('I23 SKIP runs (branch, ONLY_TARGET_BRANCHES, threshold, budget, trigger ignore) never carry it', async () => {
      const cases: Array<[string, () => void, () => VCSAdapter, RunOpts]> = [
        ['branch', () => {}, () => reReviewAdapter(CLEAN_PRIOR, [], { getPullRequestInfo: vi.fn().mockResolvedValue({ ...makePRInfo(), sourceBranch: 'hotfix/x' }) }), {}],
        ['only-target', () => { cfg.onlyTargetBranches = ['release/*'] }, () => reReviewAdapter(CLEAN_PRIOR), {}],
        ['threshold', () => { cfg.thresholds.minChangedLines = 1000 }, () => reReviewAdapter(CLEAN_PRIOR), {}],
        ['budget', () => { cfg.anthropic.maxInputTokens = 5 }, () => makeAdapter(), {}],
        ['trigger ignore', () => { cfg.trigger.ignoreCommentAuthors = ['bot'] }, () => reReviewAdapter(CLEAN_PRIOR), { trigger: { event: 'pullrequest:comment_created', commentAuthor: '{bot}' } }],
      ]
      for (const [name, configure, make, opts] of cases) {
        vi.clearAllMocks(); setupModelMocks(); configure()
        const { record } = await runWith(make(), COMMIT_A, opts)
        expect(record.action, name).toBe('SKIP')
        expect('checked_commit' in record, name).toBe(false)
        expect('dedup_source' in record, name).toBe(false)
      }
    })

    it('I26 an outcome sink (benchmark) never marks, even at a mark point', async () => {
      const sink = vi.fn().mockResolvedValue(undefined)
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        const first = await review(makeAdapter(), '100', false, undefined, 'off', false, '', sink)
        expect(sink).toHaveBeenCalledTimes(1)
        expect('checked_commit' in first!).toBe(false)

        const footerHit = await review(sameHeadAdapter(), '100', false, undefined, 'off', false, '', sink, undefined, COMMIT_A)
        expect(footerHit!.action).toBe('DEDUP_SKIP')
        expect('checked_commit' in footerHit!).toBe(false)
      } finally {
        logSpy.mockRestore()
      }
    })
  })

  describe('errors after a mark, and force', () => {
    it('I24 getRepliesToReviewComments rejecting after H1 → ERROR, absent', async () => {
      const record = await failWith(sameHeadAdapter([], 0, { getRepliesToReviewComments: vi.fn().mockRejectedValue(new Error('replies 503')) }), undefined, 'replies 503')

      expect(record.action).toBe('ERROR')
      expect('checked_commit' in record).toBe(false)
    })

    it('I24 getRepliesToReviewComments rejecting after H3 → ERROR, absent (dedup_source kept)', async () => {
      const record = await failWith(reReviewAdapter(CLEAN_PRIOR, [], { getRepliesToReviewComments: vi.fn().mockRejectedValue(new Error('replies 503')) }), COMMIT_A, 'replies 503')

      expect(record.action).toBe('ERROR')
      expect(record.dedup_source).toBe('checked_commit')
      expect('checked_commit' in record).toBe(false)
    })

    it('I24 runCommentResponse rejecting after H6 → ERROR, absent', async () => {
      quietZero()
      mockRunCommentResponse.mockRejectedValue(new Error('reply model down'))
      const record = await failWith(reReviewAdapter(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')]), undefined, 'reply model down')

      expect(record.action).toBe('ERROR')
      expect('checked_commit' in record).toBe(false)
    })

    it.each(['clean', 're-review'] as const)('I25 --force %s → absent even when posted', async (force) => {
      mockReviewer(reviewWith([NEW_FINDING]))
      const adapter = sameHeadAdapter()

      const { record } = await runWith(adapter, COMMIT_A, { force })

      expect(adapter.postComment).toHaveBeenCalledTimes(1)
      expect('checked_commit' in record).toBe(false)
    })

    it("I25 --force '' → present on H1, H7 and H9 (no pre-post GET)", async () => {
      const h1 = await runWith(sameHeadAdapter(), undefined, { force: '' as never })
      expect(h1.record.action).toBe('DEDUP_SKIP')
      expect(h1.record.checked_commit).toBe(COMMIT_A)

      vi.clearAllMocks(); quietZero()
      const h7 = await runWith(reReviewAdapter(CLEAN_PRIOR), undefined, { force: '' as never })
      expect(h7.record.action).toBe('NO_NEW_FINDINGS')
      expect(h7.record.checked_commit).toBe(COMMIT_A)

      vi.clearAllMocks(); mockReviewer(reviewWith([NEW_FINDING]))
      const adapter = reReviewAdapter(CLEAN_PRIOR)
      const h9 = await runWith(adapter, undefined, { force: '' as never })
      expect(adapter.getPreviousReviewComments).toHaveBeenCalledTimes(1)
      expect(adapter.postComment).toHaveBeenCalledTimes(1)
      expect(h9.record.checked_commit).toBe(COMMIT_A)
    })
  })

  describe('reviewer findings null or not a list (strict:false provider), through the real runReview: ERROR with its record, nothing posted, never marked', () => {
    const MISSING = 'Structured output missing required field(s): findings'
    const malformed = (extra: Record<string, unknown> = {}) => ({ summary: '', findings: null, behavioral_diff: [], production_risk: [], unresolved_questions: [], ...extra })
    const realReviewer = async (completeStructured: ReturnType<typeof vi.fn>) => {
      setupModelMocks()
      const actual = await vi.importActual<typeof import('../client.js')>('../client.js')
      vi.mocked(createProvider).mockReturnValue({ complete: vi.fn(), completeStructured } as never)
      mockRunReview.mockImplementation(actual.runReview)
    }
    const returning = (object: Record<string, unknown>) => realReviewer(vi.fn().mockResolvedValue({ object, usage: { input_tokens: 1000, output_tokens: 200 } }))
    const expectMissingFindingsError = (record: Awaited<ReturnType<typeof failWith>>, name: string) => {
      expect(record.action, name).toBe('ERROR')
      expect(record.error, name).toEqual({ type: 'Error', message: MISSING, status: null })
      expect(record.tokens, name).toMatchObject({ input: 1000, output: 200 })
      expect(record.review_findings, name).toBeNull()
      expect('checked_commit' in record, name).toBe(false)
    }

    it('M1 re-review: no_change + findings null, or findings null with a pending dev reply → ERROR, no review or reply posted', async () => {
      const cases: Array<[string, Record<string, unknown>, () => VCSAdapter]> = [
        ['no_change', malformed({ no_change: true }), () => reReviewAdapter(CLEAN_PRIOR)],
        ['no_change + reply', malformed({ no_change: true }), () => reReviewAdapter(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')])],
        ['quiet + reply', malformed(), () => reReviewAdapter(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')])],
      ]
      for (const [name, object, make] of cases) {
        vi.clearAllMocks(); await returning(object)
        const adapter = make()
        expectMissingFindingsError(await failWith(adapter, undefined, MISSING), name)
        expect(adapter.postComment, name).not.toHaveBeenCalled()
        expect(adapter.postReply, name).not.toHaveBeenCalled()
        expect(mockRunCommentResponse, name).not.toHaveBeenCalled()
      }
    })

    it('M2 first review: findings null, an object or a string → ERROR with the paid tokens, no review posted', async () => {
      for (const findings of [null, {}, 'none']) {
        vi.clearAllMocks(); await returning(malformed({ summary: 'S', findings }))
        const adapter = makeAdapter()
        expectMissingFindingsError(await failWith(adapter, undefined, MISSING), JSON.stringify(findings))
        expect(adapter.postComment).not.toHaveBeenCalled()
      }
    })

    it('M3 the same record a missing findings key gets from the providers, except that the paid tokens are kept', async () => {
      await realReviewer(vi.fn().mockRejectedValue(new Error(MISSING)))
      const missing = await failWith(makeAdapter(), undefined, MISSING)
      vi.clearAllMocks(); await returning(malformed({ summary: 'S' }))
      const nulled = await failWith(makeAdapter(), undefined, MISSING)

      const comparable = (r: typeof missing) => ({ ...r, timestamp: '', duration_ms: 0, tokens: null, cost_usd: 0 })
      expect(comparable(nulled)).toEqual(comparable(missing))
      expect(missing.tokens.input).toBe(0)
      expect(nulled.tokens).toMatchObject({ input: 1000, output: 200 })
    })

    it('M4 a malformed object that still reaches the FSM cannot hide the run\'s real error or outcome: the record is written', async () => {
      const raw = { ...reviewWith(), summary: '', findings: null as never, no_change: true }
      setupModelMocks('NO_CHANGE', raw)
      const first = await failWith(makeAdapter(), undefined, 'Reviewer returned NO_CHANGE on a first review')
      expect(first.action).toBe('ERROR')
      expect(first.error!.message).toBe('Reviewer returned NO_CHANGE on a first review — refusing to silently skip')
      expect(first.review_findings).toBeNull()

      vi.clearAllMocks(); setupModelMocks('NO_CHANGE', raw)
      const again = await runWith(reReviewAdapter(CLEAN_PRIOR), undefined)
      expect(again.record.action).toBe('NO_CHANGE')
      expect(again.record.review_findings).toBeNull()
      expect('checked_commit' in again.record).toBe(false)
    })
  })
})
