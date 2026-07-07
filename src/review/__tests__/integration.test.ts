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
    review: { maxFindings: 0, splitCheck: false, todoScan: true },
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

function setupClaudeMocks(reviewText = '### Summary\nAll good.\n\n### Findings\n\nNo findings.\n\n### Unresolved Questions\nNone.') {
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
  cfg.review = { maxFindings: 0, splitCheck: false, todoScan: true }
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

  it('does not post summary + standalone NO_CHANGE line (PR 8718 regression)', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks('### Summary\n\nNo new findings. New commits contain only cosmetic changes.\n\nNO_CHANGE')

    const record = await review(adapter, '100', true)

    expect(record!.action).toBe('NO_CHANGE')
    expect(adapter.postComment).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Scenario 8b: Judge leaks validation reasoning before the review → stripped
// ===========================================================================

describe('judge preamble leak → stripped before posting', () => {
  it('posts only from ### Summary onward (PR 45 regression)', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks('### Summary\nRisky refactor.\n\n### Findings\n\n- **MEDIUM – Substring matching** (a.ts:1)\n  Over-matches rows.')
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
    setupClaudeMocks('### Summary\nRisky.\n\n### Findings\n\n- **MEDIUM – Something** (a.ts:1)\n  Desc.')
    cfg.judge.model = 'judge-model'
    mockRunJudge.mockResolvedValue({
      text: '### Summary\nLow-risk change.\n\n### Findings\n\n- **LOW – Fragile helper** (a.ts:1)\n  Desc.\n\n### Merge Confidence: 80%\n\n<!-- JUDGE_NOTES: Dropped MEDIUM — convention claim not verifiable from diff. -->',
      usage: { input_tokens: 800, output_tokens: 300 },
    })

    const record = await review(adapter, '100', false)

    expect(record!.action).toBe('REVIEW')
    const body = vi.mocked(adapter.postComment).mock.calls[0][1] as string
    expect(body).not.toContain('JUDGE_NOTES')
    expect(body).not.toContain('Dropped MEDIUM')
    expect(body).toContain('LOW – Fragile helper')
  })
})

// ===========================================================================
// Scenario 8c: Cut guard — truncated review must not be posted (PR 8722)
// ===========================================================================

describe('cut guard — truncated review not posted', () => {
  it('rejects a judged review missing the Merge Confidence tail', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks('### Summary\nRisky.\n\n### Findings\n\n- **MEDIUM – X** (a.ts:1)\n  Desc.')
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

    const promptArg = mockRunReview.mock.calls[0][6] as { content: string }
    expect(promptArg.content).toContain('FINDINGS LIMIT')
    expect(promptArg.content).toContain('at most 3')
  })

  it('does not append anything when MAX_FINDINGS is 0', async () => {
    const adapter = makeAdapter()
    setupClaudeMocks()

    await review(adapter, '100', true)

    const promptArg = mockRunReview.mock.calls[0][6] as { content: string }
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
