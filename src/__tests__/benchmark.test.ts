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
    judge: { model: 'claude-sonnet-5', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
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
  modelContextWindow: () => 200_000,
}))

const completeStructured = vi.fn()
vi.mock('../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })),
}))

import { runBenchmark } from '../benchmark.js'
import { config } from '../config.js'
import { REVIEW_OUTPUT_SCHEMA } from '../claude/client.js'
import type { ReviewObject } from '../review/formatter.js'
import type { JudgeOutput } from '../review/judge-decisions.js'

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

const JUDGED: JudgeOutput = {
  decisions: [
    { candidate_id: 'c0', reason_category: 'validated', evidence: 'src/pool.ts:2-3 `this.conns.pop()`', note: 'Unsynchronized mutation.', score: 9 },
    { candidate_id: 'c1', reason_category: 'validated', evidence: '', note: 'No tests were added.', score: 6 },
    { candidate_id: 'c2', reason_category: 'unconfirmed_high', evidence: 'src/pool.ts:4', note: 'No confirmed crash.', score: 7 },
    { candidate_id: 'c3', reason_category: 'unverifiable', evidence: '', note: 'Line 9 is not in the diff.', score: 2 },
  ],
  summary: 'Adds an unsynchronized pool.',
  behavioral_diff: ['Pool added.'],
  production_risk: ['Races under load.'],
  unresolved_questions: [],
  merge_confidence: 70,
}

function mockModel(review: ReviewObject = REVIEW, judged: JudgeOutput = JUDGED) {
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
  cfg.anthropic.maxInputTokens = 250000
  cfg.judge ={ model: 'claude-sonnet-5', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false }
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

  it('keeps the reviewer anchor when the judge rewrites a kept body', async () => {
    mockModel(REVIEW, {
      ...JUDGED,
      decisions: [{ ...JUDGED.decisions[0], rewritten_body: 'conns races between get and put.' }, ...JUDGED.decisions.slice(1)],
    })
    const env = fixture()

    await runBenchmark(env)

    expect(readOut(env).findings[0]).toEqual({ file: 'src/pool.ts', start_line: 2, end_line: 3, message: 'Race on conns: conns races between get and put.', producer: 'my-agent' })
  })

  it('drops candidates the judge never ruled on and warns with the count', async () => {
    mockModel(REVIEW, { ...JUDGED, decisions: [JUDGED.decisions[0]] })
    const warnSpy = vi.spyOn(console, 'warn')
    const env = fixture()

    await runBenchmark(env)

    expect(readOut(env).findings.map((f: any) => f.message.split(':')[0])).toEqual(['Race on conns'])
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('undecided 3')
    warnSpy.mockRestore()
  })

  it('keeps unverifiable candidates only when ENABLE_JUDGE_KEEP_UNVERIFIED is on, and logs the flag', async () => {
    cfg.judge.policy.keepUnverified = true
    const env = fixture()

    await runBenchmark(env)

    expect(readOut(env).findings.map((f: any) => f.message.split(':')[0])).toEqual(['Race on conns', 'Cited by basename', 'Speculative leak'])
    const stdout = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(stdout).toContain('judge_keep_unverified=true')
    expect(stdout).toContain('judge_keep_minor=false')
  })

  it('gives the judge id-tagged candidates, and the file context only with ENABLE_JUDGE_FILE_CONTEXT', async () => {
    await runBenchmark(fixture())
    const judgeUser = completeStructured.mock.calls[1][1] as string
    expect(judgeUser).toContain('- [c0] **MEDIUM – Race on conns**')
    expect(judgeUser).toContain('- [c3] **MEDIUM – Speculative leak**')
    expect(judgeUser).not.toContain('## Full file context')

    completeStructured.mockClear()
    cfg.judge.fileContext = true
    await runBenchmark(fixture())
    expect(completeStructured.mock.calls[1][1]).toContain('## Full file context:\n\n### src/pool.ts')
  })
})

describe('benchmark anchors: reviewer first, judge fallback, otherwise dropped and warned', () => {
  const messages = (env: Record<string, string>) => readOut(env).findings.map((f: any) => f.message.split(':')[0])
  const warnings = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(c => c.join(' ')).join('\n')

  it('anchors a locationless reviewer finding from the judge pair on a changed line', async () => {
    mockModel(REVIEW, { ...JUDGED, decisions: [JUDGED.decisions[0], { ...JUDGED.decisions[1], anchor_file: 'src/pool.ts', anchor_lines: '4' }, ...JUDGED.decisions.slice(2)] })
    const env = fixture()

    await runBenchmark(env)

    expect(readOut(env).findings).toEqual([
      { file: 'src/pool.ts', start_line: 2, end_line: 3, message: 'Race on conns: get/put mutate conns without a lock.', producer: 'my-agent' },
      { file: 'src/pool.ts', start_line: 4, end_line: 4, message: 'PR-level concern: No tests for the pool.', producer: 'my-agent' },
      { file: 'src/pool.ts', start_line: 4, end_line: 4, message: 'Cited by basename: put accepts null.', producer: 'my-agent' },
    ])
  })

  it('drops a judge anchor that points at an unchanged context line', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    // Line 5 (` }`) is context, not an added line — the judge channel is diff-validated, so it falls through.
    mockModel(REVIEW, { ...JUDGED, decisions: [JUDGED.decisions[0], { ...JUDGED.decisions[1], anchor_file: 'src/pool.ts', anchor_lines: '5' }, ...JUDGED.decisions.slice(2)] })
    const env = fixture()

    await runBenchmark(env)

    expect(messages(env)).toEqual(['Race on conns', 'Cited by basename'])
    expect(warnings(warnSpy)).toContain('PR-level concern')
    warnSpy.mockRestore()
  })

  it('drops a kept finding that neither the reviewer nor the judge located, and warns by title', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const env = fixture()

    await runBenchmark(env)

    expect(messages(env)).toEqual(['Race on conns', 'Cited by basename'])
    expect(warnings(warnSpy)).toContain('Parse check: 1 kept finding(s) with no usable file:line')
    expect(warnings(warnSpy)).toContain('PR-level concern')
    warnSpy.mockRestore()
  })

  it('does not anchor a symbol that merely contains a digit, and the judge pair replaces it', async () => {
    const symbolic: ReviewObject = { ...REVIEW, findings: [{ ...REVIEW.findings[0], lines: 'Phase 4 idiomisation block' }] }
    const warnSpy = vi.spyOn(console, 'warn')
    mockModel(symbolic, { ...JUDGED, decisions: [JUDGED.decisions[0]] })
    const unanchoredEnv = fixture()

    await runBenchmark(unanchoredEnv)

    expect(readOut(unanchoredEnv).findings).toEqual([])
    expect(warnings(warnSpy)).toContain('Parse check: 1 kept finding(s)')

    mockModel(symbolic, { ...JUDGED, decisions: [{ ...JUDGED.decisions[0], anchor_file: 'src/pool.ts', anchor_lines: '3' }] })
    const rescuedEnv = fixture()

    await runBenchmark(rescuedEnv)

    expect(readOut(rescuedEnv).findings).toEqual([
      { file: 'src/pool.ts', start_line: 3, end_line: 3, message: 'Race on conns: get/put mutate conns without a lock.', producer: 'my-agent' },
    ])
    warnSpy.mockRestore()
  })
})

describe('benchmark bundled review (prose merge path)', () => {
  const section = (path: string, lines: number) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+const line${i} = ${i};`).join('\n')}\n`
  const BUNDLED_DIFF = DIFF + section('src/big-one.ts', 380) + section('src/big-two.ts', 380)

  beforeEach(() => {
    cfg.review.bundledReview = true
    cfg.review.maxBundles = 8
    cfg.anthropic.maxInputTokens = 8000
  })

  it('reads a bundled outcome through the prose merge, not the structured judged findings', async () => {
    // Only the bundle holding pool.ts finds anything, as in a real PR where bundles cover disjoint files.
    completeStructured.mockImplementation(async (_system: string, user: string, schema: unknown) =>
      ({ object: schema !== REVIEW_OUTPUT_SCHEMA ? JUDGED : user.includes('src/pool.ts') ? REVIEW : { ...REVIEW, findings: [] }, usage }))
    const env = fixture({ diff: BUNDLED_DIFF })

    await runBenchmark(env)

    const stdout = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(stdout).toContain('switching to bundled review')
    expect(stdout).toMatch(/Merge: bullets \d+ \(located/)
    expect(stdout).not.toContain('Benchmark findings: reviewer')
    const out = readOut(env)
    expectAccepted(out)
    expect(out.findings.map((f: any) => `${f.file}:${f.start_line}-${f.end_line} ${f.message.split(':')[0]}`).sort()).toEqual([
      'src/pool.ts:2-3 Race on conns',
      'src/pool.ts:4-4 Cited by basename',
    ])
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
      throw new Error('Structured output missing required field(s): decisions')
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
