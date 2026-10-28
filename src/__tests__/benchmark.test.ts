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
    breadth: { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3, benchmarkDeadlineSeconds: 840 },
    agentIdentity: 'test-bot',
    reply: { maxComments: 5 },
    review: { maxFindings: 0, splitCheck: true, todoScan: true, effort: '', enableNitpicks: false },
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
import { REVIEW_OUTPUT_SCHEMA, BREADTH_OUTPUT_SCHEMA } from '../claude/client.js'
import { estimateCost } from '../review/usage.js'
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
  cfg.breadth = { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3, benchmarkDeadlineSeconds: 840 }
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
    expect(stdout).toContain('j_unver=1')
    expect(stdout).toContain('j_minor=0')
  })

  it('sets the four flags from short 0/1 labels and echoes them', async () => {
    const env = { ...fixture(), RB_CONFIG_NITS: '1', RB_CONFIG_J_MINOR: '1', RB_CONFIG_J_UNVER: '1', RB_CONFIG_J_CTX: '0' }

    await runBenchmark(env)

    expect(cfg.review.enableNitpicks).toBe(true)
    expect(cfg.judge.policy).toEqual({ keepMinor: true, keepUnverified: true })
    expect(cfg.judge.fileContext).toBe(false)
    expect(logSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('nits=1 j_minor=1 j_unver=1 j_ctx=0 lnum=0')
  })

  it('LNUM=1 numbers the diff the reviewer sees and is echoed', async () => {
    await runBenchmark({ ...fixture(), RB_CONFIG_LNUM: '1' })

    expect(cfg.review.lineNumbers).toBe(true)
    expect(completeStructured.mock.calls[0][1]).toContain('    2 +  conns: Conn[] = []')   // reviewer
    expect(completeStructured.mock.calls[1][1]).toContain('    2 +  conns: Conn[] = []')   // judge
    expect(logSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('lnum=1')
  })

  it('ignores a flag label that is not 0 or 1, and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    const env = { ...fixture(), RB_CONFIG_J_MINOR: 'true' }

    await runBenchmark(env)

    expect(cfg.judge.policy.keepMinor).toBe(false)
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('RB_CONFIG_J_MINOR=true: expected 0 or 1')
    warnSpy.mockRestore()
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

  it('places a kept file-level finding (file, no line) on the file’s first changed line', async () => {
    const fileLevel: ReviewObject = { ...REVIEW, findings: [REVIEW.findings[0], { ...REVIEW.findings[1], file: 'src/pool.ts' }, ...REVIEW.findings.slice(2)] }
    mockModel(fileLevel)
    const env = fixture()

    await runBenchmark(env)

    expect(readOut(env).findings[1]).toEqual({ file: 'src/pool.ts', start_line: 2, end_line: 2, message: 'PR-level concern: No tests for the pool.', producer: 'my-agent' })
    expect(logSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('1 placed on the file\'s first changed line')
  })

  it('rejects a judge line on an unchanged context line but keeps its changed file for file-level placement', async () => {
    // Line 5 (` }`) is context, not an added line — the judge channel is diff-validated, so the line is not used.
    mockModel(REVIEW, { ...JUDGED, decisions: [JUDGED.decisions[0], { ...JUDGED.decisions[1], anchor_file: 'src/pool.ts', anchor_lines: '5' }, ...JUDGED.decisions.slice(2)] })
    const env = fixture()

    await runBenchmark(env)

    expect(readOut(env).findings[1]).toEqual({ file: 'src/pool.ts', start_line: 2, end_line: 2, message: 'PR-level concern: No tests for the pool.', producer: 'my-agent' })
  })

  it('still drops a kept finding whose judge-named file is not in the diff', async () => {
    const warnSpy = vi.spyOn(console, 'warn')
    mockModel(REVIEW, { ...JUDGED, decisions: [JUDGED.decisions[0], { ...JUDGED.decisions[1], anchor_file: 'src/elsewhere.ts', anchor_lines: '5' }, ...JUDGED.decisions.slice(2)] })
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

  it('never reads a digit inside a symbol as a line: file-level fallback instead, and the judge pair replaces it', async () => {
    const symbolic: ReviewObject = { ...REVIEW, findings: [{ ...REVIEW.findings[0], lines: 'Phase 4 idiomisation block' }] }
    const warnSpy = vi.spyOn(console, 'warn')
    mockModel(symbolic, { ...JUDGED, decisions: [JUDGED.decisions[0]] })
    const unanchoredEnv = fixture()

    await runBenchmark(unanchoredEnv)

    // Line 2 is the file's first changed line, not the "4" from "Phase 4".
    expect(readOut(unanchoredEnv).findings).toEqual([
      { file: 'src/pool.ts', start_line: 2, end_line: 2, message: 'Race on conns: get/put mutate conns without a lock.', producer: 'my-agent' },
    ])
    expect(warnings(warnSpy)).not.toContain('Parse check')

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

describe('breadth review (end-to-end)', () => {
  const FILES = ['a', 'b', 'c', 'd', 'e']
  const multiDiff = FILES.map(n => `diff --git a/src/${n}.ts b/src/${n}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/${n}.ts\n@@ -0,0 +1,2 @@\n+export const ${n} = 1\n+export const ${n}2 = 2\n`).join('')
  const firstPass: ReviewObject = { summary: 's', findings: [{ severity: 'MEDIUM', title: 'A bug', file: 'src/a.ts', lines: '1', body: 'a is wrong.' }], behavioral_diff: [], production_risk: [], unresolved_questions: [] }
  const breadthOut = { findings: [{ severity: 'MEDIUM', title: 'Same bug in b', file: 'src/b.ts', lines: '1', body: 'b repeats a.' }] }
  const keepAll = (n: number): JudgeOutput => ({
    decisions: Array.from({ length: n }, (_, i) => ({ candidate_id: `c${i}`, reason_category: 'validated', evidence: 'src/x.ts:1', note: 'n', score: 8 })),
    summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80,
  })
  const multiFixture = () => {
    const env = fixture({ diff: multiDiff })
    for (const n of FILES) writeFileSync(join(env.RB_REPO, 'src', `${n}.ts`), `export const ${n} = 1\nexport const ${n}2 = 2\n`)
    return env
  }
  const respond = (review: ReviewObject, breadth: unknown, judged: JudgeOutput | Error) =>
    completeStructured.mockImplementation(async (_s: string, _u: string, schema: unknown) => {
      if (schema === REVIEW_OUTPUT_SCHEMA) return { object: review, usage }
      if (schema === BREADTH_OUTPUT_SCHEMA) {
        if (breadth instanceof Error) throw breadth
        return { object: breadth, usage }
      }
      if (judged instanceof Error) throw judged
      return { object: judged, usage }
    })
  const usageRecord = () => {
    const out = logSpy.mock.calls.map(c => c.join(' ')).find(l => l.startsWith('\n=== Usage ==='))!
    return JSON.parse(out.slice(out.indexOf('{')))
  }

  it('runs on untouched files, judges reviewer + breadth candidates together, and writes both', async () => {
    cfg.breadth.enabled = true
    respond(firstPass, breadthOut, keepAll(2))
    const env = multiFixture()

    await runBenchmark(env)

    expect(completeStructured).toHaveBeenCalledTimes(3)
    const [breadthSystem, breadthUser, breadthSchema] = completeStructured.mock.calls[1]
    expect(breadthSchema).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(breadthSystem).toContain('## BREADTH LENS')
    expect(breadthUser).toContain('- src/a.ts:1 — A bug')
    expect(breadthUser).toContain('## Files with no finding yet:\n- src/b.ts\n- src/c.ts\n- src/d.ts\n- src/e.ts')
    const judgeUser = completeStructured.mock.calls[2][1] as string
    expect(judgeUser).toContain('[c1] **MEDIUM – Same bug in b**')
    expect(judgeUser).not.toContain('origin')
    expect(readOut(env).findings.map((f: any) => `${f.file}:${f.start_line}`)).toEqual(['src/a.ts:1', 'src/b.ts:1'])

    const r = usageRecord()
    expect(r.breadth_status).toBe('succeeded')
    expect(r.breadth_model).toBe('claude-sonnet-5')
    expect(r.review_candidates.map((c: any) => c.origin)).toEqual(['review', 'breadth'])
    expect(r.review_findings).toEqual({ high: 0, medium: 1, low: 0 })
    expect(r.untouched_files).toEqual({ count: 4, paths: ['src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'], cut: 0 })
    expect(r.breadth_tokens).toEqual({ input: 100, output: 50 })
    expect(logSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('reviewer 1, breadth 1, judge kept 2')
  })

  it('holds a breadth finding to changed lines: cited off the diff it lands on the first changed line, while the reviewer citation stands', async () => {
    cfg.breadth.enabled = true
    const offDiff = { findings: [{ ...breadthOut.findings[0], lines: '99' }] }
    respond({ ...firstPass, findings: [{ ...firstPass.findings[0], lines: '99' }] }, offDiff, keepAll(2))
    const env = multiFixture()

    await runBenchmark(env)

    expect(readOut(env).findings.map((f: any) => `${f.file}:${f.start_line}`)).toEqual(['src/a.ts:99', 'src/b.ts:1'])
  })

  it('flag off: a PR big enough to trigger breadth makes no breadth call and records disabled', async () => {
    respond(firstPass, breadthOut, keepAll(1))
    const env = multiFixture()

    await runBenchmark(env)

    expect(completeStructured).toHaveBeenCalledTimes(2)
    expect(completeStructured.mock.calls.some(c => c[2] === BREADTH_OUTPUT_SCHEMA)).toBe(false)
    expect(usageRecord().breadth_status).toBe('disabled')
    expect(readOut(env).findings.map((f: any) => f.file)).toEqual(['src/a.ts'])
  })

  it('runs the judge when the reviewer found nothing but breadth did', async () => {
    cfg.breadth.enabled = true
    respond({ ...firstPass, findings: [] }, breadthOut, keepAll(1))
    const env = multiFixture()

    await runBenchmark(env)

    expect(completeStructured).toHaveBeenCalledTimes(3)
    expect(readOut(env).findings.map((f: any) => f.file)).toEqual(['src/b.ts'])
  })

  it('a failed breadth call never fails the run: reviewer findings still get judged and written', async () => {
    cfg.breadth.enabled = true
    respond(firstPass, new Error('529 overloaded'), keepAll(1))
    const warnSpy = vi.spyOn(console, 'warn')
    const env = multiFixture()

    await runBenchmark(env)

    expect(readOut(env).findings.map((f: any) => f.file)).toEqual(['src/a.ts'])
    expect(usageRecord().breadth_status).toBe('failed')
    expect(warnSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('Breadth review FAILED')
    warnSpy.mockRestore()
  })

  it.each([
    ['skipped_small', () => fixture(), {}],
    ['skipped_few_untouched', multiFixture, { minUntouched: 5 }],
    ['skipped_no_judge', multiFixture, {}],
  ] as const)('records %s and makes no breadth call', async (status, make, over) => {
    cfg.breadth = { ...cfg.breadth, enabled: true, ...over }
    if (status === 'skipped_no_judge') cfg.judge.model = ''
    respond(firstPass, breadthOut, keepAll(1))

    await runBenchmark(make())

    expect(completeStructured.mock.calls.some(c => c[2] === BREADTH_OUTPUT_SCHEMA)).toBe(false)
    expect(usageRecord().breadth_status).toBe(status)
  })

  it('skips when the breadth input would exceed the budget the reviewer fit into', async () => {
    cfg.breadth.enabled = true
    respond(firstPass, breadthOut, keepAll(1))
    await runBenchmark(multiFixture())
    const estimate = Number(logSpy.mock.calls.map(c => c.join(' ')).join('\n').match(/Estimated input: ~([\d,]+) tokens/)![1].replace(/,/g, ''))

    logSpy.mockClear(); completeStructured.mockClear()
    cfg.anthropic.maxInputTokens = estimate + 5
    await runBenchmark(multiFixture())

    expect(completeStructured.mock.calls.some(c => c[2] === BREADTH_OUTPUT_SCHEMA)).toBe(false)
    expect(usageRecord().breadth_status).toBe('skipped_budget')
  })

  it('folds a truncated breadth response into usage, so the failed call is still costed', async () => {
    cfg.breadth.enabled = true
    respond(firstPass, Object.assign(new Error('max_tokens cut-off'), { usage: { input_tokens: 70_000, output_tokens: 30_000 } }), keepAll(1))

    await runBenchmark(multiFixture())

    const r = usageRecord()
    expect(r.breadth_status).toBe('failed')
    expect(r.breadth_tokens).toEqual({ input: 70_000, output: 30_000 })
    expect(r.tokens).toMatchObject({ input: 100 + 70_000 + 100, output: 50 + 30_000 + 50 })
    expect(r.cost_usd).toBeCloseTo(
      estimateCost({ input: 100, output: 50 }, 'claude-haiku-4-5-20251001') + estimateCost({ input: 100, output: 50 }, 'claude-sonnet-5') + estimateCost({ input: 70_000, output: 30_000 }, 'claude-sonnet-5'), 4)
  })

  it('a judge failure after breadth falls back to the reviewer findings only', async () => {
    cfg.breadth.enabled = true
    respond(firstPass, breadthOut, new Error('529 overloaded'))
    const env = multiFixture()

    await runBenchmark(env)

    expect(readOut(env).findings.map((f: any) => f.file)).toEqual(['src/a.ts'])
    const r = usageRecord()
    expect(r.breadth_status).toBe('succeeded')
    expect(r.judge_status).toBe('failed')
  })

  describe('time guard (benchmark deadline)', () => {
    // Only Date is faked, so the file and mock I/O keep their real timers.
    afterEach(() => { vi.useRealTimers() })

    const slowReviewer = (seconds: number) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      completeStructured.mockImplementation(async (_s: string, _u: string, schema: unknown) => {
        if (schema === REVIEW_OUTPUT_SCHEMA) { vi.advanceTimersByTime(seconds * 1000); return { object: firstPass, usage } }
        if (schema === BREADTH_OUTPUT_SCHEMA) return { object: breadthOut, usage }
        return { object: keepAll(2), usage }
      })
    }

    it('skips breadth once more than half of BENCHMARK_DEADLINE_SECONDS has elapsed, and still judges the reviewer findings', async () => {
      cfg.breadth = { ...cfg.breadth, enabled: true, benchmarkDeadlineSeconds: 100 }
      slowReviewer(51)
      const env = multiFixture()

      await runBenchmark(env)

      expect(completeStructured.mock.calls.some(c => c[2] === BREADTH_OUTPUT_SCHEMA)).toBe(false)
      expect(completeStructured).toHaveBeenCalledTimes(2)
      expect(usageRecord().breadth_status).toBe('skipped_time')
      expect(readOut(env).findings.map((f: any) => f.file)).toEqual(['src/a.ts'])
    })

    it('still runs breadth at exactly half the deadline', async () => {
      cfg.breadth = { ...cfg.breadth, enabled: true, benchmarkDeadlineSeconds: 100 }
      slowReviewer(50)

      await runBenchmark(multiFixture())

      expect(usageRecord().breadth_status).toBe('succeeded')
    })
  })

  it('resolves the breadth model at run time, so a JUDGE_MODEL label also moves breadth', async () => {
    cfg.breadth.enabled = true
    respond(firstPass, breadthOut, keepAll(2))

    await runBenchmark({ ...multiFixture(), RB_CONFIG_JUDGE_MODEL: 'claude-haiku-5-5' })

    const breadthCall = completeStructured.mock.calls.find(c => c[2] === BREADTH_OUTPUT_SCHEMA)!
    expect(breadthCall[3]).toMatchObject({ model: 'claude-haiku-5-5' })
    expect(usageRecord().breadth_model).toBe('claude-haiku-5-5')
  })

  it('runs at exactly BREADTH_MIN_UNTOUCHED untouched files', async () => {
    cfg.breadth = { ...cfg.breadth, enabled: true, minUntouched: 4 }
    respond(firstPass, breadthOut, keepAll(2))

    await runBenchmark(multiFixture())

    expect(usageRecord().breadth_status).toBe('succeeded')
  })

  it('MAX_FINDINGS caps both passes together: breadth gets what is left, or is skipped', async () => {
    cfg.breadth.enabled = true
    cfg.review.maxFindings = 3
    respond(firstPass, breadthOut, keepAll(2))
    await runBenchmark(multiFixture())
    expect(completeStructured.mock.calls.find(c => c[2] === BREADTH_OUTPUT_SCHEMA)![0]).toContain('Report at most 2 findings')

    logSpy.mockClear(); completeStructured.mockClear()
    cfg.review.maxFindings = 1
    await runBenchmark(multiFixture())
    expect(usageRecord().breadth_status).toBe('skipped_limit')
  })

  it('BREADTH=1 enables it from the run config, and is echoed', async () => {
    respond(firstPass, breadthOut, keepAll(2))
    await runBenchmark({ ...multiFixture(), RB_CONFIG_BREADTH: '1' })

    expect(cfg.breadth.enabled).toBe(true)
    expect(logSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('breadth=1')
  })
})

// Pins the default path: a snapshot diff here means the breadth feature leaked into flag-off runs.
describe('flag-off regression pin', () => {
  it('judge system prompt, judge input and findings.json are unchanged', async () => {
    const env = fixture()
    await runBenchmark(env)

    expect(completeStructured).toHaveBeenCalledTimes(2)
    expect(completeStructured.mock.calls[1][0]).toMatchSnapshot('judge system prompt')
    expect(completeStructured.mock.calls[1][1]).toMatchSnapshot('judge user message')
    expect(readOut(env).findings).toMatchSnapshot('findings.json')
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
