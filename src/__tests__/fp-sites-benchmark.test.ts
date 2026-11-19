import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// FP_SITES end to end: real FSM, adapter and writer; only the model is mocked.

vi.mock('../config.js', () => ({
  config: {
    llmProvider: 'anthropic',
    vcsProvider: 'bitbucket',
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-5-5', baseUrl: '', maxRetries: 1, maxInputTokens: 250000, maxTokens: 64000 },
    judge: { model: 'claude-haiku-5-5', maxRetries: 1, effort: 'high', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: true, model: '', effort: '', minFiles: 1, minUntouched: 0, benchmarkDeadlineSeconds: 840, judgeReserveSeconds: 270 },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 5 },
    review: { maxFindings: 0, splitCheck: true, todoScan: true, effort: 'high', enableNitpicks: false, secondLook: true, lineNumbers: true },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [], skipTargetBranches: [], onlyTargetBranches: [],
    diffExcludePatterns: ['*.lock'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    bitbucket: { workspace: '', baseUrl: '', username: '', token: '' },
    azure: { org: '' },
  },
  modelContextWindow: () => 1_000_000,
}))

const completeStructured = vi.fn()
vi.mock('../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))

import { runBenchmark } from '../benchmark.js'
import { config } from '../config.js'
import { REVIEW_OUTPUT_SCHEMA, findingsOutputSchema } from '../review/client.js'
import { FIRST_PASS_SITES_SECTION } from '../review/breadth.js'
import type { ReviewObject } from '../review/formatter.js'

const cfg = config as any
const BASELINE = structuredClone(cfg)
const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const POOL = 'export class Pool {\n  conns: Conn[] = []\n  get() { return this.conns.pop() }\n  put(c: Conn) { this.conns.push(c) }\n}\n'
const CACHE = 'export const cache = new Map<string, Conn>()\nexport function take(k: string) {\n  return cache.get(k)\n}\n'
const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts', 'index 1111111..2222222 100644', '--- a/src/pool.ts', '+++ b/src/pool.ts', '@@ -1,3 +1,6 @@',
  ' export class Pool {', '+  conns: Conn[] = []', '+  get() { return this.conns.pop() }', '+  put(c: Conn) { this.conns.push(c) }', ' }',
  'diff --git a/src/cache.ts b/src/cache.ts', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/src/cache.ts', '@@ -0,0 +1,4 @@',
  '+export const cache = new Map<string, Conn>()', '+export function take(k: string) {', '+  return cache.get(k)', '+}', '',
].join('\n')

// c0 is dropped by the judge, so any site named for it must produce no row and no log entry.
const REVIEW: ReviewObject = {
  summary: 'Adds a pool and a cache.', behavioral_diff: [], production_risk: [], unresolved_questions: [],
  findings: [
    { severity: 'LOW', title: 'Dead branch', file: 'src/pool.ts', lines: '4', body: 'Never taken.' },
    { severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put mutate conns without a lock; take() in src/cache.ts:3 hands out the same conn.' },
  ],
}
const site = (id: string, file: string, lines: string, where?: string) => ({ id, file, lines, ...(where === undefined ? {} : { where }) })
const BREADTH_SITES = [
  site('c0', 'src/cache.ts', '4', 'dropped parent'),
  site('c1', 'src/cache.ts', '3', 'same line as the XROWS copy'),
  site('c1', 'src/cache.ts', '1', 'same line as an original with another title'),
  site('c1', 'src/cache.ts', '2', 'take hands out a shared conn'),
  site('c1', 'src/pool.ts', '2', 'own file'),
  site('c7', 'src/cache.ts', '2', 'never briefed'),
  site('c1', 'src/cache.ts', '2'),
]
const SECOND_LOOK_SITES = [
  site('[C1]', 'src/cache.ts', '2', 'named again by second look'),
  site('c1', 'src/cache.ts', '4', 'same line as an also-affects row'),
]

const passOf = (system: string) => (system.includes('## SECOND LOOK') ? 'second_look' : system.includes('## BREADTH LENS') ? 'breadth' : '')

function respond() {
  completeStructured.mockImplementation(async (system: string, user: string, schema: any) => {
    if (schema === REVIEW_OUTPUT_SCHEMA) return { object: REVIEW, usage }
    if (schema.properties.decisions) {
      const ids = [...user.matchAll(/\[(c\d+)\]/g)].map(m => m[1])
      return { object: { decisions: ids.map(id => ({ candidate_id: id, reason_category: id === 'c0' ? 'incorrect' : 'validated', evidence: 'src/pool.ts:4', note: 'ok', score: 8 })), summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 }, usage }
    }
    const pass = passOf(system)
    const item = schema.properties.findings.items.properties
    const finding = pass === 'breadth'
      ? { severity: 'MEDIUM', title: 'Cache never evicts', file: 'src/cache.ts', lines: '1', body: 'Unbounded map.' }
      : { severity: 'HIGH', title: 'Double put on retry', file: 'src/pool.ts', lines: '4', body: 'A retried put pushes twice.', ...(item.also_affects ? { also_affects: [{ file: 'src/cache.ts', lines: '4', where: 'take twice' }] } : {}) }
    const sites = pass === 'breadth' ? BREADTH_SITES : SECOND_LOOK_SITES
    return { object: { findings: [finding], ...(schema.properties.first_pass_sites ? { first_pass_sites: sites } : {}) }, usage }
  })
}

function prFixture(diff = DIFF): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-fp-'))
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

async function run(labels: Record<string, string>, tweak: () => void = () => {}, diff = DIFF) {
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(cfg, structuredClone(BASELINE))
  completeStructured.mockReset()
  respond()
  logSpy.mockClear()
  warnSpy.mockClear()
  tweak()
  const env = { ...prFixture(diff), ...labels }
  await runBenchmark(env)
  const lines = logSpy.mock.calls.map(c => c.join(' '))
  const usageLine = lines.find(l => l.startsWith('\n=== Usage ==='))!
  const record = JSON.parse(usageLine.slice(usageLine.indexOf('{')))
  const calls = completeStructured.mock.calls.map(c => [...c])
  const callOf = (pass: string) => calls.find(c => passOf(c[0]) === pass)!
  return {
    record, rows: JSON.parse(readFileSync(env.RB_OUT, 'utf-8')).findings, calls, callOf, stdout: lines.join('\n'),
    line: lines.find(l => l.startsWith('Benchmark settings:'))!, warns: warnSpy.mock.calls.map(c => String(c[0])),
  }
}

const row = (file: string, start: number, message: string) => ({ file, start_line: start, end_line: start, message, producer: 'my-agent' })
const RACE = 'Race on conns: get/put mutate conns without a lock; take() in src/cache.ts:3 hands out the same conn.'
const HI_ON = { RB_CONFIG_XROWS: '1', RB_CONFIG_HI: '1' }

beforeEach(() => { logSpy.mockImplementation(() => {}); warnSpy.mockImplementation(() => {}) })
afterEach(() => { process.exitCode = undefined })

describe('FP_SITES label', () => {
  it('echoes fp_sites=1 right after hi=1 only when on; 0 and a typo change nothing', async () => {
    const off = await run(HI_ON)
    const on = await run({ ...HI_ON, RB_CONFIG_FP_SITES: '1' })
    const zero = await run({ ...HI_ON, RB_CONFIG_FP_SITES: '0' })
    const typo = await run({ ...HI_ON, RB_CONFIG_FP_SITES: 'yes' })

    expect(on.line).toBe(`${off.line} fp_sites=1`)
    expect(off.line).toMatch(/ hi=1$/)
    for (const other of [zero, typo]) {
      expect([other.line, JSON.stringify(other.calls), JSON.stringify(other.rows)]).toEqual([off.line, JSON.stringify(off.calls), JSON.stringify(off.rows)])
    }
    expect(typo.warns).toContain('  Ignoring config label RB_CONFIG_FP_SITES=yes: expected 0 or 1')
    expect(JSON.stringify(off.record)).not.toMatch(/first_pass_site|pass_calls/)
  })
})

describe('FP_SITES requests', () => {
  it('only breadth and second look change: the [cN] briefing, the block, the root schema property and tolerateMissing', async () => {
    const off = await run(HI_ON)
    const on = await run({ ...HI_ON, RB_CONFIG_FP_SITES: '1' })

    expect(JSON.stringify(on.calls[0])).toBe(JSON.stringify(off.calls[0]))
    expect(JSON.stringify(on.calls.at(-1))).toBe(JSON.stringify(off.calls.at(-1)))
    for (const pass of ['breadth', 'second_look']) {
      const [system, user, schema, opts] = on.callOf(pass)
      const [offSystem, offUser, , offOpts] = off.callOf(pass)
      expect(system).toBe(`${offSystem}\n\n${FIRST_PASS_SITES_SECTION}`)
      expect(user).toBe(offUser.replace('- src/pool.ts:4 — Dead branch', '- [c0] src/pool.ts:4 — Dead branch').replace('- src/pool.ts:2-3 — Race on conns', '- [c1] src/pool.ts:2-3 — Race on conns'))
      expect(schema.properties.first_pass_sites.items.required).toEqual(['id', 'file', 'lines', 'where'])
      expect(schema.required).toEqual(['findings'])
      expect(opts).toEqual({ ...offOpts, tolerateMissing: ['first_pass_sites'] })
    }
    expect(on.callOf('breadth')[2]).toBe(findingsOutputSchema({ alsoAffects: true, firstPassSites: true }))
    expect(on.callOf('second_look')[2]).toBe(findingsOutputSchema({ alsoAffects: true, scenario: true, firstPassSites: true }))
  })

  it('works without HI: breadth and second look get a sites-only schema and no item 4', async () => {
    const on = await run({ RB_CONFIG_FP_SITES: '1' })

    expect(on.callOf('breadth')[2]).toBe(findingsOutputSchema({ firstPassSites: true }))
    expect(on.callOf('second_look')[2]).toBe(findingsOutputSchema({ firstPassSites: true }))
    expect(on.callOf('second_look')[0]).not.toContain('What breaks in a real scenario')
    expect(on.rows.slice(3).map((r: any) => `${r.file}:${r.start_line}`)).toEqual(['src/cache.ts:3', 'src/cache.ts:2', 'src/cache.ts:4'])
    expect(on.stdout).toContain('First-pass site rows: 3 of 6 entries (row 3, duplicate 2, own_file 1)')
  })
})

describe('FP_SITES rows', () => {
  it('appends site rows last, only for kept parents, with one row per file and lines across both passes', async () => {
    const off = await run(HI_ON)
    const on = await run({ ...HI_ON, RB_CONFIG_FP_SITES: '1' })

    expect(on.rows.slice(0, off.rows.length)).toEqual(off.rows)
    expect(off.rows.map((r: any) => `${r.file}:${r.start_line}`)).toEqual(['src/pool.ts:2', 'src/cache.ts:1', 'src/pool.ts:4', 'src/cache.ts:3', 'src/cache.ts:4'])
    expect(on.rows.slice(off.rows.length)).toEqual([row('src/cache.ts', 2, `${RACE} Same defect here: take hands out a shared conn.`)])
    expect(on.stdout).toContain('First-pass site rows: 1 of 6 entries (duplicate 4, row 1, own_file 1)')
  })

  it('logs every entry under its own cN, never one shifted by the dropped c0, and records the counts', async () => {
    const on = await run({ ...HI_ON, RB_CONFIG_FP_SITES: '1' })

    expect(on.record.first_pass_sites.map((e: any) => [e.id, e.via, e.file, e.lines, e.status])).toEqual([
      ['c1', 'breadth', 'src/cache.ts', '3', 'duplicate'],
      ['c1', 'breadth', 'src/cache.ts', '1', 'duplicate'],
      ['c1', 'breadth', 'src/cache.ts', '2', 'row'],
      ['c1', 'breadth', 'src/pool.ts', '2', 'own_file'],
      ['c1', 'second_look', 'src/cache.ts', '2', 'duplicate'],
      ['c1', 'second_look', 'src/cache.ts', '4', 'duplicate'],
    ])
    expect(on.record.first_pass_sites.every((e: any) => e.parent === 'Race on conns')).toBe(true)
    expect(on.record.first_pass_site_rows).toBe(1)
    expect(on.record.also_affects_rows).toBe(1)
    expect(on.record.first_pass_sites_named.map((e: any) => `${e.id}@${e.via}:${e.file}:${e.lines}`)).toEqual([
      'c0@breadth:src/cache.ts:4', 'c1@breadth:src/cache.ts:3', 'c1@breadth:src/cache.ts:1', 'c1@breadth:src/cache.ts:2', 'c1@breadth:src/pool.ts:2', 'c1@second_look:src/cache.ts:2', 'c1@second_look:src/cache.ts:4',
    ])
    expect(on.record.recall_levers.first_pass_sites).toBe(true)
    expect(on.record.first_pass_sites_dropped).toEqual({ breadth: { unknown_id: 1, bad_where: 1 }, second_look: {} })
    expect(on.stdout).toContain('  Breadth sites: 5 place(s) for 2 first-pass finding(s), dropped 2 (unknown_id 1, bad_where 1)')
    expect(on.stdout).toContain('  Second-look sites: 2 place(s) for 1 first-pass finding(s), dropped 0')
    expect(on.record.pass_calls.map((c: any) => [c.stage, c.end, c.max_tokens, c.limit_ms])).toEqual([
      ['review', 'ok', 64000, null], ['breadth', 'ok', 64000, null], ['second_look', 'ok', 64000, null], ['judge', 'ok', 64000, null],
    ])
  })

  it('sites never reach the judge or a candidate', async () => {
    const off = await run(HI_ON)
    const on = await run({ ...HI_ON, RB_CONFIG_FP_SITES: '1' })

    expect(on.calls.at(-1)![1]).toBe(off.calls.at(-1)![1])
    expect(JSON.stringify(on.record.review_candidates)).toBe(JSON.stringify(off.record.review_candidates))
    expect(JSON.stringify(on.record.anchored_findings)).toBe(JSON.stringify(off.record.anchored_findings))
  })
})

describe('pass_calls on a bundled benchmark run', () => {
  it('records each bundle reviewer and judge call; no extra pass runs and no site rows are written', async () => {
    const section = (path: string, n: number) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+const line${i} = ${i};`).join('\n')}\n`
    const bundled = () => {
      cfg.review.bundledReview = true
      cfg.review.maxBundles = 8
      cfg.anthropic.maxInputTokens = 8000
    }
    const on = await run({ RB_CONFIG_FP_SITES: '1' }, bundled, DIFF + section('src/big-one.ts', 380) + section('src/big-two.ts', 380))

    expect(on.stdout).toContain('switching to bundled review')
    const stages = on.record.pass_calls.map((c: any) => `${c.stage}:${c.end}`)
    expect(on.stdout).toContain('Bundled review: 1 bundle(s)')
    expect(stages).toEqual(['review:ok', 'judge:ok'])
    expect(on.record.first_pass_sites_named).toBeNull()
    expect('first_pass_site_rows' in on.record).toBe(false)
  })
})
