import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

// Pins every model call, usage record, findings row and settings line to what v0.0.57 produced, so settings that default off provably change nothing.

vi.mock('../config.js', () => ({
  config: {
    llmProvider: 'anthropic',
    vcsProvider: 'bitbucket',
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-5-5', baseUrl: '', maxRetries: 1, maxInputTokens: 250000, maxTokens: 64000 },
    judge: { model: 'claude-haiku-5-5', maxRetries: 1, effort: 'high', policy: { keepMinor: true, keepUnverified: true }, fileContext: false },
    breadth: { enabled: true, model: '', effort: '', minFiles: 1, minUntouched: 0, benchmarkDeadlineSeconds: 840 },
    lenses: { enabled: true, list: 'rel', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 5 },
    review: { maxFindings: 0, splitCheck: true, todoScan: true, effort: 'high', enableNitpicks: true, secondLook: true, lineNumbers: true, promptCache: false },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [], skipTargetBranches: [], onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: ['*.lock', 'package-lock.json', '*.json', '*.spec.ts'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
    azure: { org: '' },
  },
  modelContextWindow: () => 1_000_000,
}))

const completeStructured = vi.fn()
vi.mock('../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))

import { runBenchmark } from '../benchmark.js'
import { review } from '../review/index.js'
import { getAgentVersion, getBuildCommit } from '../review/usage.js'
import { config } from '../config.js'
import { REVIEW_OUTPUT_SCHEMA } from '../review/client.js'
import type { ReviewObject, ReviewFinding } from '../review/formatter.js'
import type { VCSAdapter, PRInfo } from '../vcs/adapter.js'

const cfg = config as any
const BASELINE = structuredClone(cfg)
const HEAD = 'c0ffee'.padEnd(40, '1')
const BASE = 'ba5e'.padEnd(40, '2')
const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

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
  findings: [
    { severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put mutate conns without a lock; take() in src/cache.ts:3 hands out the same conn.' },
    { severity: 'LOW', title: 'Unused take export', file: 'src/cache.ts', lines: '2', body: 'Nothing imports take.' },
  ],
}
const PASS: Record<string, ReviewFinding> = {
  breadth: { severity: 'MEDIUM', title: 'Cache never evicts', file: 'src/cache.ts', lines: '1', body: 'Unbounded map.' },
  second_look: { severity: 'HIGH', title: 'Double put on retry', file: 'src/pool.ts', lines: '4', body: 'A retried put pushes twice.' },
  impact: { severity: 'HIGH', title: 'take before load', file: 'src/cache.ts', lines: '3', body: 'Old cache data is unread.' },
  reliability: { severity: 'LOW', title: 'pop on empty', file: 'src/pool.ts', lines: '3', body: 'Returns undefined.' },
}
const passOf = (system: string): string =>
  system.includes('## SECOND LOOK') ? 'second_look' : system.includes('## BREADTH LENS') ? 'breadth' : (system.match(/## (\w+) LENS/)?.[1] ?? '').toLowerCase()

// A strict-schema model: optional fields come back only when the schema asks for them.
function respond(): void {
  completeStructured.mockImplementation(async (system: string, user: string, schema: any) => {
    if (schema === REVIEW_OUTPUT_SCHEMA) return { object: REVIEW, usage }
    if (schema.properties.decisions) {
      const ids = [...user.matchAll(/\[(c\d+)\]/g)].map(m => m[1])
      return { object: { decisions: ids.map((id, i) => ({ candidate_id: id, reason_category: i === 1 ? 'incorrect' : 'validated', evidence: 'src/pool.ts:2', note: 'ok', score: 8 })), summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 }, usage }
    }
    const item = schema.properties.findings.items.properties
    const f = PASS[passOf(system)]
    return { object: { findings: [{ ...f, ...(item.also_affects ? { also_affects: [{ file: f.file === 'src/pool.ts' ? 'src/cache.ts' : 'src/pool.ts', lines: '2', where: 'same pattern' }] } : {}), ...(item.scenario ? { scenario: 'repeat' } : {}) }] }, usage }
  })
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
// Undefined and non-JSON values are made visible, so an added `signal: undefined` key or a stray AbortSignal also fails the pin.
const visible = (_k: string, v: unknown) => (v === undefined ? '<undefined>' : typeof AbortSignal !== 'undefined' && v instanceof AbortSignal ? '<AbortSignal>' : typeof v === 'function' ? '<function>' : v)
const calls = () => completeStructured.mock.calls.map(([system, user, schema, opts]) => ({
  pass: passOf(system) || (schema === REVIEW_OUTPUT_SCHEMA ? 'review' : 'judge'),
  system: sha(system), user: sha(user), schema: sha(JSON.stringify(schema)), opts: JSON.parse(JSON.stringify(opts, visible)),
}))
const scrub = (s: string) => s.split(getBuildCommit()).join('<commit>').split(getAgentVersion()).join('<version>')

function prFixture(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-id-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src/pool.ts'), POOL)
  writeFileSync(join(repo, 'src/cache.ts'), CACHE)
  writeFileSync(join(dir, 'diff.patch'), DIFF)
  writeFileSync(join(dir, 'pr.json'), JSON.stringify({ repo: 'https://github.com/owner/repo', pr_number: 7, base: BASE, head: HEAD, nwo: 'owner/repo', title: 'Pool', body: 'Pool and cache.' }))
  return {
    RB_NWO: 'owner/repo', RB_PR_NUMBER: '7', RB_BASE: BASE, RB_HEAD: HEAD, RB_AGENT: 'my-agent',
    RB_REPO: repo, RB_DIFF: join(dir, 'diff.patch'), RB_PR_JSON: join(dir, 'pr.json'), RB_OUT: join(dir, 'out', 'findings.json'),
  }
}

const logSpy = vi.spyOn(console, 'log')

async function bench(labels: Record<string, string>) {
  const env = { ...prFixture(), ...labels }
  await runBenchmark(env)
  const lines = logSpy.mock.calls.map(c => c.join(' '))
  const usageLine = lines.find(l => l.startsWith('\n=== Usage ==='))!
  const { timestamp: _t, duration_ms: _d, agent_version: _v, agent_commit: _c, ...record } = JSON.parse(usageLine.slice(usageLine.indexOf('{')))
  return { settings: lines.find(l => l.startsWith('Benchmark settings:')), calls: calls(), record, findings: readFileSync(env.RB_OUT, 'utf-8') }
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

async function production(hi: boolean) {
  cfg.review.highImpact = hi
  cfg.lenses = { enabled: true, list: 'imp+rel', model: '', recommend: false }
  const adapter = makeAdapter()
  const out = await review(adapter, '100', false, undefined, 'off', false, 'repo')
  const { timestamp: _t, duration_ms: _d, agent_version: _v, agent_commit: _c, ...record } = out as any
  return { calls: calls(), record, posted: vi.mocked(adapter.postComment).mock.calls.map(c => c.map(String)) }
}

beforeEach(() => {
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(cfg, structuredClone(BASELINE))
  completeStructured.mockReset()
  respond()
  logSpy.mockClear()
  logSpy.mockImplementation(() => {})
})
afterEach(() => { process.exitCode = undefined })

const SCENARIOS: Array<[string, () => Promise<unknown>]> = [
  ['production, HI off', () => production(false)],
  ['production, HI on', () => production(true)],
  ['benchmark, J_TGAP XROWS LENSES=imp+rel', () => bench({ RB_CONFIG_J_TGAP: '1', RB_CONFIG_XROWS: '1', RB_CONFIG_LENSES: 'imp+rel' })],
  ['benchmark, J_TGAP XROWS HI LENSES=imp+rel', () => bench({ RB_CONFIG_J_TGAP: '1', RB_CONFIG_XROWS: '1', RB_CONFIG_HI: '1', RB_CONFIG_LENSES: 'imp+rel' })],
]
const fixtureOf = (name: string) => `./__fixtures__/identity-v0057/${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`

describe('v0.0.57 identity (every new setting off)', () => {
  it.each(SCENARIOS)('%s', async (name, run) => {
    const captured = await run()
    await expect(scrub(JSON.stringify(captured, visible, 2))).toMatchFileSnapshot(fixtureOf(name))
  })

  it('the new keys at their real config.ts defaults (env unset) match every fixture too', async () => {
    const saved = { ...process.env }
    for (const k of ['EXTRA_PASS_MAX_OUTPUT_TOKENS', 'ENABLE_BENCHMARK_PASS_DEADLINE', 'ENABLE_FIRST_PASS_SITES', 'ENABLE_PROMPT_CACHE']) delete process.env[k]
    process.env.ANTHROPIC_API_KEY ||= 'test-key'
    const { config: real } = await vi.importActual<typeof import('../config.js')>('../config.js')
    // Restored in place: replacing process.env leaves vitest's stubEnv restoring a stale object, which leaks stubs into later files in the worker.
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    expect([real.anthropic.extraPassMaxTokens, real.breadth.passDeadline, real.review.firstPassSites, real.breadth.judgeReserveSeconds, real.review.promptCache]).toEqual([0, false, false, 270, false])

    for (const [name, run] of SCENARIOS) {
      for (const k of Object.keys(cfg)) delete cfg[k]
      Object.assign(cfg, structuredClone(BASELINE))
      cfg.anthropic.extraPassMaxTokens = real.anthropic.extraPassMaxTokens
      cfg.breadth.passDeadline = real.breadth.passDeadline
      cfg.breadth.judgeReserveSeconds = real.breadth.judgeReserveSeconds
      cfg.review.firstPassSites = real.review.firstPassSites
      cfg.review.promptCache = real.review.promptCache
      completeStructured.mockReset()
      respond()
      logSpy.mockClear()
      await expect(scrub(JSON.stringify(await run(), visible, 2))).toMatchFileSnapshot(fixtureOf(name))
    }
  })

  it.each([false, true])('production with FP_SITES and the pass deadline on (HI %s) still matches: both act only under --benchmark', async hi => {
    cfg.review.firstPassSites = true
    cfg.breadth.passDeadline = true
    const captured = await production(hi)
    await expect(scrub(JSON.stringify(captured, visible, 2))).toMatchFileSnapshot(`./__fixtures__/identity-v0057/production-hi-${hi ? 'on' : 'off'}.json`)
  })
})

describe('v0.0.57 identity with ENABLE_TOKEN_METRICS on (the key and the two console lines removed)', () => {
  it.each(SCENARIOS)('%s', async (name, run) => {
    cfg.tokenMetrics = true
    const captured = await run() as any
    const rows = captured.record.token_metrics?.calls
    const made = (captured.calls?.length ?? 0) + (captured.completes?.length ?? 0)
    expect(captured.record.token_metrics, 'the setting must add the key').toBeDefined()
    expect(rows.length).toBe(made)
    const lines = logSpy.mock.calls.map(c => c.join(' '))
    expect(lines.filter(l => l.startsWith('Token metrics:'))).toHaveLength(1)
    delete captured.record.token_metrics
    // Read-only compare: unlike toMatchFileSnapshot it can never write or rewrite a fixture.
    expect(scrub(JSON.stringify(captured, visible, 2))).toBe(readFileSync(new URL(fixtureOf(name), import.meta.url), 'utf-8').replace(/\r\n/g, '\n'))
  })
})
