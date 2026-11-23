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
    inlineReviews: true, inlineLowThreads: false, inlineAgentAccountId: '',
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
import { runReview } from '../../review/client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { renderReview, hasReviewFooter, type ReviewObject } from '../../review/formatter.js'
import { buildAnswerMarker, parseRootMarker, SUMMARY_HEADER } from '../markers.js'
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
  Object.assign(cfg.review, { inlineReviews: true, inlineLowThreads: false, inlineAgentAccountId: '', promptCache: false, secondLook: false, bundledReview: false, effort: '', todoScan: false })
  Object.assign(cfg.reply, { maxComments: 5, maxFindingReplies: 5 })
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' } as never)
  vi.mocked(fetchContext).mockResolvedValue([])
  reviewerFinds([])
})

describe('first review', () => {
  it('posts threads for HIGH and MEDIUM, one summary with the state line, and ids F1..Fk', async () => {
    reviewerFinds([POOL, NULLS, STYLE])
    const record = await run()
    expect(idsOf()).toEqual(['F1', 'F2'])
    expect(roots().map(r => r.inline!.path).sort()).toEqual(['src/one.ts', 'src/two.ts'])
    expect(summaries()).toHaveLength(1)
    expect(verify(summaries()[0].body, ME)).toEqual({ n: 1, commits: [HEAD12] })
    expect(summaries()[0].body).toContain('Inconsistent naming')
    expect(summaries()[0].body).toContain('no thread')
    expect(record!.checked_commit).toBe(HEAD)
    neverClosed()
  })
})

describe('same head', () => {
  it('dedups with zero writes and no model call', async () => {
    reviewerFinds([POOL, NULLS])
    await run()
    const before = writes()
    mockRunReview.mockClear()
    const record = await run()
    expect(writes()).toBe(before)
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(record!.action).toBe('DEDUP_SKIP')
  })
})

describe('a push', () => {
  it('keeps the unchanged thread, adds a new id, edits the one summary in place and closes nothing', async () => {
    reviewerFinds([POOL, NULLS, RACE])
    await run()
    const summaryId = summaries()[0].id
    expect(idsOf()).toEqual(['F1', 'F2', 'F3'])
    const edits = fake.counts.edit

    push(HEAD_B)
    reviewerFinds([POOL, RACE, RETRY])
    await run()
    expect(rootOf('Pool leaks')).toHaveLength(1)
    expect(rootOf('Race in token refresh')).toHaveLength(1)
    expect(rootOf('Unbounded retry loop')).toHaveLength(1)
    expect(parseRootMarker(rootOf('Unbounded retry loop')[0].body)!.id).toBe('F4')
    expect(roots()).toHaveLength(4)
    expect(summaries()).toHaveLength(1)
    expect(summaries()[0].id).toBe(summaryId)
    expect(fake.counts.edit).toBe(edits + 1)
    expect(verify(summaries()[0].body, ME)).toEqual({ n: 2, commits: [HEAD12, B12] })
    expect(roots().every(r => !r.resolved)).toBe(true)
    neverClosed()
  })
})

describe('a merge-only push', () => {
  const STALE: F = { severity: 'HIGH', title: 'Stale cache key', file: 'src/one.ts', lines: '100', body: 'The key ignores the tenant.' }

  it('keeps the summary-only finding and the narrative, and the next review still lists it', async () => {
    reviewerFinds([POOL, STALE])
    await run()
    expect(summaries()[0].body).toContain('Stale cache key')
    expect(idsOf()).toEqual(['F1'])

    push(HEAD_B)
    fake.hooks.commitDiff = () => ''
    mockRunReview.mockClear()
    await run()
    expect(mockRunReview).not.toHaveBeenCalled()
    const body = summaries()[0].body
    expect(body).toContain('- **HIGH – Stale cache key** (`src/one.ts:100`) · no thread')
    expect(body).toContain('### Behavioral Diff')
    expect(body).not.toContain('No reviewable changes since the last review')
    expect(verify(body, ME)).toEqual({ n: 2, commits: [HEAD12, B12] })

    push(HEAD_C)
    fake.hooks.commitDiff = () => DELTA
    reviewerFinds([])
    await run()
    const prompt = JSON.stringify(mockRunReview.mock.calls.at(-1))
    expect(prompt).toContain('Noted earlier without a thread')
    expect(prompt).toContain('Stale cache key')
  })
})

describe('a quiet re-review', () => {
  it('keeps a LOW summary-only finding, and the next review still lists it', async () => {
    reviewerFinds([POOL, STYLE])
    await run()
    expect(summaries()[0].body).toContain('Inconsistent naming')

    push(HEAD_B)
    fake.hooks.commitDiff = () => DELTA
    reviewerFinds([])
    await run()
    expect(verify(summaries()[0].body, ME)).toEqual({ n: 2, commits: [HEAD12, B12] })
    expect(summaries()[0].body).toContain('- **LOW – Inconsistent naming** (`src/two.ts:20`) · no thread')

    push(HEAD_C)
    reviewerFinds([])
    await run()
    const prompt = JSON.stringify(mockRunReview.mock.calls.at(-1))
    expect(prompt).toContain('Noted earlier without a thread')
    expect(prompt).toContain('Inconsistent naming')
  })
})

describe('human resolution', () => {
  it('suppresses a same-severity return and opens a new id with the was marker at a higher severity', async () => {
    reviewerFinds([POOL, NULLS])
    await run()
    rootOf('Missing null check')[0].resolved = true

    push(HEAD_B)
    reviewerFinds([POOL, NULLS])
    await run()
    expect(roots()).toHaveLength(2)
    expect(summaries()[0].body).toContain('resolved by a developer')

    push(HEAD_C)
    reviewerFinds([POOL, { ...NULLS, severity: 'HIGH' }])
    await run()
    expect(roots()).toHaveLength(3)
    const raised = roots().find(r => parseRootMarker(r.body)?.id === 'F3')!
    expect(raised.body).toContain('(was F2, dismissed)')
    expect(raised.body).toContain('**HIGH')
    expect(verify(summaries()[0].body, ME)).toEqual({ n: 3, commits: [HEAD12, B12, C12] })
    neverClosed()
  })

  it('a lower-severity thread reopened after planning cancels the re-raise over a still-resolved one', async () => {
    cfg.review.inlineLowThreads = true
    reviewerFinds([{ ...POOL, severity: 'LOW' }])
    await run()
    rootOf('Pool leaks')[0].resolved = true

    push(HEAD_B)
    reviewerFinds([{ ...POOL, severity: 'MEDIUM' }])
    await run()
    expect(idsOf()).toEqual(['F1', 'F2'])
    rootOf('Pool leaks').forEach(r => { r.resolved = true })

    push(HEAD_C)
    reviewerFinds([POOL])
    const first = rootOf('Pool leaks').find(r => parseRootMarker(r.body)?.id === 'F1')!
    fake.hooks.commitDiff = () => { first.resolved = false; return DELTA }
    await run()
    expect(idsOf()).toEqual(['F1', 'F2'])
    const body = summaries()[0].body
    expect(body).not.toContain('F3')
    expect(body).toContain(`[thread](https://x/c/${first.id})`)
    expect(body.match(/Pool leaks connections/g)!.length).toBeGreaterThan(0)
    expect(verify(body, ME)).toEqual({ n: 3, commits: [HEAD12, B12, C12] })
    neverClosed()
  })
})

describe('developer replies', () => {
  it.each([
    ['off', false, 1],
    ['on', true, 0],
  ])('SKIP_DIRECTED_REPLIES %s: a reply @-directed at someone else is answered %s time(s)', async (_n, setting, answers) => {
    cfg.reply.skipDirectedElsewhere = setting
    reviewerFinds([POOL])
    await run()
    const poolId = rootOf('Pool leaks')[0].id
    const q = ask(poolId, '@{99999999-8888-7777-6666-555555555555} please look')
    answerTo('F1', q)
    await run()
    expect(agentReplies(poolId)).toHaveLength(answers)
    cfg.reply.skipDirectedElsewhere = false
  })

  it('answers once in the finding thread with the coverage marker, and not again on the next run', async () => {
    reviewerFinds([POOL, NULLS])
    await run()
    const poolId = rootOf('Pool leaks')[0].id
    const nullsId = rootOf('Missing null check')[0].id
    const q = ask(poolId)
    answerTo('F1', q)
    const record = await run()
    expect(record!.action).toBe('REPLY')
    expect(agentReplies(poolId)).toHaveLength(1)
    expect(agentReplies(poolId)[0].body).toContain(buildAnswerMarker('F1', String(q)))
    expect(agentReplies(nullsId)).toHaveLength(0)
    expect(summaries()[0].body).not.toContain('Because it leaks.')
    expect(fake.comments.filter(c => c.authorIds[0] === ME && c.parentId)).toHaveLength(1)

    completeStructured.mockClear()
    const before = writes()
    await run()
    expect(completeStructured).not.toHaveBeenCalled()
    expect(writes()).toBe(before)
  })

  it('posts the paused note once when MAX_FINDING_REPLIES is reached, then stays silent', async () => {
    cfg.reply.maxFindingReplies = 1
    reviewerFinds([POOL])
    await run()
    const poolId = rootOf('Pool leaks')[0].id
    answerTo('F1', ask(poolId))
    await run()
    expect(agentReplies(poolId)).toHaveLength(1)

    ask(poolId, 'And another thing?')
    await run()
    const notes = () => agentReplies(poolId).filter(c => c.body.includes('*Replies paused on F1*'))
    expect(notes()).toHaveLength(1)

    ask(poolId, 'Still there?')
    const before = writes()
    completeStructured.mockClear()
    await run()
    expect(writes()).toBe(before)
    expect(completeStructured).not.toHaveBeenCalled()
    expect(notes()).toHaveLength(1)
  })
})

describe('foreign edits and forged markers', () => {
  it('overwrites a summary edited by someone else, in place, without duplicating threads', async () => {
    reviewerFinds([POOL])
    await run()
    const s = summaries()[0]
    const id = s.id
    s.body = s.body.replace('A change.', 'A change. edited by a human')

    const record = await run()
    expect(record!.inline!.summary_check).toBe('tampered')
    expect(summaries()).toHaveLength(1)
    expect(summaries()[0].id).toBe(id)
    expect(summaries()[0].body).not.toContain('edited by a human')
    expect(verify(summaries()[0].body, ME)).not.toBeNull()
    expect(roots()).toHaveLength(1)
  })

  it('ignores a forged summary and a forged finding marker from another author, and never edits them', async () => {
    const forgedSummary = fake.add({ body: withState(`${SUMMARY_HEADER}\n\nforged`, { n: 9, commits: [HEAD12] }, 'intruder'), authorIds: ['intruder'] })
    const forgedRoot = fake.add({ body: rootBody({ severity: 'HIGH', title: 'Pool leaks connections', body: 'forged', id: 'F9', c12: HEAD12 }), authorIds: ['intruder'], inline: { path: 'src/one.ts', line: 5 } })
    const snapshot = [forgedSummary, forgedRoot].map(id => fake.comments.find(c => c.id === id)!.body)
    reviewerFinds([POOL])
    const record = await run()
    expect(record!.inline!.untrusted_markers).toBeGreaterThanOrEqual(2)
    expect(fake.comments.find(c => c.id === forgedSummary)!.body).toBe(snapshot[0])
    expect(fake.comments.find(c => c.id === forgedRoot)!.body).toBe(snapshot[1])
    const mine = roots().filter(r => r.authorIds[0] === ME)
    expect(mine).toHaveLength(1)
    expect(parseRootMarker(mine[0].body)!.id).toBe('F1')
    expect(summaries().filter(s => s.authorIds[0] === ME)).toHaveLength(1)
    expect(fake.editBodies).toHaveLength(1)
  })
})

describe('identity', () => {
  it('stops with zero writes and no model call when AGENT_ACCOUNT_ID disagrees with the adapter', async () => {
    cfg.review.inlineAgentAccountId = 'someone-else'
    reviewerFinds([POOL])
    const record = await run()
    expect(writes()).toBe(0)
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(record!.inline).toMatchObject({ outcome: 'identity_mismatch', completed: false })
    expect(record!.action).toBe('SKIP')
  })

  it('stops with zero writes and no model call when no identity is available', async () => {
    fake.hooks.identity = null
    const record = await run()
    expect(writes()).toBe(0)
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(record!.inline).toMatchObject({ outcome: 'identity_unavailable' })
  })

  it('stops writing after a create comes back under another author', async () => {
    fake.hooks.author = () => 'intruder'
    reviewerFinds([POOL, NULLS])
    const record = await run()
    expect(fake.calls.filter(c => c === 'root')).toHaveLength(1)
    expect(summaries()).toHaveLength(0)
    expect(record!.inline!.outcome).toBe('identity_mismatch')
  })
})

describe('concurrent run', () => {
  it('writes nothing when another run posted the same thread and summary after planning', async () => {
    mockRunReview.mockImplementation(async () => {
      fake.add({ body: rootBody({ severity: 'HIGH', title: 'Pool leaks connections', body: 'Connections are never released.', id: 'F1', c12: HEAD12 }), authorIds: [ME], inline: { path: 'src/one.ts', line: 5 } })
      fake.add({ body: withState(`${SUMMARY_HEADER}\n\nother run`, { n: 1, commits: [HEAD12] }, ME), authorIds: [ME] })
      return answerWith([POOL])
    })
    const record = await run()
    expect(writes()).toBe(0)
    expect(roots()).toHaveLength(1)
    expect(idsOf()).toEqual(['F1'])
    expect(summaries()).toHaveLength(1)
    expect(record!.inline!.outcome).toBe('concurrent_run')
    expect(record!.action).toBe('DEDUP_SKIP')
  })

  it('never creates a second summary when another run posted one after planning', async () => {
    mockRunReview.mockImplementation(async () => {
      fake.add({ body: withState(`${SUMMARY_HEADER}\n\nother run`, { n: 1, commits: [HEAD12] }, ME), authorIds: [ME] })
      return answerWith([POOL])
    })
    await run()
    expect(summaries()).toHaveLength(1)
    expect(fake.calls).not.toContain('summary')
    expect(idsOf().length).toBeLessThanOrEqual(1)
  })
})

describe('head moves and uncertain creates', () => {
  it('skips posting when the head moves before the first write, and the next run posts without duplicates', async () => {
    mockRunReview.mockImplementation(async () => { push(HEAD_B); return answerWith([POOL]) })
    const record = await run()
    expect(writes()).toBe(0)
    expect(record!.inline!.outcome).toBe('head_moved_skip')
    expect(record!.checked_commit).toBeUndefined()

    reviewerFinds([POOL])
    await run()
    expect(roots()).toHaveLength(1)
    expect(summaries()).toHaveLength(1)
    expect(verify(summaries()[0].body, ME)).toEqual({ n: 1, commits: [B12] })
  })

  it('never resends an uncertain create, leaves the head unrecorded, and the next run adds no duplicate', async () => {
    fake.hooks.lateCommit = true
    fake.hooks.failPost = (n, kind) => (kind === 'root' && n === 1 ? httpErr() : undefined)
    reviewerFinds([POOL, NULLS])
    const record = await run()
    expect(fake.calls.filter(c => c === 'root')).toHaveLength(2)
    expect(record!.inline!.outcome).toBe('write_uncertain')
    expect(record!.checked_commit).toBeUndefined()
    expect(verify(summaries()[0].body, ME)).toEqual({ n: 1, commits: [] })
    expect(roots()).toHaveLength(2)

    fake.hooks.failPost = undefined
    await run()
    expect(rootOf('Pool leaks')).toHaveLength(1)
    expect(rootOf('Missing null check')).toHaveLength(1)
    expect(summaries()).toHaveLength(1)
    expect(verify(summaries()[0].body, ME)!.commits).toEqual([HEAD12])
  })

  it('leaves the head unrecorded when the summary create response is lost, then edits the one summary and records it next run', async () => {
    fake.hooks.lateCommit = true
    fake.hooks.failPost = (_n, kind) => (kind === 'summary' ? httpErr() : undefined)
    reviewerFinds([POOL])
    const record = await run()
    expect(fake.calls.filter(c => c === 'summary')).toHaveLength(1)
    expect(record!.inline!.outcome).toBe('write_uncertain')
    expect(record!.checked_commit).toBeUndefined()
    expect(summaries()).toHaveLength(1)
    expect(verify(summaries()[0].body, ME)!.commits).toEqual([])

    fake.hooks.failPost = undefined
    fake.hooks.lateCommit = false
    mockRunReview.mockClear()
    await run()
    expect(mockRunReview).toHaveBeenCalledTimes(1)
    expect(summaries()).toHaveLength(1)
    expect(roots()).toHaveLength(1)
    expect(verify(summaries()[0].body, ME)!.commits).toEqual([HEAD12])
  })

  it.each([[403, 'written'], [undefined, 'write_uncertain']] as const)('keeps the head unrecorded when the head edit after the summary create fails (%s)', async (status, outcome) => {
    fake.hooks.failEdit = () => httpErr(status)
    reviewerFinds([POOL])
    const record = await run()
    expect(record!.inline!.outcome).toBe(outcome)
    expect(record!.checked_commit).toBeUndefined()
    expect(summaries()).toHaveLength(1)
    expect(verify(summaries()[0].body, ME)!.commits).toEqual([])

    fake.hooks.failEdit = undefined
    await run()
    expect(summaries()).toHaveLength(1)
    expect(roots()).toHaveLength(1)
    expect(verify(summaries()[0].body, ME)!.commits).toEqual([HEAD12])
  })

  it('posts a create that never committed exactly once on the next run', async () => {
    fake.hooks.failPost = (n, kind) => (kind === 'root' && n === 1 ? httpErr() : undefined)
    reviewerFinds([POOL])
    await run()
    expect(roots()).toHaveLength(0)

    fake.hooks.failPost = undefined
    await run()
    expect(rootOf('Pool leaks')).toHaveLength(1)
    expect(verify(summaries()[0].body, ME)!.commits).toEqual([HEAD12])
  })
})

describe('thread cap', () => {
  it('posts 20 threads and lists the overflow as summary-only rows without ids', async () => {
    const many: F[] = Array.from({ length: 22 }, (_, i) => ({
      severity: 'MEDIUM', title: `Defect ${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)} in handler`, file: PATHS[i % 3], lines: String(1 + i), body: `Problem ${i}.`,
    }))
    reviewerFinds(many)
    const record = await run()
    expect(roots()).toHaveLength(20)
    expect(record!.inline!.roots!.summary_only.over_cap).toBe(2)
    const section = summaries()[0].body.split('**Not posted as threads**')[1].split(/\n### /)[0]
    expect(section.match(/ · no thread/g)).toHaveLength(2)
    expect(section).not.toMatch(/\bF\d+\b/)
  })
})

describe('a huge TODO scan', () => {
  it('lists the summary-only HIGH finding and a capped TODO list instead of "No findings."', async () => {
    cfg.review.todoScan = true
    const path = 'src/todos.ts'
    fake.hooks.diff = DIFF + [
      `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`, '@@ -0,0 +1,250 @@',
      ...Array.from({ length: 250 }, (_, i) => `+// TODO: ${'t'.repeat(120)} ${i}`), '',
    ].join('\n')
    fake.hooks.files = [...FILES, { path, status: 'added' }]
    reviewerFinds([{ severity: 'HIGH', title: 'Stale cache key', file: 'src/one.ts', lines: '100', body: 'The key ignores the tenant.' }])
    const record = await run()
    const body = summaries()[0].body
    expect(body).not.toContain('No findings.')
    expect(body).toContain('- **HIGH – Stale cache key** (`src/one.ts:100`) · no thread')
    expect(body).toContain('### TODOs Introduced')
    expect(body).toMatch(/- and 240 more/)
    expect(verify(body, ME)).toEqual({ n: 1, commits: [HEAD12] })
    expect(record!.checked_commit).toBe(HEAD)
  })
})

describe('flag on versus off', () => {
  it('flag off leaves existing inline artifacts untouched and does not mistake them for a legacy review', async () => {
    reviewerFinds([POOL])
    await run()
    expect(hasReviewFooter(summaries()[0].body)).toBe(false)
    const before = fake.comments.map(c => c.body)
    const edits = fake.counts.edit
    cfg.review.inlineReviews = false
    fake.raw.getPreviousReviewComments.mockImplementation(async () =>
      fake.comments.filter(c => hasReviewFooter(c.body)).map(c => ({ id: String(c.id), body: c.body, createdOn: '', resolved: false })) as never)
    push(HEAD_B)
    const record = await run()
    expect('inline' in record!).toBe(false)
    expect(fake.raw.postComment).toHaveBeenCalledTimes(1)
    expect(record!.review_number).toBe(1)
    expect(fake.comments.map(c => c.body)).toEqual(before)
    expect(fake.counts.edit).toBe(edits)
  })

  it('flag on beside a legacy review comment neither edits it nor treats it as the summary', async () => {
    const legacy = fake.add({
      body: '### Summary\nOld review.\n\n*Reviewed by review-bot (claude-sonnet-5-5) | Prompt: repo | Review #1 | Commit: abcdef123456*',
      authorIds: [ME],
    })
    const legacyBody = fake.comments.find(c => c.id === legacy)!.body
    fake.raw.getPreviousReviewComments.mockImplementation(async () => [{ id: String(legacy), body: legacyBody, createdOn: '', resolved: false }] as never)
    reviewerFinds([POOL])
    const record = await run()
    expect(fake.comments.find(c => c.id === legacy)!.body).toBe(legacyBody)
    expect(fake.editBodies).toHaveLength(1)
    expect(summaries()).toHaveLength(1)
    expect(summaries()[0].id).not.toBe(legacy)
    expect(record!.review_number).toBe(1)
    expect(record!.inline!.summary_check).toBe('missing')
    expect(roots()).toHaveLength(1)
  })
})

describe('--force on a completed head', () => {
  it.each(['re-review', 'clean'] as const)('%s invalidates the head first, re-reviews, adds no duplicate thread, and records the head again', async force => {
    reviewerFinds([POOL, NULLS])
    await run()
    const summaryId = summaries()[0].id
    mockRunReview.mockClear()
    fake.editBodies.length = 0
    const record = await run(force)
    expect(mockRunReview).toHaveBeenCalledTimes(1)
    expect(verify(fake.editBodies[0], ME)!.commits).toEqual([])
    expect(roots()).toHaveLength(2)
    expect(idsOf()).toEqual(['F1', 'F2'])
    expect(summaries()).toHaveLength(1)
    expect(summaries()[0].id).toBe(summaryId)
    expect(verify(summaries()[0].body, ME)).toEqual({ n: 2, commits: [HEAD12] })
    expect(record!.checked_commit).toBeUndefined()
    neverClosed()
  })
})

describe('finding status in replies', () => {
  const LINE5 = ['diff --git a/src/one.ts b/src/one.ts', 'index 1111111..2222222 100644', '--- a/src/one.ts', '+++ b/src/one.ts', '@@ -5,1 +5,1 @@', '-x', '+y', ''].join('\n')
  const replyUser = (): string => completeStructured.mock.calls.map(c => c).find(c => String(c[0]).includes('INLINE THREAD REPLIES'))![1] as string

  it('tells the reply model that a later commit changed the anchored line, on a push run', async () => {
    reviewerFinds([POOL])
    await run()
    const poolId = rootOf('Pool leaks')[0].id
    const q = ask(poolId, 'Is this still an issue?')
    push(HEAD_B)
    fake.hooks.commitDiff = () => LINE5
    answerTo('F1', q)
    const deltas = fake.calls.filter(c => c === 'delta').length
    await run()
    expect(replyUser()).toContain(`Finding status: opened at commit ${HEAD12}; the PR head is now ${B12}. Later commits changed the line this thread is anchored to (src/one.ts, line 5 as of ${HEAD12}).`)
    expect(fake.calls.filter(c => c === 'delta').length).toBeGreaterThan(deltas)
  })

  it('looks the status up on a comment-triggered run at an already reviewed head', async () => {
    reviewerFinds([POOL])
    await run()
    const poolId = rootOf('Pool leaks')[0].id
    push(HEAD_B)
    fake.hooks.commitDiff = () => LINE5
    await run()
    completeStructured.mockClear()
    const q = ask(poolId, 'Was this fixed?')
    answerTo('F1', q)
    await run()
    expect(replyUser()).toContain('Later commits changed the line this thread is anchored to (src/one.ts, line 5 as of')
  })
})
