import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Benchmark mode end to end for the HI and DX labels: real FSM, adapter and writer; only the model is mocked.

vi.mock('../config.js', () => ({
  config: {
    llmProvider: 'anthropic',
    vcsProvider: 'bitbucket',
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', baseUrl: '', maxRetries: 1, maxInputTokens: 250000, maxTokens: 32000 },
    judge: { model: 'claude-sonnet-5', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
    breadth: { enabled: true, model: '', effort: '', minFiles: 1, minUntouched: 0, benchmarkDeadlineSeconds: 840 },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 5 },
    review: { maxFindings: 0, splitCheck: true, todoScan: true, effort: '', enableNitpicks: false, secondLook: true },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: [], skipTargetBranches: [],
    diffExcludePatterns: ['*.lock', 'package-lock.json', '*.json', '*.spec.ts'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    bitbucket: { workspace: '', baseUrl: '', username: '', token: '' },
    azure: { org: '' },
  },
  modelContextWindow: () => 200_000,
}))

const completeStructured = vi.fn()
vi.mock('../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))
vi.mock('../review/findings-output.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../review/findings-output.js')>()
  return { ...actual, alsoAffectsRows: vi.fn(actual.alsoAffectsRows) }
})

import { runBenchmark } from '../benchmark.js'
import { alsoAffectsRows } from '../review/findings-output.js'
import { config } from '../config.js'
import { REVIEW_OUTPUT_SCHEMA } from '../review/client.js'
import type { ReviewObject, ReviewFinding } from '../review/formatter.js'

const cfg = config as any
const HEAD = 'c0ffee'.padEnd(40, '1')
const BASE = 'ba5e'.padEnd(40, '2')
const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DEFAULT_EXCLUDES = ['*.lock', 'package-lock.json', '*.json', '*.spec.ts']

const POOL = 'export class Pool {\n  conns: Conn[] = []\n  get() { return this.conns.pop() }\n  put(c: Conn) { this.conns.push(c) }\n}\n'
const CACHE = 'export const cache = new Map<string, Conn>()\nexport function take(k: string) {\n  return cache.get(k)\n}\n'
const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts', 'index 1111111..2222222 100644', '--- a/src/pool.ts', '+++ b/src/pool.ts', '@@ -1,3 +1,6 @@',
  ' export class Pool {', '+  conns: Conn[] = []', '+  get() { return this.conns.pop() }', '+  put(c: Conn) { this.conns.push(c) }', ' }',
  'diff --git a/src/cache.ts b/src/cache.ts', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/src/cache.ts', '@@ -0,0 +1,4 @@',
  '+export const cache = new Map<string, Conn>()', '+export function take(k: string) {', '+  return cache.get(k)', '+}', '',
].join('\n')

const REVIEW: ReviewObject = {
  summary: 'Adds a pool and a cache.', behavioral_diff: [], production_risk: [], unresolved_questions: [],
  findings: [{ severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put mutate conns without a lock; take() in src/cache.ts:3 hands out the same conn.' }],
}
const AA = (file: string, lines: string, where: string) => ({ file, lines, where })
const PASS: Record<string, ReviewFinding & { also_affects?: unknown; scenario?: string }> = {
  breadth: { severity: 'MEDIUM', title: 'Cache never evicts', file: 'src/cache.ts', lines: '1', body: 'Unbounded map.', also_affects: [AA('src/pool.ts', '2', '  conns array\n grows.')] },
  second_look: { severity: 'HIGH', title: 'Double put on retry', file: 'src/pool.ts', lines: '4', body: 'A retried put pushes twice.', scenario: 'repeat', also_affects: [AA('src/cache.ts', '3', 'take() hands out one conn twice'), AA('src/pool.ts', '3', 'own file')] },
}
const passOf = (system: string) => (system.includes('## SECOND LOOK') ? 'second_look' : system.includes('## BREADTH LENS') ? 'breadth' : '')

// A strict-schema model: an optional field comes back only when the schema asks for it.
function respond(opts: { judgeFails?: boolean; proposal?: string; review?: ReviewObject } = {}) {
  completeStructured.mockImplementation(async (system: string, user: string, schema: any) => {
    if (schema === REVIEW_OUTPUT_SCHEMA) return { object: opts.review ?? REVIEW, usage }
    if (schema.properties.decisions) {
      if (opts.judgeFails) throw new Error('Structured output missing required field(s): decisions')
      const ids = [...user.matchAll(/\[(c\d+)\]/g)].map(m => m[1])
      return { object: { decisions: ids.map(id => ({ candidate_id: id, reason_category: 'validated', evidence: 'src/pool.ts:2', note: 'ok', score: 8, ...(opts.proposal ? { proposal: opts.proposal } : {}) })), summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 }, usage }
    }
    const item = schema.properties.findings.items.properties
    const { also_affects, scenario, ...f } = PASS[passOf(system)]
    return { object: { findings: [{ ...f, ...(item.also_affects ? { also_affects } : {}), ...(item.scenario ? { scenario } : {}) }] }, usage }
  })
}

function fixture(diff = DIFF, extraFiles: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-hi-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  for (const [path, content] of Object.entries({ 'src/pool.ts': POOL, 'src/cache.ts': CACHE, ...extraFiles })) writeFileSync(join(repo, path), content)
  writeFileSync(join(dir, 'diff.patch'), diff)
  writeFileSync(join(dir, 'pr.json'), JSON.stringify({ repo: 'https://github.com/owner/repo', pr_number: 7, base: BASE, head: HEAD, nwo: 'owner/repo', title: 'Pool', body: 'Pool and cache.' }))
  return {
    RB_NWO: 'owner/repo', RB_PR_NUMBER: '7', RB_BASE: BASE, RB_HEAD: HEAD, RB_AGENT: 'my-agent',
    RB_REPO: repo, RB_DIFF: join(dir, 'diff.patch'), RB_PR_JSON: join(dir, 'pr.json'), RB_OUT: join(dir, 'out', 'findings.json'),
  }
}

const logSpy = vi.spyOn(console, 'log')
const warnSpy = vi.spyOn(console, 'warn')

async function run(labels: Record<string, string> = {}, setup: () => void = () => respond(), diff = DIFF, extraFiles: Record<string, string> = {}) {
  completeStructured.mockReset()
  setup()
  logSpy.mockClear()
  warnSpy.mockClear()
  const env = { ...fixture(diff, extraFiles), ...labels }
  await runBenchmark(env)
  const lines = logSpy.mock.calls.map(c => c.join(' '))
  const usageLine = lines.find(l => l.startsWith('\n=== Usage ==='))!
  const { timestamp: _t, duration_ms: _d, ...record } = JSON.parse(usageLine.slice(usageLine.indexOf('{')))
  return {
    record, raw: readFileSync(env.RB_OUT, 'utf-8'), rows: JSON.parse(readFileSync(env.RB_OUT, 'utf-8')).findings,
    calls: completeStructured.mock.calls.map(c => [...c]), stdout: lines.join('\n'), warns: warnSpy.mock.calls.map(c => String(c[0])),
    line: lines.find(l => l.startsWith('Benchmark settings:'))!,
  }
}

const row = (file: string, start: number, end: number, message: string) => ({ file, start_line: start, end_line: end, message, producer: 'my-agent' })
const RACE = 'Race on conns: get/put mutate conns without a lock; take() in src/cache.ts:3 hands out the same conn.'
const EVICT = 'Cache never evicts: Unbounded map.'
const DOUBLE = 'Double put on retry: A retried put pushes twice.'
const ORIGINALS = [row('src/pool.ts', 2, 3, RACE), row('src/cache.ts', 1, 1, EVICT), row('src/pool.ts', 4, 4, DOUBLE)]

beforeEach(() => {
  cfg.review = { maxFindings: 0, splitCheck: true, todoScan: true, effort: '', enableNitpicks: false, secondLook: true }
  cfg.judge = { model: 'claude-sonnet-5', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false }
  cfg.diffExcludePatterns = [...DEFAULT_EXCLUDES]
  cfg.anthropic.maxInputTokens = 250000
  cfg.benchmarkCounterpartRows = undefined
})

afterEach(() => { process.exitCode = undefined })

describe('HI label (end-to-end)', () => {
  const ALSO = [
    row('src/pool.ts', 2, 2, `${EVICT} Same defect here: conns array grows.`),
    row('src/cache.ts', 3, 3, `${DOUBLE} Same defect here: take() hands out one conn twice.`),
  ]

  it('HI=1 echoes hi=1 last and appends also-affects rows after the originals; the first-pass reviewer call is unchanged', async () => {
    const absent = await run()
    const one = await run({ RB_CONFIG_HI: '1' })

    expect(cfg.review.highImpact).toBe(true)
    expect(one.line).toBe(`${absent.line} hi=1`)
    expect(absent.rows).toEqual(ORIGINALS)
    expect(one.rows).toEqual([...ORIGINALS, ...ALSO])
    expect(one.calls[0][2]).toBe(REVIEW_OUTPUT_SCHEMA)
    expect(JSON.stringify(one.calls[0])).toBe(JSON.stringify(absent.calls[0]))
    expect(one.stdout).toContain('Also-affects rows: 2 of 3 entries (row 2, own_file 1)')
  })

  it('HI=1 records the lever, per-candidate scenario and also_affects, the row count and the per-entry log', async () => {
    const one = await run({ RB_CONFIG_HI: '1' })

    expect(one.record.recall_levers.high_impact).toBe(true)
    expect(one.record.review_candidates.map((c: any) => [c.origin, c.scenario, c.also_affects.length])).toEqual([['review', null, 0], ['breadth', null, 1], ['second_look', 'repeat', 2]])
    expect(one.record.also_affects_rows).toBe(2)
    expect(one.record.also_affects.map((e: any) => [e.parent, e.file, e.lines, e.status])).toEqual([
      ['Cache never evicts', 'src/pool.ts', '2', 'row'], ['Double put on retry', 'src/cache.ts', '3', 'row'], ['Double put on retry', 'src/pool.ts', '3', 'own_file'],
    ])
    expect('counterpart_rows' in one.record).toBe(false)
  })

  it('HI=0, and an invalid value with a warning, leave the settings line, calls, findings and record unchanged', async () => {
    const absent = await run()
    const zero = await run({ RB_CONFIG_HI: '0' })
    const typo = await run({ RB_CONFIG_HI: 'yes' })

    for (const other of [zero, typo]) {
      expect([other.line, JSON.stringify(other.calls), other.raw, JSON.stringify(other.record)]).toEqual([absent.line, JSON.stringify(absent.calls), absent.raw, JSON.stringify(absent.record)])
    }
    expect(typo.warns).toContain('  Ignoring config label RB_CONFIG_HI=yes: expected 0 or 1')
    expect(JSON.stringify(absent.record)).not.toMatch(/high_impact|also_affects|scenario/)
    expect(absent.line).not.toContain('hi=')
  })

  it('with XROWS=1 the order is originals, counterpart copies, then also-affects rows; hi=1 follows xrows=1', async () => {
    const one = await run({ RB_CONFIG_XROWS: '1', RB_CONFIG_HI: '1' })

    expect(one.line.endsWith(' xrows=1 hi=1')).toBe(true)
    expect(one.rows).toEqual([...ORIGINALS, row('src/cache.ts', 3, 3, RACE), ...ALSO])
    expect([one.record.counterpart_rows, one.record.also_affects_rows]).toEqual([1, 2])
  })

  it('with J_PROPOSAL=1 originals keep their proposal and also-affects rows never carry one', async () => {
    const one = await run({ RB_CONFIG_J_PROPOSAL: '1', RB_CONFIG_HI: '1' }, () => respond({ proposal: 'Guard with a mutex.' }))

    expect(one.rows.map((r: any) => r.proposal ?? null)).toEqual(['Guard with a mutex.', 'Guard with a mutex.', 'Guard with a mutex.', null, null])
    expect(one.rows.slice(3).every((r: any) => !('proposal' in r))).toBe(true)
  })

  it('a writer throw keeps the other rows, records also_affects_rows 0 and warns once', async () => {
    vi.mocked(alsoAffectsRows).mockImplementationOnce(() => { throw new Error('boom') })
    const one = await run({ RB_CONFIG_XROWS: '1', RB_CONFIG_HI: '1' })

    expect(one.rows).toEqual([...ORIGINALS, row('src/cache.ts', 3, 3, RACE)])
    expect([one.record.counterpart_rows, one.record.also_affects_rows, 'also_affects' in one.record]).toEqual([1, 0, false])
    expect(one.warns.filter(w => w.includes('Also-affects rows skipped'))).toEqual(['  Also-affects rows skipped, other rows kept: boom'])
  })

  it('also_affects invented on a first-pass reviewer finding (string, object or valid array) adds no row and logs []', async () => {
    for (const junk of ['src/cache.ts:3', AA('src/cache.ts', '3', 'take'), [AA('src/cache.ts', '3', 'take')]]) {
      const review = { ...REVIEW, findings: [{ ...REVIEW.findings[0], also_affects: junk }] } as unknown as ReviewObject
      const one = await run({ RB_CONFIG_HI: '1' }, () => respond({ review }))

      expect(one.rows).toEqual([...ORIGINALS, ...ALSO])
      expect(one.record.review_candidates[0].also_affects).toEqual([])
      expect(one.record.also_affects.some((e: any) => e.parent === 'Race on conns')).toBe(false)
    }
  })

  it('judge failure: no also-affects rows and no also-affects record keys', async () => {
    const one = await run({ RB_CONFIG_HI: '1' }, () => respond({ judgeFails: true }))

    expect(one.record.judge_status).toBe('failed')
    expect(one.rows).toEqual([row('src/pool.ts', 2, 3, RACE)])
    expect('also_affects_rows' in one.record || 'also_affects' in one.record).toBe(false)
    expect(one.stdout).not.toContain('Also-affects rows')
  })

  it('bundled review: no also-affects rows and no also-affects record keys', async () => {
    const section = (path: string, n: number) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${n} @@\n${Array.from({ length: n }, (_, i) => `+const line${i} = ${i};`).join('\n')}\n`
    const bundled = () => {
      cfg.review.bundledReview = true
      cfg.review.maxBundles = 8
      cfg.anthropic.maxInputTokens = 8000
      respond()
    }
    const one = await run({ RB_CONFIG_HI: '1' }, bundled, DIFF + section('src/big-one.ts', 380) + section('src/big-two.ts', 380))

    expect(one.stdout).toContain('switching to bundled review')
    expect(one.rows.length).toBeGreaterThan(0)
    expect(one.rows.some((r: any) => r.message.includes('Same defect here'))).toBe(false)
    expect('also_affects_rows' in one.record || 'also_affects' in one.record).toBe(false)
  })
})

describe('DX label (end-to-end)', () => {
  const plain = (path: string, line: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-old\n+${line}\n`
  const DX_DIFF = DIFF + plain('package.json', '  "files": ["dist"]') + plain('src/pool.spec.ts', 'it("pops", () => {})') + plain('yarn.lock', 'pool@1.0.0') + plain('dist/pool.min.js', 'var p=1')
  const reviewerUser = (r: Awaited<ReturnType<typeof run>>) => r.calls.find(c => c[2] === REVIEW_OUTPUT_SCHEMA)![1] as string

  it('DX=1 swaps in the generated-files list before the diff is filtered and echoes dx=1 last', async () => {
    const absent = await run({}, () => respond(), DX_DIFF)
    const one = await run({ RB_CONFIG_DX: '1' }, () => respond(), DX_DIFF)

    expect(cfg.diffExcludePatterns).toEqual(['*.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'go.sum', '*.min.js', '*.min.css', '*.map', '*.snap'])
    expect(one.line).toBe(`${absent.line} dx=1`)
    expect(reviewerUser(absent)).not.toMatch(/package\.json|pool\.spec\.ts/)
    expect(reviewerUser(one)).toContain('diff --git a/package.json b/package.json')
    expect(reviewerUser(one)).toContain('diff --git a/src/pool.spec.ts b/src/pool.spec.ts')
    expect(reviewerUser(one)).not.toMatch(/yarn\.lock|pool\.min\.js/)
    expect(one.stdout).toContain('Filtered 2 file(s) from diff (*.lock, package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, go.sum, *.min.js, *.min.css, *.map, *.snap)')
  })

  it('DX=0, and an invalid value with a warning, keep the configured list and leave everything unchanged', async () => {
    const absent = await run({}, () => respond(), DX_DIFF)
    const zero = await run({ RB_CONFIG_DX: '0' }, () => respond(), DX_DIFF)
    const typo = await run({ RB_CONFIG_DX: 'on' }, () => respond(), DX_DIFF)

    for (const other of [zero, typo]) {
      expect([other.line, JSON.stringify(other.calls), other.raw, JSON.stringify(other.record)]).toEqual([absent.line, JSON.stringify(absent.calls), absent.raw, JSON.stringify(absent.record)])
    }
    expect(cfg.diffExcludePatterns).toEqual(DEFAULT_EXCLUDES)
    expect(typo.warns).toContain('  Ignoring config label RB_CONFIG_DX=on: expected 0 or 1')
    expect(absent.line).not.toContain('dx=')
  })
})
