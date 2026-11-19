import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VCSAdapter, PRInfo } from '../../vcs/adapter.js'

// ENABLE_BENCHMARK_PASS_DEADLINE through the real FSM and client; only the provider is mocked, and it honours the signal as both real providers do.

vi.mock('../../config.js', () => ({
  config: {
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-5-5', maxRetries: 1, maxInputTokens: 250000, maxTokens: 64000, extraPassMaxTokens: 0 },
    judge: { model: 'claude-haiku-5-5', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: true, model: '', effort: '', minFiles: 1, minUntouched: 0, benchmarkDeadlineSeconds: 840, judgeReserveSeconds: 270, passDeadline: true },
    lenses: { enabled: true, list: 'imp+rel', model: '', recommend: false },
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
  modelContextWindow: vi.fn(() => 1_000_000),
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
import { REVIEW_OUTPUT_SCHEMA, runBreadth, runLens } from '../client.js'
import { DeadlineAbortError, TruncatedResponseError } from '../../llm/shared.js'
import { fetchContext } from '../../context/fetcher.js'
import type { ReviewObject } from '../formatter.js'

const cfg = config as any
const BASELINE = structuredClone(cfg)
const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, reasoning_tokens: 30 }

const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts', '--- a/src/pool.ts', '+++ b/src/pool.ts', '@@ -1,1 +1,3 @@',
  ' export class Pool {', '+  get() { return this.conns.pop() }', '+  put(c) { this.conns.push(c) }', '',
].join('\n')
const REVIEW: ReviewObject = {
  summary: 'Adds a pool.', behavioral_diff: [], production_risk: [], unresolved_questions: [],
  findings: [{ severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put race.' }],
}

const passOf = (system: string): string =>
  system.includes('## SECOND LOOK') ? 'second_look' : system.includes('## BREADTH LENS') ? 'breadth' : (system.match(/## (\w+) LENS/)?.[1] ?? '').toLowerCase()

// `hang` passes never answer; they end only when their signal aborts, as a stream cut by the SDK would.
function respond(opts: { hang?: string[]; onReview?: () => void } = {}) {
  completeStructured.mockImplementation((system: string, user: string, schema: any, callOpts: { signal?: AbortSignal }) => {
    if (schema === REVIEW_OUTPUT_SCHEMA) { opts.onReview?.(); return Promise.resolve({ object: REVIEW, usage }) }
    if (schema.properties.decisions) {
      const ids = [...user.matchAll(/\[(c\d+)\]/g)].map(m => m[1])
      return Promise.resolve({ object: { decisions: ids.map(id => ({ candidate_id: id, reason_category: 'validated', evidence: 'src/pool.ts:2', note: 'ok', score: 8 })), summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 }, usage })
    }
    const pass = passOf(system)
    if (opts.hang?.includes(pass)) {
      return new Promise((_, reject) => callOpts.signal?.addEventListener('abort', () => reject(new DeadlineAbortError('aborted', { input_tokens: 9, output_tokens: 0 }))))
    }
    return Promise.resolve({ object: { findings: [{ severity: 'LOW', title: `${pass} finding`, file: 'src/pool.ts', lines: '2', body: 'b' }] }, usage })
  })
}

const makeAdapter = (): VCSAdapter => ({
  getPullRequestInfo: vi.fn().mockResolvedValue({ id: '100', title: 'Pool', description: 'd', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'aaa111222333' } as PRInfo),
  getDiff: vi.fn().mockResolvedValue(DIFF),
  getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/pool.ts', status: 'modified' }]),
  getFileContent: vi.fn().mockResolvedValue(''),
  getRepoFileContent: vi.fn().mockResolvedValue(null),
  postComment: vi.fn().mockResolvedValue(undefined),
  getPreviousReviewComments: vi.fn().mockResolvedValue([]),
  getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
  postReply: vi.fn().mockResolvedValue(undefined),
  getCommitDiff: vi.fn().mockResolvedValue(''),
})

const optsOf = (pass: string) => completeStructured.mock.calls.filter(c => (c[2] === REVIEW_OUTPUT_SCHEMA ? 'review' : c[2].properties.decisions ? 'judge' : passOf(c[0])) === pass).map(c => c[3])
const calledPasses = () => completeStructured.mock.calls.map(c => (c[2] === REVIEW_OUTPUT_SCHEMA ? 'review' : c[2].properties.decisions ? 'judge' : passOf(c[0])))

async function run(sink = true, until?: number) {
  const pending = review(makeAdapter(), '100', false, undefined, 'off', false, 'repo', sink ? () => {} : undefined)
  if (until !== undefined) await vi.advanceTimersByTimeAsync(until)
  return (await pending)!
}

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(cfg, structuredClone(BASELINE))
  completeStructured.mockReset()
  vi.mocked(runBreadth).mockClear()
  vi.mocked(runLens).mockClear()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  logSpy.mockRestore()
  warnSpy.mockRestore()
})

describe('pass deadline (benchmark only)', () => {
  it('gives each extra pass an AbortSignal and an integer limit; the reviewer and judge get none', async () => {
    cfg.breadth.benchmarkDeadlineSeconds = 840.0004
    respond({ onReview: () => vi.advanceTimersByTime(100_123) })
    const record = await run()

    for (const pass of ['breadth', 'second_look', 'impact', 'reliability']) expect(optsOf(pass)[0].signal).toBeInstanceOf(AbortSignal)
    for (const pass of ['review', 'judge']) expect('signal' in optsOf(pass)[0]).toBe(false)
    expect(record.pass_calls!.map(c => [c.stage, c.end, c.limit_ms, c.output_tokens, c.reasoning_tokens])).toEqual([
      ['review', 'ok', null, 50, 30], ['breadth', 'ok', 469_877, 50, 30], ['second_look', 'ok', 469_877, 50, 30],
      ['lens:impact', 'ok', 469_877, 50, 30], ['lens:reliability', 'ok', 469_877, 50, 30], ['judge', 'ok', null, 50, 30],
    ])
    expect(record.pass_calls!.every(c => c.limit_ms === null || Number.isInteger(c.limit_ms))).toBe(true)
  })

  it('an abort mid-call is logged as aborted_time, later passes skip on time, and the judge still runs', async () => {
    respond({ hang: ['breadth'] })
    const record = await run(true, 570_000)

    expect(record.breadth_status).toBe('aborted_time')
    expect(record.second_look_status).toBe('skipped_time')
    expect(record.lens_runs!.map(r => r.status)).toEqual(['skipped_time', 'skipped_time'])
    expect(record.judge_status).toBe('succeeded')
    expect(record.pass_calls!.find((c: { stage: string }) => c.stage === 'breadth')).toEqual({ stage: 'breadth', end: 'aborted_time', max_tokens: 64000, output_tokens: null, reasoning_tokens: null, limit_ms: 570_000 })
    expect(record.breadth_tokens).toEqual({ input: 9, output: 0 })
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('  Breadth review stopped at the 570s pass deadline (570s elapsed) — continuing with first-pass findings only')
    expect(calledPasses()).toEqual(['review', 'breadth', 'judge'])
  })

  it('an aborted lens halts the lenses after it', async () => {
    respond({ hang: ['impact'] })
    const record = await run(true, 570_000)

    expect(record.lens_runs!.map(r => [r.name, r.status])).toEqual([['impact', 'aborted_time'], ['reliability', 'skipped_time']])
    expect(record.judge_status).toBe('succeeded')
  })

  it('skips a pass with no time left before building a signal or calling the provider', async () => {
    cfg.breadth.benchmarkDeadlineSeconds = 400
    respond({ onReview: () => vi.advanceTimersByTime(150_000) })
    const record = await run()

    expect([record.breadth_status, record.second_look_status, record.lens_runs!.map(r => r.status)]).toEqual(['skipped_time', 'skipped_time', ['skipped_time', 'skipped_time']])
    expect(calledPasses()).toEqual(['review', 'judge'])
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('  Breadth review skipped: no time left before the 130s pass deadline')
  })

  it('a deadline below the judge reserve skips every extra pass at once', async () => {
    cfg.breadth.benchmarkDeadlineSeconds = 200
    respond()
    const record = await run()

    expect([record.breadth_status, record.second_look_status]).toEqual(['skipped_time', 'skipped_time'])
    expect(calledPasses()).toEqual(['review', 'judge'])
    expect(record.judge_status).toBe('succeeded')
  })

  it('outside --benchmark the setting does nothing: no signal, no extra argument, no pass_calls', async () => {
    respond()
    const record = await run(false)

    expect(completeStructured.mock.calls.every(c => !('signal' in c[3]))).toBe(true)
    expect(vi.mocked(runBreadth).mock.calls.map(c => c.length)).toEqual([11, 12])
    expect(vi.mocked(runLens).mock.calls.map(c => c.length)).toEqual([12, 12])
    expect('pass_calls' in record).toBe(false)
  })

  it('setting off under --benchmark: the old argument lists and no pass_calls', async () => {
    cfg.breadth.passDeadline = false
    respond()
    const record = await run()

    expect(completeStructured.mock.calls.every(c => !('signal' in c[3]))).toBe(true)
    expect(vi.mocked(runBreadth).mock.calls.map(c => c.length)).toEqual([11, 12])
    expect('pass_calls' in record).toBe(false)
  })
})

describe('pass_calls records failed attempts once each', () => {
  const loggedRecord = () => {
    const line = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).find((l: string) => l.startsWith('\n=== Usage ==='))!
    return JSON.parse(line.slice(line.indexOf('{')))
  }

  it('a truncated first-pass call appears with its end state and output, then the run errors', async () => {
    respond()
    const answer = completeStructured.getMockImplementation()!
    completeStructured.mockImplementationOnce(async () => { throw new TruncatedResponseError('cut', { input_tokens: 10, output_tokens: 64000, reasoning_tokens: 63000 }) })
    completeStructured.mockImplementation(answer)

    await expect(run()).rejects.toThrow('cut')
    expect(loggedRecord().pass_calls).toEqual([{ stage: 'review', end: 'truncated', max_tokens: 64000, output_tokens: 64000, reasoning_tokens: 63000, limit_ms: null }])
  })

  it('a context-rejected attempt is logged before the diff-only retry, with no double entries', async () => {
    vi.mocked(fetchContext).mockResolvedValueOnce([{ path: 'src/pool.ts', content: 'export class Pool {}' }] as never)
    respond()
    const answer = completeStructured.getMockImplementation()!
    completeStructured.mockImplementationOnce(async () => { throw Object.assign(new Error('prompt is too long: 300000 tokens'), { status: 400 }) })
    completeStructured.mockImplementation(answer)
    const record = await run()

    expect(record.pass_calls!.map((c: { stage: string; end: string }) => `${c.stage}:${c.end}`)).toEqual([
      'review:error', 'review:ok', 'breadth:ok', 'second_look:ok', 'lens:impact:ok', 'lens:reliability:ok', 'judge:ok',
    ])
  })

  it('a failed extra pass and a failed judge are each recorded once', async () => {
    respond()
    const answer = completeStructured.getMockImplementation()!
    completeStructured.mockImplementation(async (system: string, user: string, schema: any, opts: unknown) => {
      if (passOf(system) === 'second_look') throw new Error('terminated')
      if (schema.properties?.decisions) throw new TruncatedResponseError('judge cut', { input_tokens: 5, output_tokens: 64000 })
      return answer(system, user, schema, opts)
    })
    const record = await run()

    expect(record.pass_calls!.map((c: { stage: string; end: string }) => `${c.stage}:${c.end}`)).toEqual([
      'review:ok', 'breadth:ok', 'second_look:error', 'lens:impact:ok', 'lens:reliability:ok', 'judge:truncated',
    ])
    expect(record.second_look_status).toBe('failed')
  })
})

describe('EXTRA_PASS_MAX_OUTPUT_TOKENS', () => {
  it('raises only the extra-pass cap; the reviewer and judge keep MAX_OUTPUT_TOKENS', async () => {
    cfg.anthropic.extraPassMaxTokens = 128000
    respond()
    const record = await run()

    expect(['review', 'judge'].map(p => optsOf(p)[0].maxTokens)).toEqual([64000, 64000])
    expect(['breadth', 'second_look', 'impact', 'reliability'].map(p => optsOf(p)[0].maxTokens)).toEqual([128000, 128000, 128000, 128000])
    expect(record.pass_calls!.map((c: { max_tokens: number }) => c.max_tokens)).toEqual([64000, 128000, 128000, 128000, 128000, 64000])
  })

  it('unset, every call keeps MAX_OUTPUT_TOKENS', async () => {
    respond()
    await run()
    expect(completeStructured.mock.calls.map(c => c[3].maxTokens)).toEqual([64000, 64000, 64000, 64000, 64000, 64000])
  })
})
