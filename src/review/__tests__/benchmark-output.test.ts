import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseLineRange, normalizeFindingPath, keptByJudge, mapFindings, buildBenchmarkOutput, writeBenchmarkOutput } from '../benchmark-output.js'
import { renderReview, type ReviewFinding, type ReviewObject } from '../formatter.js'

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({ severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '42-45', body: 'conns is read without the mutex.', ...over })

const PR = { repo: 'https://github.com/owner/repo', prNumber: '1938', base: 'b'.repeat(40), head: 'h'.repeat(40) }

describe('parseLineRange', () => {
  it.each([
    ['26-31', { start: 26, end: 31 }],
    ['3', { start: 3, end: 3 }],
    ['L10-L12', { start: 10, end: 12 }],
    ['26 – 31', { start: 26, end: 31 }],
    ['40, 12', { start: 12, end: 40 }],
  ])('%s → %o', (lines, expected) => {
    expect(parseLineRange(lines)).toEqual(expected)
  })

  it.each([undefined, '', 'n/a', '0'])('%s → null', (lines) => {
    expect(parseLineRange(lines)).toBeNull()
  })
})

describe('normalizeFindingPath', () => {
  it('strips ./ and leading slashes and uses forward slashes', () => {
    expect(normalizeFindingPath('./src/a.ts')).toBe('src/a.ts')
    expect(normalizeFindingPath('/src/a.ts')).toBe('src/a.ts')
    expect(normalizeFindingPath('src\\lib\\a.ts')).toBe('src/lib/a.ts')
    expect(normalizeFindingPath('`src/a.ts`')).toBe('src/a.ts')
  })

  it('snaps a diff-prefixed or basename-only path to the exact changed path', () => {
    const changed = ['src/pool.ts', 'lib/util/a.ts']
    expect(normalizeFindingPath('b/src/pool.ts', changed)).toBe('src/pool.ts')
    expect(normalizeFindingPath('a.ts', changed)).toBe('lib/util/a.ts')
    expect(normalizeFindingPath('util/a.ts', changed)).toBe('lib/util/a.ts')
  })

  it('keeps the path as given when it is ambiguous or outside the diff', () => {
    expect(normalizeFindingPath('a.ts', ['x/a.ts', 'y/a.ts'])).toBe('a.ts')
    expect(normalizeFindingPath('docs/other.md', ['src/pool.ts'])).toBe('docs/other.md')
  })
})

describe('mapFindings', () => {
  it('maps one entry per finding with "<title>: <body>" and the producer', () => {
    expect(mapFindings([finding()], 'my-agent')).toEqual([
      { file: 'src/pool.ts', start_line: 42, end_line: 45, message: 'Race on conns: conns is read without the mutex.', producer: 'my-agent' },
    ])
  })

  it('maps a single line to start == end', () => {
    expect(mapFindings([finding({ lines: '7' })], 'a')[0]).toMatchObject({ start_line: 7, end_line: 7 })
  })

  it('drops findings without a file or a parseable line range', () => {
    const out = mapFindings([
      finding({ file: undefined }),
      finding({ file: '  ' }),
      finding({ lines: undefined }),
      finding({ lines: 'whole file' }),
      finding({ title: 'Kept' }),
    ], 'a')
    expect(out).toHaveLength(1)
    expect(out[0].message.startsWith('Kept:')).toBe(true)
  })

  it('never emits a ./ or absolute path', () => {
    const out = mapFindings([finding({ file: './src/pool.ts' }), finding({ file: '/src/pool.ts' })], 'a')
    expect(out.map(f => f.file)).toEqual(['src/pool.ts', 'src/pool.ts'])
  })
})

describe('keptByJudge', () => {
  const reviewer = [finding({ title: 'Race on conns' }), finding({ title: 'Leaked handle' }), finding({ title: 'Dropped one' })]

  it('keeps only findings the judge scored or rendered', () => {
    const judged = '### Findings\n- **LOW – Leaked handle** (`src/pool.ts:9`)\n  desc\n\n### Merge Confidence: 80%'
    const kept = keptByJudge(reviewer, judged, [{ title: 'race on  CONNS', severity: 'MEDIUM', score: 8 }])
    expect(kept.map(f => f.title)).toEqual(['Race on conns', 'Leaked handle'])
  })

  it('keeps nothing when the judge kept nothing', () => {
    expect(keptByJudge(reviewer, '### Findings\nNo actionable findings.', [])).toEqual([])
  })

  it('round-trips the reviewer rendering (judge returned findings unchanged)', () => {
    const obj: ReviewObject = { summary: 's', findings: reviewer, behavioral_diff: [], production_risk: [], unresolved_questions: [] }
    expect(keptByJudge(reviewer, renderReview(obj))).toEqual(reviewer)
  })

  it('keeps a finding whose title the judge reframed, matched by its preserved location', () => {
    const reframed = [finding({ title: 'ReDoS via backtracking', file: 'src/engine.ts', lines: '12-20' })]
    const judged = '### Findings\n- **MEDIUM – Catastrophic-backtracking ReDoS not addressed** (`src/engine.ts:12-20`)\n  still exploitable.\n\n### Merge Confidence: 70%'
    const kept = keptByJudge(reframed, judged, [{ title: 'Catastrophic-backtracking ReDoS not addressed', severity: 'MEDIUM', score: 8 }])
    expect(kept.map(f => f.title)).toEqual(['ReDoS via backtracking'])
  })

  it('matches a basename-only judge citation and a narrowed range', () => {
    const reviewer = [finding({ title: 'Unbounded loop', file: 'src/app/core/pool.ts', lines: '40-60' })]
    const judged = '### Findings\n- **MEDIUM – Loop can run unbounded** (`pool.ts:52`)\n  desc\n\n### Merge Confidence: 70%'
    expect(keptByJudge(reviewer, judged, []).map(f => f.title)).toEqual(['Unbounded loop'])
  })

  it('does not match a location that lives in Behavioral Diff rather than Findings', () => {
    const reviewer = [finding({ title: 'Not actually flagged', file: 'src/pool.ts', lines: '2-3' })]
    const judged = '### Findings\nNo findings.\n\n### Behavioral Diff\n- pool changed (`src/pool.ts:2-3`)\n\n### Merge Confidence: 90%'
    expect(keptByJudge(reviewer, judged, [])).toEqual([])
  })
})

describe('buildBenchmarkOutput', () => {
  it('echoes head and repo as given and pr_number as a JSON number, with no review prose fields', () => {
    const out = buildBenchmarkOutput(PR, 'my-agent', [])
    expect(out).toEqual({ pr: { repo: PR.repo, pr_number: 1938, base: PR.base, head: PR.head }, agent: 'my-agent', findings: [] })
    expect(Object.keys(out).sort()).toEqual(['agent', 'findings', 'pr'])
  })
})

describe('writeBenchmarkOutput', () => {
  it('writes parseable JSON, creating the directory, and leaves no temp file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rb-out-')), 'nested', 'findings.json')
    writeBenchmarkOutput(path, buildBenchmarkOutput(PR, 'a', mapFindings([finding()], 'a')))
    const written = JSON.parse(readFileSync(path, 'utf-8'))
    expect(written.pr.head).toBe(PR.head)
    expect(written.findings).toHaveLength(1)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('writes an empty findings list as a valid file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rb-out-')), 'findings.json')
    writeBenchmarkOutput(path, buildBenchmarkOutput(PR, 'a', []))
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ pr: { pr_number: 1938, head: PR.head }, findings: [] })
  })
})
