import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { VCSAdapter, PRInfo } from '../../vcs/adapter.js'
import { ContentFilterError } from '../../llm/shared.js'
import { rememberExceptions } from '../../prompt/exceptions.js'

vi.mock('../../config.js', () => ({
  config: {
    llmApiKey: 'k',
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-5-5', maxRetries: 1, maxInputTokens: 150000, maxTokens: 32000 },
    judge: { model: 'claude-haiku-5-5', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3, benchmarkDeadlineSeconds: 840 },
    lenses: { enabled: true, list: 'slop', model: '', recommend: false, sections: '', everyReview: true },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3 },
    review: { maxFindings: 0, splitCheck: false, todoScan: true, effort: '', enableNitpicks: false, secondLook: false, lineNumbers: true },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [], skipTargetBranches: [], onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: ['*.lock'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
  modelContextWindow: vi.fn(() => 1_000_000),
}))

vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn(async () => ({ content: 'System prompt', source: 'repo' })) }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn(async () => []) }))
vi.mock('../usage.js', async importOriginal => ({ ...(await importOriginal() as object), logUsageRecord: vi.fn() }))

const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ completeStructured, complete: vi.fn() })) }))

import { review } from '../index.js'
import { config } from '../../config.js'
import { markdownHasFindings } from '../formatter.js'
import { LENS_REGISTRY, lensOverlay } from '../lenses.js'
import { loadPrompt } from '../../prompt/loader.js'

const cfg = config as any
const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const HEAD = 'aaa111222333'

const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts', 'index 1111111..2222222 100644', '--- a/src/pool.ts', '+++ b/src/pool.ts', '@@ -1,3 +1,8 @@',
  ' export class Pool {', '+  // increment the counter', '+  count = 0', '+  // await cache.clear(key)', '+  get() { return this.conns.pop() }', '+  put(c: Conn) { this.conns.push(c) }', ' }', '',
].join('\n')

const prInfo = (): PRInfo => ({ id: '100', title: 'Pool', description: 'd', author: 'dev', sourceBranch: 'feature/pool', targetBranch: 'develop', sourceCommit: HEAD })

function adapter(over: Partial<VCSAdapter> = {}): VCSAdapter {
  return {
    getPullRequestInfo: vi.fn().mockResolvedValue(prInfo()),
    getDiff: vi.fn().mockResolvedValue(DIFF),
    getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/pool.ts', status: 'modified' }]),
    getFileContent: vi.fn().mockResolvedValue(''),
    getRepoFileContent: vi.fn().mockResolvedValue(null),
    postComment: vi.fn().mockResolvedValue(undefined),
    getPreviousReviewComments: vi.fn().mockResolvedValue([]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
    postReply: vi.fn().mockResolvedValue(undefined),
    getCommitDiff: vi.fn().mockResolvedValue(''),
    ...over,
  }
}

const reviewer = (findings: object[] = []) => ({ summary: 'Adds a pool.', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [] })
const SLOP = [
  { severity: 'LOW', title: 'Restating comment: the comment repeats the next line', file: 'src/pool.ts', lines: '2', body: 'Delete it.' },
  { severity: 'LOW', title: 'Commented-out code: an old cache clear is left behind', file: 'src/pool.ts', lines: '4', body: 'Delete it.' },
  { severity: 'LOW', title: 'Not a kind at all', file: 'src/pool.ts', lines: '3', body: 'x' },
]
const verdicts = (v: string[]) => ({ decisions: v.map((verdict, i) => ({ candidate_id: `s${i}`, verdict, evidence: 'e', score: 8 })) })
const judged = (n: number, category = 'validated') => ({
  decisions: Array.from({ length: n }, (_, i) => ({ candidate_id: `c${i}`, reason_category: category, evidence: 'e', note: 'n', score: 8 })),
  summary: 'Adds a connection pool to the service.', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 90,
})

interface Script { reviewer?: object; slop?: object[]; rel?: object[]; section?: object | Error | Array<object | Error>; judge?: object | Error }

function script(s: Script) {
  const sectionOut = Array.isArray(s.section) ? [...s.section] : s.section ? [s.section] : [verdicts(['validated', 'validated'])]
  completeStructured.mockImplementation(async (system: string, _user: string, schema: any) => {
    const props = schema?.properties ?? {}
    if ('behavioral_diff' in props && 'findings' in props) return { object: s.reviewer ?? reviewer(), usage }
    if ('findings' in props) return { object: { findings: system.includes('## SLOP LENS') ? s.slop ?? SLOP : s.rel ?? [] }, usage }
    if (props.decisions?.items?.properties?.verdict) {
      const next = sectionOut.length > 1 ? sectionOut.shift()! : sectionOut[0]
      if (next instanceof Error) throw next
      return { object: next, usage }
    }
    if (s.judge instanceof Error) throw s.judge
    return { object: s.judge ?? judged(1), usage }
  })
}

const sectionCalls = () => completeStructured.mock.calls.filter(c => c[2]?.properties?.decisions?.items?.properties?.verdict)
const posted = (a: VCSAdapter): string => (a.postComment as any).mock.calls[0][1] as string

beforeEach(() => {
  completeStructured.mockReset()
  Object.assign(cfg.lenses, { enabled: true, list: 'slop', sections: '', everyReview: true })
  delete cfg.judge.shownAnchors
  cfg.review.promptCache = false
  cfg.review.maxFindings = 0
  cfg.anthropic.maxInputTokens = 150000
})

describe('a section lens on a first review', () => {
  it('posts a Cleanup block after Unresolved Questions and keeps it out of the findings count', async () => {
    script({})
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    const comment = posted(a)

    expect(comment).toContain('### Cleanup\nLow-value code added in this PR; not counted in the findings or the verdict.\n\n- `src/pool.ts:2` · Restating comment · the comment repeats the next line')
    expect(comment).toContain('- `src/pool.ts:4` · Commented-out code')
    expect(comment.indexOf('### Unresolved Questions')).toBeLessThan(comment.indexOf('### Cleanup'))
    expect(comment.indexOf('### Cleanup')).toBeLessThan(comment.indexOf('### TODOs Introduced') < 0 ? Infinity : comment.indexOf('### TODOs Introduced'))
    expect(markdownHasFindings(comment)).toBe(false)
    expect(record!.judge_status).toBe('skipped_no_findings')
    expect(record!.findings).toEqual({ high: 0, medium: 0, low: 0 })
    expect(record!.lens_runs![0]).toMatchObject({ name: 'slop', placement: 'section', findings: 0, intake: { received: 3, places: 2, dropped: { unknown_kind: 1 } }, judge: { status: 'succeeded' }, section: { kept: 2, rows: 2, posted: 2 } })
    expect(record!.section_findings!.map(r => [r.lens, r.anchor, r.kind, r.posted])).toEqual([['slop', 'src/pool.ts:2', 'Restating comment', true], ['slop', 'src/pool.ts:4', 'Commented-out code', true]])
    expect(record!.review_candidates).toBeNull()
  })

  it('sends the section judge only the restricted input, with the lens criteria and no main-judge fields', async () => {
    script({})
    await review(adapter(), '100', false, undefined, 'off', false, 'repo')
    const [system, user, schema] = sectionCalls()[0]
    expect(system).toContain('You are a section judge. A focused review pass (slop) flagged places')
    expect(system).toContain('- Hollow test: a test that cannot fail')
    expect(system).toContain('No repo-specific exceptions. Apply all rules as written.')
    expect(user).toContain('- [s0] Restating comment · src/pool.ts:2 — the comment repeats the next line')
    expect(user).toContain('- [s1] Commented-out code · src/pool.ts:4')
    expect(user).not.toContain('Not a kind at all')
    expect(Object.keys(schema.properties)).toEqual(['decisions'])
  })

  it('drops a place the section judge rules incorrect', async () => {
    script({ section: verdicts(['validated', 'incorrect']) })
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(posted(a)).toContain('· Restating comment ·')
    expect(posted(a)).not.toContain('Commented-out code')
    expect(record!.section_findings).toHaveLength(1)
  })

  it('retries a section judge output that skips a candidate, pricing both attempts', async () => {
    script({ section: [verdicts(['validated']), verdicts(['validated', 'validated'])] })
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(sectionCalls()).toHaveLength(2)
    expect(posted(a)).toContain('Commented-out code')
    const judge = record!.lens_runs![0].judge!
    expect(judge.sanity).toEqual({ retried: true, degenerate_after_retry: false, reasons: ['1 undecided'] })
    expect(judge.tokens).toEqual({ input: 200, output: 100 })
    expect(record!.tokens.input).toBe(100 + 100 + 200)
  })

  it('shows no block when the section judge is refused, never retries, and posts no notice', async () => {
    script({ section: new ContentFilterError({ signal: 'refusal' } as never) })
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(sectionCalls()).toHaveLength(1)
    expect(a.postComment).toHaveBeenCalledTimes(1)
    expect(posted(a)).not.toContain('### Cleanup')
    expect(posted(a)).not.toContain('Automated review not completed')
    expect(record!.content_filter!.map(f => f.stage)).toEqual(['lens_judge:slop'])
    expect(record!.lens_runs![0].judge!.status).toBe('refused')
    expect(record!.lens_runs![0].section).toBeUndefined()
  })

  it('moves a LOW maintainability finding that shares its lines into the section, leaving one copy', async () => {
    script({
      reviewer: reviewer([{ severity: 'LOW', title: 'Stale comment', file: 'src/pool.ts', lines: '2', body: 'Remove.', type: 'maintainability' }]),
      judge: judged(1),
    })
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    const comment = posted(a)
    expect(comment).toContain('No actionable findings.')
    expect(comment).toContain('- `src/pool.ts:2` · Restating comment')
    expect(record!.findings).toEqual({ high: 0, medium: 0, low: 0 })
    expect(record!.judge_decisions![0].routed_to_section).toBe('slop')
    expect(record!.section_findings![0].absorbed).toBe(true)
    expect(record!.lens_runs![0].section).toMatchObject({ absorbed_low: 1, covered_by_finding: 0 })
  })

  it('keeps a runtime-typed LOW in Findings and drops the section place on the same lines', async () => {
    script({
      reviewer: reviewer([{ severity: 'LOW', title: 'Off by one', file: 'src/pool.ts', lines: '2', body: 'Bug.', type: 'correctness' }]),
      judge: judged(1),
    })
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(posted(a)).toContain('**LOW – Off by one**')
    expect(posted(a)).not.toContain('Restating comment')
    expect(record!.findings).toEqual({ high: 0, medium: 0, low: 1 })
    expect(record!.lens_runs![0].section).toMatchObject({ covered_by_finding: 1, rows: 1 })
  })

  it('leaves the main judge request identical with and without a section lens', async () => {
    script({ reviewer: reviewer([{ severity: 'MEDIUM', title: 'Pool leaks', file: 'src/pool.ts', lines: '5', body: 'Leak.', type: 'reliability' }]), judge: judged(1) })
    await review(adapter(), '100', false, undefined, 'off', false, 'repo')
    const withSlop = completeStructured.mock.calls.filter(c => c[2]?.properties?.decisions?.items?.properties?.reason_category).map(c => [c[0], c[1]])
    completeStructured.mockReset()
    cfg.lenses.enabled = false
    script({ reviewer: reviewer([{ severity: 'MEDIUM', title: 'Pool leaks', file: 'src/pool.ts', lines: '5', body: 'Leak.', type: 'reliability' }]), judge: judged(1) })
    await review(adapter(), '100', false, undefined, 'off', false, 'repo')
    const without = completeStructured.mock.calls.filter(c => c[2]?.properties?.decisions?.items?.properties?.reason_category).map(c => [c[0], c[1]])
    expect(withSlop).toEqual(without)
  })

  it('puts slop in Findings with LENS_SECTIONS=none, where no section judge runs and the main judge decides', async () => {
    cfg.lenses.sections = 'none'
    script({ judge: judged(2, 'minor') })
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(sectionCalls()).toHaveLength(0)
    expect(posted(a)).not.toContain('### Cleanup')
    expect(record!.lens_runs![0].placement).toBeUndefined()
    expect(record!.lens_runs![0].findings).toBe(2)
    expect(record!.section_findings).toBeUndefined()
  })
})

describe('shown-context anchors', () => {
  it('never trip a slop lens, placed in Findings or in a section', async () => {
    cfg.judge.shownAnchors = true
    for (const sections of ['none', '']) {
      cfg.lenses.sections = sections
      script({ judge: judged(2, 'minor') })
      await expect(review(adapter(), '100', false, undefined, 'off', false, 'repo')).resolves.toBeTruthy()
    }
  })
})

describe('lenses on a re-review', () => {
  const previous = (): Partial<VCSAdapter> => ({
    getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '1', body: `### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.\n\n---\n*Reviewed by test-bot (claude-haiku-5-5) | Prompt: repo | Review #1 | Commit: aabbcc112233*`, createdOn: '2026-03-09T10:00:00Z', resolved: false }]),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),
  })

  beforeEach(() => { cfg.lenses.list = 'rel' })

  const REL = [{ severity: 'MEDIUM', title: 'Pool leaks a connection', file: 'src/pool.ts', lines: '5', body: 'Leak.', type: 'reliability' }]

  it('judges lens candidates alone when the reviewer found nothing, and posts them when kept', async () => {
    script({ rel: REL, judge: judged(1) })
    const a = adapter(previous())
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(posted(a)).toContain('**MEDIUM – Pool leaks a connection**')
    expect(record!.judge_status).toBe('succeeded')
    expect(record!.lens_runs![0].rereview).toEqual({ outside_delta: 0 })
    expect(record!.rereview_lens_judge).toBeUndefined()
  })

  it('falls back to the quiet re-review when the judge keeps none of them', async () => {
    script({ rel: REL, judge: judged(1, 'incorrect') })
    const a = adapter(previous())
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(a.postComment).not.toHaveBeenCalled()
    expect(record!.action).toBe('NO_NEW_FINDINGS')
    expect(record!.rereview_lens_judge).toMatchObject({ status: 'succeeded', kept: 0 })
    expect(completeStructured.mock.calls.filter(c => c[2]?.properties?.decisions?.items?.properties?.reason_category)).toHaveLength(1)
  })

  it('drops a lens candidate whose lines the delta did not add', async () => {
    const outside = [{ ...REL[0], lines: '3' }]
    const delta = DIFF.replace('+  count = 0\n', ' count = 0\n')
    script({ rel: outside, judge: judged(1) })
    const a = adapter({ ...previous(), getCommitDiff: vi.fn().mockResolvedValue(delta) })
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(record!.lens_runs![0].rereview).toEqual({ outside_delta: 1 })
    expect(a.postComment).not.toHaveBeenCalled()
  })

  it('skips lenses on a re-review when ENABLE_LENS_REREVIEW is off', async () => {
    cfg.lenses.everyReview = false
    script({ rel: REL, judge: judged(1) })
    const record = await review(adapter(previous()), '100', false, undefined, 'off', false, 'repo')
    expect(record!.lens_runs![0].status).toBe('skipped_rereview')
  })
})

describe('byte identity of what slop does not touch', () => {
  const REVIEWER = reviewer([{ severity: 'MEDIUM', title: 'Pool leaks', file: 'src/pool.ts', lines: '5', body: 'Leak.', type: 'reliability' }])
  const REL_FIND = [{ severity: 'MEDIUM', title: 'Race on put', file: 'src/pool.ts', lines: '6', body: 'Race.', type: 'reliability' }]

  const calls = (): unknown[][] => completeStructured.mock.calls.map(c => [c[0], c[1]])
  const sansSlop = (list: unknown[][]) => list.filter(c => !String(c[0]).includes('## SLOP LENS') && !String(c[0]).startsWith('You are a section judge'))

  async function run(list: string): Promise<{ comment: string; record: any; sent: unknown[][] }> {
    completeStructured.mockReset()
    cfg.lenses.list = list
    script({ reviewer: REVIEWER, rel: REL_FIND, slop: SLOP, judge: judged(2) })
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    return { comment: posted(a), record, sent: calls() }
  }

  it('sends the reviewer, the rel pass and the main judge the same requests whether or not slop is listed', async () => {
    cfg.lenses.sections = ''
    const only = await run('rel')
    const both = await run('rel,slop')
    const rel = (s: unknown[][]) => s.filter(c => String(c[0]).includes('## RELIABILITY LENS') || String(c[0]) === 'System prompt')
    expect(rel(both.sent)).toEqual(rel(only.sent))
    expect(sansSlop(both.sent).length).toBeGreaterThan(0)
    expect(both.sent.filter(c => String(c[0]).includes('## SLOP LENS')).length).toBe(1)
  })

  it('keeps the posted text identical up to the blocks, and the slop order does not move the rel pass', async () => {
    const only = await run('rel')
    const both = await run('rel,slop')
    const reversed = await run('slop,rel')
    expect(both.comment.startsWith(only.comment.slice(0, only.comment.indexOf('\n\n---\n*Reviewed by')))).toBe(true)
    expect(reversed.comment).toBe(both.comment)
    expect(reversed.record.lens_runs.map((r: any) => r.name)).toEqual(['reliability', 'slop'])
  })

  it('hands the benchmark sink the same outcome with and without slop', async () => {
    const outcome = async (list: string) => {
      completeStructured.mockReset()
      cfg.lenses.list = list
      script({ reviewer: REVIEWER, rel: REL_FIND, judge: judged(2) })
      let out: any
      await review(adapter(), '100', false, undefined, 'off', false, 'repo', o => { out = o })
      return out
    }
    const only = await outcome('rel')
    const both = await outcome('rel,slop')
    expect(both.lensFindings).toEqual(only.lensFindings)
    const strip = (o: any) => ({ ...o, lensFindings: undefined })
    expect(strip(both).judgedFindings).toEqual(strip(only).judgedFindings)
    expect(both.reviewText).toBe(only.reviewText)
  })
})

describe('placement, budget, halts and posting flags', () => {
  it('runs a section lens past a MAX_FINDINGS halt that skipped the findings lens', async () => {
    cfg.review.maxFindings = 1
    cfg.lenses.list = 'rel,slop'
    script({ reviewer: reviewer([{ severity: 'MEDIUM', title: 'Pool leaks', file: 'src/pool.ts', lines: '5', body: 'Leak.', type: 'reliability' }]), judge: judged(1) })
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(record!.lens_runs!.map(r => [r.name, r.status])).toEqual([['reliability', 'skipped_limit'], ['slop', 'succeeded']])
    expect(posted(a)).toContain('### Cleanup')
    expect(record!.lens_runs![1].section).toMatchObject({ kept: 2 })
  })

  it('places a recall lens in a section with LENS_SECTIONS=rel and keeps it out of Findings and the verdict', async () => {
    cfg.lenses.list = 'rel'
    cfg.lenses.sections = 'rel'
    script({ rel: [{ severity: 'MEDIUM', title: 'Pool leaks a connection', file: 'src/pool.ts', lines: '5', body: 'The put never releases.', type: 'reliability' }] })
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(posted(a)).toContain('### Reliability\nFindings from the reliability pass; not counted in the verdict.\n\n- `src/pool.ts:5` · MEDIUM · Pool leaks a connection\n  The put never releases.')
    expect(posted(a)).not.toContain('**MEDIUM')
    expect(sectionCalls()[0][0]).toContain('A focused review pass (reliability) flagged places')
    expect(record!.judge_status).toBe('skipped_no_findings')
    expect(record!.findings).toEqual({ high: 0, medium: 0, low: 0 })
    expect(record!.lens_runs![0]).toMatchObject({ name: 'reliability', placement: 'section', findings: 0, section: { kept: 1, rows: 1, posted: 1 } })
  })

  it('skips the section judge over budget: no section, no block, one skipped_budget log', async () => {
    cfg.anthropic.maxInputTokens = 6000
    vi.mocked(loadPrompt).mockResolvedValueOnce(rememberExceptions({ content: 'System prompt', source: 'repo' } as never, 'No repo exceptions. '.repeat(2000)))
    script({})
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(sectionCalls()).toHaveLength(0)
    expect(record!.lens_runs![0]).toMatchObject({ status: 'succeeded', judge: { status: 'skipped_budget', tokens: null } })
    expect(record!.lens_runs![0].section).toBeUndefined()
    expect(record!.section_findings).toBeNull()
    expect(posted(a)).not.toContain('### Cleanup')
  })

  it('reports no row as posted on a dry run', async () => {
    script({})
    const a = adapter()
    const record = await review(a, '100', true, undefined, 'off', false, 'repo')
    expect(a.postComment).not.toHaveBeenCalled()
    expect(record!.lens_runs![0].section).toMatchObject({ rows: 2, posted: 0 })
    expect(record!.section_findings!.map(r => r.posted)).toEqual([false, false])
  })

  it('reports no row as posted when the post is skipped as a duplicate', async () => {
    script({})
    const dup = { id: '9', body: `x\n*Reviewed by test-bot (claude-haiku-5-5) | Prompt: repo | Review #1 | Commit: ${HEAD}*`, createdOn: '2026-03-09T10:00:00Z', resolved: false }
    const a = adapter({ getPreviousReviewComments: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([dup]) })
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(a.postComment).not.toHaveBeenCalled()
    expect(record!.lens_runs![0].section!.posted).toBe(0)
    expect(record!.section_findings!.map(r => r.posted)).toEqual([false, false])
  })
})

describe('slop with ENABLE_PROMPT_CACHE', () => {
  beforeEach(() => { cfg.review.promptCache = true })

  const sharedReview = { summary: 'Adds a pool.', behavioral_diff: [], production_risk: [], unresolved_questions: [] }

  function scriptCached(): void {
    completeStructured.mockImplementation(async (_system: string, user: unknown, schema: any, opts: any) => {
      const props = schema?.properties ?? {}
      if (props.decisions?.items?.properties?.verdict) return { object: verdicts(['validated', 'validated']), usage }
      if (props.decisions) return { object: judged(1), usage }
      if (opts?.systemAfter?.includes('## SLOP LENS')) return { object: { ...sharedReview, findings: SLOP }, usage: { ...usage, cache_read_input_tokens: 80 } }
      return { object: reviewer(), usage: Array.isArray(user) ? { ...usage, cache_creation_input_tokens: 80 } : usage }
    })
  }

  it('runs the section lens as a cached pass and sends its section judge uncached', async () => {
    scriptCached()
    const a = adapter()
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    const slop = completeStructured.mock.calls.filter(c => c[3]?.systemAfter?.includes('## SLOP LENS'))
    expect(slop).toHaveLength(1)
    expect(Array.isArray(slop[0][1])).toBe(true)
    expect(record!.prompt_cache).toMatchObject({ reviewer_marked: true, shared_stages: ['lens:slop'] })
    expect(sectionCalls()).toHaveLength(1)
    expect(Array.isArray(sectionCalls()[0][1])).toBe(false)
    expect(posted(a)).toContain('- `src/pool.ts:2` · Restating comment')
    expect(record!.lens_runs![0]).toMatchObject({ tokens: { cache_read: 80 }, section: { kept: 2, posted: 2 } })
    expect(record!.pass_calls!.map(c => [c.stage, c.end])).toContainEqual(['lens:slop', 'ok'])
  })

  it('keeps the unrewritten overlay for slop in Findings with shown anchors on', async () => {
    cfg.lenses.sections = 'none'
    cfg.judge.shownAnchors = true
    scriptCached()
    const record = await review(adapter(), '100', false, undefined, 'off', false, 'repo')
    const slop = completeStructured.mock.calls.filter(c => c[3]?.systemAfter?.includes('## SLOP LENS'))
    expect(slop).toHaveLength(1)
    expect(slop[0][3].systemAfter).toBe(lensOverlay(LENS_REGISTRY.slop, LENS_REGISTRY.slop.cap ?? 0, false))
    expect(sectionCalls()).toHaveLength(0)
    expect(record!.prompt_cache).toMatchObject({ reviewer_marked: true, shared_stages: ['lens:slop'] })
    expect(record!.lens_runs![0].placement).toBeUndefined()
  })
})

describe('a lens-only re-review judge on the legacy flow', () => {
  const previous = (): Partial<VCSAdapter> => ({
    getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '1', body: `### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.\n\n---\n*Reviewed by test-bot (claude-haiku-5-5) | Prompt: repo | Review #1 | Commit: aabbcc112233*`, createdOn: '2026-03-09T10:00:00Z', resolved: false }]),
    getCommitDiff: vi.fn().mockResolvedValue(DIFF),
  })
  const REL = { severity: 'MEDIUM', title: 'Pool leaks a connection', file: 'src/pool.ts', lines: '5', body: 'Leak.', type: 'reliability' }
  const mainJudgeCalls = () => completeStructured.mock.calls.filter(c => c[2]?.properties?.decisions?.items?.properties?.reason_category)

  beforeEach(() => { cfg.lenses.list = 'rel' })

  it('is refused without a retry or a notice, and the quiet re-review stands', async () => {
    script({ rel: [REL], judge: new ContentFilterError({ signal: 'refusal' } as never) })
    const a = adapter(previous())
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(mainJudgeCalls()).toHaveLength(1)
    expect(a.postComment).not.toHaveBeenCalled()
    expect(record!.action).toBe('NO_NEW_FINDINGS')
    expect(record!.rereview_lens_judge).toMatchObject({ status: 'refused', kept: 0 })
    expect(record!.content_filter!.map(f => f.stage)).toEqual(['judge'])
  })

  it('failing leaves the quiet re-review and no content-filter record', async () => {
    script({ rel: [REL], judge: new Error('boom') })
    const a = adapter(previous())
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(a.postComment).not.toHaveBeenCalled()
    expect(record!.rereview_lens_judge).toMatchObject({ status: 'failed', kept: 0 })
    expect(record!.content_filter ?? []).toHaveLength(0)
  })

  it('does not retry a stub output on the legacy flow', async () => {
    script({ rel: [REL], judge: { ...judged(1), summary: 'x' } })
    const a = adapter(previous())
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(mainJudgeCalls()).toHaveLength(1)
    expect(posted(a)).toContain('**MEDIUM – Pool leaks a connection**')
    expect(record!.judge_sanity).toBeUndefined()
  })

  it('flags the section place absorbed when every kept finding moved into a section', async () => {
    cfg.lenses.list = 'rel,slop'
    script({ rel: [{ severity: 'LOW', title: 'Stale comment', file: 'src/pool.ts', lines: '2', body: 'Remove.', type: 'maintainability' }], judge: judged(1) })
    const a = adapter(previous())
    const record = await review(a, '100', false, undefined, 'off', false, 'repo')
    expect(a.postComment).not.toHaveBeenCalled()
    expect(record!.rereview_lens_judge).toMatchObject({ status: 'succeeded', kept: 0 })
    expect(record!.rereview_lens_judge!.decisions[0].routed_to_section).toBe('slop')
    expect(record!.section_findings!.find(r => r.anchor === 'src/pool.ts:2')!.absorbed).toBe(true)
    expect(record!.lens_runs!.find(r => r.name === 'slop')!.section).toMatchObject({ absorbed_low: 1, posted: 0 })
  })

  describe('delta gate', () => {
    const OUTSIDE = { ...REL, lines: '3' }
    const DELTA_ONE = DIFF.replace('+  count = 0\n', ' count = 0\n')
    const BIG = ['diff --git a/src/big.ts b/src/big.ts', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/src/big.ts', '@@ -0,0 +1,60 @@', ...Array.from({ length: 60 }, (_, i) => `+export const big_${i} = ${i}`), ''].join('\n')

    it('keeps every candidate when the merged-target delta is dropped to an empty one', async () => {
      script({ rel: [OUTSIDE], judge: judged(1) })
      const a = adapter({ ...previous(), getCommitDiff: vi.fn().mockResolvedValue(DIFF + BIG) })
      const record = await review(a, '100', false, undefined, 'off', false, 'repo')
      expect(record!.lens_runs![0].rereview).toEqual({ outside_delta: 0 })
      expect(posted(a)).toContain('**MEDIUM – Pool leaks a connection**')
    })

    it('keeps every candidate when the delta could not be fetched', async () => {
      script({ rel: [OUTSIDE], judge: judged(1) })
      const a = adapter({ ...previous(), getCommitDiff: vi.fn().mockRejectedValue(new Error('404')) })
      const record = await review(a, '100', false, undefined, 'off', false, 'repo')
      expect(record!.lens_runs![0].rereview).toEqual({ outside_delta: 0 })
      expect(posted(a)).toContain('**MEDIUM – Pool leaks a connection**')
    })

    it('lets a candidate with no numeric lines through a non-empty delta', async () => {
      script({ rel: [{ ...REL, lines: '' }, OUTSIDE], judge: judged(1) })
      const a = adapter({ ...previous(), getCommitDiff: vi.fn().mockResolvedValue(DELTA_ONE) })
      const record = await review(a, '100', false, undefined, 'off', false, 'repo')
      expect(record!.lens_runs![0].rereview).toEqual({ outside_delta: 1 })
      expect(record!.lens_runs![0].findings).toBe(1)
    })
  })
})
