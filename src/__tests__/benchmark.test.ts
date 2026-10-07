import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// End-to-end benchmark mode: real FSM, prompt loader, context fetch and filesystem adapter; only the model is mocked.

vi.mock('../config.js', () => ({
  config: {
    llmProvider: 'anthropic',
    vcsProvider: 'bitbucket',
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', baseUrl: '', maxRetries: 1, maxInputTokens: 250000, maxTokens: 32000 },
    judge: { model: 'claude-sonnet-5', maxRetries: 1, effort: '' },
    agentIdentity: 'test-bot',
    reply: { maxComments: 5 },
    review: { maxFindings: 0, splitCheck: true, todoScan: true, effort: '' },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: ['main', 'master', 'release/*', 'hotfix/*'],
    skipTargetBranches: ['main', 'master'],
    diffExcludePatterns: ['*.lock', 'package-lock.json', '*.json', '*.spec.ts'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    bitbucket: { workspace: '', baseUrl: '', username: '', token: '' },
    azure: { org: '' },
  },
}))

const completeStructured = vi.fn()
vi.mock('../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })),
}))

import { runBenchmark } from '../benchmark.js'
import { config } from '../config.js'
import { REVIEW_OUTPUT_SCHEMA } from '../claude/client.js'
import type { ReviewObject } from '../review/formatter.js'

const cfg = config as any
const HEAD = 'c0ffee'.padEnd(40, '1')
const BASE = 'ba5e'.padEnd(40, '2')
const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts',
  'index 1111111..2222222 100644',
  '--- a/src/pool.ts',
  '+++ b/src/pool.ts',
  '@@ -1,3 +1,6 @@',
  ' export class Pool {',
  '+  conns: Conn[] = []',
  '+  get() { return this.conns.pop() }',
  '+  put(c: Conn) { this.conns.push(c) }',
  ' }',
  '',
].join('\n')

const REVIEW: ReviewObject = {
  summary: 'Adds an unsynchronized pool.',
  findings: [
    { severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put mutate conns without a lock.' },
    { severity: 'LOW', title: 'PR-level concern', body: 'No tests for the pool.' },
    { severity: 'HIGH', title: 'Cited by basename', file: 'pool.ts', lines: '4', body: 'put accepts null.' },
    { severity: 'MEDIUM', title: 'Speculative leak', file: 'src/pool.ts', lines: '9', body: 'Might leak.' },
  ],
  behavioral_diff: ['Pool added.'],
  production_risk: ['Races under load.'],
  unresolved_questions: ['Is Pool shared across workers?'],
}

const JUDGED = {
  review_markdown: [
    '### Summary', 'Adds an unsynchronized pool.', '',
    '### Findings',
    '- **MEDIUM – Race on conns** (`src/pool.ts:2-3`)', '  get/put mutate conns without a lock.',
    '- **LOW – PR-level concern**', '  No tests for the pool.',
    '- **MEDIUM – Cited by basename** (pool.ts:4)', '  put accepts null.', '',
    '### Merge Confidence: 70%',
  ].join('\n'),
  judge_notes: 'Dropped Speculative leak — line 9 is not in the diff.',
  finding_scores: [
    { title: 'Race on conns', severity: 'MEDIUM', score: 9 },
    { title: 'PR-level concern', severity: 'LOW', score: 6 },
    { title: 'Cited by basename', severity: 'MEDIUM', score: 7 },
  ],
}

function mockModel(review: ReviewObject = REVIEW, judged = JUDGED) {
  completeStructured.mockImplementation(async (_system: string, _user: string, schema: unknown) =>
    ({ object: schema === REVIEW_OUTPUT_SCHEMA ? review : judged, usage }))
}

function fixture(opts: { diff?: string | null; prJson?: unknown } = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-e2e-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'pool.ts'), 'export class Pool {\n  conns: Conn[] = []\n  get() { return this.conns.pop() }\n  put(c: Conn) { this.conns.push(c) }\n}\n')
  if (opts.diff !== null) writeFileSync(join(dir, 'diff.patch'), opts.diff ?? DIFF)
  const prJson = opts.prJson === undefined
    ? { repo: 'https://github.com/owner/repo', pr_number: 1938, base: BASE, head: HEAD, nwo: 'owner/repo', title: 'Add pool', body: 'Connection pool.' }
    : opts.prJson
  if (prJson !== null) writeFileSync(join(dir, 'pr.json'), JSON.stringify(prJson))
  return {
    RB_NWO: 'owner/repo', RB_PR_NUMBER: '1938', RB_BASE: BASE, RB_HEAD: HEAD, RB_AGENT: 'my-agent',
    RB_REPO: repo, RB_DIFF: join(dir, 'diff.patch'), RB_PR_JSON: join(dir, 'pr.json'), RB_OUT: join(dir, 'out', 'findings.json'),
  }
}

const readOut = (env: Record<string, string>) => JSON.parse(readFileSync(env.RB_OUT, 'utf-8'))

// The same checks scripts/try-agent.sh applies before accepting a findings file.
function expectAccepted(out: any) {
  expect(Object.keys(out).sort()).toEqual(['agent', 'findings', 'pr'])
  expect(out.pr).toEqual({ repo: expect.any(String), pr_number: 1938, base: BASE, head: HEAD })
  expect(out.agent).toBe('my-agent')
  expect(Array.isArray(out.findings)).toBe(true)
  for (const f of out.findings) {
    expect(Object.keys(f).sort()).toEqual(['end_line', 'file', 'message', 'producer', 'start_line'])
    expect(typeof f.file).toBe('string')
    expect(f.file.startsWith('./') || f.file.startsWith('/')).toBe(false)
    expect(Number.isInteger(f.start_line) && Number.isInteger(f.end_line)).toBe(true)
    expect(f.end_line).toBeGreaterThanOrEqual(f.start_line)
    expect(typeof f.message).toBe('string')
    expect(f.producer).toBe('my-agent')
  }
}

const logSpy = vi.spyOn(console, 'log')

beforeEach(() => {
  logSpy.mockClear()
  completeStructured.mockReset()
  mockModel()
  cfg.vcsProvider = 'bitbucket'
  cfg.anthropic.model = 'claude-haiku-4-5-20251001'
  cfg.judge = { model: 'claude-sonnet-5', maxRetries: 1, effort: '' }
  cfg.review = { maxFindings: 0, splitCheck: true, todoScan: true, effort: '' }
  cfg.skipSourceBranches = ['main', 'master', 'release/*', 'hotfix/*']
  cfg.skipTargetBranches = ['main', 'master']
  cfg.thresholds = { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 }
})

afterEach(() => {
  process.exitCode = undefined
})

describe('benchmark mode end-to-end (model + judge mocked)', () => {
  it('writes judge-filtered, line-anchored findings to RB_OUT in the ReviewBench schema', async () => {
    const env = fixture()

    await expect(runBenchmark(env)).resolves.toBeUndefined()

    const out = readOut(env)
    expectAccepted(out)
    expect(out.pr.repo).toBe('https://github.com/owner/repo')
    expect(out.findings).toEqual([
      { file: 'src/pool.ts', start_line: 2, end_line: 3, message: 'Race on conns: get/put mutate conns without a lock.', producer: 'my-agent' },
      { file: 'src/pool.ts', start_line: 4, end_line: 4, message: 'Cited by basename: put accepts null.', producer: 'my-agent' },
    ])
    expect(completeStructured).toHaveBeenCalledTimes(2)
  })

  it('feeds the reviewer the mounted diff and checkout context, as a first review', async () => {
    await runBenchmark(fixture())

    const [system, user] = completeStructured.mock.calls[0]
    expect(user).toContain('## Pull Request: Add pool')
    expect(user).toContain('+  get() { return this.conns.pop() }')
    expect(user).toContain('## Full file context:\n\n### src/pool.ts')
    expect(user).not.toContain('Previous Review')
    expect(system).not.toContain('## SPLIT CHECK')
  })

  it('applies RB_CONFIG_* labels and echoes their values to stdout', async () => {
    const env = { ...fixture(), RB_CONFIG_MODEL: 'claude-opus-5', RB_CONFIG_EFFORT: 'high', RB_CONFIG_JUDGE_MODEL: 'claude-sonnet-5' }

    await runBenchmark(env)

    expect(completeStructured.mock.calls[0][3]).toMatchObject({ model: 'claude-opus-5', effort: 'high' })
    expect(completeStructured.mock.calls[1][3]).toMatchObject({ model: 'claude-sonnet-5' })
    const stdout = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(stdout).toContain('model=claude-opus-5')
    expect(stdout).toContain('effort=high')
  })

  it('emits every line-anchored reviewer finding when no judge is configured', async () => {
    cfg.judge.model = ''
    const env = fixture()

    await runBenchmark(env)

    expect(completeStructured).toHaveBeenCalledTimes(1)
    expect(readOut(env).findings.map((f: any) => f.message.split(':')[0])).toEqual(['Race on conns', 'Cited by basename', 'Speculative leak'])
  })

  it('reviews a PR over the default MAX_CHANGED_LINES — a skipped PR scores zero', async () => {
    const big = DIFF + Array.from({ length: 3100 }, (_, i) => `+line ${i}`).join('\n') + '\n'
    const env = fixture({ diff: big })

    await runBenchmark(env)

    expect(completeStructured).toHaveBeenCalled()
    expect(readOut(env).findings.length).toBeGreaterThan(0)
  })
})

describe('benchmark mode fail-safe', () => {
  it('writes findings: [] and resolves when the model call fails', async () => {
    completeStructured.mockRejectedValue(new Error('529 overloaded'))
    const env = fixture()

    await expect(runBenchmark(env)).resolves.toBeUndefined()

    const out = readOut(env)
    expectAccepted(out)
    expect(out.findings).toEqual([])
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('falls back to the unjudged reviewer findings when the judge fails (not empty)', async () => {
    completeStructured.mockImplementation(async (_s: string, _u: string, schema: unknown) => {
      if (schema === REVIEW_OUTPUT_SCHEMA) return { object: REVIEW, usage }
      throw new Error('Structured output missing required field(s): finding_scores')
    })
    const env = fixture()

    await expect(runBenchmark(env)).resolves.toBeUndefined()

    const out = readOut(env)
    expectAccepted(out)
    // judge errored → keep the reviewer's line-anchored findings rather than zeroing the PR
    expect(out.findings.map((f: any) => f.message.split(':')[0])).toEqual(['Race on conns', 'Cited by basename', 'Speculative leak'])
  })

  it('writes findings: [] when the diff is missing, without calling the model', async () => {
    const env = fixture({ diff: null })

    await expect(runBenchmark(env)).resolves.toBeUndefined()

    expectAccepted(readOut(env))
    expect(readOut(env).findings).toEqual([])
    expect(completeStructured).not.toHaveBeenCalled()
  })

  it('writes findings: [] when the review is skipped (nothing reviewable)', async () => {
    const lockOnly = 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1,2 @@\n+{}\n'
    const env = fixture({ diff: lockOnly })

    await runBenchmark(env)

    expect(readOut(env).findings).toEqual([])
    expect(completeStructured).not.toHaveBeenCalled()
  })

  it('takes head and pr_number from env, and the repo from RB_NWO, when pr.json is absent', async () => {
    completeStructured.mockRejectedValue(new Error('boom'))
    const env = fixture({ prJson: null })

    await runBenchmark(env)

    const out = readOut(env)
    expectAccepted(out)
    expect(out.pr.repo).toBe('https://github.com/owner/repo')
  })
})
