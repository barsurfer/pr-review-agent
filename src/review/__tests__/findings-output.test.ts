import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseLineRange, normalizeFindingPath, findingsFromJudgedMarkdown, mapFindings, resolveKeptFindings, keptToReportFindings, mergeJudgedFindings, mergeJudgedFindingsWithStats, buildFindingsReport, writeFindingsReport, countFindingBullets } from '../findings-output.js'
import { renderReview, type ReviewFinding, type ReviewObject, type FindingScore } from '../formatter.js'

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({ severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '42-45', body: 'conns is read without the mutex.', ...over })

const score = (over: Partial<FindingScore> = {}): FindingScore =>
  ({ severity: 'MEDIUM', title: 'Race on conns', score: 9, ...over })

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

  it('is not fooled by "C# findings" in the Summary (section is line-anchored)', () => {
    const md = '### Summary\nUses C# findings naming\n\n### Findings\n- **HIGH – Real** (`src/a.ts:1-2`)\n  body.'
    expect(findingsFromJudgedMarkdown(md, 'rb').map(f => f.file)).toEqual(['src/a.ts'])
  })
})

describe('countFindingBullets', () => {
  it('counts severity bullets in the Findings section only', () => {
    const md = '### Summary\nC# findings here\n\n### Findings\n- **HIGH – A** (`a.ts:1`)\n  x\n- **LOW – B** (`b.ts:2`)\n  y\n\n### Behavioral Diff\n- **HIGH – not a finding**'
    expect(countFindingBullets(md)).toBe(2)
  })

  it('is zero when the judge kept nothing', () => {
    expect(countFindingBullets('### Findings\nNo findings.\n\n### Merge Confidence: 95%')).toBe(0)
  })
})

describe('resolveKeptFindings', () => {
  it('recovers the anchor from the reviewer finding when the judge score carries none (the drift case)', () => {
    const revs = [finding(), finding({ title: 'PKCE optional', file: 'auth/handler.go', lines: '40', severity: 'MEDIUM', body: 'code_challenge empty bypasses S256.' })]
    const kept = resolveKeptFindings(revs, [score({ title: 'PKCE optional', severity: 'MEDIUM' })])
    expect(kept).toEqual([{ severity: 'MEDIUM', title: 'PKCE optional', body: 'code_challenge empty bypasses S256.', file: 'auth/handler.go', lines: '40', score: 9, anchorSource: 'reviewer' }])
  })

  it('uses the matched reviewer finding\'s diff-anchored location over the judge\'s transcription', () => {
    const kept = resolveKeptFindings([finding({ lines: '42-45' })], [score({ file: 'src/pool.ts', lines: '50' })])
    expect(kept[0]).toMatchObject({ file: 'src/pool.ts', lines: '42-45', anchorSource: 'reviewer' })
  })

  it('falls back to the judge score\'s own file/lines only when no reviewer finding matches', () => {
    const kept = resolveKeptFindings([finding({ title: 'Something else entirely' })], [score({ title: 'Unrelated kept finding', file: 'auth/x.go', lines: '50' })])
    expect(kept[0]).toMatchObject({ file: 'auth/x.go', lines: '50', anchorSource: 'judge' })
  })

  it('uses the judge pair when the matched reviewer finding has a file but no lines', () => {
    const kept = resolveKeptFindings([finding({ file: 'a.ts', lines: undefined })], [score({ file: 'a.ts', lines: '5' })])
    expect(kept[0]).toMatchObject({ file: 'a.ts', lines: '5', anchorSource: 'judge' })
  })

  it('strips a trailing :line the judge welded onto its fallback file', () => {
    const kept = resolveKeptFindings([finding({ title: 'nope' })], [score({ title: 'Unrelated', file: 'auth/handler.go:91', lines: '91' })])
    expect(kept[0]).toMatchObject({ file: 'auth/handler.go', lines: '91', anchorSource: 'judge' })
  })

  it('takes the anchor atomically — never welds the judge\'s file to the reviewer\'s line', () => {
    const kept = resolveKeptFindings([finding({ file: 'src/pool.ts', lines: '42-45' })], [score({ file: 'other/handler.go' })])
    expect(kept[0]).toMatchObject({ file: 'src/pool.ts', lines: '42-45', anchorSource: 'reviewer' })
  })

  it('claims an exact-title match before any looser candidate can steal it', () => {
    const revs = [finding({ title: 'Null deref', file: 'a.ts', lines: '1' }), finding({ title: 'Null deref in the handler path', file: 'b.ts', lines: '2' })]
    expect(resolveKeptFindings(revs, [score({ title: 'Null deref' })])[0].file).toBe('a.ts')
  })

  it('does not let a vague kept title steal the specific reviewer finding (no swap)', () => {
    const revs = [
      finding({ title: 'Race condition on connection pool', file: 'pool.ts', lines: '42', body: 'specific' }),
      finding({ title: 'Race condition', file: 'other.ts', lines: '5', body: 'vague' }),
    ]
    const kept = resolveKeptFindings(revs, [score({ title: 'Race condition' }), score({ title: 'Race condition on connection pool' })])
    expect(kept[0]).toMatchObject({ title: 'Race condition', file: 'other.ts', lines: '5', body: 'vague' })
    expect(kept[1]).toMatchObject({ title: 'Race condition on connection pool', file: 'pool.ts', lines: '42', body: 'specific' })
  })

  it('abstains (no anchor) on an unbreakable tie rather than guessing by array order', () => {
    const revs = [
      finding({ title: 'Error handling in parseConfig', file: 'config.ts', lines: '30' }),
      finding({ title: 'Error handling for the writer', file: 'writer.ts', lines: '9' }),
    ]
    expect(resolveKeptFindings(revs, [score({ title: 'Error handling' })])[0].file).toBeUndefined()
  })

  it('does not match on a single shared word even at 0.5 overlap (floor isolated: files agree, overlap = 0.5)', () => {
    // 'Token leak' shares only 'token' with the reviewer → overlap 1/2 = 0.5 (clears the threshold) but 1 < 2 words
    // (fails the floor). Files agree so the veto can't mask it; an empty body proves no reviewer match.
    const kept = resolveKeptFindings([finding({ title: 'Token refresh race condition', file: 'a.ts', lines: '1', body: 'REVBODY' })], [score({ title: 'Token leak', file: 'a.ts', lines: '88' })])
    expect(kept[0]).toMatchObject({ body: '', anchorSource: 'judge' })
  })

  it('does not match below the overlap threshold even with 2 shared words (threshold isolated)', () => {
    // 2 shared words clear the floor; overlap 2/5 = 0.4 is below 0.5. Files agree so only the threshold can block.
    const kept = resolveKeptFindings([finding({ title: 'Null pointer deref in parser handler path', file: 'a.ts', lines: '1', body: 'REVBODY' })], [score({ title: 'Null pointer check here now', file: 'a.ts', lines: '88' })])
    expect(kept[0]).toMatchObject({ body: '', anchorSource: 'judge' })
  })

  it('vetoes a loose match the judge\'s own file disproves (veto isolated — overlap is well above the floor)', () => {
    // 3 shared words clear the floor; only the file veto (log.ts vs refresh.ts) can block it.
    const kept = resolveKeptFindings([finding({ title: 'Token refresh leak path', file: 'refresh.ts', lines: '40', body: 'REVBODY' })], [score({ title: 'Token refresh leak', file: 'log.ts', lines: '7' })])
    expect(kept[0]).toMatchObject({ body: '', file: 'log.ts', anchorSource: 'judge' })   // did not borrow refresh.ts
  })

  it('disambiguates duplicate reviewer titles by the judge\'s file', () => {
    const revs = [finding({ title: 'Missing null check', file: 'a.ts', lines: '10' }), finding({ title: 'Missing null check', file: 'b.ts', lines: '20' })]
    expect(resolveKeptFindings(revs, [score({ title: 'Missing null check', file: 'b.ts' })])[0]).toMatchObject({ file: 'b.ts', lines: '20' })
  })

  it('tells apart same-basename files in different directories (suffix, not basename)', () => {
    const revs = [finding({ title: 'Dup', file: 'src/a/index.ts', lines: '10' }), finding({ title: 'Dup', file: 'src/b/index.ts', lines: '20' })]
    expect(resolveKeptFindings(revs, [score({ title: 'Dup', file: 'src/b/index.ts' })])[0]).toMatchObject({ file: 'src/b/index.ts', lines: '20' })
  })

  it('abstains on duplicate exact titles the judge did not disambiguate (no false anchor)', () => {
    const revs = [finding({ title: 'Missing null check', file: 'a.ts', lines: '10' }), finding({ title: 'Missing null check', file: 'b.ts', lines: '20' })]
    const kept = resolveKeptFindings(revs, [score({ title: 'Missing null check' })])
    expect(kept[0]).toMatchObject({ file: undefined, anchorSource: 'none' })
  })

  it('does not weld a reviewer file to a judge line when neither source has a complete pair', () => {
    const kept = resolveKeptFindings([finding({ title: 'X', file: 'a.ts', lines: undefined })], [score({ title: 'X', lines: '40' })])
    expect(kept[0]).toMatchObject({ file: undefined, lines: undefined, anchorSource: 'none' })
    expect(keptToReportFindings(kept, 'rb')).toEqual([])   // an anchorSource:'none' row is never emitted
  })

  it('handles non-ASCII titles without collapsing them to an empty match', () => {
    const revs = [finding({ title: 'Ошибка один', file: 'a.ts', lines: '1' }), finding({ title: 'Другая ошибка два', file: 'b.ts', lines: '2' })]
    expect(resolveKeptFindings(revs, [score({ title: 'Ошибка один' })])[0].file).toBe('a.ts')
  })

  it('never treats a title that normalizes to empty as an exact match', () => {
    const kept = resolveKeptFindings([finding({ title: '!!!', file: 'a.ts', lines: '1' })], [score({ title: '???' })])
    expect(kept[0].file).toBeUndefined()
  })

  it('matches a judge-reframed title to the reviewer finding by word overlap and takes its body/anchor', () => {
    const revs = [finding({ title: 'Unbounded session map growth', file: 'auth/session.go', lines: '12', body: 'SaveSession has no cap.' })]
    const kept = resolveKeptFindings(revs, [score({ title: 'Unbounded session growth from unauthenticated /authorize' })])
    expect(kept[0]).toMatchObject({ title: 'Unbounded session growth from unauthenticated /authorize', body: 'SaveSession has no cap.', file: 'auth/session.go', lines: '12', anchorSource: 'reviewer' })
  })

  it('keeps a kept finding even if no reviewer match is found, just without an anchor', () => {
    const kept = resolveKeptFindings([finding({ title: 'Totally different' })], [score({ title: 'Nothing like it at all', score: 6 })])
    expect(kept).toEqual([{ severity: 'MEDIUM', title: 'Nothing like it at all', body: '', file: undefined, lines: undefined, score: 6, anchorSource: 'none' }])
  })

  it('does not reuse one reviewer finding for two kept scores', () => {
    const revs = [finding({ title: 'Race on conns', file: 'a.ts', lines: '1' })]
    const kept = resolveKeptFindings(revs, [score({ title: 'Race on conns' }), score({ title: 'Race on conns' })])
    expect(kept[0].file).toBe('a.ts')
    expect(kept[1].file).toBeUndefined()
  })

  it('returns nothing when the judge kept nothing', () => {
    expect(resolveKeptFindings([finding()], [])).toEqual([])
  })
})

describe('keptToReportFindings', () => {
  it('maps kept findings with anchors to report shape, dropping those without a usable file:line', () => {
    const kept = resolveKeptFindings(
      [finding({ title: 'A', file: 'a.ts', lines: '1-2', body: 'x' }), finding({ title: 'B', file: undefined, body: 'y' })],
      [score({ title: 'A' }), score({ title: 'B' })],
    )
    expect(keptToReportFindings(kept, 'rb')).toEqual([
      { file: 'a.ts', start_line: 1, end_line: 2, message: 'A: x', producer: 'rb' },
    ])
  })

  it('recovers the full judged set end-to-end when the judge wrote no (file:line) in its markdown', () => {
    // The Mcp-Docker regression: 4 reviewer findings with anchors, judge kept all 4 with prose-only locations.
    const revs = [
      finding({ title: 'PKCE optional', file: 'auth/handler.go', lines: '40', body: 'b1' }),
      finding({ title: 'Unbounded session map', file: 'auth/session.go', lines: '12', body: 'b2' }),
      finding({ title: 'Throttling misread as invalid token', file: 'auth/handler.go', lines: '88', body: 'b3' }),
      finding({ title: 'Uncached failed-token call', file: 'auth/handler.go', lines: '60', body: 'b4' }),
    ]
    const scores = revs.map(r => score({ title: r.title, severity: r.severity }))
    const out = keptToReportFindings(resolveKeptFindings(revs, scores), 'rb', ['auth/handler.go', 'auth/session.go'])
    expect(out).toHaveLength(4)
    expect(out.map(f => f.file)).toEqual(['auth/handler.go', 'auth/session.go', 'auth/handler.go', 'auth/handler.go'])
  })
})

describe('mergeJudgedFindings', () => {
  const judged = (findings: string) => `### Summary\ns\n\n### Findings\n${findings}\n\n### Merge Confidence: 70%`

  it('passes markdown rows through untouched — same title+file at different lines both survive', () => {
    const md = judged('- **MEDIUM – Missing null check** (`a.ts:10`)\n  x\n- **MEDIUM – Missing null check** (`a.ts:90`)\n  y')
    expect(mergeJudgedFindings(md, [], [], 'rb').map(f => f.start_line)).toEqual([10, 90])
  })

  it('does not collapse distinct findings whose titles share a colon prefix', () => {
    const md = judged('- **MEDIUM – Security: SQL injection** (`a.ts:10`)\n  x\n- **MEDIUM – Security: missing auth** (`a.ts:50`)\n  y')
    expect(mergeJudgedFindings(md, [], [], 'rb')).toHaveLength(2)
  })

  it('keeps a multi-file markdown finding as separate rows', () => {
    const md = judged('- **HIGH – Public search** (`a.ts:1`, `b.ts:2`)\n  both lost the perm check.')
    expect(mergeJudgedFindings(md, [], [], 'rb').map(f => f.file)).toEqual(['a.ts', 'b.ts'])
  })

  it('adds a structured recovery for a finding the judge located only as prose', () => {
    const md = judged('- **MEDIUM – Race on conns**\n  conns mutated without a lock.')   // no (file:line)
    const revs = [finding({ title: 'Race on conns', file: 'a.ts', lines: '3', body: 'b' })]
    const out = mergeJudgedFindings(md, revs, [score({ title: 'Race on conns' })], 'rb')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ file: 'a.ts', start_line: 3 })
  })

  it('suppresses a recovery whose bullet the markdown already located (exact title, no double-count)', () => {
    const md = judged('- **MEDIUM – Race on conns** (`a.ts:3`)\n  conns mutated without a lock.')
    const revs = [finding({ title: 'Race on conns', file: 'a.ts', lines: '3', body: 'b' })]
    expect(mergeJudgedFindings(md, revs, [score({ title: 'Race on conns' })], 'rb')).toHaveLength(1)
  })

  it('recovers a prose-located finding that sits on the SAME lines as a distinct located one (clustering)', () => {
    // Plugin.kt:43-53 carries two different findings; one is located, the other prose-only.
    const md = judged('- **MEDIUM – Unsynchronized concurrent execution** (`Plugin.kt:43-53`)\n  x\n- **MEDIUM – Threads created without daemon flag**\n  y')
    const revs = [finding({ title: 'Threads created without daemon flag', file: 'Plugin.kt', lines: '43-53', body: 'z' })]
    const out = mergeJudgedFindings(md, revs, [score({ title: 'Unsynchronized concurrent execution' }), score({ title: 'Threads created without daemon flag' })], 'rb')
    expect(out.map(f => f.message.split(':')[0]).sort()).toEqual(['Threads created without daemon flag', 'Unsynchronized concurrent execution'])
  })

  it('recovers a prose-located finding a few lines from a distinct located one (clustering, small gap)', () => {
    const md = judged('- **MEDIUM – A** (`github.go:95-99`)\n  x\n- **MEDIUM – B**\n  y')
    const revs = [finding({ title: 'B', file: 'github.go', lines: '102-112', body: 'z' })]
    const out = mergeJudgedFindings(md, revs, [score({ title: 'A' }), score({ title: 'B' })], 'rb')
    expect(out.map(f => f.start_line).sort((a, b) => a - b)).toEqual([95, 102])
  })

  it('accepts a rare double-count when the judge reframes a located finding\'s title (a dup row beats a lost finding)', () => {
    const md = judged('- **MEDIUM – Throttling (429) misread as an invalid token** (`h.go:88`)\n  x')
    const revs = [finding({ title: 'Throttling misread as invalid token', file: 'h.go', lines: '88', body: 'b' })]
    expect(mergeJudgedFindings(md, revs, [score({ title: 'Throttling misread as invalid token' })], 'rb')).toHaveLength(2)
  })

  it('pairs duplicate-title bullets by file identity, not array order (located first, scores reversed)', () => {
    const md = judged('- **MEDIUM – Missing null check** (`a.ts:10`)\n  x\n- **MEDIUM – Missing null check**\n  y')
    const revs = [finding({ title: 'Missing null check', file: 'a.ts', lines: '10', body: 'p' }), finding({ title: 'Missing null check', file: 'b.ts', lines: '20', body: 'q' })]
    const scores = [score({ title: 'Missing null check', file: 'b.ts' }), score({ title: 'Missing null check', file: 'a.ts' })]
    expect(mergeJudgedFindings(md, revs, scores, 'rb').map(f => `${f.file}:${f.start_line}`).sort()).toEqual(['a.ts:10', 'b.ts:20'])
  })

  it('pairs duplicate-title bullets by identity regardless of bullet order (prose first)', () => {
    const md = judged('- **MEDIUM – Missing null check**\n  y\n- **MEDIUM – Missing null check** (`b.ts:20`)\n  x')
    const revs = [finding({ title: 'Missing null check', file: 'a.ts', lines: '10', body: 'p' }), finding({ title: 'Missing null check', file: 'b.ts', lines: '20', body: 'q' })]
    const scores = [score({ title: 'Missing null check', file: 'a.ts' }), score({ title: 'Missing null check', file: 'b.ts' })]
    expect(mergeJudgedFindings(md, revs, scores, 'rb').map(f => `${f.file}:${f.start_line}`).sort()).toEqual(['a.ts:10', 'b.ts:20'])
  })

  it('pairs a score to its bullet across case and punctuation (normalized title), no double-count', () => {
    const md = judged('- **MEDIUM – PKCE Bypass!** (`a.ts:5`)\n  x')
    const revs = [finding({ title: 'pkce bypass', file: 'a.ts', lines: '5', body: 'b' })]
    expect(mergeJudgedFindings(md, revs, [score({ title: 'pkce bypass' })], 'rb')).toHaveLength(1)
  })

  it('keeps a distinct prose-located finding that only shares words with a located one (same file, far apart)', () => {
    const md = judged('- **MEDIUM – Missing validation of redirect URI** (`auth.ts:10`)\n  x')
    const revs = [finding({ title: 'Missing validation of state parameter', file: 'auth.ts', lines: '77', body: 'b' })]
    const out = mergeJudgedFindings(md, revs, [score({ title: 'Missing validation of state parameter' })], 'rb')
    expect(out.map(f => f.start_line)).toEqual([10, 77])
  })

  it('keeps a distinct prose-located finding sharing words with a located one in another file', () => {
    const md = judged('- **MEDIUM – Race condition in cache eviction** (`cache.go:10`)\n  x')
    const revs = [finding({ title: 'Race condition in session store', file: 'session.go', lines: '300', body: 'b' })]
    const out = mergeJudgedFindings(md, revs, [score({ title: 'Race condition in session store' })], 'rb')
    expect(out).toHaveLength(2)
  })

  it('suppresses a recovery whose title exactly matches a located row even in another file', () => {
    const md = judged('- **MEDIUM – Null deref** (`a.ts:10`)\n  x')
    const revs = [finding({ title: 'Null deref', file: 'b.ts', lines: '5', body: 'b' })]
    const out = mergeJudgedFindings(md, revs, [score({ title: 'Null deref' })], 'rb')
    expect(out.map(f => f.file)).toEqual(['a.ts'])
  })

  it('returns the located markdown rows when the judge gave no scores (empty finding_scores)', () => {
    const md = judged('- **MEDIUM – A** (`a.ts:1`)\n  x\n- **HIGH – B** (`b.ts:2`)\n  y')
    expect(mergeJudgedFindings(md, [], [], 'rb').map(f => f.file)).toEqual(['a.ts', 'b.ts'])
  })

  it('returns the located markdown rows when judgeScores is undefined, not just empty', () => {
    const md = judged('- **MEDIUM – A** (`a.ts:1`)\n  x')
    expect(mergeJudgedFindings(md, [finding()], undefined, 'rb')).toHaveLength(1)
  })

  it('a recovered row with no reviewer match borrows the judge bullet text instead of a bare title (R2 Case B)', () => {
    const md = judged('- **MEDIUM – Unbounded session map**\n  SaveSession has no cap; a flood of /authorize grows the map until OOM.')
    const revs = [finding({ title: 'Totally unrelated thing', file: 'x.ts', lines: '1', body: 'other' })]
    const out = mergeJudgedFindings(md, revs, [score({ title: 'Unbounded session map', file: 'auth/session.go', lines: '60' })], 'rb')
    expect(out).toHaveLength(1)
    expect(out[0].message).toBe('Unbounded session map: SaveSession has no cap; a flood of /authorize grows the map until OOM.')
  })

  it('a recovered row with a reviewer match keeps the reviewer body (Case A not shipped)', () => {
    const md = judged('- **MEDIUM – Race on conns**\n  judge terse text.')
    const revs = [finding({ title: 'Race on conns', file: 'a.ts', lines: '3', body: 'reviewer body.' })]
    expect(mergeJudgedFindings(md, revs, [score({ title: 'Race on conns' })], 'rb')[0].message).toBe('Race on conns: reviewer body.')
  })
})

describe('mergeJudgedFindingsWithStats', () => {
  const judged = (findings: string) => `### Summary\ns\n\n### Findings\n${findings}\n\n### Merge Confidence: 70%`

  it('mergeJudgedFindings returns the same findings as the stats variant', () => {
    const md = judged('- **MEDIUM – A** (`a.ts:1`)\n  x')
    const revs = [finding({ title: 'A', file: 'a.ts', lines: '1', body: 'b' })]
    expect(mergeJudgedFindings(md, revs, [score({ title: 'A' })], 'rb'))
      .toEqual(mergeJudgedFindingsWithStats(md, revs, [score({ title: 'A' })], 'rb').findings)
  })

  it('flags a certain silent drop the old row-count check masked', () => {
    // located single + located two-file (inflates rows) + a prose bullet nothing can anchor.
    const md = judged('- **MEDIUM – A** (`a.ts:1`)\n  x\n- **HIGH – B** (`b.ts:2`, `c.ts:3`)\n  y\n- **MEDIUM – C**\n  z')
    const { findings, stats } = mergeJudgedFindingsWithStats(md, [], [score({ title: 'A' }), score({ title: 'B' }), score({ title: 'C' })], 'rb')
    expect(stats.unanchoredPaired).toBe(1)             // C: kept prose bullet, no anchor
    expect(findings.length).toBeGreaterThanOrEqual(stats.scores)   // rows (3) ≥ scores (3): old `kept > rows` stays silent
  })

  it('counts unscored prose bullets when the judge returns empty finding_scores', () => {
    const md = judged('- **MEDIUM – A**\n  x\n- **MEDIUM – B**\n  y')
    expect(mergeJudgedFindingsWithStats(md, [], [], 'rb').stats.unscoredProse).toBe(2)
  })

  it('counts an unpaired anchored score (the reframe double-count signal)', () => {
    const md = judged('- **MEDIUM – Throttling (429) misread** (`h.go:88`)\n  x')
    const revs = [finding({ title: 'Throttling misread as invalid token', file: 'h.go', lines: '88', body: 'b' })]
    expect(mergeJudgedFindingsWithStats(md, revs, [score({ title: 'Throttling misread as invalid token' })], 'rb').stats.recoveredUnpaired).toBe(1)
  })

  it('zeroes the drop counters when every bullet is located', () => {
    const md = judged('- **MEDIUM – A** (`a.ts:1`)\n  x')
    const s = mergeJudgedFindingsWithStats(md, [finding({ title: 'A', file: 'a.ts', lines: '1' })], [score({ title: 'A' })], 'rb').stats
    expect([s.unanchoredPaired, s.unanchoredUnpaired, s.unscoredProse]).toEqual([0, 0, 0])
  })

  it('detects parser drift — a severity bullet the head regex cannot read', () => {
    const md = judged('- **MEDIUM Something** (`a.ts:1`)\n  x')   // no dash after MEDIUM
    expect(mergeJudgedFindingsWithStats(md, [], [], 'rb').stats.bullets).toBe(0)
    expect(countFindingBullets(md)).toBe(1)
  })

  it('does not raise a false certain drop when a prose bullet is recovered under a reframed score title (F1)', () => {
    const md = judged('- **MEDIUM – Unbounded session map**\n  prose only.')
    const revs = [finding({ title: 'Unbounded session map growth', file: 'auth/session.go', lines: '60', body: 'b' })]
    const { findings, stats } = mergeJudgedFindingsWithStats(md, revs, [score({ title: 'Unbounded session map growth' })], 'rb')
    expect(findings).toHaveLength(1)        // the finding was recovered
    expect(stats.recoveredUnpaired).toBe(1)
    expect(stats.unscoredProse).toBe(0)     // NOT counted as a certain drop
  })

  it('keeps the score title on a Case A recovery, not the bullet heading spelling (F2)', () => {
    const md = judged('- **MEDIUM – `parseConfig` leaks the handle**\n  prose only.')
    const revs = [finding({ title: 'parseConfig leaks the handle', file: 'a.ts', lines: '5', body: 'reviewer body' })]
    const out = mergeJudgedFindings(md, revs, [score({ title: 'parseConfig leaks the handle' })], 'rb')
    expect(out[0].message).toBe('parseConfig leaks the handle: reviewer body')   // not the backticked heading
  })

  it('counts a borrowed-text recovery (R2 Case B frequency)', () => {
    const md = judged('- **MEDIUM – Unbounded session map**\n  judge prose text.')
    const revs = [finding({ title: 'Unrelated', file: 'x.ts', lines: '1', body: 'o' })]
    const s = mergeJudgedFindingsWithStats(md, revs, [score({ title: 'Unbounded session map', file: 'a.ts', lines: '2' })], 'rb').stats
    expect(s.borrowed).toBe(1)
  })

  it('counts dupOfLocated and rowsRecovered on a mixed PR', () => {
    const md = judged('- **MEDIUM – A** (`a.ts:1`)\n  x\n- **MEDIUM – B**\n  prose.')
    const revs = [finding({ title: 'A', file: 'a.ts', lines: '1', body: 'p' }), finding({ title: 'B', file: 'b.ts', lines: '2', body: 'q' })]
    const s = mergeJudgedFindingsWithStats(md, revs, [score({ title: 'A' }), score({ title: 'B' })], 'rb').stats
    expect(s.dupOfLocated).toBe(1)    // A was located → its recovery dropped
    expect(s.rowsRecovered).toBe(1)   // B recovered
  })
})

describe('buildFindingsReport', () => {
  it('echoes head and repo as given and pr_number as a JSON number, with no review prose fields', () => {
    const out = buildFindingsReport(PR, 'my-agent', [])
    expect(out).toEqual({ pr: { repo: PR.repo, pr_number: 1938, base: PR.base, head: PR.head }, agent: 'my-agent', findings: [] })
    expect(Object.keys(out).sort()).toEqual(['agent', 'findings', 'pr'])
  })
})

describe('writeFindingsReport', () => {
  it('writes parseable JSON, creating the directory, and leaves no temp file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rb-out-')), 'nested', 'findings.json')
    writeFindingsReport(path, buildFindingsReport(PR, 'a', mapFindings([finding()], 'a')))
    const written = JSON.parse(readFileSync(path, 'utf-8'))
    expect(written.pr.head).toBe(PR.head)
    expect(written.findings).toHaveLength(1)
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  it('writes an empty findings list as a valid file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rb-out-')), 'findings.json')
    writeFindingsReport(path, buildFindingsReport(PR, 'a', []))
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ pr: { pr_number: 1938, head: PR.head }, findings: [] })
  })
})
