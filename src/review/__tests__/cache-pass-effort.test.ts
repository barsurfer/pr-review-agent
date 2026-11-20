import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// CACHED_PASS_EFFORT end to end: real FSM, adapter and record; only the model is mocked.

vi.mock('../../config.js', () => ({
  config: {
    llmProvider: 'anthropic',
    vcsProvider: 'bitbucket',
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-5-5', baseUrl: '', maxRetries: 1, maxInputTokens: 250000, maxTokens: 64000 },
    judge: { model: 'claude-haiku-5-5', maxRetries: 1, effort: 'high', policy: { keepMinor: true, keepUnverified: true }, fileContext: false },
    breadth: { enabled: true, model: '', effort: '', minFiles: 1, minUntouched: 0, benchmarkDeadlineSeconds: 840, judgeReserveSeconds: 270 },
    lenses: { enabled: true, list: 'rel', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 5 },
    review: { maxFindings: 0, splitCheck: true, todoScan: true, effort: 'high', enableNitpicks: true, secondLook: true, lineNumbers: true, promptCache: false, cachedPassEffort: '' },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [], skipTargetBranches: [], onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: ['*.lock'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
    azure: { org: '' },
  },
  modelContextWindow: () => 1_000_000,
}))

const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))

import { runBenchmark } from '../../benchmark.js'
import { review } from '../index.js'
import { DeadlineAbortError } from '../../llm/shared.js'
import { config } from '../../config.js'
import { estimateCost, estimateAttemptsCost } from '../usage.js'
import type { ReviewObject, ReviewFinding } from '../formatter.js'
import type { VCSAdapter, PRInfo } from '../../vcs/adapter.js'

const cfg = config as any
const BASELINE = structuredClone(cfg)

const POOL = 'export class Pool {\n  conns: Conn[] = []\n  get() { return this.conns.pop() }\n  put(c: Conn) { this.conns.push(c) }\n}\n'
const CACHE = 'export const cache = new Map<string, Conn>()\nexport function take(k: string) {\n  return cache.get(k)\n}\n'
const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts', 'index 1111111..2222222 100644', '--- a/src/pool.ts', '+++ b/src/pool.ts', '@@ -1,3 +1,6 @@',
  ' export class Pool {', '+  conns: Conn[] = []', '+  get() { return this.conns.pop() }', '+  put(c: Conn) { this.conns.push(c) }', ' }',
  'diff --git a/src/cache.ts b/src/cache.ts', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/src/cache.ts', '@@ -0,0 +1,4 @@',
  '+export const cache = new Map<string, Conn>()', '+export function take(k: string) {', '+  return cache.get(k)', '+}', '',
].join('\n')

const REVIEW: ReviewObject = {
  summary: 'Adds a pool and a cache.', behavioral_diff: ['Pool added.'], production_risk: [], unresolved_questions: [],
  findings: [{ severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put mutate conns without a lock.' }],
}
const PASS: Record<string, ReviewFinding> = {
  breadth: { severity: 'MEDIUM', title: 'Cache never evicts', file: 'src/cache.ts', lines: '1', body: 'Unbounded map.' },
  second_look: { severity: 'HIGH', title: 'Double put on retry', file: 'src/pool.ts', lines: '4', body: 'A retried put pushes twice.' },
  impact: { severity: 'HIGH', title: 'take before load', file: 'src/cache.ts', lines: '3', body: 'Old cache data is unread.' },
  reliability: { severity: 'LOW', title: 'pop on empty', file: 'src/pool.ts', lines: '3', body: 'Returns undefined.' },
}
const passOf = (text: string): string =>
  text.includes('## SECOND LOOK') ? 'second_look' : text.includes('## BREADTH LENS') ? 'breadth' : (text.match(/## (\w+) LENS/)?.[1] ?? '').toLowerCase()
const stageOf = (system: string, schema: any, opts: any): string =>
  opts?.systemAfter ? passOf(opts.systemAfter) : schema.properties.decisions ? 'judge' : passOf(system) || 'review'

const plain = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const WRITE = { input_tokens: 20000, output_tokens: 5000, cache_read_input_tokens: 0, cache_creation_input_tokens: 80000 }
const READ = { input_tokens: 20000, output_tokens: 5000, cache_read_input_tokens: 80000, cache_creation_input_tokens: 0 }
const PAID = { input_tokens: 30000, output_tokens: 7000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const err400 = (usage?: object, message = 'system messages not accepted') => Object.assign(new Error(message), { status: 400, ...(usage ? { usage } : {}) })

type Behavior = (stage: string, opts: any, n: number) => { throw?: Error; usage?: object } | undefined
let behave: Behavior = () => undefined
// What an accepted response reports as its reasoning count; undefined = the provider reported none.
let reported: number | undefined
const seen: Record<string, number> = {}

function respond(): void {
  completeStructured.mockImplementation(async (system: string, user: any, schema: any, opts: any) => {
    const stage = stageOf(system, schema, opts)
    const n = (seen[stage] = (seen[stage] ?? 0) + 1)
    const cached = Array.isArray(user)
    const scripted = behave(stage, opts, n)
    if (scripted?.throw) throw scripted.throw
    // A provider reports the accepted count only on feature-enabled cached calls.
    const final = opts?.systemAfter && (opts.effortAfter || opts.keepEffort) && reported !== undefined ? { final_reasoning_tokens: reported } : {}
    if (stage === 'review') return { object: REVIEW, usage: cached ? WRITE : plain }
    if (stage === 'judge') {
      const ids = [...String(user).matchAll(/\[(c\d+)\]/g)].map(m => m[1])
      return { object: { decisions: ids.map(id => ({ candidate_id: id, reason_category: 'validated', evidence: 'src/pool.ts:2', note: 'ok', score: 8 })), summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 }, usage: plain }
    }
    const shared = cached ? { summary: 'one line', behavioral_diff: [], production_risk: [], unresolved_questions: [] } : {}
    return { object: { ...shared, findings: [PASS[stage]] }, usage: scripted?.usage ?? { ...(cached ? READ : plain), ...final } }
  })
}

const callsOf = () => completeStructured.mock.calls.map(([system, user, schema, opts]) => ({ stage: stageOf(system, schema, opts), user, opts }))

function prFixture(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-ceff-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/pool.ts'), POOL)
  writeFileSync(join(repo, 'src/cache.ts'), CACHE)
  writeFileSync(join(dir, 'diff.patch'), DIFF)
  writeFileSync(join(dir, 'pr.json'), JSON.stringify({ repo: 'https://github.com/owner/repo', pr_number: 7, base: 'b'.repeat(40), head: 'a'.repeat(40), nwo: 'owner/repo', title: 'Pool', body: 'Pool and cache.' }))
  return {
    RB_NWO: 'owner/repo', RB_PR_NUMBER: '7', RB_BASE: 'b'.repeat(40), RB_HEAD: 'a'.repeat(40), RB_AGENT: 'my-agent',
    RB_REPO: repo, RB_DIFF: join(dir, 'diff.patch'), RB_PR_JSON: join(dir, 'pr.json'), RB_OUT: join(dir, 'out', 'findings.json'),
  }
}

const logSpy = vi.spyOn(console, 'log')
const warnSpy = vi.spyOn(console, 'warn')

function reset(tweak: () => void): void {
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(cfg, structuredClone(BASELINE))
  completeStructured.mockReset()
  for (const k of Object.keys(seen)) delete seen[k]
  respond()
  logSpy.mockClear()
  warnSpy.mockClear()
  tweak()
}

async function bench(labels: Record<string, string>, tweak: () => void = () => {}) {
  reset(tweak)
  await runBenchmark({ ...prFixture(), ...labels })
  const lines = logSpy.mock.calls.map(c => c.join(' '))
  const usageLine = lines.find(l => l.startsWith('\n=== Usage ==='))!
  const record = JSON.parse(usageLine.slice(usageLine.indexOf('{')))
  const calls = callsOf()
  const rows = (stage: string) => (record.pass_calls as any[]).filter(p => p.stage === stage)
  return { record, calls, of: (stage: string) => calls.filter(c => c.stage === stage), rows, settings: lines.find(l => l.startsWith('Benchmark settings:'))!, stdout: lines.join('\n') }
}

const makeAdapter = (): VCSAdapter => ({
  getPullRequestInfo: vi.fn().mockResolvedValue({ id: '100', title: 'Pool', description: 'd', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'aaa111222333' } as PRInfo),
  getDiff: vi.fn().mockResolvedValue(DIFF),
  getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/pool.ts', status: 'modified' }, { path: 'src/cache.ts', status: 'added' }]),
  getFileContent: vi.fn(async (path: string) => (path === 'src/pool.ts' ? POOL : CACHE)),
  getRepoFileContent: vi.fn().mockResolvedValue(null),
  postComment: vi.fn().mockResolvedValue(undefined),
  getPreviousReviewComments: vi.fn().mockResolvedValue([]),
  getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
  postReply: vi.fn().mockResolvedValue(undefined),
  getCommitDiff: vi.fn().mockResolvedValue(''),
})

const LABELS = { RB_CONFIG_J_TGAP: '1', RB_CONFIG_XROWS: '1', RB_CONFIG_LENSES: 'imp+rel', RB_CONFIG_CACHE: '1' }
const EFFORT = { ...LABELS, RB_CONFIG_C_EFFORT: 'medium' }
const STAGES = ['breadth', 'second_look', 'impact', 'reliability']
const rowKey = (rows: any[]) => rows.map(r => `${r.end}(${r.pass_effort})`)

beforeEach(() => { behave = () => undefined; reported = undefined; logSpy.mockImplementation(() => {}); warnSpy.mockImplementation(() => {}) })
afterEach(() => { process.exitCode = undefined })

describe('which calls carry the effort message', () => {
  it('every shared pass sends it with keepEffort; the reviewer, the judge and an uncached breadth do not', async () => {
    const run = await bench(EFFORT, () => { cfg.breadth.model = 'claude-sonnet-4-6' })
    for (const stage of ['second_look', 'impact', 'reliability']) expect(run.of(stage)[0].opts).toMatchObject({ effortAfter: 'medium', keepEffort: true, systemAfter: expect.any(String) })
    for (const stage of ['review', 'judge', 'breadth']) {
      expect('effortAfter' in run.of(stage)[0].opts).toBe(false)
      expect('keepEffort' in run.of(stage)[0].opts).toBe(false)
    }
    expect(run.record.prompt_cache.pass_effort).toEqual({ effort: 'medium', status: 'on' })
    expect(run.record.pass_calls.map((p: any) => [p.stage, p.pass_effort])).toEqual([['review', undefined], ['breadth', undefined], ['second_look', 'medium'], ['lens:impact', 'medium'], ['lens:reliability', 'medium'], ['judge', undefined]])
  })

  it('all four passes send it on the recipe, and the top-level effort stays the reviewer\'s', async () => {
    const run = await bench(EFFORT)
    for (const stage of STAGES) expect(run.of(stage)[0].opts).toMatchObject({ effortAfter: 'medium', keepEffort: true, effort: 'high' })
    expect(run.settings).toMatch(/ cache=1 c_effort=medium$/)
  })

  it('an unsupported model sends none and logs why', async () => {
    const run = await bench(EFFORT, () => { cfg.anthropic.model = cfg.judge.model = 'claude-opus-4-8' })
    for (const stage of STAGES) expect(run.of(stage)[0].opts).not.toHaveProperty('effortAfter')
    for (const stage of STAGES) expect(run.of(stage)[0].opts).not.toHaveProperty('keepEffort')
    expect(run.record.prompt_cache.pass_effort).toEqual({ effort: 'medium', status: 'unsupported_model' })
    expect(run.stdout).toContain('Cached pass effort medium not sent: unsupported_model')
    expect((run.record.pass_calls as any[]).some(p => 'pass_effort' in p)).toBe(false)
  })

  it('no shared pass: the status says so and nothing carries it', async () => {
    const run = await bench({ RB_CONFIG_CACHE: '1', RB_CONFIG_C_EFFORT: 'medium', RB_CONFIG_LENSES: 'off' }, () => { cfg.breadth.enabled = false; cfg.review.secondLook = false })
    expect(run.record.prompt_cache.pass_effort).toEqual({ effort: 'medium', status: 'no_shared_pass' })
    expect(run.stdout).toContain('Cached pass effort medium not sent: no_shared_pass')
    expect((run.record.pass_calls as any[]).some(p => 'pass_effort' in p)).toBe(false)
  })

  it('unset: no key in any request, row or the cache log', async () => {
    const run = await bench(LABELS)
    for (const c of run.calls) expect(Object.keys(c.opts)).not.toContain('effortAfter')
    for (const c of run.calls) expect(Object.keys(c.opts)).not.toContain('keepEffort')
    expect(run.record.prompt_cache).not.toHaveProperty('pass_effort')
    expect(JSON.stringify(run.record)).not.toMatch(/pass_effort|final_reasoning/)
  })
})

describe('the effort message is rejected', () => {
  const rejectEffort: Behavior = (stage, opts) => (stage === 'breadth' && opts.effortAfter ? { throw: err400() } : undefined)

  it('a 400 then the shipped cached request succeeds: the cache stays, later passes keep keepEffort without the message', async () => {
    behave = rejectEffort
    const run = await bench(EFFORT)
    const breadth = run.of('breadth')
    expect(breadth.map(c => [c.opts.effortAfter, c.opts.keepEffort, Array.isArray(c.user)])).toEqual([['medium', true, true], [undefined, true, true]])
    for (const stage of ['second_look', 'impact', 'reliability']) {
      expect(run.of(stage)).toHaveLength(1)
      expect(run.of(stage)[0].opts).toMatchObject({ keepEffort: true, systemAfter: expect.any(String) })
      expect('effortAfter' in run.of(stage)[0].opts).toBe(false)
    }
    expect(run.record.prompt_cache.uncached).toEqual([])
    expect(run.record.prompt_cache.pass_effort.status).toMatch(/^rejected_400: system messages not accepted/)
    expect(run.record.breadth_status).toBe('succeeded')
    expect(run.rows('breadth').map((r: any) => [r.end, r.pass_effort])).toEqual([['error', 'medium'], ['ok', 'high']])
    expect(run.rows('second_look').map((r: any) => r.pass_effort)).toEqual(['high'])
  })

  it('a later pass keeps keepEffort after the disable, and its own 400 goes to the uncached request', async () => {
    behave = (stage, opts) => (stage === 'breadth' && opts.effortAfter ? { throw: err400() } : stage === 'second_look' && opts.keepEffort ? { throw: err400(undefined, 'reasoning.effort: Invalid option') } : undefined)
    const run = await bench(EFFORT)
    const secondLook = run.of('second_look')
    expect(secondLook.map(c => [Array.isArray(c.user), c.opts.keepEffort])).toEqual([[true, true], [false, undefined]])
    expect(run.record.prompt_cache.uncached.map((u: any) => u.stage)).toEqual(['second_look', 'lens:impact', 'lens:reliability'])
  })

  it('a 400, then the shipped request 400s too: one uncached request, rows error(medium), error(high), ok', async () => {
    behave = (stage, opts) => (stage === 'breadth' && opts.systemAfter ? { throw: err400() } : undefined)
    const run = await bench(EFFORT)
    expect(run.of('breadth').map(c => [Array.isArray(c.user), c.opts.effortAfter, c.opts.keepEffort])).toEqual([[true, 'medium', true], [true, undefined, true], [false, undefined, undefined]])
    expect(rowKey(run.rows('breadth'))).toEqual(['error(medium)', 'error(high)', 'ok(undefined)'])
    expect(run.record.breadth_status).toBe('succeeded')
    expect(run.record.prompt_cache.uncached[0]).toMatchObject({ stage: 'breadth' })
    for (const stage of ['second_look', 'impact', 'reliability']) expect(run.of(stage)[0].opts).not.toHaveProperty('systemAfter')
  })

  it('a paid response, a 400, then the shipped request succeeds: the paid tokens count once in the row, the stage and the run', async () => {
    behave = (stage, opts, n) => (stage === 'breadth' && opts.effortAfter ? { throw: err400(PAID) } : undefined)
    const base = await bench(EFFORT)
    const rows = base.rows('breadth')
    expect(rows.map((r: any) => [r.end, r.input_tokens])).toEqual([['error', PAID.input_tokens], ['ok', READ.input_tokens]])
    expect(base.record.breadth_tokens.input).toBe(PAID.input_tokens + READ.input_tokens)
    expect(base.record.breadth_tokens.output).toBe(PAID.output_tokens + READ.output_tokens)
    const clean = await (async () => { behave = () => undefined; return bench(EFFORT) })()
    expect(base.record.tokens.input - clean.record.tokens.input).toBe(PAID.input_tokens)
    expect(base.record.tokens.output - clean.record.tokens.output).toBe(PAID.output_tokens)
  })

  it('a paid 400, a second 400 without usage, then the uncached success: the paid tokens count once (nested fallback)', async () => {
    behave = (stage, opts) => (stage === 'breadth' && opts.systemAfter ? { throw: opts.effortAfter ? err400(PAID) : err400() } : undefined)
    const run = await bench(EFFORT)
    const rows = run.rows('breadth')
    expect(rowKey(rows)).toEqual(['error(medium)', 'error(high)', 'ok(undefined)'])
    expect(rows.map((r: any) => r.input_tokens)).toEqual([PAID.input_tokens, null, plain.input_tokens])
    expect(rows.reduce((n: number, r: any) => n + (r.input_tokens ?? 0), 0)).toBe(run.record.breadth_tokens.input)
    expect(run.record.breadth_tokens.input).toBe(PAID.input_tokens + plain.input_tokens)
    behave = () => undefined
    const clean = await bench({ ...LABELS, RB_CONFIG_C_EFFORT: 'medium' }, () => { cfg.breadth.enabled = true })
    expect(clean.record.breadth_tokens.input).toBe(READ.input_tokens)
  })

  it('a context overflow on the effort request fails the pass: no re-send, the status stays on', async () => {
    behave = (stage, opts) => (stage === 'breadth' && opts.effortAfter ? { throw: err400(undefined, 'prompt is too long: 999999 tokens') } : undefined)
    const run = await bench(EFFORT)
    expect(run.of('breadth')).toHaveLength(1)
    expect(run.record.breadth_status).toBe('failed')
    expect(run.record.prompt_cache.pass_effort.status).toBe('on')
    expect(rowKey(run.rows('breadth'))).toEqual(['error(medium)'])
    expect(run.of('second_look')[0].opts.effortAfter).toBe('medium')
  })

  it('without the setting a 400 on cached breadth behaves as in v0.0.59: one error row with no usage, no keepEffort', async () => {
    behave = (stage, opts) => (stage === 'breadth' && opts.systemAfter ? { throw: err400(PAID) } : undefined)
    const run = await bench(LABELS)
    expect(run.rows('breadth').map((r: any) => [r.end, r.input_tokens])).toEqual([['error', null], ['ok', plain.input_tokens]])
    expect(run.of('breadth').every(c => !('keepEffort' in c.opts))).toBe(true)
  })
})

describe('the accepted response\'s reasoning count', () => {
  it.each([[0, 0], [1234, 1234], [undefined, null]])('reports %s as %s on every feature-enabled cached call, fallbacks and later passes included', async (count, logged) => {
    reported = count
    behave = (stage, opts) => (stage === 'breadth' && opts.effortAfter ? { throw: err400() } : undefined)
    const run = await bench(EFFORT)
    expect(run.rows('breadth').map((r: any) => r.final_reasoning_tokens)).toEqual([null, logged])
    for (const stage of ['second_look', 'lens:impact', 'lens:reliability']) expect(run.rows(stage).map((r: any) => r.final_reasoning_tokens)).toEqual([logged])
  })

  it('is never summed into the stage or run reasoning totals', async () => {
    reported = 700
    const run = await bench(EFFORT)
    expect(JSON.stringify(run.record.breadth_tokens)).not.toContain('final_reasoning')
    expect(run.record.reasoning_tokens ?? 0).toBe(0)
  })
})

describe('a stage priced from attempts when only some reported a cost', () => {
  const costed = (cost?: number) => ({ ...PAID, ...(cost === undefined ? {} : { cost_usd: cost }) })

  it.each([
    ['cost then none', 0.0123, undefined],
    ['none then cost', undefined, 0.0123],
  ])('%s: the paid attempt and the shipped request are each priced by their own cost or estimate', async (_n, first, second) => {
    behave = (stage, opts) => {
      if (stage !== 'breadth') return undefined
      return opts.effortAfter ? { throw: err400(costed(first)) } : { usage: { ...READ, ...(second === undefined ? {} : { cost_usd: second }) } }
    }
    const run = await bench(EFFORT)
    const attempts = [costed(first), { ...READ, ...(second === undefined ? {} : { cost_usd: second }) }]
    const expected = Math.round(attempts.reduce((n, a) => n + (a.cost_usd ?? estimateCost({ input: a.input_tokens, output: a.output_tokens, cache_read: a.cache_read_input_tokens, cache_write: a.cache_creation_input_tokens }, 'claude-haiku-5-5')), 0) * 10000) / 10000
    expect(estimateAttemptsCost(attempts as any, 'claude-haiku-5-5')).toBe(expected)
    expect(run.record.breadth_cost_usd).toBe(expected)
    expect(run.rows('breadth').map((r: any) => r.cost_usd)).toEqual(attempts.map(a => a.cost_usd ?? estimateCost({ input: a.input_tokens, output: a.output_tokens, cache_read: a.cache_read_input_tokens, cache_write: a.cache_creation_input_tokens }, 'claude-haiku-5-5')))
  })
})

describe('C_EFFORT benchmark label', () => {
  it('echoes c_effort=<v> after cache=1 only when set; 0, off and a typo leave the run as unset', async () => {
    const off = await bench(LABELS)
    const zero = await bench({ ...EFFORT, RB_CONFIG_C_EFFORT: '0' })
    const lower = await bench({ ...EFFORT, RB_CONFIG_C_EFFORT: 'off' })
    const typo = await bench({ ...EFFORT, RB_CONFIG_C_EFFORT: 'extreme' })
    const typoWarnings = warnSpy.mock.calls.map(c => String(c[0]))
    const on = await bench(EFFORT)

    expect(on.settings).toBe(`${off.settings} c_effort=medium`)
    for (const other of [zero, lower]) expect(other.settings).toBe(off.settings)
    expect(typo.settings).toBe(off.settings)
    expect(typoWarnings).toContain('  Ignoring config label RB_CONFIG_C_EFFORT=extreme: expected 0, off or low|medium|high|xhigh|max')
    expect('pass_effort' in (zero.record.prompt_cache ?? {})).toBe(false)
  })

  it('warns when it is set without CACHE', async () => {
    const run = await bench({ RB_CONFIG_C_EFFORT: 'medium' })
    expect(warnSpy.mock.calls.map(c => String(c[0]))).toContain('  C_EFFORT is set but CACHE=0 - no pass shares the cache, so it has no effect.')
    expect(run.settings).toMatch(/ c_effort=medium$/)
  })

  it('the recipe with six labels gives a 38-character row id', async () => {
    const labels = { RB_CONFIG_J_TGAP: '1', RB_CONFIG_XROWS: '1', RB_CONFIG_HI: '1', RB_CONFIG_LENSES: 'imp+rel', RB_CONFIG_CACHE: '1', RB_CONFIG_C_EFFORT: 'medium' }
    const rowId = `pr-review-agent-${Object.values(labels).join('-')}`
    const run = await bench(labels)
    expect(rowId).toBe('pr-review-agent-1-1-1-imp+rel-1-medium')
    expect(rowId).toHaveLength(38)
    expect(run.settings).toMatch(/ lenses=imp\+rel j_tgap=1 xrows=1 hi=1 cache=1 c_effort=medium$/)
    expect(run.record.prompt_cache.pass_effort.status).toBe('on')
  })
})

describe('production path', () => {
  it('sends the message when CACHED_PASS_EFFORT is set with the cache on', async () => {
    reset(() => { cfg.review.promptCache = true; cfg.review.cachedPassEffort = 'medium' })
    await review(makeAdapter(), '100', false, undefined, 'off', false, 'repo')
    const calls = callsOf()
    expect(calls.filter(c => c.opts.effortAfter === 'medium').map(c => c.stage)).toEqual(['breadth', 'second_look', 'reliability'])
  })
})

describe('fix round', () => {
  it('an uncached fallback row carries neither pass_effort nor final_reasoning_tokens', async () => {
    behave = (stage, opts) => (stage === 'breadth' && opts.systemAfter ? { throw: err400() } : undefined)
    const run = await bench(EFFORT)
    const last = run.rows('breadth')[2]
    expect(last.end).toBe('ok')
    expect('pass_effort' in last || 'final_reasoning_tokens' in last).toBe(false)
  })

  it('a deadline abort after a completed fallback attempt keeps that attempt\'s output (7000 + 9000)', async () => {
    const abort = Object.assign(new DeadlineAbortError('deadline'), { completed: { input_tokens: 100, output_tokens: 9000 } })
    behave = (stage, opts) => (stage === 'breadth' && opts.systemAfter ? { throw: opts.effortAfter ? err400({ input_tokens: 100, output_tokens: 7000 }) : abort } : undefined)
    const run = await bench(EFFORT)
    expect(run.record.breadth_status).toBe('aborted_time')
    expect(run.record.breadth_tokens.output).toBe(16000)
  })

  it('astra sequence: 7000 paid, shipped 400, then the uncached call aborts holding 9000 completed: 16000 recorded', async () => {
    const abort = Object.assign(new DeadlineAbortError('deadline'), { completed: { input_tokens: 100, output_tokens: 9000 } })
    behave = (stage, opts) => (stage !== 'breadth' ? undefined : !opts.systemAfter ? { throw: abort } : { throw: opts.effortAfter ? err400({ input_tokens: 100, output_tokens: 7000 }) : err400() })
    const run = await bench(EFFORT)
    expect(run.record.breadth_status).toBe('aborted_time')
    expect(run.record.breadth_tokens.output).toBe(16000)
  })

  it('astra cost case: both cached 400s, then an uncached call reporting a cost on one attempt only is priced per attempt in the record', async () => {
    const a = { input_tokens: 1000, output_tokens: 100, cost_usd: 0.01 }
    const b = { input_tokens: 1000, output_tokens: 100 }
    behave = (stage, opts) => (stage !== 'breadth' ? undefined : opts.systemAfter ? { throw: err400() } : { usage: { input_tokens: 2000, output_tokens: 200, attempts: [a, b] } })
    const run = await bench(EFFORT)
    const expected = Math.round((0.01 + estimateCost({ input: 1000, output: 100, cache_read: 0, cache_write: 0 }, 'claude-haiku-5-5')) * 10000) / 10000
    expect(run.record.breadth_cost_usd).toBe(expected)
  })

  it('warns once on Sonnet 5.5 and not on Haiku', async () => {
    const sonnet = await bench(EFFORT, () => { cfg.anthropic.model = cfg.judge.model = 'claude-sonnet-5-5' })
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('Sonnet 5.5'))).toHaveLength(1)
    expect(sonnet.record.prompt_cache.pass_effort.status).toBe('on')
    await bench(EFFORT)
    expect(warnSpy.mock.calls.filter(c => String(c[0]).includes('Sonnet 5.5'))).toHaveLength(0)
  })
})
