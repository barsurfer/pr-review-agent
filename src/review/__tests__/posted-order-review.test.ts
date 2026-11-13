import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VCSAdapter, PRInfo } from '../../vcs/adapter.js'
import type { OutcomeSink, ReviewOutcome } from '../types.js'

vi.mock('../../config.js', () => ({
  config: {
    llmApiKey: 'k',
    anthropic: { apiKey: 'k', model: 'claude-haiku-4-5-20251001', maxRetries: 1, maxInputTokens: 150000, maxTokens: 32000, modelContextTokens: 0 },
    judge: { model: '', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false, quality: false, shownAnchors: false, proposals: false, suggestedFixes: false },
    breadth: { enabled: false, model: '', effort: '', minFiles: 2, minUntouched: 1, benchmarkDeadlineSeconds: 840, priorityTargets: false },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3, model: '', skipDirectedElsewhere: false },
    review: { maxFindings: 0, splitCheck: false, todoScan: true, effort: '', enableNitpicks: false, secondLook: false, secondLookBreadthTargets: false, bundledReview: false, maxBundles: 8, lineNumbers: false },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [],
    skipTargetBranches: [],
    onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: [],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
  modelContextWindow: () => 200_000,
}))

vi.mock('../client.js', () => ({ runReview: vi.fn(), runCommentResponse: vi.fn(), runJudge: vi.fn(), runBreadth: vi.fn(), runLens: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../usage.js', async (importOriginal) => ({ ...(await importOriginal() as object), getBuildCommit: () => 'testbuild', logUsageRecord: vi.fn() }))
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn() }))
// Spied so one run can post without ordering: the baseline every ordered run is compared against.
vi.mock('../posted-order.js', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../posted-order.js')
  return { ...actual, orderPosted: vi.fn(actual.orderPosted) }
})

import { review } from '../index.js'
import { config } from '../../config.js'
import { runReview, runJudge, runBreadth } from '../client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { createProvider } from '../../llm/provider.js'
import { orderPosted } from '../posted-order.js'
import { renderReview, extractCommitHash, hasReviewFooter, markdownHasFindings, type ReviewObject, type ReviewFinding } from '../formatter.js'
import { renderFixBlock, stripSuggestedFixes, stripOwnSuggestedFixes, SUGGESTED_FIX_MARKER } from '../suggested-fix.js'

const cfg = config as any
const COMMIT = 'aaa111222333'
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,6 @@\n+import { foo } from \'./foo\'\n+foo()\n+bar()\n',
  'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,1 +1,3 @@\n+export const b = 1\n+export const b2 = 2\n',
].join('')
const pr: PRInfo = { id: '100', title: 'Test PR', description: 'A test PR', author: 'dev', sourceBranch: 'feature/test', targetBranch: 'develop', sourceCommit: COMMIT.padEnd(40, 'f') }

const at = (severity: ReviewFinding['severity'], title: string, lines: string, body = `${title} body.`, file = 'src/a.ts'): ReviewFinding => ({ severity, title, file, lines, body })
const LOW = at('LOW', 'Unused import', '10', 'Remove it.\nIt is never read.')
const MED = at('MEDIUM', 'Missing await', '11', 'Await foo().\n```ts\nawait foo()\n```\nOtherwise the rejection is lost.')
const HIGH = at('HIGH', 'Crash on null', '12')
const reviewWith = (findings: ReviewFinding[], extra: Partial<ReviewObject> = {}): ReviewObject =>
  ({ summary: 'ok', findings, behavioral_diff: ['b'], production_risk: [], unresolved_questions: ['q?'], ...extra })

const completeStructured = vi.fn()
const isJudge = (schema: unknown) => !!(schema as { properties: Record<string, unknown> }).properties.decisions
type Decide = (i: number) => Record<string, unknown>

// Real reviewer and judge clients over a mocked provider, so the judge's render closure is the production one.
async function clients(reviewObj: ReviewObject, decide: Decide = () => ({})) {
  const actual = await vi.importActual<typeof import('../client.js')>('../client.js')
  vi.mocked(createProvider).mockReturnValue({ complete: vi.fn(), completeStructured } as never)
  vi.mocked(runReview).mockImplementation(actual.runReview)
  vi.mocked(runJudge).mockImplementation(actual.runJudge)
  completeStructured.mockReset()
  completeStructured.mockImplementation(async (_system: string, user: string, schema: unknown) => {
    if (!isJudge(schema)) return { object: structuredClone(reviewObj), usage: { input_tokens: 1000, output_tokens: 200 } }
    const ids = [...user.matchAll(/^- \[c(\d+)\]/gm)].map(m => Number(m[1]))
    return {
      object: {
        decisions: ids.map(i => ({ candidate_id: `c${i}`, reason_category: 'validated', evidence: 'src/a.ts:10', note: 'n', score: 8, ...decide(i) })),
        summary: 'Judged.', behavioral_diff: ['b'], production_risk: [], unresolved_questions: [], merge_confidence: 70,
      },
      usage: { input_tokens: 800, output_tokens: 300 },
    }
  })
}

function makeAdapter(diff = DIFF, files = ['src/a.ts', 'src/b.ts']): VCSAdapter {
  return {
    getPullRequestInfo: vi.fn().mockResolvedValue(pr),
    getDiff: vi.fn().mockResolvedValue(diff),
    getChangedFiles: vi.fn().mockResolvedValue(files.map(path => ({ path, status: 'modified' }))),
    getFileContent: vi.fn().mockResolvedValue(''),
    getRepoFileContent: vi.fn().mockResolvedValue(null),
    postComment: vi.fn().mockResolvedValue(undefined),
    getPreviousReviewComments: vi.fn().mockResolvedValue([]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
    postReply: vi.fn().mockResolvedValue(undefined),
    getCommitDiff: vi.fn().mockResolvedValue(''),
  } as unknown as VCSAdapter
}

async function run(opts: { unordered?: boolean; dryRun?: boolean; sink?: OutcomeSink; adapter?: () => VCSAdapter } = {}) {
  const actualOrder = await vi.importActual<typeof import('../posted-order.js')>('../posted-order.js')
  if (opts.unordered) vi.mocked(orderPosted).mockImplementation(plain => ({ text: plain }))
  const adapter = (opts.adapter ?? makeAdapter)()
  const lines: string[] = []
  const spies = (['log', 'warn', 'error'] as const).map(level => vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
    const text = a.map(String).join(' ')
    if (!text.startsWith('\n=== Usage ===')) lines.push(`${level}: ${text}`)
  }))
  let record
  try {
    record = await review(adapter, '100', opts.dryRun ?? false, undefined, 'off', false, 'repo', opts.sink)
  } finally {
    for (const s of spies) s.mockRestore()
    vi.mocked(orderPosted).mockImplementation(actualOrder.orderPosted)
  }
  const posted = vi.mocked(adapter.postComment).mock.calls[0]?.[1] as string | undefined
  return { record: { ...record!, timestamp: '', duration_ms: 0 }, posted, lines }
}

const headers = (text: string) => [...text.matchAll(/^- \*\*(HIGH|MEDIUM|LOW) – ([^*]+)\*\*/gm)].map(m => `${m[1]} ${m[2]}`)
const FOOTER_LINE = `*Reviewed by test-bot (claude-haiku-4-5-20251001) | Prompt: repo | Review #1 | Commit: ${COMMIT} | Build: testbuild*`

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('JOB_NAME', '')
  vi.stubEnv('BUILD_NUMBER', '')
  vi.stubEnv('BUILD_URL', '')
  cfg.judge.model = ''
  cfg.judge.suggestedFixes = false
  cfg.breadth.enabled = false
  cfg.review.bundledReview = false
  cfg.anthropic.maxInputTokens = 150000
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.mocked(runReview).mockReset()
  vi.mocked(runJudge).mockReset()
  vi.mocked(runBreadth).mockReset()
})

describe('posted severity order through review()', () => {
  it('reviewer-only: the posted body is ordered; record, metrics and console lines equal the unordered run', async () => {
    const obj = reviewWith([LOW, MED, HIGH])
    await clients(obj)
    const ordered = await run()
    const unordered = await run({ unordered: true })

    expect(ordered.posted).toBe(renderReview({ ...obj, findings: [HIGH, MED, LOW] }) + `\n\n---\n${FOOTER_LINE}`)
    expect(unordered.posted).toBe(renderReview(obj) + `\n\n---\n${FOOTER_LINE}`)
    expect(ordered.record).toEqual(unordered.record)
    expect(ordered.record.review_findings).toEqual({ high: 1, medium: 1, low: 1 })
    expect(ordered.lines).toEqual(unordered.lines)
  })

  it('judged: a judge-downgraded HIGH is ordered with the MEDIUMs; judge_decisions, anchored_findings, finding_scores and candidates keep production order', async () => {
    const raced = at('HIGH', 'Race', '10')
    await clients(reviewWith([raced, LOW, HIGH, MED]), i => (i === 0 ? { reason_category: 'unconfirmed_high' } : {}))
    cfg.judge.model = 'judge-model'
    const ordered = await run()
    const unordered = await run({ unordered: true })

    expect(headers(unordered.posted!)).toEqual(['MEDIUM Race', 'LOW Unused import', 'HIGH Crash on null', 'MEDIUM Missing await'])
    expect(headers(ordered.posted!)).toEqual(['HIGH Crash on null', 'MEDIUM Race', 'MEDIUM Missing await', 'LOW Unused import'])
    expect(ordered.posted!.length).toBe(unordered.posted!.length)
    expect(ordered.record).toEqual(unordered.record)
    expect(ordered.record.judge_decisions!.map(d => d.final_severity)).toEqual(['MEDIUM', 'LOW', 'HIGH', 'MEDIUM'])
    expect(ordered.record.finding_scores!.map(s => s.title)).toEqual(['Race', 'Unused import', 'Crash on null', 'Missing await'])
    expect(ordered.record.anchored_findings!.map(a => a.severity)).toEqual(['MEDIUM', 'LOW', 'HIGH', 'MEDIUM'])
    expect(ordered.lines).toEqual(unordered.lines)
  })

  it('judged with breadth: a breadth-appended HIGH posts first; review_candidates keep origin order', async () => {
    const breadthHigh = at('HIGH', 'Same crash in b', '1', 'b repeats a.', 'src/b.ts')
    await clients(reviewWith([MED, at('LOW', 'Typo', '11')]))
    vi.mocked(runBreadth).mockResolvedValue({ findings: [breadthHigh], usage: { input_tokens: 300, output_tokens: 100 }, promptHash: 'abc123' })
    cfg.judge.model = 'judge-model'
    cfg.breadth.enabled = true
    const ordered = await run()
    const unordered = await run({ unordered: true })

    expect(ordered.record.breadth_status).toBe('succeeded')
    expect(headers(ordered.posted!)).toEqual(['HIGH Same crash in b', 'MEDIUM Missing await', 'LOW Typo'])
    expect(headers(unordered.posted!)).toEqual(['MEDIUM Missing await', 'LOW Typo', 'HIGH Same crash in b'])
    expect(ordered.record.review_candidates!.map(c => c.origin)).toEqual(['review', 'review', 'breadth'])
    expect(ordered.record).toEqual(unordered.record)
    expect(ordered.lines).toEqual(unordered.lines)
  })

  it('already-ordered reviews post byte-identical bodies, judged and reviewer-only', async () => {
    const obj = reviewWith([HIGH, MED, LOW])
    await clients(obj)
    const reviewerOnly = await run()
    expect(reviewerOnly.posted).toBe((await run({ unordered: true })).posted)
    expect(reviewerOnly.posted).toBe(renderReview(obj) + `\n\n---\n${FOOTER_LINE}`)

    cfg.judge.model = 'judge-model'
    const judged = await run()
    expect(judged.posted).toBe((await run({ unordered: true })).posted)
    expect(headers(judged.posted!)).toEqual(['HIGH Crash on null', 'MEDIUM Missing await', 'LOW Unused import'])
  })

  it('suggested fixes: each block posts under its moved finding; the strip gives the ordered flag-off comment; counts equal the unordered run', async () => {
    await clients(reviewWith([LOW, MED, HIGH]), i => (i === 0 ? { proposal: 'void 0' } : i === 2 ? { proposal: 'if (!x) return' } : {}))
    cfg.judge.model = 'judge-model'
    cfg.judge.suggestedFixes = true
    const on = await run()
    const onUnordered = await run({ unordered: true })
    cfg.judge.suggestedFixes = false
    const off = await run()

    const posted = on.posted!
    expect(headers(posted)).toEqual(['HIGH Crash on null', 'MEDIUM Missing await', 'LOW Unused import'])
    // The review already holds a 3-backtick fence (the MEDIUM body), so blocks get a 4-backtick one.
    expect(posted).toContain(`  Crash on null body.${renderFixBlock('if (!x) return', '````')}\n\n- **MEDIUM – Missing await**`)
    expect(posted).toContain(`It is never read.${renderFixBlock('void 0', '````')}\n\n### Behavioral Diff`)
    expect(posted.split(SUGGESTED_FIX_MARKER)).toHaveLength(3)
    expect(stripSuggestedFixes(posted)).toBe(off.posted)
    expect(stripOwnSuggestedFixes(posted, 'review')).toBe(off.posted)
    expect(on.record.suggested_fixes).toEqual({ rendered: 2, rejected: 0 })
    expect(on.record).toEqual(onUnordered.record)
    expect(on.lines).toEqual(onUnordered.lines)
  })

  it('the next run reads the ordered comment the same: footer hash, review footer, findings', async () => {
    await clients(reviewWith([LOW, MED, HIGH]))
    const { posted } = await run()
    expect(extractCommitHash(posted!)).toBe(COMMIT)
    expect(hasReviewFooter(posted!)).toBe(true)
    expect(markdownHasFindings(posted!)).toBe(true)
    expect(posted!.trimEnd().split('\n').at(-1)).toBe(FOOTER_LINE)
  })

  it('dry-run prints the ordered body and posts nothing', async () => {
    await clients(reviewWith([LOW, MED, HIGH]))
    const posted = (await run()).posted!
    const dry = await run({ dryRun: true })
    const dryUnordered = await run({ dryRun: true, unordered: true })

    expect(dry.posted).toBeUndefined()
    expect(dry.lines).toContain(`log: ${posted}`)
    expect(dryUnordered.lines).not.toContain(`log: ${posted}`)
    const preview = (l: string[]) => l.filter(x => !x.startsWith('log: ### Summary'))
    expect(preview(dry.lines)).toEqual(preview(dryUnordered.lines))
  })

  it('benchmark sink: the outcome keeps production order and nothing is reordered', async () => {
    await clients(reviewWith([LOW, MED, HIGH]))
    cfg.judge.model = 'judge-model'
    const outcomes: ReviewOutcome[] = []
    await run({ sink: o => { outcomes.push(o) } })

    expect(orderPosted).not.toHaveBeenCalled()
    expect(headers(outcomes[0].reviewText)).toEqual(['LOW Unused import', 'MEDIUM Missing await', 'HIGH Crash on null'])
    expect(outcomes[0].judgedFindings!.map(k => k.severity)).toEqual(['LOW', 'MEDIUM', 'HIGH'])
  })

  it('bundled: the merge already sorts by severity, so the posted body equals the unordered run, judged or not', async () => {
    const section = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,120 @@\n${Array.from({ length: 120 }, (_, i) => `+const line${i} = ${i}`).join('\n')}\n`
    const files = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']
    const bigAdapter = () => makeAdapter(files.map(section).join(''), files)
    cfg.review.bundledReview = true
    cfg.anthropic.maxInputTokens = 2000
    vi.mocked(runReview).mockImplementation(async (...args: unknown[]) => {
      const inA = (args[6] as string).includes('a/one.ts')
      const o = reviewWith(inA ? [at('LOW', 'Alpha nit', '5', 'nit', 'a/one.ts')] : [at('HIGH', 'Beta crash', '5', 'crash', 'b/one.ts')])
      return { text: renderReview(o), usage: { input_tokens: 100, output_tokens: 10 }, review: o }
    })

    const unjudged = await run({ adapter: bigAdapter })
    expect(unjudged.record.action).toBe('REVIEW')
    expect(headers(unjudged.posted!)).toEqual(['HIGH Beta crash', 'LOW Alpha nit'])
    expect(unjudged.posted).toBe((await run({ adapter: bigAdapter, unordered: true })).posted)

    const actual = await vi.importActual<typeof import('../client.js')>('../client.js')
    vi.mocked(createProvider).mockReturnValue({ complete: vi.fn(), completeStructured } as never)
    vi.mocked(runJudge).mockImplementation(actual.runJudge)
    completeStructured.mockReset()
    completeStructured.mockImplementation(async () => ({
      object: { decisions: [{ candidate_id: 'c0', reason_category: 'validated', evidence: 'e', note: 'n', score: 8 }], summary: 'J.', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 },
      usage: { input_tokens: 100, output_tokens: 10 },
    }))
    cfg.judge.model = 'judge-model'
    const judged = await run({ adapter: bigAdapter })
    expect(headers(judged.posted!)).toEqual(['HIGH Beta crash', 'LOW Alpha nit'])
    expect(judged.posted).toBe((await run({ adapter: bigAdapter, unordered: true })).posted)
  })
})
