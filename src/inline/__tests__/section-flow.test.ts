import { describe, it, expect, vi, beforeEach } from 'vitest'

const cfg = vi.hoisted(() => ({
  llmProvider: 'anthropic',
  vcsProvider: 'bitbucket',
  llmApiKey: 'k',
  agentIdentity: 'review-bot',
  anthropic: { model: 'claude-sonnet-5-5', maxRetries: 1, maxInputTokens: 250000, maxTokens: 64000, extraPassMaxTokens: 0 },
  judge: { model: 'claude-haiku-5-5', maxRetries: 1, effort: '', policy: { keepMinor: true, keepUnverified: true }, fileContext: false },
  breadth: { enabled: false, model: '', effort: '', minFiles: 1, minUntouched: 0, benchmarkDeadlineSeconds: 840, judgeReserveSeconds: 270, passDeadline: false },
  lenses: { enabled: true, list: 'rel', model: '', recommend: false, sections: '', everyReview: true },
  reply: { maxComments: 5, maxFindingReplies: 5, model: 'claude-haiku-5-5', skipDirectedElsewhere: false },
  review: {
    inlineReviews: true, inlineLowThreads: false, inlineAgentAccountId: '', inlineHide: [] as string[],
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
// Only the reviewer is mocked: the real judge runs, so a lens-only re-review reaches the provider mock through the shared JUDGE_REVIEW.
vi.mock('../../review/client.js', async importOriginal => ({ ...(await importOriginal() as object), runReview: vi.fn(), runCommentResponse: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../../review/usage.js', async importOriginal => ({ ...(await importOriginal() as object), logUsageRecord: vi.fn() }))
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))

import { review } from '../../review/index.js'
import { runReview } from '../../review/client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { renderReview, type ReviewObject } from '../../review/formatter.js'
import { CONTENT_FILTER_MARKER } from '../../review/content-filter.js'
import { ContentFilterError } from '../../llm/shared.js'
import { SUMMARY_HEADER } from '../markers.js'
import { makeFake, type Fake } from './fake-bitbucket.js'

const bulk = (path: string, n: number): string => [
  `diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${n} @@`,
  ...Array.from({ length: n }, (_, i) => `+export const ${path.replace(/\W/g, '_')}_${i} = ${i}`), '',
].join('\n')
const PATHS = ['src/one.ts', 'src/two.ts']
const DELTA = ['diff --git a/src/one.ts b/src/one.ts', 'index 1111111..2222222 100644', '--- a/src/one.ts', '+++ b/src/one.ts', '@@ -30,1 +30,1 @@', '-x', '+y', ''].join('\n')
const HEAD_B = 'b'.repeat(12) + '0'.repeat(28)

type F = ReviewObject['findings'][number]
const POOL: F = { severity: 'HIGH', title: 'Pool leaks connections', file: 'src/one.ts', lines: '5', body: 'Connections are never released.' }
const NULLS: F = { severity: 'MEDIUM', title: 'Missing null check on user', file: 'src/two.ts', lines: '10', body: 'The user can be null here.' }
const STYLE: F = { severity: 'LOW', title: 'Inconsistent naming', file: 'src/one.ts', lines: '2', body: 'Mixed naming styles.' }
const REL = { severity: 'MEDIUM', title: 'Retry loop never stops', file: 'src/one.ts', lines: '30', body: 'The loop has no bound.', type: 'reliability' }
const SLOP = { severity: 'LOW', title: 'Restating comment: the comment repeats the next line', file: 'src/one.ts', lines: '2', body: 'Delete it.' }

const reviewUsage = { input_tokens: 1000, output_tokens: 500 }
const judgeUsage = { input_tokens: 5000, output_tokens: 700 }
const object = (findings: F[]): ReviewObject => ({ summary: 'The reviewer narrative here.', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [], delta_stats: { resolved: 0, still_open: 0, new_findings: findings.length } })
const reviewerFinds = (findings: F[]): void => { vi.mocked(runReview).mockImplementation(async () => ({ text: renderReview(object(findings)), usage: reviewUsage, review: object(findings) }) as never) }

type Out = object | Error
let lensOut: Record<string, object[]> = {}
let judgeOut: Out[] = []
let judgeVerdict = 'validated'

const GOOD_SUMMARY = 'A judged summary long enough.'
const judgeAnswer = (user: string, summary = GOOD_SUMMARY): object => ({
  decisions: [...user.matchAll(/\[(c\d+)\]/g)].map(m => ({ candidate_id: m[1], reason_category: judgeVerdict, evidence: 'src/one.ts:30', note: 'ok', score: 8 })),
  summary, behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80,
})

function respond(): void {
  completeStructured.mockImplementation(async (system: string, user: string, schema: any) => {
    const props = schema?.properties ?? {}
    if (props.decisions?.items?.properties?.verdict) {
      const n = String(user).match(/- \[s\d+\]/g)?.length ?? 0
      return { object: { decisions: Array.from({ length: n }, (_, i) => ({ candidate_id: `s${i}`, verdict: 'validated', evidence: 'e', score: 8 })) }, usage: judgeUsage }
    }
    if (props.decisions) {
      const next = judgeOut.length > 1 ? judgeOut.shift()! : judgeOut[0]
      if (next instanceof Error) throw next
      return { object: next ?? judgeAnswer(String(user)), usage: judgeUsage }
    }
    if ('findings' in props) {
      const name = system.includes('## SLOP LENS') ? 'slop' : 'rel'
      return { object: { findings: lensOut[name] ?? [] }, usage: reviewUsage }
    }
    throw new Error('unexpected model call')
  })
}

const judgeCalls = () => completeStructured.mock.calls.filter(c => c[2]?.properties?.decisions && !c[2].properties.decisions.items?.properties?.verdict)

let fake: Fake
let last: Record<string, any> | undefined
const run = async () => { last = (await review(fake.adapter, '7', false, undefined, 'off')) as unknown as Record<string, any> }
const record = (): Record<string, any> => last!
const summary = () => fake.comments.find(c => !c.parentId && !c.inline && c.body.startsWith(SUMMARY_HEADER))!
const roots = () => fake.comments.filter(c => c.inline && !c.parentId)

beforeEach(() => {
  vi.clearAllMocks()
  completeStructured.mockReset()
  lensOut = {}
  judgeOut = []
  judgeVerdict = 'validated'
  fake = makeFake()
  fake.hooks.diff = PATHS.map(p => bulk(p, 40)).join('')
  fake.hooks.files = PATHS.map(path => ({ path, status: 'added' }))
  fake.hooks.commitDiff = () => DELTA
  Object.assign(cfg.lenses, { enabled: true, list: 'rel', sections: '', everyReview: true })
  cfg.judge.model = 'claude-haiku-5-5'
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' } as never)
  vi.mocked(fetchContext).mockResolvedValue([])
  respond()
})

describe('a lens-only re-review on the inline flow', () => {
  beforeEach(async () => {
    reviewerFinds([POOL])
    await run()
    expect(roots()).toHaveLength(1)
    completeStructured.mockClear()
    fake.hooks.head = HEAD_B
    reviewerFinds([])
    lensOut = { rel: [REL] }
  })

  it('judges the lens candidates alone with the open-thread block, retries a stub, and posts the survivor as a thread', async () => {
    judgeOut = [judgeAnswer('[c0]', 'x'), judgeAnswer('[c0]')]
    await run()
    expect(judgeCalls()).toHaveLength(2)
    for (const c of judgeCalls()) {
      expect(String(c[1])).toContain('## Still Open on This PR')
      expect(String(c[1])).toContain('Pool leaks connections')
    }
    expect(record().judge_sanity).toMatchObject({ retried: true, degenerate_after_retry: false })
    expect(record().rereview_lens_judge).toBeUndefined()
    expect(record().lens_runs[0]).toMatchObject({ name: 'reliability', status: 'succeeded', rereview: { outside_delta: 0 } })
    expect(roots()).toHaveLength(2)
    expect(roots()[1].body).toContain('Retry loop never stops')
  })

  it('writes a quiet summary and logs the judge when it keeps none of the candidates', async () => {
    judgeVerdict = 'incorrect'
    await run()
    expect(judgeCalls()).toHaveLength(1)
    expect(record().rereview_lens_judge).toMatchObject({ status: 'succeeded', kept: 0 })
    expect(roots()).toHaveLength(1)
    expect(record().inline).toMatchObject({ outcome: 'written' })
  })

  it('records a refused judge without a retry or a notice, and still writes the quiet summary', async () => {
    judgeOut = [new ContentFilterError({ signal: 'native_refusal' })]
    await run()
    expect(judgeCalls()).toHaveLength(1)
    expect(record().rereview_lens_judge).toMatchObject({ status: 'refused', kept: 0 })
    expect(record().content_filter.map((f: { stage: string }) => f.stage)).toEqual(['judge'])
    expect(summary().body).not.toContain(CONTENT_FILTER_MARKER)
    expect(roots()).toHaveLength(1)
    expect(record().inline).toMatchObject({ outcome: 'written' })
  })

  it('records a failed judge and carries on', async () => {
    judgeOut = [new Error('boom')]
    await run()
    expect(record().rereview_lens_judge).toMatchObject({ status: 'failed', kept: 0 })
    expect(record().content_filter ?? []).toHaveLength(0)
    expect(roots()).toHaveLength(1)
    expect(record().inline).toMatchObject({ outcome: 'written' })
  })
})

describe('summary-only rows and section places', () => {
  const ROW = '- `src/one.ts:2` · Restating comment · the comment repeats the next line'

  beforeEach(async () => {
    cfg.lenses.enabled = false
    reviewerFinds([STYLE])
    await run()
    expect(summary().body).toContain('no thread')
    completeStructured.mockClear()
    cfg.lenses.enabled = true
    cfg.lenses.list = 'slop'
    lensOut = { slop: [SLOP] }
    fake.hooks.head = HEAD_B
  })

  it('does not suppress a place on a fresh review with a row that review no longer carries', async () => {
    reviewerFinds([NULLS])
    await run()
    expect(record().lens_runs[0].section).toMatchObject({ covered_by_thread: 0, rows: 1, posted: 1 })
    expect(summary().body).toContain(ROW)
  })

  it('suppresses the place on a quiet re-review that carries the row', async () => {
    reviewerFinds([])
    await run()
    expect(record().lens_runs[0].section).toMatchObject({ covered_by_thread: 1, rows: 0 })
    expect(summary().body).toContain('Inconsistent naming')
    expect(summary().body).not.toContain('### Cleanup')
  })
})
