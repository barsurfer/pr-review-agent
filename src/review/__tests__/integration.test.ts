import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VCSAdapter, PRInfo, ReviewComment, CommentReply } from '../../vcs/adapter.js'

// ---------------------------------------------------------------------------
// Mocks — vi.mock factories are hoisted, so no external refs allowed
// ---------------------------------------------------------------------------

vi.mock('../../config.js', () => ({
  config: {
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', maxRetries: 1, maxInputTokens: 150000 },
    judge: { model: '', maxRetries: 1 },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3 },
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
import { runReview, runCommentResponse } from '../../claude/client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'

const mockRunReview = vi.mocked(runReview)
const mockRunCommentResponse = vi.mocked(runCommentResponse)
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

function setupClaudeMocks(reviewText = '### Summary\nAll good.\n\n### Findings\n\nNo findings.') {
  mockLoadPrompt.mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  mockFetchContext.mockResolvedValue([])
  mockRunReview.mockResolvedValue({ text: reviewText, usage: { input_tokens: 1000, output_tokens: 200 } })
  mockRunCommentResponse.mockResolvedValue({ text: 'Thanks for clarifying.', usage: { input_tokens: 500, output_tokens: 100 } })
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset mock implementations (clearAllMocks only clears call records)
  setupClaudeMocks()
  cfg.judge.model = ''
  cfg.reply.maxComments = 3
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
// Scenario 6: New commit → delta RE_REVIEW
// ===========================================================================

describe('new commit → RE_REVIEW', () => {
  it('produces delta review with discussion', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Old' + footer(1, 'aabbcc112233'), createdOn: '2026-03-09T10:00:00Z' },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({
        replies: [{ id: '300', parentId: '200', author: 'Vadim', body: 'Fixed', createdOn: '2026-03-09T12:00:00Z' }],
        agentReplyCount: 0,
      }),
      getCommitDiff: vi.fn().mockResolvedValue(DIFF),
    })
    setupClaudeMocks()

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('RE_REVIEW')
    expect(record!.review_number).toBe(2)
    expect(mockRunReview).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// Scenario 7: New commit but delta only excluded files → NO_CHANGE skip
// ===========================================================================

describe('delta only excluded files → NO_CHANGE', () => {
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

    expect(record!.action).toBe('NO_CHANGE')
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 8: Claude returns NO_CHANGE → skip (never post)
// ===========================================================================

describe('Claude returns NO_CHANGE → skip', () => {
  it('does not post NO_CHANGE as a comment', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks('NO_CHANGE')

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('NO_CHANGE')
    expect(adapter.postComment).not.toHaveBeenCalled()
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
        { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
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
})

// ===========================================================================
// Scenario 14: force=off by default → dedup works
// Regression: Commander default value bug (PR 712 root cause)
// ===========================================================================

describe('force defaults to off → dedup works', () => {
  it('same commit is deduped when force is not passed', async () => {
    const adapter = makeAdapter({
      getPreviousReviewComments: vi.fn().mockResolvedValue([
        { id: '200', body: '### Review' + footer(1, COMMIT_A), createdOn: '2026-03-10T10:00:00Z' },
      ]),
      getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
    })

    // force not passed → defaults to 'off'
    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('DEDUP_SKIP')
    expect(mockRunReview).not.toHaveBeenCalled()
  })
})
