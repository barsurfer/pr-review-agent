import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VCSAdapter, PRInfo } from '../../vcs/adapter.js'
import type { ReviewOutcome } from '../types.js'

// The real FSM and client with only the provider mocked, so every assertion is on what a model call would actually receive.

vi.mock('../../config.js', () => ({
  config: {
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', maxRetries: 1, maxInputTokens: 150000, maxTokens: 32000 },
    judge: { model: 'claude-sonnet-5', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: true, model: '', effort: '', minFiles: 1, minUntouched: 0, benchmarkDeadlineSeconds: 840 },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3 },
    review: { maxFindings: 0, splitCheck: false, todoScan: false, effort: '', enableNitpicks: false, secondLook: true, lineNumbers: false },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [], skipTargetBranches: [], onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: ['*.lock'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
  modelContextWindow: vi.fn(() => 200_000),
}))

const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn(async () => ({ content: 'SYS', source: 'repo' })) }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn(async () => []) }))
vi.mock('../usage.js', async (importOriginal) => ({ ...(await importOriginal() as object), logUsageRecord: vi.fn() }))
vi.mock('../client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client.js')>()
  return { ...actual, runBreadth: vi.fn(actual.runBreadth), runLens: vi.fn(actual.runLens) }
})

import { review } from '../index.js'
import { config } from '../../config.js'
import { REVIEW_OUTPUT_SCHEMA, BREADTH_OUTPUT_SCHEMA, JUDGE_OUTPUT_SCHEMA, findingsOutputSchema, runBreadth, runLens } from '../client.js'
import { IMPACT_ITEM } from '../breadth.js'
import type { ReviewObject, ReviewFinding } from '../formatter.js'

const cfg = config as any
const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts', '--- a/src/pool.ts', '+++ b/src/pool.ts', '@@ -1,1 +1,3 @@',
  ' export class Pool {', '+  get() { return this.conns.pop() }', '+  put(c) { this.conns.push(c) }',
  'diff --git a/src/cache.ts b/src/cache.ts', '--- a/src/cache.ts', '+++ b/src/cache.ts', '@@ -1,1 +1,2 @@',
  ' export const cache = new Map()', '+export function take(k) { return cache.get(k) }', '',
].join('\n')

const REVIEW: ReviewObject = {
  summary: 'Adds a pool.', behavioral_diff: [], production_risk: [], unresolved_questions: [],
  findings: [{ severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put race.' }],
}

const PASS: Record<string, ReviewFinding> = {
  breadth: { severity: 'MEDIUM', title: 'Cache never evicts', file: 'src/cache.ts', lines: '2', body: 'Unbounded.' },
  second_look: { severity: 'HIGH', title: 'Double put', file: 'src/pool.ts', lines: '3', body: 'A retried put pushes twice.' },
  impact: { severity: 'HIGH', title: 'take before load', file: 'src/cache.ts', lines: '2', body: 'Old cache data is unread.' },
  reliability: { severity: 'LOW', title: 'pop on empty', file: 'src/pool.ts', lines: '2', body: 'Returns undefined.' },
}

const passOf = (system: string): string =>
  system.includes('## SECOND LOOK') ? 'second_look' : system.includes('## BREADTH LENS') ? 'breadth' : (system.match(/## (\w+) LENS/)?.[1] ?? '').toLowerCase()

// Answers like a strict-schema model: an optional field comes back only when the schema asks for it.
function respond(): void {
  completeStructured.mockImplementation(async (system: string, user: string, schema: any) => {
    if (schema === REVIEW_OUTPUT_SCHEMA) return { object: REVIEW, usage }
    if (schema.properties.decisions) {
      const ids = [...user.matchAll(/\[(c\d+)\]/g)].map(m => m[1])
      return { object: { decisions: ids.map(id => ({ candidate_id: id, reason_category: 'validated', evidence: 'src/pool.ts:2', note: 'ok', score: 8 })), summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 }, usage }
    }
    const item = schema.properties.findings.items.properties
    const f = PASS[passOf(system)]
    return { object: { findings: [{ ...f, ...(item.also_affects ? { also_affects: [{ file: 'src/cache.ts', lines: '2', where: 'take' }] } : {}), ...(item.scenario ? { scenario: 'repeat' } : {}) }] }, usage }
  })
}

const makeAdapter = (): VCSAdapter => ({
  getPullRequestInfo: vi.fn().mockResolvedValue({ id: '100', title: 'Pool', description: 'd', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'aaa111222333' } as PRInfo),
  getDiff: vi.fn().mockResolvedValue(DIFF),
  getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/pool.ts', status: 'modified' }, { path: 'src/cache.ts', status: 'modified' }]),
  getFileContent: vi.fn().mockResolvedValue(''),
  getRepoFileContent: vi.fn().mockResolvedValue(null),
  postComment: vi.fn().mockResolvedValue(undefined),
  getPreviousReviewComments: vi.fn().mockResolvedValue([]),
  getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
  postReply: vi.fn().mockResolvedValue(undefined),
  getCommitDiff: vi.fn().mockResolvedValue(''),
})

const callOf = (pass: string) => completeStructured.mock.calls.find(c => c[2] !== REVIEW_OUTPUT_SCHEMA && !c[2].properties.decisions && passOf(c[0]) === pass)
const judgeCall = () => completeStructured.mock.calls.find(c => c[2].properties?.decisions)!
const lensOrder = () => completeStructured.mock.calls.map(c => passOf(c[0])).filter(p => p && p !== 'breadth' && p !== 'second_look')

async function run(opts: { hi: boolean; lenses?: string; sink?: boolean }) {
  completeStructured.mockReset()
  vi.mocked(runBreadth).mockClear()
  vi.mocked(runLens).mockClear()
  respond()
  cfg.review.highImpact = opts.hi
  cfg.lenses = { enabled: !!opts.lenses, list: opts.lenses ?? '', model: '', recommend: false }
  const adapter = makeAdapter()
  const outcomes: ReviewOutcome[] = []
  const record = await review(adapter, '100', false, undefined, 'off', false, 'repo', opts.sink ? o => { outcomes.push(o) } : undefined)
  return { record: record!, calls: completeStructured.mock.calls.map(c => [...c]), posted: vi.mocked(adapter.postComment).mock.calls, outcome: outcomes[0] }
}

let logSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}) })
afterEach(() => {
  logSpy.mockRestore()
  vi.useRealTimers()
  cfg.review.highImpact = undefined
  cfg.lenses = { enabled: false, list: '', model: '', recommend: false }
})

describe('production (no sink) with ENABLE_HIGH_IMPACT', () => {
  it('the first-pass reviewer call is byte-identical with the flag on', async () => {
    const off = await run({ hi: false })
    const on = await run({ hi: true })

    expect(on.calls[0][2]).toBe(REVIEW_OUTPUT_SCHEMA)
    expect(JSON.stringify(on.calls[0])).toBe(JSON.stringify(off.calls[0]))
  })

  it('breadth keeps the constant schema; second-look gets item 4 and a scenario-only schema; the judge call and the posted review are unchanged', async () => {
    const off = await run({ hi: false })
    const offCalls = { breadth: callOf('breadth')!, sl: callOf('second_look')!, judge: judgeCall() }
    const on = await run({ hi: true })

    expect(callOf('breadth')![2]).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(JSON.stringify(callOf('breadth'))).toBe(JSON.stringify(offCalls.breadth))
    expect(offCalls.sl[2]).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(offCalls.sl[0]).not.toContain(IMPACT_ITEM)
    expect(callOf('second_look')![2]).toBe(findingsOutputSchema({ scenario: true }))
    expect(callOf('second_look')![0]).toContain(IMPACT_ITEM)
    expect(judgeCall()[2]).toBe(JUDGE_OUTPUT_SCHEMA)
    expect(JSON.stringify(judgeCall())).toBe(JSON.stringify(offCalls.judge))
    expect(on.posted).toEqual(off.posted)
    expect(on.posted[0][1]).not.toMatch(/also_affects|scenario|Same defect here/)
  })

  it('runs no lens when none is listed, and records the lever and scenario tags without also-affects keys', async () => {
    const on = await run({ hi: true })

    expect(lensOrder()).toEqual([])
    expect('lens_runs' in on.record).toBe(false)
    expect(on.record.recall_levers.high_impact).toBe(true)
    expect(on.record.review_candidates!.map(c => [c.origin, c.scenario])).toEqual([['review', null], ['breadth', null], ['second_look', 'repeat']])
    expect(JSON.stringify(on.record)).not.toMatch(/also_affects/)
  })

  it('flag off: the record has no scenario, also-affects or high_impact keys', async () => {
    const off = await run({ hi: false })
    expect(JSON.stringify(off.record)).not.toMatch(/scenario|also_affects|high_impact/)
  })
})

describe('the impact lens runs only where listed, in list order', () => {
  it('LENSES=imp+rel runs impact then reliability as lens:impact and lens:reliability, both on the constant schema with the flag off', async () => {
    const off = await run({ hi: false, lenses: 'imp+rel' })

    expect(lensOrder()).toEqual(['impact', 'reliability'])
    expect([callOf('impact')![2], callOf('reliability')![2]]).toEqual([BREADTH_OUTPUT_SCHEMA, BREADTH_OUTPUT_SCHEMA])
    expect(off.record.lens_runs!.map(r => [r.name, r.status])).toEqual([['impact', 'succeeded'], ['reliability', 'succeeded']])
    expect(off.record.review_candidates!.map(c => c.origin)).toEqual(['review', 'breadth', 'second_look', 'lens:impact', 'lens:reliability'])
  })

  it('LENSES=rel+imp reverses the order', async () => {
    await run({ hi: false, lenses: 'rel+imp' })
    expect(lensOrder()).toEqual(['reliability', 'impact'])
  })

  it('with the flag on in production only the impact lens adds the scenario tag; reliability keeps the constant schema', async () => {
    const off = await run({ hi: false, lenses: 'imp+rel' })
    const offRel = callOf('reliability')!
    const on = await run({ hi: true, lenses: 'imp+rel' })

    expect(callOf('impact')![2]).toBe(findingsOutputSchema({ scenario: true }))
    expect(callOf('reliability')![2]).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(callOf('reliability')![0]).toBe(offRel[0])
    expect(on.record.review_candidates!.map(c => [c.origin, c.scenario])).toEqual([['review', null], ['breadth', null], ['second_look', 'repeat'], ['lens:impact', 'repeat'], ['lens:reliability', null]])
    expect(off.record.lens_runs!.map(r => r.name)).toEqual(on.record.lens_runs!.map(r => r.name))
  })
})

describe('benchmark mode (outcome sink) with ENABLE_HIGH_IMPACT', () => {
  it('only the extra passes ask for also_affects; the reviewer and judge calls match the flag-off run', async () => {
    const off = await run({ hi: false, lenses: 'imp+rel', sink: true })
    const offJudge = judgeCall()
    const on = await run({ hi: true, lenses: 'imp+rel', sink: true })

    expect(on.calls[0][2]).toBe(REVIEW_OUTPUT_SCHEMA)
    expect(JSON.stringify(on.calls[0])).toBe(JSON.stringify(off.calls[0]))
    expect(callOf('breadth')![2]).toBe(findingsOutputSchema({ alsoAffects: true }))
    expect(callOf('second_look')![2]).toBe(findingsOutputSchema({ alsoAffects: true, scenario: true }))
    expect(callOf('impact')![2]).toBe(findingsOutputSchema({ alsoAffects: true, scenario: true }))
    expect(callOf('reliability')![2]).toBe(findingsOutputSchema({ alsoAffects: true }))
    expect(JSON.stringify(judgeCall())).toBe(JSON.stringify(offJudge))
  })

  it('kept findings carry alsoAffects only with the flag; the reviewer finding never has one', async () => {
    const off = await run({ hi: false, sink: true })
    const on = await run({ hi: true, sink: true })

    expect(off.outcome.judgedFindings!.some(k => 'alsoAffects' in k)).toBe(false)
    expect(on.outcome.judgedFindings!.map(k => [k.title, k.alsoAffects ?? null])).toEqual([
      ['Race on conns', null],
      ['Cache never evicts', [{ file: 'src/cache.ts', lines: '2', where: 'take' }]],
      ['Double put', [{ file: 'src/cache.ts', lines: '2', where: 'take' }]],
    ])
    expect(on.record.review_candidates!.map(c => c.also_affects)).toEqual([[], [{ file: 'src/cache.ts', lines: '2', where: 'take' }], [{ file: 'src/cache.ts', lines: '2', where: 'take' }]])
  })

  it('time guard: impact listed first runs and the second lens is the one skipped once half the deadline has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    completeStructured.mockReset()
    respond()
    const answer = completeStructured.getMockImplementation()!
    completeStructured.mockImplementation(async (system: string, user: string, schema: unknown) => {
      if (passOf(system) === 'impact') vi.advanceTimersByTime((cfg.breadth.benchmarkDeadlineSeconds / 2 + 1) * 1000)
      return answer(system, user, schema)
    })
    cfg.review.highImpact = true
    cfg.lenses = { enabled: true, list: 'imp+rel', model: '', recommend: false }

    const record = await review(makeAdapter(), '100', false, undefined, 'off', false, 'repo', () => {})

    expect(lensOrder()).toEqual(['impact'])
    expect(record!.lens_runs!.map(r => [r.name, r.status])).toEqual([['impact', 'succeeded'], ['reliability', 'skipped_time']])
  })
})

describe('extra-pass call arguments', () => {
  const counts = () => ({
    breadth: vi.mocked(runBreadth).mock.calls.filter(c => c[11] !== 'second-look').map(c => c.length),
    secondLook: vi.mocked(runBreadth).mock.calls.filter(c => c[11] === 'second-look').map(c => c.length),
    lens: vi.mocked(runLens).mock.calls.map(c => c.length),
  })

  it.each([false, true])('flag off (sink %s): breadth gets 11 arguments, second-look 12 and each lens 12, as before the flag existed', async sink => {
    await run({ hi: false, lenses: 'rel', sink })
    expect(counts()).toEqual({ breadth: [11], secondLook: [12], lens: [12] })
  })

  it('flag on: the schema is one trailing argument only where a variant is requested', async () => {
    await run({ hi: true, lenses: 'imp+rel' })
    expect(counts()).toEqual({ breadth: [11], secondLook: [13], lens: [13, 12] })
    await run({ hi: true, lenses: 'imp+rel', sink: true })
    expect(counts()).toEqual({ breadth: [13], secondLook: [13], lens: [13, 13] })
  })
})
