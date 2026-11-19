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
import { renderReview, buildReplyFooter, type ReviewObject } from '../formatter.js'

const cfg = config as any
const COMMIT_A = 'aaa111222333'
const PRIOR_COMMIT = 'aabbcc112233'
const PRIOR_AT = '2026-03-09T10:00:00Z'
const LIMIT = 3
const DIFF = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,5 @@
+import { foo } from './foo'
+foo()
`
const CLEAN_PRIOR = '### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.'
const FLAGGED_PRIOR = '### Summary\nOne issue.\n\n### Findings\n- **MEDIUM – Prior issue** (`a.ts:1`)\n  desc\n\n### Unresolved Questions\nNone.'
const NEW_FINDING: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'New issue', file: 'src/app.ts', lines: '11', body: 'desc' }
const footer = (n: number, commit: string) => `\n\n---\n*Reviewed by test-bot (claude-haiku-4-5-20251001) | Prompt: repo | Review #${n} | Commit: ${commit}*`
const reviewWith = (findings: ReviewObject['findings'] = [], extra: Partial<ReviewObject> = {}): ReviewObject =>
  ({ summary: 'ok', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [], ...extra })

type Entry = 'comment' | 'push-nochange' | 'push-zero' | 'push-findings'
type Budget = 'below' | 'at' | 'above'
type Prior = 'clean' | 'findings'
interface Outcome { action: string; reason: string | null; review: boolean; reply: boolean; note: boolean; model: boolean; head: boolean }
interface Row { entry: Entry; question: boolean; budget: Budget; flag: boolean; prior: Prior; expect: Outcome }

const COUNT: Record<Budget, number> = { below: LIMIT - 1, at: LIMIT, above: LIMIT + 1 }
const NOTE_RE = /^Reply limit of \d+ reached for this review\./

function buildAdapter(row: Row): VCSAdapter {
  const n = COUNT[row.budget]
  const agent: CommentReply[] = Array.from({ length: n }, (_, i) => ({
    id: `agent-${i}`, parentId: '200', author: 'Agent (prior reply)', body: 'Confirmed.' + buildReplyFooter('test-bot', 'claude-haiku-4-5-20251001'), createdOn: `2026-03-09T10:1${i}:00Z`,
  }))
  const dev: CommentReply[] = row.question ? [{ id: 'dev-1', parentId: '200', author: 'Fernando', body: 'Why?', createdOn: '2026-03-09T12:00:00Z' }] : []
  const priorBody = (row.prior === 'clean' ? CLEAN_PRIOR : FLAGGED_PRIOR) + footer(1, row.entry === 'comment' ? COMMIT_A : PRIOR_COMMIT)
  const info: PRInfo = { id: '100', title: 'T', description: 'd', author: 'dev', sourceBranch: 'feature/t', targetBranch: 'develop', sourceCommit: COMMIT_A }
  return {
    getPullRequestInfo: vi.fn().mockResolvedValue(info),
    getDiff: vi.fn().mockResolvedValue(DIFF),
    getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/app.ts', status: 'modified' }]),
    getFileContent: vi.fn().mockResolvedValue(''),
    getRepoFileContent: vi.fn().mockResolvedValue(null),
    postComment: vi.fn().mockResolvedValue(undefined),
    getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '200', body: priorBody, createdOn: PRIOR_AT }]),
    getRepliesToReviewComments: vi.fn().mockImplementation(async (_pr: string, _ids: string[], includeAnswered?: boolean) =>
      includeAnswered ? { replies: [...agent, ...dev], agentReplyCount: n } : { replies: dev, agentReplyCount: n }),
    postReply: vi.fn().mockResolvedValue(undefined),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),
  } as unknown as VCSAdapter
}

function mockReviewer(entry: Entry) {
  const obj = entry === 'push-nochange' ? reviewWith([], { summary: '', no_change: true })
    : entry === 'push-findings' ? reviewWith([NEW_FINDING])
    : reviewWith([], { delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } })
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
  vi.mocked(runReview).mockResolvedValue({ text: renderReview(obj), usage: { input_tokens: 1000, output_tokens: 200 }, review: obj })
  vi.mocked(runCommentResponse).mockResolvedValue({ text: 'Answer.', usage: { input_tokens: 500, output_tokens: 100 } })
}

async function run(row: Row): Promise<Outcome> {
  cfg.reply.maxComments = LIMIT
  cfg.reply.limitPerReview = row.flag
  const adapter = buildAdapter(row)
  mockReviewer(row.entry)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const record = await review(adapter, '100', false)
    const replies = vi.mocked(adapter.postReply).mock.calls.map(c => String(c[2]))
    return {
      action: record!.action,
      reason: record!.skip_reason,
      review: vi.mocked(adapter.postComment).mock.calls.length > 0,
      reply: replies.some(b => !NOTE_RE.test(b)),
      note: replies.some(b => NOTE_RE.test(b)),
      model: vi.mocked(runCommentResponse).mock.calls.length > 0,
      head: record!.checked_commit === COMMIT_A,
    }
  } finally {
    log.mockRestore(); warn.mockRestore()
  }
}

const CLEAN_NONE = 'Re-review found no new findings (prior review already clean)'
const o = (action: string, reason: string | null, f: Partial<Omit<Outcome, 'action' | 'reason'>> = {}): Outcome =>
  ({ action, reason, review: false, reply: false, note: false, model: false, head: false, ...f })

export const ROWS: Row[] = []
const add = (entry: Entry, question: boolean, budget: Budget, flag: boolean, prior: Prior, expect: Outcome) => ROWS.push({ entry, question, budget, flag, prior, expect })

// Flag off: only the limit-reached rows with an open question after a push differ from main (A1/A2); the rest equal main.
for (const budget of ['below', 'at', 'above'] as Budget[]) {
  const n = COUNT[budget]
  const limitReason = `reply limit reached (${n}/${LIMIT})`
  add('comment', false, budget, false, 'clean', o('DEDUP_SKIP', 'no new commits and no unanswered questions', { head: true }))
  add('comment', true, budget, false, 'clean', budget === 'below'
    ? o('REPLY', null, { reply: true, model: true, head: true })
    : o('DEDUP_SKIP', limitReason, { head: true }))
  add('push-nochange', false, budget, false, 'clean', o('NO_CHANGE', 'No changes since last review', { head: true }))
  add('push-nochange', true, budget, false, 'clean', budget === 'below'
    ? o('REPLY', null, { reply: true, model: true, head: true })
    : o('NO_CHANGE', 'No changes since last review', { head: true }))
  add('push-zero', false, budget, false, 'clean', o('NO_NEW_FINDINGS', CLEAN_NONE, { head: true }))
  add('push-zero', true, budget, false, 'clean', budget === 'below'
    ? o('REPLY', null, { reply: true, model: true, head: true })
    : o('NO_NEW_FINDINGS', CLEAN_NONE, { head: true }))
  add('push-zero', false, budget, false, 'findings', o('RE_REVIEW', null, { review: true, head: true }))
  add('push-zero', true, budget, false, 'findings', budget === 'below'
    ? o('REPLY', null, { reply: true, model: true })
    : o('RE_REVIEW', null, { review: true, head: true }))
  add('push-findings', false, budget, false, 'clean', o('RE_REVIEW', null, { review: true, head: true }))
  add('push-findings', true, budget, false, 'clean', o('RE_REVIEW', null, { review: true, head: true }))
}

// Flag on, replies all newer than the review, so the per-review count equals the PR count. Pure dedup and NO_CHANGE: a note at the limit, none above it.
for (const budget of ['below', 'at', 'above'] as Budget[]) {
  const n = COUNT[budget]
  const note = budget === 'at'
  const limitReason = `reply limit reached (${n}/${LIMIT})`
  add('comment', false, budget, true, 'clean', o('DEDUP_SKIP', 'no new commits and no unanswered questions', { head: true }))
  add('comment', true, budget, true, 'clean', budget === 'below'
    ? o('REPLY', null, { reply: true, model: true, head: true })
    : o('DEDUP_SKIP', limitReason, { head: true, note }))
  add('push-nochange', false, budget, true, 'clean', o('NO_CHANGE', 'No changes since last review', { head: true }))
  add('push-nochange', true, budget, true, 'clean', budget === 'below'
    ? o('REPLY', null, { reply: true, model: true, head: true })
    : o('NO_CHANGE', 'No changes since last review', { head: true, note }))
  add('push-zero', false, budget, true, 'clean', o('NO_NEW_FINDINGS', CLEAN_NONE, { head: true }))
  add('push-zero', false, budget, true, 'findings', o('RE_REVIEW', null, { review: true, head: true }))
  add('push-findings', false, budget, true, 'clean', o('RE_REVIEW', null, { review: true, head: true }))
  add('push-findings', true, budget, true, 'clean', o('RE_REVIEW', null, { review: true, head: true }))
}
add('push-zero', true, 'below', true, 'clean', o('REPLY', null, { reply: true, model: true, head: true }))
add('push-zero', true, 'below', true, 'findings', o('REPLY', null, { reply: true, model: true }))
// The gate never posts a note: at or above the limit it finishes the re-review as with the flag off.
for (const budget of ['at', 'above'] as Budget[]) {
  add('push-zero', true, budget, true, 'clean', o('NO_NEW_FINDINGS', CLEAN_NONE, { head: true }))
  add('push-zero', true, budget, true, 'findings', o('RE_REVIEW', null, { review: true, head: true }))
}

beforeEach(() => { vi.clearAllMocks() })

describe('reply limit decision table', () => {
  it.each(ROWS.map(r => [`${r.entry} q=${r.question} budget=${r.budget} flag=${r.flag} prior=${r.prior}`, r] as const))('%s', async (_name, row) => {
    expect(await run(row)).toEqual(row.expect)
  })
})
