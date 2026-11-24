import { describe, it, expect, vi, beforeEach } from 'vitest'

const cfg = vi.hoisted(() => ({
  llmApiKey: 'k',
  agentIdentity: 'review-bot',
  anthropic: { model: 'claude-sonnet-5-5', maxRetries: 1, maxTokens: 64000 },
  reply: { maxComments: 5, maxFindingReplies: 5, model: 'claude-haiku-5-5', skipDirectedElsewhere: false },
  judge: { suggestedFixes: true },
  review: { inlineReviews: true, inlineLowThreads: false, inlineAgentAccountId: '', todoScan: false },
  diffExcludePatterns: [] as string[],
}))
vi.mock('../../config.js', () => ({ config: cfg, modelContextWindow: () => 1_000_000 }))
vi.mock('../replies-call.js', () => ({ runFindingReplies: vi.fn(), runSummaryReplies: vi.fn() }))

import { selectInlineEngine } from '../engine.js'
import { runFindingReplies, runSummaryReplies } from '../replies-call.js'
import { State, type ReviewContext } from '../../review/types.js'
import { renderReview, type ReviewFinding } from '../../review/formatter.js'
import { rootBody } from '../compose.js'
import { withState, verify } from '../state.js'
import { SUMMARY_HEADER, buildAnswerMarker, parseAnswerMarker } from '../markers.js'
import { makeFake, httpErr, ME, HEAD, HEAD12, type Fake } from './fake-bitbucket.js'
import type { InlineDeps, InlineOutcome } from '../types.js'

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/src/a.ts', '@@ -0,0 +1,20 @@',
  ...Array.from({ length: 20 }, (_, i) => `+line${i + 1}`), '',
].join('\n')
const DELTA = ['diff --git a/src/a.ts b/src/a.ts', 'index 1111111..2222222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -15,1 +15,1 @@', '-line15', '+line15b', ''].join('\n')

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({ severity: 'HIGH', title: 'Null user crashes profile load', file: 'src/a.ts', lines: '4', body: 'It crashes.', ...over })
const reviewObject = (findings: ReviewFinding[], extra = {}) => ({ summary: 'A change.', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [], ...extra })

function ctxOf(fake: Fake, over: Record<string, unknown> = {}): ReviewContext {
  return {
    adapter: fake.adapter, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'r', startTime: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 }, estimatedInputTokens: 0, action: 'ERROR', reviewNumber: 0,
    prInfo: { id: '7', title: 't', description: '', author: 'dev', sourceBranch: 'f', targetBranch: 'main', sourceCommit: HEAD },
    diff: DIFF, filteredDiff: DIFF, changedFiles: [{ path: 'src/a.ts', status: 'added' }], ...over,
  } as unknown as ReviewContext
}

function depsOf(over: Partial<InlineDeps> = {}) {
  return {
    transition: vi.fn(async () => State.LOAD_PROMPT),
    markHeadChecked: vi.fn(),
    narrowTargetMergeDelta: vi.fn(async (_c: ReviewContext, _b: string, _h: string, d: string) => d),
    ...over,
  } as InlineDeps & { transition: ReturnType<typeof vi.fn>; markHeadChecked: ReturnType<typeof vi.fn>; narrowTargetMergeDelta: ReturnType<typeof vi.fn> }
}

const engineOf = (fake: Fake) => selectInlineEngine(fake.adapter)!

const seedSummary = (fake: Fake, state: { n: number; commits: string[] }, text = 'old'): number =>
  fake.add({ body: withState(`${SUMMARY_HEADER}\n\n${text}`, state, ME), authorIds: [ME] })
const seedThread = (fake: Fake, o: { id: string; title: string; line: number; severity?: 'HIGH' | 'MEDIUM' | 'LOW'; resolved?: boolean; base?: string }): number =>
  fake.add({ body: rootBody({ severity: o.severity ?? 'MEDIUM', title: o.title, body: 'Details.', id: o.id, c12: o.base ?? A }), authorIds: [ME], inline: { path: 'src/a.ts', line: o.line }, resolved: o.resolved })

const reviewed = (ctx: ReviewContext, findings: ReviewFinding[]): void => {
  const obj = reviewObject(findings)
  ctx.reviewObject = obj
  ctx.reviewText = renderReview(obj)
}
const summaryOf = (fake: Fake) => fake.comments.find(c => !c.parentId && c.body.startsWith(SUMMARY_HEADER))
const roots = (fake: Fake) => fake.comments.filter(c => c.inline)
const writes = (fake: Fake): string[] => fake.calls.filter(c => ['root', 'summary', 'reply', 'edit'].includes(c))
const neverClosed = (fake: Fake): void => {
  expect(fake.raw.resolveThread).not.toHaveBeenCalled()
  expect(fake.raw.reopenThread).not.toHaveBeenCalled()
  expect(fake.raw.postComment).not.toHaveBeenCalled()
  expect(fake.raw.postReply).not.toHaveBeenCalled()
}

let fake: Fake
beforeEach(() => {
  fake = makeFake()
  fake.hooks.commitDiff = () => DELTA
  cfg.review.inlineReviews = true
  cfg.review.inlineLowThreads = false
  cfg.review.inlineAgentAccountId = ''
  cfg.reply.maxComments = 5
  cfg.judge.suggestedFixes = true
  vi.mocked(runFindingReplies).mockReset()
  vi.mocked(runSummaryReplies).mockReset()
})

describe('selectInlineEngine', () => {
  it('never constructs an engine with the flag off', () => {
    cfg.review.inlineReviews = false
    expect(selectInlineEngine(fake.adapter)).toBeUndefined()
    expect(fake.raw.getAgentIdentity).not.toHaveBeenCalled()
    expect(fake.raw.listMarkedThreads).not.toHaveBeenCalled()
  })

  it('keeps the legacy flow, with a log line, for an adapter without the inline methods', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(selectInlineEngine({ getPullRequestInfo: vi.fn() } as never)).toBeUndefined()
    expect(log.mock.calls.flat().join('\n')).toMatch(/does not support them/)
    log.mockRestore()
  })

  it('keeps the legacy flow for a benchmark run', () => {
    expect(selectInlineEngine(fake.adapter, vi.fn())).toBeUndefined()
  })
})

describe('identity', () => {
  it.each([
    ['no lookup and no setting', () => { fake.hooks.identity = null }, 'identity_unavailable'],
    ['a failing lookup and no setting', () => { fake.hooks.identity = new Error('boom') }, 'identity_unavailable'],
    ['a setting that disagrees with the lookup', () => { cfg.review.inlineAgentAccountId = 'someone-else' }, 'identity_mismatch'],
  ] as Array<[string, () => void, InlineOutcome]>)('stops without posting or calling the model: %s', async (_name, arrange, outcome) => {
    arrange()
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    expect(await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)).toBe(State.SKIP)
    expect(ctx.action).toBe('SKIP')
    expect(ctx.skipReason).toBeTruthy()
    expect(e.record().outcome).toBe(outcome)
    expect(deps.transition).not.toHaveBeenCalled()
    expect(writes(fake)).toEqual([])
    // The SKIP that follows goes straight to the legacy printer, never to a reply flow or a legacy post.
    await e.step(State.SKIP, ctx, deps)
    expect(deps.transition).toHaveBeenCalledWith(State.SKIP, ctx)
    neverClosed(fake)
  })

  it('fails the run with zero writes when the listing throws', async () => {
    fake.hooks.listError = new Error('list down')
    await expect(engineOf(fake).step(State.CHECK_PREVIOUS_REVIEWS, ctxOf(fake), depsOf())).rejects.toThrow('list down')
    expect(writes(fake)).toEqual([])
  })
})

describe('dedup', () => {
  it('dedups A->B->A without a delta fetch and marks the head checked', async () => {
    seedSummary(fake, { n: 2, commits: [B, HEAD12] })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    expect(await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)).toBe(State.SKIP)
    expect(ctx.action).toBe('DEDUP_SKIP')
    expect(e.record().outcome).toBe('dedup')
    expect(fake.raw.getCommitDiff).not.toHaveBeenCalled()
    expect(deps.markHeadChecked).toHaveBeenCalledTimes(1)
    expect(deps.transition).not.toHaveBeenCalled()
    expect(writes(fake)).toEqual([])
  })

  it('reviews when LAST_CHECKED_COMMIT is given but the state is missing or tampered', async () => {
    const e1 = engineOf(fake)
    const c1 = ctxOf(fake, { checkedCommit: HEAD })
    expect(await e1.step(State.CHECK_PREVIOUS_REVIEWS, c1, depsOf())).toBe(State.LOAD_PROMPT)
    expect(c1.dedupHit).toBeUndefined()

    const id = seedSummary(fake, { n: 1, commits: [HEAD12] })
    fake.comments.find(c => c.id === id)!.body += ' tampered'
    const e2 = engineOf(fake)
    const c2 = ctxOf(fake, { checkedCommit: HEAD })
    expect(await e2.step(State.CHECK_PREVIOUS_REVIEWS, c2, depsOf())).toBe(State.LOAD_PROMPT)
    expect(e2.record().summary_check).toBe('tampered')
  })

  it('labels a dedup that matches LAST_CHECKED_COMMIT', async () => {
    seedSummary(fake, { n: 1, commits: [HEAD12] })
    const ctx = ctxOf(fake, { checkedCommit: HEAD })
    await engineOf(fake).step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    expect(ctx.dedupHit).toBe('checked_commit')
  })

  it('records a merge-only delta (null) with no model call', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf({ narrowTargetMergeDelta: vi.fn(async () => null) as never })
    expect(await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)).toBe(State.DONE)
    expect(deps.transition).not.toHaveBeenCalled()
    expect(deps.markHeadChecked).toHaveBeenCalledTimes(1)
    expect(verify(summaryOf(fake)!.body, ME)).toEqual({ n: 2, commits: [A, HEAD12] })
    expect(summaryOf(fake)!.body).toContain('no change')
    expect(ctx.action).toBe('RE_REVIEW')
  })

  it('refreshes the summary on a zero-line delta', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    fake.hooks.commitDiff = () => ''
    const ctx = ctxOf(fake)
    expect(await engineOf(fake).step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())).toBe(State.DONE)
    expect(verify(summaryOf(fake)!.body, ME)!.commits).toContain(HEAD12)
  })

  it('reviews the full diff when the delta fetch fails', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    fake.hooks.commitDiff = () => new Error('gone')
    const ctx = ctxOf(fake)
    expect(await engineOf(fake).step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())).toBe(State.LOAD_PROMPT)
    expect(ctx.deltaFetchFailed).toBe(true)
    expect(ctx.deltaDiff).toBeUndefined()
  })

  it('sets up the pipeline context for a re-review', async () => {
    seedSummary(fake, { n: 3, commits: [A] })
    seedThread(fake, { id: 'F1', title: 'Null user crashes profile load', line: 4 })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    expect(await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())).toBe(State.LOAD_PROMPT)
    expect(ctx.previousReviews).toEqual([])
    expect(ctx.reviewNumber).toBe(4)
    expect(ctx.deltaDiff).toBe(DELTA)
    expect(e.prior!.block).toContain('[F1] MEDIUM')
    expect(e.priorFor(['other.ts'])).toBeUndefined()
    expect(e.priorFor(['src/a.ts'])!.block).toContain('[F1]')
  })

  it('--force clean sends no list and no delta', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    seedThread(fake, { id: 'F1', title: 'T', line: 4 })
    const e = engineOf(fake)
    const ctx = ctxOf(fake, { force: 'clean' })
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    expect(e.prior).toBeUndefined()
    expect(e.priorFor(['src/a.ts'])).toBeUndefined()
    expect(ctx.deltaDiff).toBeUndefined()
    expect(fake.raw.getCommitDiff).not.toHaveBeenCalled()
  })
})

describe('writing a review', () => {
  it('records a clean first review and the next event dedups', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    expect(ctx.reviewNumber).toBe(1)
    reviewed(ctx, [])
    expect(await e.step(State.POST_REVIEW, ctx, deps)).toBe(State.DONE)
    expect(ctx.action).toBe('REVIEW')
    expect(deps.markHeadChecked).toHaveBeenCalledTimes(1)
    expect(verify(summaryOf(fake)!.body, ME)).toEqual({ n: 1, commits: [HEAD12] })
    expect(summaryOf(fake)!.body).toContain('No findings.')
    expect(e.record()).toMatchObject({ outcome: 'written', summary: 'created', completed: true, summary_check: 'missing', identity: 'api' })

    const next = ctxOf(fake)
    const e2 = engineOf(fake)
    expect(await e2.step(State.CHECK_PREVIOUS_REVIEWS, next, depsOf())).toBe(State.SKIP)
    expect(next.action).toBe('DEDUP_SKIP')
    neverClosed(fake)
  })

  it('posts new findings as threads, then the summary, in that order', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [finding(), finding({ severity: 'LOW', title: 'Unused var', lines: '9' })])
    await e.step(State.POST_REVIEW, ctx, depsOf())
    expect(writes(fake)).toEqual(['root', 'summary', 'edit'])
    expect(roots(fake)[0].inline).toEqual({ path: 'src/a.ts', line: 4 })
    expect(summaryOf(fake)!.body).toContain('Not posted as threads')
    expect(e.record().roots).toMatchObject({ posted: 1, failed: 0, summary_only: { low: 1 } })
  })

  it('does not re-post an open thread, and re-raises a resolved one only at a higher severity as a new id', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    seedThread(fake, { id: 'F1', title: 'Null user crashes profile load', line: 4, severity: 'HIGH' })
    seedThread(fake, { id: 'F2', title: 'Unbounded render loop', line: 10, severity: 'MEDIUM', resolved: true })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [
      finding(),
      finding({ severity: 'MEDIUM', title: 'Unbounded render loop', lines: '10' }),
      finding({ severity: 'HIGH', title: 'Unbounded render loop', lines: '10' }),
    ])
    await e.step(State.POST_REVIEW, ctx, depsOf())
    const posted = roots(fake).filter(c => c.id > 3)
    expect(posted).toHaveLength(1)
    expect(posted[0].body).toContain('**HIGH – Unbounded render loop** (was F2, dismissed)')
    expect(posted[0].body).toContain('*Finding F3 |')
    expect(e.record()).toMatchObject({ suppressed: { open_duplicate: 1, resolved: 0, in_run_duplicate: 1 }, raised_over_resolved: 1 })
    expect(ctx.action).toBe('RE_REVIEW')
    neverClosed(fake)
  })

  it('removes a completed head before any create on a forced run, and records it again at the end', async () => {
    seedSummary(fake, { n: 1, commits: [HEAD12] })
    const e = engineOf(fake)
    const ctx = ctxOf(fake, { force: 're-review' })
    expect(await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())).toBe(State.LOAD_PROMPT)
    expect(fake.raw.getCommitDiff).not.toHaveBeenCalled()
    reviewed(ctx, [finding()])
    await e.step(State.POST_REVIEW, ctx, depsOf())
    expect(fake.calls.indexOf('edit')).toBeLessThan(fake.calls.indexOf('root'))
    expect(verify(fake.editBodies[0], ME)).toEqual({ n: 1, commits: [] })
    expect(verify(summaryOf(fake)!.body, ME)).toEqual({ n: 2, commits: [HEAD12] })
  })

  it('stops a forced run whose invalidation edit fails, with zero creates', async () => {
    seedSummary(fake, { n: 1, commits: [HEAD12] })
    fake.hooks.failEdit = () => httpErr(500)
    const e = engineOf(fake)
    const ctx = ctxOf(fake, { force: 're-review' })
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [finding()])
    expect(await e.step(State.POST_REVIEW, ctx, depsOf())).toBe(State.SKIP)
    expect(e.record().outcome).toBe('force_invalidate_failed')
    expect(ctx.action).toBe('SKIP')
    expect(writes(fake).filter(c => c !== 'edit')).toEqual([])
  })

  it('never resends after an uncertain create and does not record the head', async () => {
    fake.hooks.failPost = (_n, kind) => (kind === 'root' ? httpErr() : undefined)
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    reviewed(ctx, [finding(), finding({ title: 'Second problem', lines: '8' })])
    await e.step(State.POST_REVIEW, ctx, deps)
    expect(fake.raw.postInlineComment).toHaveBeenCalledTimes(2)
    expect(deps.markHeadChecked).not.toHaveBeenCalled()
    expect(ctx.headChecked).toBeUndefined()
    expect(verify(summaryOf(fake)!.body, ME)).toEqual({ n: 1, commits: [] })
    expect(summaryOf(fake)!.body).toContain('no thread')
    expect(e.record()).toMatchObject({ outcome: 'write_uncertain', completed: false })
    expect(ctx.action).toBe('REVIEW')
  })

  it('skips posting when the head moved before the first write', async () => {
    fake.hooks.head = 'f'.repeat(40)
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    reviewed(ctx, [finding()])
    expect(await e.step(State.POST_REVIEW, ctx, deps)).toBe(State.SKIP)
    expect(writes(fake)).toEqual([])
    expect(e.record()).toMatchObject({ outcome: 'head_moved_skip', head_moved_at: 'ffffffffffff' })
    expect(ctx.action).toBe('SKIP')
    expect(deps.markHeadChecked).not.toHaveBeenCalled()
  })

  it('maps a failed head lookup to a skip whose reason does not say the head moved', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    reviewed(ctx, [finding()])
    fake.adapter.getPullRequestInfo = vi.fn(async () => { throw new Error('boom') }) as never
    expect(await e.step(State.POST_REVIEW, ctx, deps)).toBe(State.SKIP)
    expect(writes(fake)).toEqual([])
    expect(e.record().outcome).toBe('head_check_failed')
    expect(ctx.skipReason).not.toMatch(/moved/)
    expect(deps.markHeadChecked).not.toHaveBeenCalled()
  })

  it('maps a head that moves after the first write to head_moved_partial', async () => {
    fake.hooks.onCreate = kind => { if (kind === 'root') fake.hooks.head = 'f'.repeat(40) }
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [finding(), finding({ title: 'Second problem', lines: '8' })])
    await e.step(State.POST_REVIEW, ctx, depsOf())
    expect(e.record().outcome).toBe('head_moved_partial')
    expect(ctx.action).toBe('SKIP')
    expect(roots(fake)).toHaveLength(1)
  })

  it('maps a foreign author on a create to identity_mismatch and stops writing', async () => {
    fake.hooks.author = () => 'intruder'
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [finding(), finding({ title: 'Second problem', lines: '8' })])
    await e.step(State.POST_REVIEW, ctx, depsOf())
    expect(e.record().outcome).toBe('identity_mismatch')
    expect(ctx.action).toBe('SKIP')
    expect(writes(fake)).toEqual(['root'])
  })

  it('maps a concurrent writer to DEDUP_SKIP', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    seedThread(fake, { id: 'F9', title: 'Added by another run', line: 2 })
    reviewed(ctx, [finding()])
    await e.step(State.POST_REVIEW, ctx, depsOf())
    expect(e.record().outcome).toBe('concurrent_run')
    expect(ctx.action).toBe('DEDUP_SKIP')
    expect(writes(fake)).toEqual([])
  })

  it('prints a dry run and writes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const e = engineOf(fake)
    const ctx = ctxOf(fake, { dryRun: true })
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [finding()])
    expect(await e.step(State.POST_REVIEW, ctx, depsOf())).toBe(State.DONE)
    log.mockRestore()
    expect(writes(fake)).toEqual([])
    expect(e.record().outcome).toBe('dry_run')
    expect(ctx.action).toBe('REVIEW')
  })

  it('resets whatever the legacy gate set before POST_REVIEW, then remaps it', async () => {
    fake.hooks.head = 'f'.repeat(40)
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [finding()])
    ctx.headChecked = true
    ctx.action = 'NO_NEW_FINDINGS'
    ctx.skipReason = 'legacy reason'
    await e.step(State.POST_REVIEW, ctx, depsOf())
    expect(ctx.headChecked).toBeUndefined()
    expect(ctx.action).toBe('SKIP')
    expect(ctx.skipReason).not.toBe('legacy reason')
  })

  it('refuses to post a truncated review', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    ctx.reviewObject = reviewObject([])
    ctx.reviewText = '### Summary\nA change.\n\n### Findings\nNo findings.'
    await expect(e.step(State.POST_REVIEW, ctx, depsOf())).rejects.toThrow(/truncated/)
    expect(writes(fake)).toEqual([])
  })

  it('keeps the partial record and never uses the legacy post when the summary write fails', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    fake.hooks.failEdit = () => httpErr(403)
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    reviewed(ctx, [finding()])
    await expect(e.step(State.POST_REVIEW, ctx, deps)).rejects.toThrow(/403/)
    expect(e.record().roots!.posted).toBe(1)
    expect(e.record().summary).toBe('not_written')
    expect(e.record().completed).toBe(false)
    expect(deps.markHeadChecked).not.toHaveBeenCalled()
    neverClosed(fake)
  })
})

describe('NO_CHANGE', () => {
  const noChange = (ctx: ReviewContext, findings: ReviewFinding[] = []): void => {
    ctx.reviewObject = reviewObject(findings, { no_change: true }) as never
    ctx.reviewText = 'NO_CHANGE'
  }

  it('throws on a first inline review', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    noChange(ctx)
    await expect(e.step(State.CHECK_NO_CHANGE, ctx, depsOf())).rejects.toThrow(/first review/)
  })

  it('records a coherent NO_CHANGE', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    noChange(ctx)
    expect(await e.step(State.CHECK_NO_CHANGE, ctx, deps)).toBe(State.DONE)
    expect(verify(summaryOf(fake)!.body, ME)).toEqual({ n: 2, commits: [A, HEAD12] })
    expect(deps.markHeadChecked).toHaveBeenCalledTimes(1)
    expect(ctx.action).toBe('RE_REVIEW')
  })

  it('does not record NO_CHANGE together with a finding, and only answers replies', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    noChange(ctx, [finding()])
    await e.step(State.CHECK_NO_CHANGE, ctx, deps)
    expect(deps.markHeadChecked).not.toHaveBeenCalled()
    expect(writes(fake)).toEqual([])
    expect(ctx.action).toBe('NO_CHANGE')
    expect(e.record().outcome).toBe('incoherent_no_change')
  })

  it('passes a normal review straight to the legacy gate', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    reviewed(ctx, [finding()])
    deps.transition.mockClear()
    await e.step(State.CHECK_NO_CHANGE, ctx, deps)
    expect(deps.transition).toHaveBeenCalledWith(State.CHECK_NO_CHANGE, ctx)
  })
})

describe('unchanged runs keep the last review', () => {
  const HEAD2 = 'e'.repeat(40)
  const lowFinding = finding({ severity: 'LOW', title: 'Unused var', lines: '9', body: 'Dead code.' })
  const noChange = (ctx: ReviewContext): void => {
    ctx.reviewObject = reviewObject([], { no_change: true }) as never
    ctx.reviewText = 'NO_CHANGE'
  }

  async function firstReview(): Promise<void> {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    const obj = reviewObject([finding(), lowFinding], { behavioral_diff: ['Profile load now checks the user'], production_risk: ['Crash on null user'] })
    ctx.reviewObject = obj
    ctx.reviewText = renderReview(obj)
    await e.step(State.POST_REVIEW, ctx, deps)
    fake.hooks.head = HEAD2
  }
  const nextCtx = (): ReviewContext => ctxOf(fake, { prInfo: { id: '7', title: 't', description: '', author: 'dev', sourceBranch: 'f', targetBranch: 'main', sourceCommit: HEAD2 } })

  const keeps = (): void => {
    const body = summaryOf(fake)!.body
    expect(body).toContain('Profile load now checks the user')
    expect(body).toContain('Crash on null user')
    expect(body).toContain('- **LOW – Unused var** (`src/a.ts:9`) · no thread\n  Dead code.')
    expect(body).toContain('[thread](')
    expect(body).toMatch(/- Review 2 · eeeeeeeeeeee · no change/)
    expect(body).not.toContain('No reviewable changes since the last review')
    expect(verify(body, ME)).toEqual({ n: 2, commits: [HEAD12, 'eeeeeeeeeeee'] })
  }

  it.each([
    ['a merge-only delta', async (e: ReturnType<typeof engineOf>, ctx: ReviewContext) => e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf({ narrowTargetMergeDelta: vi.fn(async () => null) as never }))],
    ['a zero-line delta', async (e: ReturnType<typeof engineOf>, ctx: ReviewContext) => { fake.hooks.commitDiff = () => ''; return e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf()) }],
    ['a coherent NO_CHANGE', async (e: ReturnType<typeof engineOf>, ctx: ReviewContext) => {
      const deps = depsOf()
      await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
      noChange(ctx)
      return e.step(State.CHECK_NO_CHANGE, ctx, deps)
    }],
  ])('%s keeps the narrative and the summary-only rows', async (_name, run) => {
    await firstReview()
    const e = engineOf(fake)
    expect(await run(e, nextCtx())).toBe(State.DONE)
    keeps()
  })

  const quiet = async (e: ReturnType<typeof engineOf>, ctx: ReviewContext, text: string): Promise<void> => {
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    const obj = reviewObject([], text ? { summary: text } : {})
    ctx.reviewObject = obj
    ctx.reviewText = text === '' ? '' : renderReview(obj)
    ctx.action = 'NO_NEW_FINDINGS'
    expect(await e.step(State.SKIP, ctx, deps)).toBe(State.DONE)
  }

  it('a quiet re-review keeps the earlier summary-only rows and the last narrative when it has none of its own', async () => {
    await firstReview()
    await quiet(engineOf(fake), nextCtx(), '')
    const body = summaryOf(fake)!.body
    expect(body).toContain('- **LOW – Unused var** (`src/a.ts:9`) · no thread\n  Dead code.')
    expect(body).toContain('Profile load now checks the user')
    expect(body).not.toContain('No new findings.')
    expect(verify(body, ME)).toEqual({ n: 2, commits: [HEAD12, 'eeeeeeeeeeee'] })
  })

  it('a quiet re-review keeps the summary-only rows but uses its own narrative when it has one', async () => {
    await firstReview()
    await quiet(engineOf(fake), nextCtx(), '### Summary\nNothing new in this push.\n\n### Findings\nNo findings.')
    const body = summaryOf(fake)!.body
    expect(body).toContain('- **LOW – Unused var** (`src/a.ts:9`) · no thread')
    expect(body).toContain('Nothing new in this push.')
  })

  it('falls back to the placeholder when the loaded summary has no narrative', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    const ctx = ctxOf(fake)
    await engineOf(fake).step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf({ narrowTargetMergeDelta: vi.fn(async () => null) as never }))
    expect(summaryOf(fake)!.body).toContain('No reviewable changes since the last review; the earlier review stands.')
  })
})

describe('JUDGE_REVIEW wrap', () => {
  const second = finding({ title: 'Double put on retry', lines: '6' })

  // A faithful copy of the legacy quiet-gate condition, so the swap is tested against the thing it works around.
  const gate = (seen: { n?: number }) => vi.fn(async (state: State, ctx: ReviewContext) => {
    if (state !== State.JUDGE_REVIEW) return State.LOAD_PROMPT
    seen.n = ctx.reviewNumber
    const own = ctx.reviewObject!.findings.length
    if (own === 0 && ctx.reviewNumber > 1 && ctx.force !== 're-review') { ctx.action = 'NO_NEW_FINDINGS'; return State.SKIP }
    const extra = [...(ctx.secondLookFindings ?? []), ...(ctx.lensRuns ?? []).flatMap(r => r.findings)]
    ctx.judgedFindings = extra.map(f => ({ ...f }))
    ctx.reviewText = renderReview({ ...ctx.reviewObject!, findings: extra })
    return State.POST_REVIEW
  })

  it('judges a second-look finding on a re-review, then plans it as a new thread and records the head after the summary', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const seen: { n?: number } = {}
    const deps = depsOf({ transition: gate(seen) as never })
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    expect(ctx.reviewNumber).toBe(2)
    reviewed(ctx, [])
    ctx.secondLookFindings = [second]
    expect(await e.step(State.JUDGE_REVIEW, ctx, deps)).toBe(State.POST_REVIEW)
    expect(seen.n).toBe(1)
    expect(ctx.reviewNumber).toBe(2)
    ctx.judgeUsage = { input_tokens: 1, output_tokens: 1 }
    ctx.reviewText += '\n\n### Merge Confidence: 80%'
    deps.markHeadChecked.mockImplementation(() => { expect(fake.calls).toContain('edit') })
    await e.step(State.POST_REVIEW, ctx, deps)
    expect(roots(fake).map(c => c.body)[0]).toContain('Double put on retry')
    expect(fake.calls.indexOf('root')).toBeLessThan(fake.calls.indexOf('edit'))
    expect(deps.markHeadChecked).toHaveBeenCalledTimes(1)
  })

  it('does the same for a lens finding', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const seen: { n?: number } = {}
    const deps = depsOf({ transition: gate(seen) as never })
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    reviewed(ctx, [])
    ctx.lensRuns = [{ name: 'reliability', status: 'succeeded', model: 'm', findings: [second] }]
    await e.step(State.JUDGE_REVIEW, ctx, deps)
    expect(seen.n).toBe(1)
    expect(ctx.reviewNumber).toBe(2)
  })

  it('restores the review number when the judge throws', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf({ transition: vi.fn(async (s: State) => { if (s === State.JUDGE_REVIEW) throw new Error('judge down'); return State.LOAD_PROMPT }) as never })
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    reviewed(ctx, [])
    ctx.secondLookFindings = [second]
    await expect(e.step(State.JUDGE_REVIEW, ctx, deps)).rejects.toThrow('judge down')
    expect(ctx.reviewNumber).toBe(2)
  })

  it('does not swap when nothing was found anywhere, and writes "No findings." for the gate skip', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const seen: { n?: number } = {}
    const deps = depsOf({ transition: gate(seen) as never })
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    reviewed(ctx, [])
    expect(await e.step(State.JUDGE_REVIEW, ctx, deps)).toBe(State.SKIP)
    expect(seen.n).toBe(2)
    expect(ctx.action).toBe('NO_NEW_FINDINGS')
    expect(await e.step(State.SKIP, ctx, deps)).toBe(State.DONE)
    expect(summaryOf(fake)!.body).toContain('No findings.')
    expect(verify(summaryOf(fake)!.body, ME)).toEqual({ n: 2, commits: [A, HEAD12] })
    expect(deps.markHeadChecked).toHaveBeenCalledTimes(1)
    expect(ctx.action).toBe('RE_REVIEW')
  })

  it('answers replies for any other skip after the load, keeping the legacy reason', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    ctx.action = 'SKIP'
    ctx.skipReason = 'Diff exceeds the model context window'
    expect(await e.step(State.SKIP, ctx, deps)).toBe(State.SKIP)
    expect(ctx.skipReason).toBe('Diff exceeds the model context window')
    expect(ctx.action).toBe('SKIP')
    expect(writes(fake)).toEqual([])
  })
})

describe('replies', () => {
  const question = (fake: Fake, rootId: number, body = 'Why is this a problem?'): number => fake.add({ parentId: rootId, body, authorIds: ['dev'] })
  const usage = { input_tokens: 100, output_tokens: 50 }

  it('answers a pending question on a dedup run and tracks the reply usage', async () => {
    seedSummary(fake, { n: 1, commits: [HEAD12] })
    const rootId = seedThread(fake, { id: 'F1', title: 'Null user crashes profile load', line: 4 })
    const q = question(fake, rootId)
    vi.mocked(runFindingReplies).mockResolvedValue({ answers: [{ target: 'F1', rootId: String(rootId), through: String(q), text: 'Because.' }], dropped: 0, usage })
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    expect(await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())).toBe(State.DONE)
    expect(ctx.action).toBe('REPLY')
    const reply = fake.comments.find(c => c.parentId === rootId && c.authorIds[0] === ME)!
    expect(parseAnswerMarker(reply.body)).toMatchObject({ target: 'F1', through: String(q), model: expect.any(String) })
    expect(e.replyUsage).toEqual(expect.objectContaining(usage))
    expect(ctx.usage.input_tokens).toBe(100)
    expect(e.record()).toMatchObject({ outcome: 'replies_only', answers: { threads: 1, posted: 1 }, reply_usage: { model: 'claude-haiku-5-5', input_tokens: 100, output_tokens: 50 } })
    expect(summaryOf(fake)!.body).toContain('old')
    expect(writes(fake)).toEqual(['reply'])

    const again = engineOf(fake)
    const ctx2 = ctxOf(fake)
    vi.mocked(runFindingReplies).mockClear()
    await again.step(State.CHECK_PREVIOUS_REVIEWS, ctx2, depsOf())
    expect(runFindingReplies).not.toHaveBeenCalled()
    expect(ctx2.action).toBe('DEDUP_SKIP')
  })

  const answerIn = (parent: number, target: string): number => fake.add({ parentId: parent, body: `Earlier answer.

${buildAnswerMarker(target, '0')}`, authorIds: [ME] })
  const summaryNote = (summaryId: number) => fake.comments.find(c => c.parentId === summaryId && c.authorIds[0] === ME && c.body.includes('*Replies paused on summary*'))

  it('counts MAX_REPLY_COMMENTS per thread: finding-thread answers do not use up the summary budget', async () => {
    cfg.reply.maxComments = 5
    const summaryId = seedSummary(fake, { n: 1, commits: [HEAD12] })
    const r1 = seedThread(fake, { id: 'F1', title: 'T', line: 4 })
    const r2 = seedThread(fake, { id: 'F2', title: 'U', line: 5 })
    for (let i = 0; i < 3; i++) { answerIn(r1, 'F1'); answerIn(r2, 'F2') }
    const q = question(fake, summaryId, 'What about the summary?')
    vi.mocked(runSummaryReplies).mockResolvedValue({ answer: { target: 'summary', rootId: String(summaryId), through: String(q), text: 'Because.' }, dropped: 0, usage })
    const e = engineOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctxOf(fake), depsOf())
    expect(runSummaryReplies).toHaveBeenCalledTimes(1)
    expect(summaryNote(summaryId)).toBeUndefined()
    expect(e.record().answers!.limit_notes).toBe(0)
  })

  it('posts the summary limit note only after MAX_REPLY_COMMENTS answers in the summary thread, leaving finding threads alone', async () => {
    cfg.reply.maxComments = 5
    const summaryId = seedSummary(fake, { n: 1, commits: [HEAD12] })
    const rootId = seedThread(fake, { id: 'F1', title: 'T', line: 4 })
    for (let i = 0; i < 5; i++) answerIn(summaryId, 'summary')
    question(fake, summaryId, 'What about the summary?')
    const fq = question(fake, rootId)
    vi.mocked(runFindingReplies).mockResolvedValue({ answers: [{ target: 'F1', rootId: String(rootId), through: String(fq), text: 'Because.' }], dropped: 0, usage })
    const e = engineOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctxOf(fake), depsOf())
    expect(runSummaryReplies).not.toHaveBeenCalled()
    expect(summaryNote(summaryId)).toBeDefined()
    expect(e.record().answers!.limit_notes).toBe(1)
    expect(fake.comments.some(c => c.parentId === rootId && c.authorIds[0] === ME && parseAnswerMarker(c.body)?.through === String(fq))).toBe(true)
  })

  it('keeps the review when the reply call fails', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    const rootId = seedThread(fake, { id: 'F1', title: 'T', line: 4 })
    question(fake, rootId)
    vi.mocked(runFindingReplies).mockRejectedValue(Object.assign(new Error('reply model down'), { usage }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [])
    expect(await e.step(State.POST_REVIEW, ctx, depsOf())).toBe(State.DONE)
    warn.mockRestore()
    expect(ctx.action).toBe('RE_REVIEW')
    expect(e.replyUsage).toBeDefined()
    expect(fake.comments.filter(c => c.parentId === rootId && c.authorIds[0] === ME)).toHaveLength(0)
  })
})

describe('fix round', () => {
  const usage = { input_tokens: 100, output_tokens: 50 }
  const question = (f: Fake, rootId: number): number => f.add({ parentId: rootId, body: 'Why is this a problem?', authorIds: ['dev'] })

  it('counts a posted summary-thread answer in answers.summary', async () => {
    const summaryId = seedSummary(fake, { n: 1, commits: [HEAD12] })
    const q = question(fake, summaryId)
    vi.mocked(runSummaryReplies).mockResolvedValue({ answer: { target: 'summary', rootId: String(summaryId), through: String(q), text: 'Because.' }, dropped: 0, usage })
    const e = engineOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctxOf(fake), depsOf())
    expect(e.record().answers).toMatchObject({ posted: 1, summary: 1 })
  })

  it('does not report a completed review when the re-list fails before any write', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    reviewed(ctx, [finding()])
    fake.hooks.listError = new Error('list down')
    await expect(e.step(State.POST_REVIEW, ctx, deps)).rejects.toThrow(/before any write/)
    expect(writes(fake)).toEqual([])
    expect(deps.markHeadChecked).not.toHaveBeenCalled()
    expect(e.record()).toMatchObject({ outcome: 'write_failed', completed: false })
  })

  it('fails a replies-only run when the reply model fails and nothing was posted', async () => {
    seedSummary(fake, { n: 1, commits: [HEAD12] })
    const rootId = seedThread(fake, { id: 'F1', title: 'T', line: 4 })
    question(fake, rootId)
    vi.mocked(runFindingReplies).mockRejectedValue(new Error('reply model down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(engineOf(fake).step(State.CHECK_PREVIOUS_REVIEWS, ctxOf(fake), depsOf())).rejects.toThrow('reply model down')
    warn.mockRestore()
    expect(writes(fake)).toEqual([])
  })

  it('records a refused summary edit as write_failed, not written', async () => {
    seedSummary(fake, { n: 1, commits: [A] })
    fake.hooks.failEdit = () => httpErr(403)
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [finding()])
    await expect(e.step(State.POST_REVIEW, ctx, depsOf())).rejects.toThrow(/403/)
    expect(e.record().outcome).toBe('write_failed')
  })

  it('records a budget skip after the load as skipped, keeping the legacy action and reason', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    ctx.action = 'SKIP'
    ctx.skipReason = 'Diff exceeds the model context window'
    await e.step(State.SKIP, ctx, deps)
    expect(e.record().outcome).toBe('skipped')
    expect(ctx.action).toBe('SKIP')
    expect(ctx.skipReason).toBe('Diff exceeds the model context window')
  })

  it('puts the suggested-fix block in the thread root and keeps the full body for summary-only rows', async () => {
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    const f = finding({ body: 'It crashes. Use a guard.', proposal: 'if (!user) return', bodyWithoutFix: 'It crashes.' } as Partial<ReviewFinding>)
    const low = finding({ severity: 'LOW', title: 'Unused var', lines: '9', body: 'Dead code. Delete it.', proposal: 'remove()', bodyWithoutFix: 'Dead code.' } as Partial<ReviewFinding>)
    reviewed(ctx, [f, low])
    await e.step(State.POST_REVIEW, ctx, depsOf())
    const root = roots(fake)[0].body
    expect(root).toContain('It crashes.\n\n**Suggested fix:**\n\n```suggested-fix-v1\nif (!user) return\n```')
    expect(root).not.toContain('Use a guard')
    expect(root.trimEnd().split('\n').pop()).toMatch(/^\*Finding F1 \| opened at/)
    expect(summaryOf(fake)!.body).toContain('Dead code. Delete it.')
  })
})

describe('second fix round', () => {
  const usage = { input_tokens: 100, output_tokens: 50 }
  const question = (f: Fake, rootId: number): number => f.add({ parentId: rootId, body: 'Why is this a problem?', authorIds: ['dev'] })
  const pendingQuestion = (): void => {
    seedSummary(fake, { n: 1, commits: [A] })
    question(fake, seedThread(fake, { id: 'F1', title: 'T', line: 4 }))
  }

  it('keeps the legacy SKIP, without an error, when the reply model fails after a budget skip', async () => {
    pendingQuestion()
    vi.mocked(runFindingReplies).mockRejectedValue(new Error('context length exceeded'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    ctx.action = 'SKIP'
    ctx.skipReason = 'Diff exceeds the model context window'
    expect(await e.step(State.SKIP, ctx, deps)).toBe(State.SKIP)
    warn.mockRestore()
    expect(ctx.action).toBe('SKIP')
    expect(ctx.skipReason).toBe('Diff exceeds the model context window')
    expect(e.record().outcome).toBe('skipped')
    expect(writes(fake)).toEqual([])
  })

  it('keeps the legacy SKIP when the writer cannot re-list before any write after a skip', async () => {
    pendingQuestion()
    vi.mocked(runFindingReplies).mockResolvedValue({ answers: [{ target: 'F1', rootId: '2', through: '3', text: 'Because.' }], dropped: 0, usage })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    const deps = depsOf()
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, deps)
    fake.hooks.listError = new Error('list down')
    ctx.action = 'SKIP'
    ctx.skipReason = 'Diff exceeds the model context window'
    expect(await e.step(State.SKIP, ctx, deps)).toBe(State.SKIP)
    warn.mockRestore()
    expect(ctx.action).toBe('SKIP')
    expect(ctx.skipReason).toBe('Diff exceeds the model context window')
    expect(e.record().outcome).toBe('skipped')
    expect(writes(fake)).toEqual([])
  })

  it('records the dedup outcome when the replies-only run throws, and keeps the head completed', async () => {
    seedSummary(fake, { n: 1, commits: [HEAD12] })
    question(fake, seedThread(fake, { id: 'F1', title: 'T', line: 4 }))
    vi.mocked(runFindingReplies).mockRejectedValue(new Error('reply model down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = engineOf(fake)
    await expect(e.step(State.CHECK_PREVIOUS_REVIEWS, ctxOf(fake), depsOf())).rejects.toThrow('reply model down')
    warn.mockRestore()
    expect(e.record()).toMatchObject({ outcome: 'dedup', completed: true })
  })

  it('does not unrecord a completed head when a dedup run fails to write', async () => {
    seedSummary(fake, { n: 1, commits: [HEAD12] })
    const rootId = seedThread(fake, { id: 'F1', title: 'T', line: 4 })
    const q = question(fake, rootId)
    vi.mocked(runFindingReplies).mockResolvedValue({ answers: [{ target: 'F1', rootId: String(rootId), through: String(q), text: 'Because.' }], dropped: 0, usage })
    const real = fake.raw.listMarkedThreads.getMockImplementation()!
    fake.raw.listMarkedThreads.mockImplementationOnce(real).mockImplementationOnce(async () => { throw new Error('list down') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = engineOf(fake)
    await expect(e.step(State.CHECK_PREVIOUS_REVIEWS, ctxOf(fake), depsOf())).rejects.toThrow(/before any write/)
    warn.mockRestore()
    expect(e.record()).toMatchObject({ outcome: 'write_failed', completed: true })
  })

  it('rethrows a dedup reply failure without its usage, which the engine already counted', async () => {
    seedSummary(fake, { n: 1, commits: [HEAD12] })
    question(fake, seedThread(fake, { id: 'F1', title: 'T', line: 4 }))
    vi.mocked(runFindingReplies).mockRejectedValue(Object.assign(new Error('truncated'), { usage }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = ctxOf(fake)
    const err = await engineOf(fake).step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf()).catch((x: unknown) => x)
    warn.mockRestore()
    expect((err as Error).message).toBe('truncated')
    expect((err as { usage?: unknown }).usage).toBeUndefined()
    expect(ctx.usage.input_tokens).toBe(100)
  })

  it.each([[false], [true]])('with ENABLE_SUGGESTED_FIXES=%s a thread root has a fix block only when on', async flag => {
    cfg.judge.suggestedFixes = flag
    const e = engineOf(fake)
    const ctx = ctxOf(fake)
    await e.step(State.CHECK_PREVIOUS_REVIEWS, ctx, depsOf())
    reviewed(ctx, [finding({ body: 'It crashes. Use a guard.', proposal: 'if (!user) return', bodyWithoutFix: 'It crashes.' } as Partial<ReviewFinding>)])
    await e.step(State.POST_REVIEW, ctx, depsOf())
    expect(roots(fake)[0].body.includes('Suggested fix')).toBe(flag)
  })

  it('drops a carried summary-only row once a thread exists for the same finding', async () => {
    const text = [
      SUMMARY_HEADER, '', '### Summary', 'A change.', '', '### Findings', '**Not posted as threads**',
      '- **MEDIUM – Null user crashes profile load** (`src/a.ts:4`) · no thread', '  Details.', '', '### Review History', `- Review 1 · ${A} · 1 finding, 0 new threads`,
    ].join('\n')
    fake.add({ body: withState(text, { n: 1, commits: [A] }, ME), authorIds: [ME] })
    seedThread(fake, { id: 'F1', title: 'Null user crashes profile load', line: 4 })
    fake.hooks.commitDiff = () => ''
    const e = engineOf(fake)
    expect(await e.step(State.CHECK_PREVIOUS_REVIEWS, ctxOf(fake), depsOf())).toBe(State.DONE)
    const body = summaryOf(fake)!.body
    expect(body).toContain('· F1 ·')
    expect(body).not.toContain('· no thread')
  })
})
