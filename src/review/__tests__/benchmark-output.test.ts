import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseLineRange, normalizeFindingPath, findingsFromJudgedMarkdown, mapFindings, buildBenchmarkOutput, writeBenchmarkOutput } from '../benchmark-output.js'
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

describe('findingsFromJudgedMarkdown', () => {
  it('reads each kept finding from the judge Findings section as "<title>: <body>" at its cited location', () => {
    const judged = '### Summary\ns\n\n### Findings\n- **HIGH – Auth gate removed** (`src/api/search.ts:23-30`)\n  requirePerm was deleted.\n\n- **MEDIUM – LIKE escape wrong** (`src/db/options.ts:126-152`)\n  backslash mismatches Postgres.\n\n### Merge Confidence: 40%'
    expect(findingsFromJudgedMarkdown(judged, 'rb')).toEqual([
      { file: 'src/api/search.ts', start_line: 23, end_line: 30, message: 'Auth gate removed: requirePerm was deleted.', producer: 'rb' },
      { file: 'src/db/options.ts', start_line: 126, end_line: 152, message: 'LIKE escape wrong: backslash mismatches Postgres.', producer: 'rb' },
    ])
  })

  it('emits one entry per file for a multi-location finding', () => {
    const judged = '### Findings\n- **HIGH – Public search** (`src/api/search.ts:23-30`, `src/api/suggest.ts:22-28`)\n  both lost the perm check.\n\n### Merge Confidence: 50%'
    const out = findingsFromJudgedMarkdown(judged, 'rb')
    expect(out.map(f => f.file)).toEqual(['src/api/search.ts', 'src/api/suggest.ts'])
    expect(out.every(f => f.message.startsWith('Public search:'))).toBe(true)
  })

  it('keeps the judge-reframed title verbatim — no reviewer join to lose it', () => {
    const judged = '### Findings\n- **MEDIUM – Catastrophic-backtracking ReDoS** (`src/engine.ts:12-20`)\n  still exploitable.'
    expect(findingsFromJudgedMarkdown(judged, 'rb')[0].message).toBe('Catastrophic-backtracking ReDoS: still exploitable.')
  })

  it('snaps a basename or diff-prefixed citation to the exact changed path', () => {
    const judged = '### Findings\n- **MEDIUM – Loop** (`pool.ts:52`)\n  unbounded.'
    expect(findingsFromJudgedMarkdown(judged, 'rb', ['src/app/core/pool.ts'])[0].file).toBe('src/app/core/pool.ts')
  })

  it('drops a finding with no parseable location and ignores other sections', () => {
    const judged = '### Findings\n- **LOW – PR-level concern**\n  no single location.\n\n### Behavioral Diff\n- changed (`src/pool.ts:2-3`)\n\n### Merge Confidence: 90%'
    expect(findingsFromJudgedMarkdown(judged, 'rb')).toEqual([])
  })

  it('emits nothing when the judge kept nothing', () => {
    expect(findingsFromJudgedMarkdown('### Findings\nNo findings.\n\n### Merge Confidence: 95%', 'rb')).toEqual([])
  })

  it('parses the reviewer rendering too (judge returned findings unchanged)', () => {
    const obj: ReviewObject = { summary: 's', findings: [finding({ title: 'Race on conns' })], behavioral_diff: [], production_risk: [], unresolved_questions: [] }
    const out = findingsFromJudgedMarkdown(renderReview(obj), 'rb')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ file: 'src/pool.ts', start_line: 42, end_line: 45, message: 'Race on conns: conns is read without the mutex.' })
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
