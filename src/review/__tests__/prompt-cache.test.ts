import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ENABLE_PROMPT_CACHE end to end: real FSM, adapter and record; only the model is mocked.

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
    review: { maxFindings: 0, splitCheck: true, todoScan: true, effort: 'high', enableNitpicks: true, secondLook: true, lineNumbers: true, promptCache: false },
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
import { config } from '../../config.js'
import { REVIEW_OUTPUT_SCHEMA, SHARED_PASS_TOLERATE, sharedOutputSchema, findingsOutputSchema } from '../client.js'
import { FIRST_PASS_SITES_SECTION, PASS_OUTPUT_NOTE } from '../breadth.js'
import { estimateCost } from '../usage.js'
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

// One first-pass finding on pool.ts only: breadth targets cache.ts and second look re-reads pool.ts.
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
let reviewExtras = false

function respond(): void {
  completeStructured.mockImplementation(async (system: string, user: any, schema: any, opts: any) => {
    const stage = stageOf(system, schema, opts)
    const cached = Array.isArray(user)
    if (stage === 'review') {
      const extra = reviewExtras ? { findings: REVIEW.findings.map(f => ({ ...f, also_affects: [{ file: 'src/cache.ts', lines: '2', where: 'REVIEWER-EXTRA' }], scenario: 'repeat' })), first_pass_sites: [{ id: 'c0', file: 'src/cache.ts', lines: '2', where: 'REVIEWER-SITE' }] } : {}
      return { object: { ...REVIEW, ...extra }, usage: cached ? WRITE : plain }
    }
    if (stage === 'judge') {
      const ids = [...String(user).matchAll(/\[(c\d+)\]/g)].map(m => m[1])
      return { object: { decisions: ids.map(id => ({ candidate_id: id, reason_category: 'validated', evidence: 'src/pool.ts:2', note: 'ok', score: 8 })), summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 }, usage: plain }
    }
    const shared = cached ? { summary: 'one line', behavioral_diff: [], production_risk: [], unresolved_questions: [] } : {}
    return { object: { ...shared, findings: [PASS[stage]] }, usage: cached ? READ : plain }
  })
}

const callsOf = () => completeStructured.mock.calls.map(([system, user, schema, opts]) => ({ stage: stageOf(system, schema, opts), system, user, schema, opts }))

function prFixture(diff = DIFF): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-cache-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/pool.ts'), POOL)
  writeFileSync(join(repo, 'src/cache.ts'), CACHE)
  writeFileSync(join(dir, 'diff.patch'), diff)
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
  respond()
  logSpy.mockClear()
  warnSpy.mockClear()
  tweak()
}

async function bench(labels: Record<string, string>, tweak: () => void = () => {}, diff = DIFF) {
  reset(tweak)
  const env = { ...prFixture(diff), ...labels }
  await runBenchmark(env)
  const lines = logSpy.mock.calls.map(c => c.join(' '))
  const usageLine = lines.find(l => l.startsWith('\n=== Usage ==='))!
  const record = JSON.parse(usageLine.slice(usageLine.indexOf('{')))
  const calls = callsOf()
  return { record, calls, call: (stage: string) => calls.find(c => c.stage === stage)!, settings: lines.find(l => l.startsWith('Benchmark settings:'))!, findings: readFileSync(env.RB_OUT, 'utf-8'), stdout: lines.join('\n') }
}

const makeAdapter = (overrides: Partial<VCSAdapter> = {}): VCSAdapter => ({
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
  ...overrides,
})

async function production(tweak: () => void = () => {}, adapter: VCSAdapter = makeAdapter()) {
  reset(tweak)
  const record = await review(adapter, '100', false, undefined, 'off', false, 'repo') as any
  const calls = callsOf()
  return { record, calls, call: (stage: string) => calls.find(c => c.stage === stage)! }
}

const on = (tweak: () => void = () => {}) => () => { tweak(); cfg.review.promptCache = true }
const BENCH = { RB_CONFIG_J_TGAP: '1', RB_CONFIG_XROWS: '1', RB_CONFIG_LENSES: 'imp+rel' }

beforeEach(() => { reviewExtras = false; logSpy.mockImplementation(() => {}); warnSpy.mockImplementation(() => {}) })
afterEach(() => { process.exitCode = undefined })

describe('prompt cache request shapes (CACHE=1, Haiku reviewer and judge at high)', () => {
  it('the reviewer adds only the marker; every pass sends S, [U + marker, briefing], the overlay as a trailing system message and schema F', async () => {
    const off = await bench(BENCH)
    const cached = await bench({ ...BENCH, RB_CONFIG_CACHE: '1' })

    const review = cached.call('review')
    const offReview = off.call('review')
    expect(review.system).toBe(offReview.system)
    expect(review.user).toEqual([{ text: offReview.user, cache: true }])
    expect(review.schema).toBe(REVIEW_OUTPUT_SCHEMA)
    expect(review.opts).toEqual(offReview.opts)

    for (const stage of ['breadth', 'second_look', 'impact', 'reliability']) {
      const pass = cached.call(stage)
      expect(pass.system).toBe(review.system)
      expect(pass.user).toHaveLength(2)
      expect(pass.user[0]).toEqual({ text: offReview.user, cache: true })
      expect(pass.user[1].cache).toBeUndefined()
      expect(pass.schema).toBe(review.schema)
      expect(pass.opts.systemAfter.endsWith(`\n\n${PASS_OUTPUT_NOTE}`)).toBe(true)
      expect(pass.opts.tolerateMissing).toEqual(SHARED_PASS_TOLERATE)
      expect(pass.opts).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
      expect('sessionId' in pass.opts).toBe(false)
    }
    expect(cached.call('breadth').user[1].text).toBe(off.call('breadth').user.slice(off.call('breadth').user.lastIndexOf('\n\n## First-pass findings') + 2))
    expect(cached.call('judge')).toEqual(off.call('judge'))
    expect(cached.settings).toBe(`${off.settings} cache=1`)
  })

  it('second look reads the full U and is told which files it covers', async () => {
    const off = await bench(BENCH)
    const cached = await bench({ ...BENCH, RB_CONFIG_CACHE: '1' })

    expect(off.call('second_look').user).not.toContain('+++ b/src/cache.ts')
    expect(cached.call('second_look').user[0].text).toContain('+++ b/src/cache.ts')
    expect(cached.call('second_look').user[1].text).toMatch(/^## Files to re-read \(this pass covers only these\):\n- src\/pool\.ts\n\n## Findings already reported/)
  })

  it('a pass limit in the overlay says it replaces the reviewer limit in S', async () => {
    const cached = await bench({ ...BENCH, RB_CONFIG_CACHE: '1' }, () => { cfg.review.maxFindings = 5 })

    expect(cached.call('review').system).toContain('Report at most 5 findings')
    expect(cached.call('breadth').opts.systemAfter).toMatch(/^## FINDINGS LIMIT\nThis replaces the findings limit above: report at most 4 findings in this pass/)
    expect(cached.call('breadth').system).not.toContain('at most 4')
  })
})

describe('prompt cache usage record (flag on only)', () => {
  it('logs per-stage and per-call reads, writes and cost, and subtracts the passes from the reviewer estimate', async () => {
    const off = await bench(BENCH)
    const { record } = await bench({ ...BENCH, RB_CONFIG_CACHE: '1' })

    expect(record.prompt_cache).toEqual({ ttl: '5m', reviewer_marked: true, shared_stages: ['breadth', 'second_look', 'lens:impact', 'lens:reliability'], uncached: [] })
    expect(record.tokens).toMatchObject({ cache_read: 4 * 80000, cache_write: 80000 })
    expect(record.breadth_tokens).toEqual({ input: 20000, output: 5000, cache_read: 80000, cache_write: 0 })
    expect(record.second_look_tokens).toEqual({ input: 20000, output: 5000, cache_read: 80000, cache_write: 0 })
    expect(record.lens_runs.map((r: any) => r.tokens)).toEqual([{ input: 20000, output: 5000, cache_read: 80000, cache_write: 0 }, { input: 20000, output: 5000, cache_read: 80000, cache_write: 0 }])
    expect(record.judge_tokens).toEqual({ input: 100, output: 50, cache_read: 0, cache_write: 0 })
    // Haiku 5.5 up to 100K: 20000 × 0.10 + 80000 × 0.10 × 0.1 + 5000 × 0.50, per 1M.
    expect(record.breadth_cost_usd).toBe(0.0053)
    // 20000 × 0.10 + 80000 × 0.10 × 1.25 + 5000 × 0.50: the passes' 320K reads must not push the reviewer over the tier.
    const passes = record.judge_cost_usd + record.breadth_cost_usd + record.second_look_cost_usd + record.lens_runs.reduce((s: number, r: any) => s + r.cost_usd, 0)
    expect(record.cost_usd - passes).toBeCloseTo(0.0145, 10)
    expect(record.pass_calls.map((c: any) => [c.stage, c.end, c.input_tokens, c.cache_read_tokens, c.cache_write_tokens, c.cost_usd])).toEqual([
      ['review', 'ok', 20000, 0, 80000, 0.0145],
      ['breadth', 'ok', 20000, 80000, 0, 0.0053],
      ['second_look', 'ok', 20000, 80000, 0, 0.0053],
      ['lens:impact', 'ok', 20000, 80000, 0, 0.0053],
      ['lens:reliability', 'ok', 20000, 80000, 0, 0.0053],
      ['judge', 'ok', 100, 0, 0, 0],
    ])

    expect(JSON.stringify(off.record)).not.toMatch(/prompt_cache|pass_calls|cache_read_tokens/)
    expect(off.record.breadth_tokens).toEqual({ input: 100, output: 50 })
  })

  it('production records pass_calls and prompt_cache too when the flag is on', async () => {
    const { record } = await production(on())
    expect(record.prompt_cache).toMatchObject({ reviewer_marked: true, shared_stages: ['breadth', 'second_look', 'lens:reliability'] })
    expect(record.pass_calls.map((c: any) => c.stage)).toEqual(['review', 'breadth', 'second_look', 'lens:reliability', 'judge'])
  })
})

describe('prompt cache with HI and FP_SITES', () => {
  const LABELS = { ...BENCH, RB_CONFIG_HI: '1', RB_CONFIG_FP_SITES: '1', RB_CONFIG_CACHE: '1' }

  it('F carries also_affects, scenario and first_pass_sites for every call; breadth and second look keep the sites section', async () => {
    const cached = await bench(LABELS)
    const F = sharedOutputSchema({ alsoAffects: true, scenario: true, firstPassSites: true })

    for (const stage of ['review', 'breadth', 'second_look', 'impact', 'reliability']) expect(cached.call(stage).schema).toBe(F)
    expect((F as any).required).toEqual((REVIEW_OUTPUT_SCHEMA as any).required)
    expect((REVIEW_OUTPUT_SCHEMA as any).properties.findings.items.properties.also_affects).toBeUndefined()
    for (const stage of ['breadth', 'second_look']) {
      const overlay = cached.call(stage).opts.systemAfter
      expect(overlay).toContain(FIRST_PASS_SITES_SECTION)
      expect(overlay).not.toMatch(/first_pass_sites (empty|to)/)
    }
    expect(cached.call('second_look').opts.systemAfter).toContain('What breaks in a real scenario')
    expect(cached.call('impact').opts.systemAfter).not.toContain(FIRST_PASS_SITES_SECTION)
    expect(cached.call('breadth').user[1].text).toContain('- [c0] src/pool.ts:2-3 — Race on conns')
  })

  it("the reviewer's own extras are stripped before candidate assembly, rows and the record", async () => {
    reviewExtras = true
    const cached = await bench(LABELS)

    expect(JSON.stringify(cached.record)).not.toMatch(/REVIEWER-EXTRA|REVIEWER-SITE/)
    expect(cached.findings).not.toMatch(/REVIEWER-EXTRA|REVIEWER-SITE/)
    expect(cached.call('judge').user).not.toMatch(/REVIEWER-EXTRA|REVIEWER-SITE/)
    expect(cached.record.review_candidates[0]).toMatchObject({ origin: 'review', scenario: null, also_affects: [] })
  })
})

describe('prompt cache eligibility', () => {
  const same = (a: any, b: any) => expect({ system: a.system, user: a.user, schema: a.schema, opts: a.opts }).toEqual({ system: b.system, user: b.user, schema: b.schema, opts: b.opts })

  it('Sonnet reviewer with a Haiku judge: breadth follows the reviewer and shares the cache', async () => {
    const tweak = () => { cfg.anthropic.model = 'claude-sonnet-5-5'; cfg.review.effort = 'medium'; cfg.lenses.enabled = false }
    const cached = await production(on(tweak))
    expect(cached.record.prompt_cache).toMatchObject({ reviewer_marked: true, shared_stages: ['breadth', 'second_look'], uncached: [] })
    expect(cached.record.breadth_model).toBe('claude-sonnet-5-5')
  })

  it('model mismatch: a breadth model unlike the reviewer runs breadth uncached with exactly its flag-off request', async () => {
    const tweak = () => { cfg.breadth.model = 'claude-sonnet-5-5' }
    const off = await production(tweak)
    const cached = await production(on(tweak))
    expect(cached.record.prompt_cache).toEqual({ ttl: '5m', reviewer_marked: true, shared_stages: ['second_look', 'lens:reliability'], uncached: [{ stage: 'breadth', reason: 'model' }] })
    same(cached.call('breadth'), off.call('breadth'))
    same(cached.call('judge'), off.call('judge'))
  })

  it('effort mismatch: LENS_MODEL set to the reviewer model clears the lens effort, so the lens runs uncached', async () => {
    const tweak = () => { cfg.anthropic.model = 'claude-sonnet-5-5'; cfg.review.effort = 'low'; cfg.lenses.model = 'claude-sonnet-5-5'; cfg.breadth.enabled = false }
    const off = await production(tweak)
    const cached = await production(on(tweak))
    expect(cached.record.prompt_cache).toEqual({ ttl: '5m', reviewer_marked: true, shared_stages: ['second_look'], uncached: [{ stage: 'lens:reliability', reason: 'effort' }] })
    same(cached.call('reliability'), off.call('reliability'))
    expect(off.call('reliability').opts.effort).toBeUndefined()
    expect(cached.call('second_look').opts.systemAfter).toBeDefined()
  })

  it('unlisted model: no marker and every call exactly as flag-off', async () => {
    const tweak = () => { cfg.anthropic.model = 'claude-sonnet-5'; cfg.judge.model = 'claude-sonnet-5'; cfg.judge.effort = 'high' }
    const off = await production(tweak)
    const cached = await production(on(tweak))
    expect(cached.record.prompt_cache).toEqual({
      ttl: '5m', reviewer_marked: false, shared_stages: [],
      uncached: [{ stage: 'review', reason: 'unsupported_model' }, { stage: 'breadth', reason: 'unsupported_model' }, { stage: 'second_look', reason: 'unsupported_model' }, { stage: 'lens:reliability', reason: 'unsupported_model' }],
    })
    expect(cached.calls.length).toBe(off.calls.length)
    cached.calls.forEach((c, i) => same(c, off.calls[i]))
  })

  it('JUDGING_MODEL empty: no marker, logged as no_judge', async () => {
    const tweak = () => { cfg.judge.model = '' }
    const off = await production(tweak)
    const cached = await production(on(tweak))
    expect(cached.record.prompt_cache).toEqual({ ttl: '5m', reviewer_marked: false, shared_stages: [], uncached: [{ stage: 'review', reason: 'no_judge' }] })
    same(cached.call('review'), off.call('review'))
  })

  it('no enabled pass: no marker, logged as no_shared_pass', async () => {
    const cached = await production(on(() => { cfg.breadth.enabled = false; cfg.review.secondLook = false; cfg.lenses.enabled = false }))
    expect(cached.record.prompt_cache.uncached).toEqual([{ stage: 'review', reason: 'no_shared_pass' }])
    expect(typeof cached.call('review').user).toBe('string')
  })

  it('a re-review sends no marker', async () => {
    const prior = '### Summary\nOne issue.\n\n### Findings\n- **MEDIUM – Prior issue** (`src/pool.ts:2`)\n  desc\n\n---\n*Reviewed by test-bot (claude-haiku-5-5) | Prompt: repo | Review #1 | Commit: bbb111222333*'
    const adapter = makeAdapter({ getPreviousReviewComments: vi.fn().mockResolvedValue([{ id: '200', body: prior, createdOn: '2026-03-09T10:00:00Z' }]), getCommitDiff: vi.fn().mockResolvedValue(DIFF) })
    const cached = await production(on(), adapter)
    expect(cached.record.review_number).toBe(2)
    expect(cached.record.prompt_cache.uncached).toEqual([{ stage: 'review', reason: 'rereview' }])
    expect(cached.calls.every(c => typeof c.user === 'string')).toBe(true)
  })

  it('the bundled path sends no marker', async () => {
    const section = (path: string, n: number) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+const line${i} = ${i};`).join('\n')}\n`
    const bundled = () => { cfg.review.bundledReview = true; cfg.review.maxBundles = 8; cfg.anthropic.maxInputTokens = 8000 }
    const cached = await bench({ RB_CONFIG_CACHE: '1' }, bundled, DIFF + section('src/big-one.ts', 380) + section('src/big-two.ts', 380))
    expect(cached.stdout).toContain('switching to bundled review')
    expect(cached.record.prompt_cache).toEqual({ ttl: '5m', reviewer_marked: false, shared_stages: [], uncached: [{ stage: 'review', reason: 'bundled' }] })
    expect(cached.calls.every(c => typeof c.user === 'string')).toBe(true)
  })
})

describe('prompt cache fallback and session_id', () => {
  const same = (a: any, b: any) => expect({ system: a.system, user: a.user, schema: a.schema, opts: a.opts }).toEqual({ system: b.system, user: b.user, schema: b.schema, opts: b.opts })

  async function rejecting(stage: string) {
    reset(on())
    const base = completeStructured.getMockImplementation()!
    completeStructured.mockImplementation(async (system: string, user: any, schema: any, opts: any) => {
      if (opts?.systemAfter && passOf(opts.systemAfter) === stage) throw Object.assign(new Error('Provider returned error'), { status: 400 })
      return base(system, user, schema, opts)
    })
    return await review(makeAdapter(), '100', false, undefined, 'off', false, 'repo') as any
  }

  it('any 400 on a cached pass re-sends it as its flag-off request and turns the cache off for every later pass, never the overlay as user text', async () => {
    const off = await production()
    const record = await rejecting('breadth')
    const breadthCalls = callsOf().filter(c => c.stage === 'breadth' || c.opts?.systemAfter?.includes('## BREADTH LENS'))

    expect(breadthCalls).toHaveLength(2)
    expect(breadthCalls[0].opts.systemAfter).toContain('## BREADTH LENS')
    same(breadthCalls[1], off.call('breadth'))
    const later = callsOf().filter(c => ['second_look', 'reliability'].includes(c.stage))
    expect(later).toHaveLength(2)
    same(later[0], off.call('second_look'))
    same(later[1], off.call('reliability'))
    expect(record.prompt_cache.shared_stages).toEqual([])
    expect(record.prompt_cache.uncached).toEqual([{ stage: 'breadth', reason: 'rejected_400: Provider returned error' }, { stage: 'second_look', reason: 'off_after_400' }, { stage: 'lens:reliability', reason: 'off_after_400' }])
    expect(warnSpy.mock.calls.map(c => String(c[0])).some(w => w.includes('(Provider returned error)'))).toBe(true)
    expect(record.pass_calls.map((c: any) => `${c.stage}:${c.end}`)).toEqual(['review:ok', 'breadth:error', 'breadth:ok', 'second_look:ok', 'lens:reliability:ok', 'judge:ok'])
    expect(record.breadth_status).toBe('succeeded')
  })

  it('a rejection on a later pass keeps the passes that already ran cached in shared_stages', async () => {
    const off = await production()
    const record = await rejecting('second_look')
    expect(record.prompt_cache.shared_stages).toEqual(['breadth'])
    expect(record.prompt_cache.uncached).toEqual([{ stage: 'second_look', reason: 'rejected_400: Provider returned error' }, { stage: 'lens:reliability', reason: 'off_after_400' }])
    same(callsOf().find(c => c.stage === 'reliability'), off.call('reliability'))
  })

  it('a context-length 400 on a cached pass is no rejection: the pass fails as before and the cache stays on for later passes', async () => {
    reset(on())
    const base = completeStructured.getMockImplementation()!
    completeStructured.mockImplementation(async (system: string, user: any, schema: any, opts: any) => {
      if (opts?.systemAfter && passOf(opts.systemAfter) === 'breadth') throw Object.assign(new Error('prompt is too long: 1200000 tokens > 1000000 maximum'), { status: 400 })
      return base(system, user, schema, opts)
    })
    const record = await review(makeAdapter(), '100', false, undefined, 'off', false, 'repo') as any

    expect(callsOf().filter(c => c.stage === 'breadth')).toHaveLength(1)
    expect(record.breadth_status).toBe('failed')
    expect(record.prompt_cache.shared_stages).toEqual(['breadth', 'second_look', 'lens:reliability'])
    expect(record.prompt_cache.uncached).toEqual([])
    expect(callsOf().find(c => c.stage === 'second_look')!.opts.systemAfter).toBeDefined()
  })

  it('a planned shared pass that a findings-dependent gate skips is moved out of shared_stages', async () => {
    const cached = await production(on(() => { cfg.breadth.minUntouched = 2 }))
    expect(cached.record.breadth_status).toBe('skipped_few_untouched')
    expect(cached.record.prompt_cache.shared_stages).toEqual(['second_look', 'lens:reliability'])
    expect(cached.record.prompt_cache.uncached).toEqual([{ stage: 'breadth', reason: 'skipped_after_plan: skipped_few_untouched' }])
  })

  it('OpenRouter: one session_id per run on the reviewer and shared passes, never on the judge; absent with the flag off', async () => {
    const tweak = () => { cfg.llmProvider = 'openrouter'; cfg.anthropic.model = 'anthropic/claude-haiku-5.5'; cfg.judge.model = 'anthropic/claude-haiku-5.5' }
    const cached = await production(on(tweak))
    const id = cached.record.prompt_cache.session_id

    expect(id).toMatch(/^[0-9a-f]{32}$/)
    for (const stage of ['review', 'breadth', 'second_look', 'reliability']) expect(cached.call(stage).opts.sessionId).toBe(id)
    expect('sessionId' in cached.call('judge').opts).toBe(false)

    const again = await production(on(tweak))
    expect(again.record.prompt_cache.session_id).toMatch(/^[0-9a-f]{32}$/)

    const off = await production(tweak)
    expect(JSON.stringify(off.calls.map(c => c.opts))).not.toContain('sessionId')
  })

  it('Anthropic direct sends no session_id', async () => {
    const cached = await production(on())
    expect('session_id' in cached.record.prompt_cache).toBe(false)
    expect(JSON.stringify(cached.calls.map(c => c.opts))).not.toContain('sessionId')
  })
})

describe('cache cost math', () => {
  it('prices writes at 1.25x and reads at the model fraction of the input rate', () => {
    const t = { input: 0, output: 0, cache_read: 1_000_000 }
    expect(estimateCost(t, 'claude-sonnet-5-5')).toBe(0.1)
    expect(estimateCost(t, 'claude-opus-5-5')).toBe(0.2)
    expect(estimateCost(t, 'claude-opus-5')).toBe(0.5)
    expect(estimateCost(t, 'claude-fable-5-1')).toBe(0.25)
    expect(estimateCost(t, 'claude-mythos-5-1')).toBe(0.25)
    expect(estimateCost(t, 'claude-fable-5')).toBe(1)
    expect(estimateCost(t, 'anthropic/claude-sonnet-5.5')).toBe(0.1)
    expect(estimateCost({ input: 0, output: 0, cache_write: 1_000_000 }, 'claude-sonnet-5-5')).toBe(2.5)
    expect(estimateCost({ input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_write: 1_000_000 }, 'claude-opus-4-8')).toBe(5 + 25 + 0.5 + 6.25)
  })

  it('cached tokens count toward the Haiku 5.5 100K tier', () => {
    expect(estimateCost({ input: 1000, output: 0, cache_read: 99_000 }, 'claude-haiku-5-5')).toBe(0.0011)
    // 101K prompt: the 0.50 input card applies to the uncached part and the reads.
    expect(estimateCost({ input: 1000, output: 0, cache_read: 100_000 }, 'claude-haiku-5-5')).toBe(0.0055)
    expect(estimateCost({ input: 1000, output: 0, cache_write: 100_000 }, 'claude-haiku-5-5')).toBe(0.063)
  })

  it('without cache fields the estimate is unchanged', () => {
    expect(estimateCost({ input: 123_456, output: 7_890 }, 'claude-haiku-5-5')).toBe(estimateCost({ input: 123_456, output: 7_890, cache_read: 0, cache_write: 0 }, 'claude-haiku-5-5'))
    expect(estimateCost({ input: 50_000, output: 1_000 }, 'claude-haiku-5-5')).toBe(0.0055)
  })
})

describe('CACHE benchmark label', () => {
  it('echoes cache=1 last only when on; 0 and a typo change nothing', async () => {
    const off = await bench(BENCH)
    const zero = await bench({ ...BENCH, RB_CONFIG_CACHE: '0' })
    const typo = await bench({ ...BENCH, RB_CONFIG_CACHE: 'yes' })
    const cached = await bench({ ...BENCH, RB_CONFIG_CACHE: '1' })

    expect(cached.settings).toBe(`${off.settings} cache=1`)
    for (const other of [zero, typo]) {
      expect([other.settings, JSON.stringify(other.calls), other.findings]).toEqual([off.settings, JSON.stringify(off.calls), off.findings])
      expect('prompt_cache' in other.record).toBe(false)
    }
    expect(warnSpy.mock.calls.map(c => String(c[0]))).not.toContain('  Ignoring unsupported config label RB_CONFIG_CACHE')
  })

  it("the owner's recipe CACHE=1 J_TGAP=1 XROWS=1 HI=1 LENSES=imp+rel applies every label within the row-id limit", async () => {
    const labels = { RB_CONFIG_CACHE: '1', RB_CONFIG_J_TGAP: '1', RB_CONFIG_XROWS: '1', RB_CONFIG_HI: '1', RB_CONFIG_LENSES: 'imp+rel' }
    const rowId = `pr-review-agent-${Object.values(labels).join('-')}`
    const cached = await bench(labels)

    expect(rowId).toBe('pr-review-agent-1-1-1-1-imp+rel')
    expect(rowId.length).toBeLessThanOrEqual(64)
    expect(cached.settings).toMatch(/ lenses=imp\+rel j_tgap=1 xrows=1 hi=1 cache=1$/)
    expect(cached.record.prompt_cache.reviewer_marked).toBe(true)
  })
})

describe('prompt cache gates decided before the reviewer call', () => {
  it('breadth as the only consumer under BREADTH_MIN_FILES: no marker, breadth logged skipped_small', async () => {
    const cached = await production(on(() => { cfg.review.secondLook = false; cfg.lenses.enabled = false; cfg.breadth.minFiles = 5 }))
    expect(cached.record.prompt_cache).toEqual({ ttl: '5m', reviewer_marked: false, shared_stages: [], uncached: [{ stage: 'review', reason: 'no_shared_pass' }, { stage: 'breadth', reason: 'skipped_small' }] })
    expect(cached.record.breadth_status).toBe('skipped_small')
    expect(typeof cached.call('review').user).toBe('string')
  })

  it('an extra-pass budget the reviewer payload already exceeds: every pass logged skipped_budget, no marker', async () => {
    const cached = await bench({ ...BENCH, RB_CONFIG_CACHE: '1' }, () => { cfg.anthropic.extraPassMaxTokens = 999_950 })
    expect(cached.record.prompt_cache.reviewer_marked).toBe(false)
    expect(cached.record.prompt_cache.uncached.slice(1).map((u: any) => u.reason)).toEqual(['skipped_budget', 'skipped_budget', 'skipped_budget', 'skipped_budget'])
    expect(cached.record.breadth_status).toBe('skipped_budget')
  })

  it('no time left before the pass deadline: every pass logged skipped_time, no marker', async () => {
    const cached = await bench({ ...BENCH, RB_CONFIG_CACHE: '1' }, () => { cfg.breadth.passDeadline = true; cfg.breadth.benchmarkDeadlineSeconds = 200 })
    expect(cached.record.prompt_cache.reviewer_marked).toBe(false)
    expect(cached.record.prompt_cache.uncached.slice(1).map((u: any) => u.reason)).toEqual(['skipped_time', 'skipped_time', 'skipped_time', 'skipped_time'])
  })
})

describe('prompt cache after a context-length recovery', () => {
  it('passes estimate from the stored diff-only prefix, so second look is not skipped on the discarded payload', async () => {
    const big = CACHE + Array.from({ length: 400 }, (_, i) => `// pad ${i} ${'x'.repeat(200)}\n`).join('')
    const adapter = () => makeAdapter({ getFileContent: vi.fn(async (path: string) => (path === 'src/pool.ts' ? POOL : big)) })
    const estimated = (await production(() => {}, adapter())).record.tokens.estimated_input
    const tweak = () => { cfg.anthropic.maxInputTokens = estimated + 10 }
    reset(on(tweak))
    const base = completeStructured.getMockImplementation()!
    completeStructured.mockImplementation(async (system: string, user: any, schema: any, opts: any) => {
      if (Array.isArray(user) && !opts?.systemAfter && user[0].text.includes('## Full file context')) throw Object.assign(new Error('prompt is too long: 260000 tokens > 250000 maximum'), { status: 400 })
      return base(system, user, schema, opts)
    })
    const record = await review(adapter(), '100', false, undefined, 'off', false, 'repo') as any
    const calls = callsOf()
    const prefix = calls.filter(c => c.stage === 'review').at(-1)!.user[0].text

    expect(record.degraded).toBe(true)
    expect(prefix).not.toContain('## Full file context')
    expect(record.second_look_status).toBe('succeeded')
    expect(calls.find(c => c.stage === 'second_look')!.user[0].text).toBe(prefix)
    expect(record.pass_calls.map((c: any) => `${c.stage}:${c.end}`).slice(0, 2)).toEqual(['review:error', 'review:ok'])
  })
})

describe('prompt cache cost per attempt', () => {
  it('a resent reviewer or pass without a provider cost is priced attempt by attempt in the stage, per-call and reviewer costs', async () => {
    const attempt = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 99000, cache_creation_input_tokens: 0 }
    const resent = { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 198000, cache_creation_input_tokens: 0, attempts: [attempt, attempt] }
    reset(on(() => { cfg.lenses.enabled = false; cfg.review.secondLook = false }))
    const base = completeStructured.getMockImplementation()!
    completeStructured.mockImplementation(async (system: string, user: any, schema: any, opts: any) => {
      const answer = await base(system, user, schema, opts)
      const stage = stageOf(system, schema, opts)
      return stage === 'review' || stage === 'breadth' ? { ...answer, usage: resent } : answer
    })
    const record = await review(makeAdapter(), '100', false, undefined, 'off', false, 'repo') as any

    expect(record.breadth_cost_usd).toBe(0.0027)
    expect(record.pass_calls.filter((c: any) => c.stage === 'review' || c.stage === 'breadth').map((c: any) => c.cost_usd)).toEqual([0.0027, 0.0027])
    expect(record.cost_usd - record.breadth_cost_usd - record.judge_cost_usd).toBeCloseTo(0.0027, 10)
  })
})

describe('prompt cache reviewer schema F wording and tolerance', () => {
  it('F words scenario and first_pass_sites without pass sections the reviewer never sees; the flag-off pass schemas keep theirs', () => {
    const F = sharedOutputSchema({ alsoAffects: true, scenario: true, firstPassSites: true }) as any
    const text = JSON.stringify(F)
    expect(text).not.toMatch(/SECOND LOOK|IMPACT LENS|OTHER SITES OF FIRST-PASS FINDINGS/)
    const passSchema = findingsOutputSchema({ scenario: true, firstPassSites: true }) as any
    expect(passSchema.properties.findings.items.properties.scenario.description).toContain('SECOND LOOK item 4')
    expect(passSchema.properties.first_pass_sites.description).toContain('OTHER SITES OF FIRST-PASS FINDINGS')
    expect(F.properties.first_pass_sites.items).toEqual(passSchema.properties.first_pass_sites.items)
  })

  it('the cached reviewer tolerates a malformed first_pass_sites entry only when F carries it', async () => {
    const withSites = await bench({ ...BENCH, RB_CONFIG_FP_SITES: '1', RB_CONFIG_CACHE: '1' })
    expect(withSites.call('review').opts.tolerateMissing).toEqual(['first_pass_sites'])
    const plain = await bench({ ...BENCH, RB_CONFIG_CACHE: '1' })
    expect('tolerateMissing' in plain.call('review').opts).toBe(false)
  })
})
