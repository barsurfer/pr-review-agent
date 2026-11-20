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
  reply: { maxComments: 5, maxFindingReplies: 5, model: 'claude-haiku-5-5' },
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
vi.mock('../engine.js', async importOriginal => {
  const real = await importOriginal() as typeof import('../engine.js')
  return { ...real, selectInlineEngine: vi.fn(real.selectInlineEngine) }
})

import { review } from '../../review/index.js'
import { runReview } from '../../review/client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { logUsageRecord } from '../../review/usage.js'
import { renderReview, type ReviewObject } from '../../review/formatter.js'
import { State, type ReviewContext } from '../../review/types.js'
import { selectInlineEngine } from '../engine.js'
import { buildAnswerMarker, SUMMARY_HEADER } from '../markers.js'
import { rootBody } from '../compose.js'
import { verify, withState } from '../state.js'
import type { InlineDeps } from '../types.js'
import { makeFake, ME, HEAD, HEAD12, type Fake } from './fake-bitbucket.js'

const A = 'aaaaaaaaaaaa'
const mockRunReview = vi.mocked(runReview)

const bulk = (path: string, n: number): string => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${n} @@`,
  ...Array.from({ length: n }, (_, i) => `+export const ${path.replace(/\W/g, '_')}_${i} = ${i}`), '',
].join('\n')
const PATHS = ['src/one.ts', 'src/two.ts', 'src/three.ts']
const DIFF = PATHS.map(p => bulk(p, 40)).join('')
const DELTA = ['diff --git a/src/one.ts b/src/one.ts', 'index 1111111..2222222 100644', '--- a/src/one.ts', '+++ b/src/one.ts', '@@ -30,1 +30,1 @@', '-x', '+y', ''].join('\n')
const FILES = PATHS.map(path => ({ path, status: 'added' }))

const usage = { input_tokens: 1000, output_tokens: 500 }
const object = (findings: ReviewObject['findings'] = [], extra: Partial<ReviewObject> = {}): ReviewObject =>
  ({ summary: 'A change.', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [], ...extra })
const answerWith = (o: ReviewObject) => ({ text: renderReview(o), usage, review: o })

let fake: Fake
let step: ReturnType<typeof vi.spyOn> | undefined
let depsSeen: InlineDeps | undefined

const seedSummary = (state: { n: number; commits: string[] }): number => fake.add({ body: withState(`${SUMMARY_HEADER}\n\nold`, state, ME), authorIds: [ME] })
const seedThread = (id: string, title: string, line: number, file = 'src/one.ts'): number =>
  fake.add({ body: rootBody({ severity: 'MEDIUM', title, body: 'Details of the problem.', id, c12: A }), authorIds: [ME], inline: { path: file, line } })
const summaryOf = () => fake.comments.find(c => !c.parentId && c.body.startsWith(SUMMARY_HEADER))

beforeEach(async () => {
  vi.clearAllMocks()
  fake = makeFake()
  fake.hooks.diff = DIFF
  fake.hooks.files = FILES
  fake.hooks.commitDiff = () => DELTA
  Object.assign(cfg.review, { inlineReviews: true, inlineLowThreads: false, promptCache: false, secondLook: false, bundledReview: false, effort: '' })
  Object.assign(cfg.lenses, { enabled: false, recommend: false })
  Object.assign(cfg.breadth, { enabled: false })
  cfg.judge.model = ''
  cfg.anthropic.maxInputTokens = 250000
  cfg.reply.maxComments = 5
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' } as never)
  vi.mocked(fetchContext).mockResolvedValue([])
  mockRunReview.mockImplementation(async () => answerWith(object()))
  depsSeen = undefined
  step = undefined
  await withEngine()
})

// Delegates to the real selector but keeps a handle on the engine's step, so a test can see the deps object it was driven with.
async function withEngine(): Promise<void> {
  const real = await vi.importActual<typeof import('../engine.js')>('../engine.js')
  vi.mocked(selectInlineEngine).mockImplementation((adapter, sink) => {
    const engine = real.selectInlineEngine(adapter, sink)
    if (engine) {
      const original = engine.step.bind(engine)
      step = vi.spyOn(engine, 'step').mockImplementation(async (state, ctx, deps) => { depsSeen = deps; return original(state, ctx, deps) })
    }
    return engine
  })
}

describe('flag on', () => {
  it('drives the run through step with the legacy transition, markHeadChecked and narrowTargetMergeDelta', async () => {
    await withEngine()
    const record = await review(fake.adapter, '7', false)
    expect(step).toHaveBeenCalled()
    expect(Object.keys(depsSeen!).sort()).toEqual(['markHeadChecked', 'narrowTargetMergeDelta', 'transition'])
    expect(step!.mock.calls[0][0]).toBe(State.CHECK_TRIGGER)
    expect(fake.raw.postComment).not.toHaveBeenCalled()
    expect(summaryOf()).toBeDefined()
    expect(record!.inline).toMatchObject({ active: true, outcome: 'written', summary: 'created', completed: true })
    expect(record!.checked_commit).toBe(HEAD)
    expect(record!.action).toBe('REVIEW')
  })

  it('posts findings as threads and the summary, never through the legacy comment', async () => {
    mockRunReview.mockImplementation(async () => answerWith(object([{ severity: 'HIGH', title: 'Pool leaks', file: 'src/one.ts', lines: '5', body: 'Never released.' }])))
    const record = await review(fake.adapter, '7', false)
    expect(fake.comments.filter(c => c.inline)).toHaveLength(1)
    expect(fake.raw.postComment).not.toHaveBeenCalled()
    expect(record!.inline!.roots).toMatchObject({ posted: 1 })
  })

  it('pins markHeadChecked to the legacy exclusions that the writer relies on', async () => {
    await withEngine()
    await review(fake.adapter, '7', false)
    const mark = depsSeen!.markHeadChecked
    const variant = (over: Record<string, unknown>): ReviewContext => ({ force: 'off', dryRun: false, ...over } as unknown as ReviewContext)
    const marked = (over: Record<string, unknown>): boolean => { const c = variant(over); mark(c); return c.headChecked === true }
    expect(marked({})).toBe(true)
    expect(marked({ bundleUncertain: true })).toBe(false)
    expect(marked({ deltaFetchFailed: true })).toBe(false)
    expect(marked({ dryRun: true })).toBe(false)
    expect(marked({ force: 're-review' })).toBe(false)
    expect(marked({ force: 'clean' })).toBe(false)
    expect(marked({ outcomeSink: vi.fn() })).toBe(false)
  })
})

describe('inactive engine', () => {
  const legacyAdapter = (): ReviewContext['adapter'] => {
    const a = fake.raw
    return {
      getPullRequestInfo: a.getPullRequestInfo, getDiff: a.getDiff, getChangedFiles: a.getChangedFiles, getFileContent: a.getFileContent, getRepoFileContent: a.getRepoFileContent,
      postComment: vi.fn().mockResolvedValue(undefined), getPreviousReviewComments: a.getPreviousReviewComments, getRepliesToReviewComments: a.getRepliesToReviewComments,
      postReply: vi.fn(), getCommitDiff: a.getCommitDiff,
    } as unknown as ReviewContext['adapter']
  }

  it('keeps the legacy flow and records unsupported_vcs for an adapter without the inline methods', async () => {
    const adapter = legacyAdapter()
    const record = await review(adapter, '7', false)
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
    expect(record!.inline).toEqual({ active: false, reason: 'unsupported_vcs' })
    expect(fake.calls).not.toContain('list')
  })

  it('keeps the benchmark flow and records benchmark', async () => {
    const sink = vi.fn()
    const record = await review(fake.adapter, '7', false, undefined, 'off', false, '', sink)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(record!.inline).toEqual({ active: false, reason: 'benchmark' })
    expect(fake.raw.listMarkedThreads).not.toHaveBeenCalled()
    expect(fake.calls.filter(c => ['root', 'summary', 'edit'].includes(c))).toEqual([])
  })

  it('adds no inline key and constructs no engine with the flag off', async () => {
    cfg.review.inlineReviews = false
    const adapter = legacyAdapter()
    const record = await review(adapter, '7', false)
    expect('inline' in record!).toBe(false)
    expect(adapter.postComment).toHaveBeenCalledTimes(1)
    expect(fake.raw.getAgentIdentity).not.toHaveBeenCalled()
  })
})

describe('reviewer argument positions through review()', () => {
  // A thread without a summary is the one inline case that still reviews as review 1, so the cache and recommendation can be on beside the list.
  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])('recommendation %s, cache %s', async (recommend, cache) => {
    cfg.lenses.recommend = recommend
    if (cache) Object.assign(cfg.review, { promptCache: true, secondLook: true })
    cfg.judge.model = 'claude-haiku-5-5'
    seedThread('F1', 'Unbounded pool growth', 5)
    await review(fake.adapter, '7', false)
    const args = mockRunReview.mock.calls[0]
    expect(args).toHaveLength(16)
    expect(args[13]).toBe(recommend)
    if (cache) expect(args[14]).toMatchObject({ schema: expect.any(Object) })
    else expect(args[14]).toBeUndefined()
    expect(args[15]).toEqual({ block: expect.stringContaining('[F1] MEDIUM · src/one.ts:5 · Unbounded pool growth') })
  })

  it('keeps the legacy argument count when there is nothing to list', async () => {
    await review(fake.adapter, '7', false)
    expect(mockRunReview.mock.calls[0]).toHaveLength(13)
  })
})

describe('re-reviews', () => {
  it('reports skipped_rereview for second look and lenses, then writes the zero-finding summary and records the head', async () => {
    Object.assign(cfg.review, { secondLook: true })
    Object.assign(cfg.lenses, { enabled: true, list: 'rel' })
    cfg.judge.model = 'claude-haiku-5-5'
    seedSummary({ n: 1, commits: [A] })
    mockRunReview.mockImplementation(async () => answerWith(object([], { delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } })))
    const record = await review(fake.adapter, '7', false)
    expect(record!.second_look_status).toBe('skipped_rereview')
    expect(record!.lens_runs!.map(r => r.status)).toEqual(['skipped_rereview'])
    expect(verify(summaryOf()!.body, ME)).toEqual({ n: 2, commits: [A, HEAD12] })
    expect(summaryOf()!.body).toContain('No findings.')
    expect(record!.checked_commit).toBe(HEAD)
    expect(record!.action).toBe('RE_REVIEW')
    expect(record!.review_number).toBe(2)
    expect(record!.inline).toMatchObject({ outcome: 'written', summary: 'edited', completed: true })
  })

  it('goes to the bundled path when the reviewer list pushes a near-limit re-review over the input budget', async () => {
    cfg.review.bundledReview = true
    const zero = async () => answerWith(object([], { delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } }))
    mockRunReview.mockImplementation(zero)
    seedSummary({ n: 1, commits: [A] })
    const base = (await review(fake.adapter, '7', false))!.tokens.estimated_input
    expect(mockRunReview).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    mockRunReview.mockImplementation(zero)
    fake = makeFake()
    Object.assign(fake.hooks, { diff: DIFF, files: FILES, commitDiff: () => DELTA })
    seedSummary({ n: 1, commits: [A] })
    PATHS.forEach((p, i) => seedThread(`F${i + 1}`, `Problem number ${i + 1} in ${p} with a long descriptive title`, 3, p))
    cfg.anthropic.maxInputTokens = base + 5
    await review(fake.adapter, '7', false)
    expect(mockRunReview.mock.calls.length).toBeGreaterThan(1)
    for (const c of mockRunReview.mock.calls) {
      expect(c).toHaveLength(16)
      expect(c[13]).toBe(false)
      expect(c[14]).toBeUndefined()
      const block = (c[15] as { block: string }).block
      const diff = c[6] as string
      for (const p of PATHS) expect(block.includes(` ${p}:`)).toBe(diff.includes(`diff --git a/${p} `))
    }
  })
})

describe('reply usage', () => {
  it('prices Haiku answers at the reply model and sums them into cost_usd beside a Sonnet review', async () => {
    const summaryId = seedSummary({ n: 1, commits: [A] })
    const rootId = seedThread('F1', 'Unbounded pool growth', 5)
    const q = fake.add({ parentId: rootId, body: 'Why does this matter?', authorIds: ['dev'] })
    void summaryId
    completeStructured.mockResolvedValue({ object: { answers: [{ id: 'F1', through: String(q), text: 'It grows without bound.' }] }, usage: { input_tokens: 1000, output_tokens: 200 } })
    mockRunReview.mockImplementation(async () => answerWith(object([{ severity: 'MEDIUM', title: 'New problem', file: 'src/two.ts', lines: '4', body: 'Bad.' }], { delta_stats: { resolved: 0, still_open: 1, new_findings: 1 } })))
    const record = await review(fake.adapter, '7', false)
    const reply = fake.comments.find(c => c.parentId === rootId && c.authorIds[0] === ME)!
    expect(reply.body).toContain(buildAnswerMarker('F1', String(q)))
    // Sonnet 5.5: 1000 in at $2/M plus 500 out at $10/M; Haiku 5.5: 1000 in at $0.1/M plus 200 out at $0.5/M.
    expect(record!.cost_usd).toBeCloseTo(0.007 + 0.0002, 6)
    expect(record!.tokens).toMatchObject({ input: 2000, output: 700 })
    expect(record!.inline!.reply_usage).toEqual({ model: 'claude-haiku-5-5', input_tokens: 1000, output_tokens: 200, cost_usd: 0.0002 })
    expect(record!.model).toBe('claude-sonnet-5-5')
  })

  it('counts the usage of a failed dedup reply once, at the reply model', async () => {
    seedSummary({ n: 1, commits: [HEAD12] })
    fake.add({ parentId: seedThread('F1', 'Unbounded pool growth', 5), body: 'Why?', authorIds: ['dev'] })
    completeStructured.mockRejectedValue(Object.assign(new Error('reply model down'), { usage: { input_tokens: 1000, output_tokens: 200 } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(review(fake.adapter, '7', false, undefined, 'off', true)).rejects.toThrow('reply model down')
    warn.mockRestore()
    const record = vi.mocked(logUsageRecord).mock.calls[0][0]
    expect(record.tokens).toMatchObject({ input: 1000, output: 200 })
    expect(record.cost_usd).toBeCloseTo(0.0002, 6)
  })

  it('records a reply-only run at the reply model', async () => {
    seedSummary({ n: 1, commits: [HEAD12] })
    const rootId = seedThread('F1', 'Unbounded pool growth', 5)
    const q = fake.add({ parentId: rootId, body: 'Why?', authorIds: ['dev'] })
    completeStructured.mockResolvedValue({ object: { answers: [{ id: 'F1', through: String(q), text: 'Because.' }] }, usage: { input_tokens: 1000, output_tokens: 200 } })
    const record = await review(fake.adapter, '7', false)
    expect(mockRunReview).not.toHaveBeenCalled()
    expect(record!.action).toBe('REPLY')
    expect(record!.model).toBe('claude-haiku-5-5')
    expect(record!.cost_usd).toBeCloseTo(0.0002, 6)
    expect(record!.inline).toMatchObject({ outcome: 'replies_only', answers: { posted: 1 } })
  })
})
