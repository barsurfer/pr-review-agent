import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

// Pins every Bitbucket request, model call, posted comment and usage record of the legacy flow at v0.0.61, so a new output engine behind a default-off flag provably changes nothing.

const h = vi.hoisted(() => ({ route: (_m: string, _u: string, _b?: unknown): Promise<unknown> => Promise.reject(new Error('router not set')) }))

vi.mock('axios', () => ({
  default: {
    create: () => ({ get: (u: string) => h.route('GET', u), post: (u: string, b: unknown) => h.route('POST', u, b) }),
    get: (u: string) => h.route('GET', u),
    isAxiosError: (e: any) => e?.isAxiosError === true,
  },
}))

vi.mock('../config.js', () => ({
  config: {
    llmProvider: 'anthropic',
    vcsProvider: 'bitbucket',
    anthropic: { apiKey: 'test-key', model: 'claude-sonnet-5-5', baseUrl: '', maxRetries: 1, maxInputTokens: 250000, maxTokens: 64000, extraPassMaxTokens: 128000 },
    judge: { model: 'claude-haiku-5-5', maxRetries: 1, effort: 'high', policy: { keepMinor: true, keepUnverified: true }, fileContext: false },
    // Pinned to what v0.0.61 resolved from an empty model (the judge's), so a later change to the breadth default cannot move the recorded fixtures.
    breadth: { enabled: true, model: 'claude-haiku-5-5', effort: 'high', minFiles: 1, minUntouched: 0, benchmarkDeadlineSeconds: 840, judgeReserveSeconds: 270, passDeadline: false },
    lenses: { enabled: true, list: 'rel', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 5 },
    review: { maxFindings: 0, splitCheck: true, todoScan: true, effort: 'high', enableNitpicks: true, secondLook: true, lineNumbers: true, promptCache: false, targetMergeCheck: true },
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
const complete = vi.fn()
vi.mock('../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete, completeStructured })) }))

import { BitbucketAdapter } from '../vcs/bitbucket.js'
import { runBenchmark } from '../benchmark.js'
import { review } from '../review/index.js'
import { getAgentVersion, getBuildCommit } from '../review/usage.js'
import { config } from '../config.js'
import { renderReview, buildReviewFooter, buildReplyFooter } from '../review/formatter.js'
import type { ReviewObject, ReviewFinding } from '../review/formatter.js'

const cfg = config as any
const BASELINE = structuredClone(cfg)
const HEAD = 'aaa111222333'.padEnd(40, '4')
const OLD = 'bbb111222333'.padEnd(40, '5')
const TARGET = 'ccc111222333'.padEnd(40, '6')
const BASE = 'ba5e'.padEnd(40, '2')
const API = 'https://api.bitbucket.org/2.0'
const REPO = '/repositories/test/repo'
const plain = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const WRITE = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 8000 }
const READ = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0 }

const POOL = 'export class Pool {\n  conns: Conn[] = []\n  get() { return this.conns.pop() }\n  put(c: Conn) { this.conns.push(c) }\n}\n'
const CACHE = 'export const cache = new Map<string, Conn>()\nexport function take(k: string) {\n  return cache.get(k)\n}\n'
const FILES: Record<string, string> = { 'src/pool.ts': POOL, 'src/cache.ts': CACHE }
const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts', 'index 1111111..2222222 100644', '--- a/src/pool.ts', '+++ b/src/pool.ts', '@@ -1,3 +1,6 @@',
  ' export class Pool {', '+  conns: Conn[] = []', '+  get() { return this.conns.pop() }', '+  put(c: Conn) { this.conns.push(c) }', ' }',
  'diff --git a/src/cache.ts b/src/cache.ts', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/src/cache.ts', '@@ -0,0 +1,4 @@',
  '+export const cache = new Map<string, Conn>()', '+export function take(k: string) {', '+  return cache.get(k)', '+}', '',
].join('\n')
const DELTA = [
  'diff --git a/src/pool.ts b/src/pool.ts', 'index 2222222..4444444 100644', '--- a/src/pool.ts', '+++ b/src/pool.ts', '@@ -3,2 +3,3 @@',
  '   get() { return this.conns.pop() }', '+  size() { return this.conns.length }', '   put(c: Conn) { this.conns.push(c) }', '',
].join('\n')

// Five new files of about 500 tokens each, so a 6000-token budget forces one bundle per file.
const bulk = (path: string): { diff: string; content: string } => {
  const lines = Array.from({ length: 50 }, (_, i) => `export const ${path.replace(/\W/g, '_')}_${i} = ${i}`)
  const header = [`diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..5555555', '--- /dev/null', `+++ b/${path}`, '@@ -0,0 +1,50 @@']
  return { content: lines.join('\n') + '\n', diff: [...header, ...lines.map(l => '+' + l), ''].join('\n') }
}
const BULK_PATHS = ['src/pool.ts', 'src/cache.ts', 'src/net/a.ts', 'src/net/b.ts', 'src/net/c.ts']

const REVIEW: ReviewObject = {
  summary: 'Adds a pool and a cache.', behavioral_diff: ['Pool added.'], production_risk: [], unresolved_questions: [],
  findings: [
    { severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put mutate conns without a lock; take() in src/cache.ts:3 hands out the same conn.' },
    { severity: 'LOW', title: 'Unused take export', file: 'src/cache.ts', lines: '2', body: 'Nothing imports take.' },
  ],
}
const REREVIEW: ReviewObject = { ...REVIEW, delta_stats: { resolved: 1, still_open: 1, new_findings: 0 } }
const ZERO: ReviewObject = { summary: 'Both findings fixed.', behavioral_diff: [], production_risk: [], unresolved_questions: [], findings: [], delta_stats: { resolved: 2, still_open: 0, new_findings: 0 } }
const NO_CHANGE: ReviewObject = { summary: '', behavioral_diff: [], production_risk: [], unresolved_questions: [], findings: [], no_change: true }
const PASS: Record<string, ReviewFinding> = {
  breadth: { severity: 'MEDIUM', title: 'Cache never evicts', file: 'src/cache.ts', lines: '1', body: 'Unbounded map.' },
  second_look: { severity: 'HIGH', title: 'Double put on retry', file: 'src/pool.ts', lines: '4', body: 'A retried put pushes twice.' },
  reliability: { severity: 'LOW', title: 'pop on empty', file: 'src/pool.ts', lines: '3', body: 'Returns undefined.' },
}
const passOf = (text: string): string =>
  text.includes('## SECOND LOOK') ? 'second_look' : text.includes('## BREADTH LENS') ? 'breadth' : (text.match(/## (\w+) LENS/)?.[1] ?? '').toLowerCase()
const stageOf = (system: string, schema: any, opts: any): string =>
  opts?.systemAfter ? passOf(opts.systemAfter) : schema.properties.decisions ? 'judge' : passOf(system) || 'review'

let reviewerObject: ReviewObject = REVIEW

// Schema F offers a pass's extras to the reviewer too, so a strict-schema model returns an extra only when its schema carries one.
function respond(): void {
  completeStructured.mockImplementation(async (system: string, user: any, schema: any, opts: any) => {
    const stage = stageOf(system, schema, opts)
    const cached = Array.isArray(user)
    if (stage === 'review') {
      const lens = schema.properties.lens_recommendations ? { lens_recommendations: [{ lens: 'reliability', reason: 'Pool mutates shared state.' }] } : {}
      return { object: { ...reviewerObject, ...lens }, usage: cached ? WRITE : plain }
    }
    if (stage === 'judge') {
      const item = schema.properties.decisions.items.properties
      const ids = [...String(user).matchAll(/\[(c\d+)\]/g)].map(m => m[1])
      const decisions = ids.map((id, i) => ({
        candidate_id: id, reason_category: i === 1 ? 'incorrect' : 'validated', evidence: 'src/pool.ts:2', note: 'ok', score: 8,
        ...(item.proposal && i !== 1 ? { proposal: 'Guard get() against an empty pool\nif (!this.conns.length) throw new Error("empty")', ...(item.body_without_fix ? { body_without_fix: 'The pool is mutated without a lock.' } : {}) } : {}),
      }))
      return { object: { decisions, summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 }, usage: plain }
    }
    const item = schema.properties.findings.items.properties
    const f = PASS[stage]
    const finding = { ...f, ...(item.also_affects ? { also_affects: [{ file: f.file === 'src/pool.ts' ? 'src/cache.ts' : 'src/pool.ts', lines: '2', where: 'same pattern' }] } : {}), ...(item.scenario ? { scenario: 'repeat' } : {}) }
    const shared = cached ? { summary: 'one line', behavioral_diff: [], production_risk: [], unresolved_questions: [] } : {}
    return { object: { ...shared, findings: [finding] }, usage: cached ? READ : plain }
  })
  complete.mockImplementation(async () => ({ text: 'The lock is not needed because pop and push run on one tick.', usage: plain }))
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const visible = (_k: string, v: unknown) => (v === undefined ? '<undefined>' : typeof AbortSignal !== 'undefined' && v instanceof AbortSignal ? '<AbortSignal>' : typeof v === 'function' ? '<function>' : v)
const calls = () => completeStructured.mock.calls.map(([system, user, schema, opts]) => ({
  stage: stageOf(system, schema, opts), system: sha(system), user: sha(typeof user === 'string' ? user : JSON.stringify(user)), schema: sha(JSON.stringify(schema)),
  systemAfter: opts?.systemAfter === undefined ? '<undefined>' : sha(opts.systemAfter), opts: JSON.parse(JSON.stringify(opts, visible)),
}))
const completes = () => complete.mock.calls.map(([system, user, opts]) => ({ system: sha(system), user: sha(user), opts: JSON.parse(JSON.stringify(opts, visible)) }))
const promptDirs: string[] = []
// The prompt path is the footer's prompt label, so its random directory and per-OS separator must not reach a fixture.
const scrubPromptPath = (s: string) => promptDirs.reduce((out, d) => out.split(JSON.stringify(d).slice(1, -1)).join('<prompt-dir>').split(d).join('<prompt-dir>'), s).replace(/<prompt-dir>(?:\\\\|\\|\/)prompt\.txt/g, '<prompt-dir>/prompt.txt')
const scrub = (s: string) => scrubPromptPath(s.split(getBuildCommit()).join('<commit>').split(getAgentVersion()).join('<version>'))

const AGENT = { display_name: 'Review Bot', uuid: '{agent-uuid}', account_id: 'agent-acc', nickname: 'reviewbot' }
const DEV = { display_name: 'Dev One', uuid: '{dev-uuid}', account_id: 'dev-acc', nickname: 'devone' }
const reviewComment = (id: number, commit12: string, n: number, createdOn: string) => ({
  id, content: { raw: renderReview(REVIEW) + buildReviewFooter('test-bot', 'claude-sonnet-5-5', 'default', n, commit12, 'abc1234') }, created_on: createdOn, user: AGENT,
})
const humanReply = (id: number, parent: number, text: string, createdOn: string) => ({ id, parent: { id: parent }, content: { raw: text }, created_on: createdOn, user: DEV })
const agentReply = (id: number, parent: number, createdOn: string) => ({
  id, parent: { id: parent }, content: { raw: 'Answered earlier.' + buildReplyFooter('test-bot', 'claude-sonnet-5-5') }, created_on: createdOn, user: AGENT,
})

interface World { comments: unknown[]; delta: string; diff: string; stat: Array<{ status: string; path: string }>; files: Record<string, string> }
let world: World
let requests: Array<{ method: string; url: string; body?: unknown }>

const notFound = () => Object.assign(new Error('Request failed with status code 404'), { isAxiosError: true, response: { status: 404, headers: {} } })
const reply = (data: unknown, status = 200, headers: Record<string, string> = {}) => ({ status, data, headers })

// Plays the Bitbucket Cloud endpoints the legacy flow uses, with the redirects the live API answers PR diffs with.
function router(method: string, url: string, body?: unknown): Promise<unknown> {
  requests.push({ method, url, ...(body === undefined ? {} : { body }) })
  const path = url.startsWith(API) ? url.slice(API.length) : url
  if (method === 'POST') {
    if (path === `${REPO}/pullrequests/100/comments`) return Promise.resolve(reply({ id: 900 + requests.length }, 201))
    return Promise.reject(new Error(`unrouted POST ${url}`))
  }
  if (path === `${REPO}/pullrequests/100`) {
    return Promise.resolve(reply({
      id: 100, title: 'Pool', description: 'Pool and cache.', author: { display_name: 'Dev One' },
      source: { branch: { name: 'feature/pool' }, commit: { hash: HEAD } }, destination: { branch: { name: 'develop' }, commit: { hash: TARGET } },
    }))
  }
  if (path === `${REPO}/pullrequests/100/diff`) return Promise.resolve(reply('', 302, { location: `${API}${REPO}/diff/test/repo:${HEAD}%0D${BASE}?from_pullrequest_id=100` }))
  if (path === `${REPO}/pullrequests/100/diffstat`) return Promise.resolve(reply('', 302, { location: `${API}${REPO}/diffstat/test/repo:${HEAD}%0D${BASE}?from_pullrequest_id=100` }))
  if (path.startsWith(`${REPO}/diff/test/repo:`)) return Promise.resolve(reply(world.diff))
  if (path.startsWith(`${REPO}/diffstat/test/repo:`)) {
    return Promise.resolve(reply({ values: world.stat.map(e => ({ status: e.status, new: { path: e.path }, old: { path: e.path } })) }))
  }
  if (/\/diff\/[0-9a-f]+\.\.[0-9a-f]+$/.test(path)) return Promise.resolve(reply(world.delta))
  if (path === `${REPO}/pullrequests/100/comments`) return Promise.resolve(reply({ values: world.comments }))
  const src = path.match(/^\/repositories\/test\/repo\/src\/[^/]+\/(.+)$/)
  if (src) return world.files[src[1]] !== undefined ? Promise.resolve(reply(world.files[src[1]])) : Promise.reject(notFound())
  return Promise.reject(new Error(`unrouted GET ${url}`))
}

function prFixture(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-id61-'))
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
const warnSpy = vi.spyOn(console, 'warn')

async function bench(labels: Record<string, string>) {
  const env = { ...prFixture(), ...labels }
  await runBenchmark(env)
  const lines = logSpy.mock.calls.map(c => c.join(' '))
  const usageLine = lines.find(l => l.startsWith('\n=== Usage ==='))!
  const { timestamp: _t, duration_ms: _d, agent_version: _v, agent_commit: _c, ...record } = JSON.parse(usageLine.slice(usageLine.indexOf('{')))
  return { settings: lines.find(l => l.startsWith('Benchmark settings:')), calls: calls(), record, findings: readFileSync(env.RB_OUT, 'utf-8') }
}

interface Options { force?: 'off' | 'clean' | 're-review'; dryRun?: boolean; promptPath?: string }
async function legacy(opts: Options = {}) {
  const adapter = new BitbucketAdapter(API, 'test', 'bot', 'x')
  adapter.setRepoSlug('repo')
  const out = await review(adapter, '100', opts.dryRun ?? false, opts.promptPath, opts.force ?? 'off', false, 'repo')
  const { timestamp: _t, duration_ms: _d, agent_version: _v, agent_commit: _c, ...record } = out as any
  const lines = logSpy.mock.calls.map(c => c.join(' '))
  const dryRun = opts.dryRun ? lines.slice(lines.findIndex(l => l.includes('=== DRY RUN'))).join('\n').split('\n=== Usage ===')[0] : undefined
  return { requests, calls: calls(), completes: completes(), record, ...(dryRun === undefined ? {} : { dryRun }) }
}

function reset(): void {
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(cfg, structuredClone(BASELINE))
  reviewerObject = REVIEW
  world = { comments: [], delta: DELTA, diff: DIFF, stat: [{ status: 'modified', path: 'src/pool.ts' }, { status: 'added', path: 'src/cache.ts' }], files: FILES }
  requests = []
  h.route = router
  completeStructured.mockReset()
  complete.mockReset()
  respond()
  logSpy.mockClear()
  warnSpy.mockClear()
}

// A frozen clock makes each comment's footer and every pass limit repeatable.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-01T00:00:00Z') })
  vi.stubEnv('JOB_NAME', '')
  vi.stubEnv('BUILD_NUMBER', '')
  vi.stubEnv('BUILD_URL', '')
  reset()
  logSpy.mockImplementation(() => {})
  warnSpy.mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); process.exitCode = undefined })

const T = (name: string, action: string, run: () => Promise<unknown>): [string, string, () => Promise<unknown>] => [name, action, run]
const quiet = () => { cfg.breadth.enabled = false; cfg.review.secondLook = false; cfg.lenses.enabled = false }

const SCENARIOS: Array<[string, string, () => Promise<unknown>]> = [
  T('1 first review', 'REVIEW', () => legacy()),
  T('2 re-review', 'RE_REVIEW', () => {
    world.comments = [reviewComment(1, OLD.slice(0, 12), 1, '2026-01-01T10:00:00Z'), humanReply(2, 1, 'Why is a lock needed here?', '2026-01-01T10:05:00Z'), agentReply(3, 2, '2026-01-01T10:06:00Z')]
    reviewerObject = REREVIEW
    return legacy()
  }),
  T('3 zero-finding confirmation', 'RE_REVIEW', () => {
    quiet()
    world.comments = [reviewComment(1, OLD.slice(0, 12), 1, '2026-01-01T10:00:00Z')]
    reviewerObject = ZERO
    return legacy()
  }),
  T('4 reply-only', 'REPLY', () => {
    world.comments = [reviewComment(1, HEAD.slice(0, 12), 1, '2026-01-01T10:00:00Z'), humanReply(2, 1, 'Why is a lock needed here?', '2026-01-01T10:05:00Z')]
    return legacy()
  }),
  T('5 PR 24 reply-limit note', 'DEDUP_SKIP', () => {
    cfg.reply.maxComments = 2
    cfg.reply.limitPerReview = true
    world.comments = [
      reviewComment(1, HEAD.slice(0, 12), 2, '2026-01-01T10:00:00Z'),
      humanReply(2, 1, 'First question?', '2026-01-01T10:05:00Z'), agentReply(3, 2, '2026-01-01T10:06:00Z'),
      humanReply(4, 1, 'Second question?', '2026-01-01T10:10:00Z'), agentReply(5, 4, '2026-01-01T10:11:00Z'),
      humanReply(6, 1, 'Third question?', '2026-01-01T10:15:00Z'),
    ]
    return legacy()
  }),
  T('6 suggested fixes', 'REVIEW', () => {
    cfg.judge.suggestedFixes = true
    return legacy()
  }),
  T('7 force re-review', 'RE_REVIEW', () => {
    world.comments = [reviewComment(1, HEAD.slice(0, 12), 1, '2026-01-01T10:00:00Z')]
    reviewerObject = REREVIEW
    return legacy({ force: 're-review' })
  }),
  T('8 NO_CHANGE', 'NO_CHANGE', () => {
    world.comments = [reviewComment(1, OLD.slice(0, 12), 1, '2026-01-01T10:00:00Z')]
    reviewerObject = NO_CHANGE
    return legacy()
  }),
  T('9 bundled', 'REVIEW', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-id61-prompt-'))
    const promptPath = join(dir, 'prompt.txt')
    promptDirs.push(dir)
    writeFileSync(promptPath, 'Review the diff. Report defects the change introduces.\n')
    cfg.review.bundledReview = true
    cfg.anthropic.maxInputTokens = 6000
    cfg.anthropic.maxTokens = 100
    const bulky = BULK_PATHS.map(bulk)
    world.diff = bulky.map(b => b.diff).join('')
    world.stat = BULK_PATHS.map(path => ({ status: 'added', path }))
    world.files = Object.fromEntries(BULK_PATHS.map((path, i) => [path, bulky[i].content]))
    return legacy({ promptPath })
  }),
  T('10 benchmark', 'REVIEW', () => bench({ RB_CONFIG_J_TGAP: '1', RB_CONFIG_XROWS: '1', RB_CONFIG_LENSES: 'rel' })),
  T('11 dry-run', 'REVIEW', () => legacy({ dryRun: true })),
  T('12 PR holding inline artifacts', 'REVIEW', () => {
    world.comments = [
      { id: 1, content: { raw: '### Review summary\n*inline-summary v1 | maintained by the review agent*\n\n- **HIGH – Null user** (`src/pool.ts:2@aaa111222333`) · F1 · [thread](https://bitbucket.org/test/repo/pull-requests/100#comment-2)\n\n*inline-state v1 | n=1 | commits=aaa111222333 | sig=0123456789abcdef*' }, created_on: '2026-01-01T10:00:00Z', user: AGENT },
      { id: 2, content: { raw: '**HIGH – Null user**\n\nA null user crashes the load.\n\n*Finding F1 | opened at aaa111222333*' }, inline: { path: 'src/pool.ts', to: 2, from: null }, created_on: '2026-01-01T10:01:00Z', user: AGENT },
      { id: 3, parent: { id: 2 }, content: { raw: 'Fixed in the next push.' }, inline: { path: 'src/pool.ts', to: 2, from: null }, created_on: '2026-01-01T10:05:00Z', user: DEV },
      { id: 4, parent: { id: 2 }, content: { raw: 'Thanks, noted.\n\n*Answer on F1 | through 3*' }, inline: { path: 'src/pool.ts', to: 2, from: null }, created_on: '2026-01-01T10:06:00Z', user: AGENT },
    ]
    return legacy()
  }),
  T('13 prompt cache on', 'REVIEW', () => { cfg.review.promptCache = true; return legacy() }),
  T('14 lens recommendation on', 'REVIEW', () => { cfg.lenses.recommend = true; return legacy() }),
  T('15 prompt cache and lens recommendation on', 'REVIEW', () => { cfg.review.promptCache = true; cfg.lenses.recommend = true; return legacy() }),
]
const fixtureOf = (name: string) => `./__fixtures__/identity-v0061/${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`

describe('v0.0.61 identity (every setting off but the one a scenario names)', () => {
  it.each(SCENARIOS)('%s', async (name, action, run) => {
    const captured = await run() as { record: { action: string } }
    expect(captured.record.action, JSON.stringify((captured.record as any).skip_reason)).toBe(action)
    await expect(scrub(JSON.stringify(captured, visible, 2))).toMatchFileSnapshot(fixtureOf(name))
  })
})

describe('v0.0.61 identity: each scenario reached its intended path', () => {
  const run = async (name: string) => { const [, , go] = SCENARIOS.find(s => s[0] === name)!; return go() as Promise<any> }
  const posts = (c: any) => c.requests.filter((r: any) => r.method === 'POST')

  it('a first review posts one review comment and no reply', async () => {
    const c = await run('1 first review')
    expect(posts(c)).toHaveLength(1)
    expect(posts(c)[0].body.parent).toBeUndefined()
    expect(c.record.review_number).toBe(1)
  })
  it('a re-review reads the delta and posts review number 2', async () => {
    const c = await run('2 re-review')
    expect(c.requests.some((r: any) => /\/diff\/[0-9a-f]{40}\.\.[0-9a-f]{12}$/.test(r.url))).toBe(true)
    expect(posts(c)[0].body.content.raw).toContain('Review #2')
  })
  it('the 0-finding confirmation posts without a judge call', async () => {
    const c = await run('3 zero-finding confirmation')
    expect(c.calls.map((x: any) => x.stage)).toEqual(['review'])
    expect(posts(c)).toHaveLength(1)
  })
  it('reply-only answers under the human reply and runs no review call', async () => {
    const c = await run('4 reply-only')
    expect(c.calls).toEqual([])
    expect(c.completes).toHaveLength(1)
    expect(posts(c)[0].body.parent).toEqual({ id: 1 })
  })
  it('the reply-limit note posts under the newest reply parent with no model call', async () => {
    const c = await run('5 PR 24 reply-limit note')
    expect(c.calls).toEqual([])
    expect(c.completes).toEqual([])
    expect(posts(c)[0].body.content.raw).toContain('Reply limit of 2 reached for this review')
    expect(posts(c)[0].body.parent).toEqual({ id: 1 })
  })
  it('suggested fixes render at least one block', async () => {
    const c = await run('6 suggested fixes')
    expect(c.record.suggested_fixes.rendered).toBeGreaterThan(0)
    expect(posts(c)[0].body.content.raw).toContain('suggested-fix-v1')
  })
  it('a forced re-review on a reviewed head still posts', async () => {
    const c = await run('7 force re-review')
    expect(posts(c)).toHaveLength(1)
  })
  it('NO_CHANGE posts nothing', async () => {
    const c = await run('8 NO_CHANGE')
    expect(posts(c)).toEqual([])
  })
  it('the bundled path runs more than one reviewer call', async () => {
    const c = await run('9 bundled')
    expect(c.calls.filter((x: any) => x.stage === 'review').length).toBeGreaterThan(1)
    expect(posts(c)).toHaveLength(1)
  })
  it('a dry run posts nothing and prints the review', async () => {
    const c = await run('11 dry-run')
    expect(posts(c)).toEqual([])
    expect(c.dryRun).toContain('DRY RUN')
  })
  it('inline artifacts are not reviews: a legacy first review, review number 1', async () => {
    const c = await run('12 PR holding inline artifacts')
    expect(c.record.review_number).toBe(1)
    expect(posts(c)).toHaveLength(1)
    expect(c.calls.length).toBeGreaterThan(0)
  })
  it('the cache scenarios mark the reviewer, the lens scenarios log recommendations', async () => {
    expect((await run('13 prompt cache on')).record.prompt_cache.reviewer_marked).toBe(true)
    reset()
    const lens = await run('14 lens recommendation on')
    expect(lens.record.lens_recommendations).toEqual([{ lens: 'reliability', reason: 'Pool mutates shared state.' }])
    reset()
    const both = await run('15 prompt cache and lens recommendation on')
    expect(both.record.prompt_cache.reviewer_marked).toBe(true)
    expect(both.record.lens_recommendations).toEqual([{ lens: 'reliability', reason: 'Pool mutates shared state.' }])
  })
})

describe('v0.0.61 identity at the real config.ts defaults', () => {
  it('the inline settings read off, and that default matches every fixture', async () => {
    const saved = { ...process.env }
    // Keys must be unset (an empty string bypasses the default), and a missing dotenv file stops a developer .env refilling them.
    for (const k of ['ENABLE_INLINE_REVIEWS', 'ENABLE_INLINE_LOW_THREADS', 'AGENT_ACCOUNT_ID', 'MAX_FINDING_REPLIES']) delete process.env[k]
    process.env.DOTENV_CONFIG_PATH = 'D:/nonexistent/.env'
    process.env.ANTHROPIC_API_KEY ||= 'test-key'
    const { config: real } = await vi.importActual<typeof import('../config.js')>('../config.js')
    // Restored in place: replacing process.env leaves vitest's stubEnv restoring a stale object, which leaks stubs into later files in the worker.
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
    expect(real.review.inlineReviews).toBe(false)
    expect(real.review.inlineLowThreads).toBe(false)
    expect(real.review.inlineAgentAccountId).toBe('')
    expect(real.reply.maxFindingReplies).toBe(5)

    for (const [name, , run] of SCENARIOS) {
      reset()
      cfg.review.inlineReviews = real.review.inlineReviews
      cfg.review.inlineLowThreads = real.review.inlineLowThreads
      cfg.review.inlineAgentAccountId = real.review.inlineAgentAccountId
      cfg.reply.maxFindingReplies = real.reply.maxFindingReplies
      await expect(scrub(JSON.stringify(await run(), visible, 2))).toMatchFileSnapshot(fixtureOf(name))
    }
  }, 60_000)
})

describe('v0.0.61 identity with ENABLE_TOKEN_METRICS on (the key and the two console lines removed)', () => {
  it.each(SCENARIOS)('%s', async (name, _action, run) => {
    cfg.tokenMetrics = true
    const captured = await run() as any
    const rows = captured.record.token_metrics?.calls
    const made = (captured.calls?.length ?? 0) + (captured.completes?.length ?? 0)
    const lines = logSpy.mock.calls.map(c => c.join(' ')).filter(l => l.startsWith('Token metrics:'))
    // A skip before any estimate or call has nothing to measure, so the key stays absent.
    if (made === 0 && captured.record.action === 'DEDUP_SKIP') {
      expect(captured.record.token_metrics).toBeUndefined()
      expect(lines).toHaveLength(0)
    } else {
      expect(captured.record.token_metrics, 'the setting must add the key').toBeDefined()
      expect(rows.length).toBe(made)
      expect(lines).toHaveLength(1)
    }
    delete captured.record.token_metrics
    // Read-only compare: unlike toMatchFileSnapshot it can never write or rewrite a fixture.
    expect(scrub(JSON.stringify(captured, visible, 2))).toBe(readFileSync(new URL(fixtureOf(name), import.meta.url), 'utf-8').replace(/\r\n/g, '\n'))
  })
})
