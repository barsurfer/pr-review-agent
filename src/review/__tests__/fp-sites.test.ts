import { describe, it, expect, vi, beforeEach } from 'vitest'

const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))

import { BREADTH_LENS, SECOND_LOOK_LENS, FIRST_PASS_SITES_SECTION, breadthSystemPrompt, secondLookSystemPrompt, breadthBriefing, secondLookBriefing, withImpactItem } from '../breadth.js'
import { findingsOutputSchema, sanitizeFirstPassSites, runLens, runBreadth, BREADTH_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA } from '../client.js'
import { applyJudgeDecisions, type JudgeOutput } from '../judge-decisions.js'
import { firstPassSiteRows, alsoAffectsRows, counterpartFindings, type KeptFinding, type FirstPassSite, type ReportFinding } from '../findings-output.js'
import type { ReviewFinding } from '../formatter.js'
import type { PRInfo, ChangedFile } from '../../vcs/adapter.js'

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const prInfo = { title: 't', sourceBranch: 's', targetBranch: 'm', description: '' } as PRInfo

beforeEach(() => { completeStructured.mockReset() })

describe('first_pass_sites schema', () => {
  it('leaves every existing variant the same object and adds an optional root property only with the option', () => {
    const hi = findingsOutputSchema({ alsoAffects: true, scenario: true })
    expect(findingsOutputSchema({ alsoAffects: true, scenario: true, firstPassSites: false })).toBe(hi)
    expect(findingsOutputSchema({ firstPassSites: false })).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(JSON.stringify(hi)).not.toContain('first_pass_sites')

    const sites = findingsOutputSchema({ alsoAffects: true, scenario: true, firstPassSites: true }) as any
    expect(findingsOutputSchema({ alsoAffects: true, scenario: true, firstPassSites: true })).toBe(sites)
    expect(sites.required).toEqual(['findings'])
    expect(sites.properties.first_pass_sites.items.required).toEqual(['id', 'file', 'lines', 'where'])
    expect(Object.keys(sites.properties.first_pass_sites.items.properties)).toEqual(['id', 'file', 'lines', 'where'])
    expect(sites.properties.findings).toEqual((hi as any).properties.findings)
    expect(JSON.stringify(REVIEW_OUTPUT_SCHEMA)).not.toContain('first_pass_sites')
  })
})

describe('sanitizeFirstPassSites', () => {
  const ids = new Map([['c0', 0], ['c2', 2]])

  it('keeps entries for briefed ids only, normalizes the id, collapses where, and drops malformed entries', () => {
    const got = sanitizeFirstPassSites([
      { id: '[C2]', file: ' src/a.ts ', lines: '4', where: '  a\n  b ' },
      { id: 'c1', file: 'src/a.ts', lines: '4', where: 'not briefed' },
      { id: 'c0', file: 'src/a.ts', lines: '4' },
      { id: 'c0', file: '', lines: '4', where: 'w' },
      'junk', null, 7,
      { id: 'c0', file: 'src/b.ts', lines: 9, where: 'w' },
      { id: 'c0', file: 'src/b.ts', lines: '9', where: 'w' },
    ], ids, 'breadth')

    expect([...got.sites.entries()]).toEqual([
      [2, [{ id: 'c2', file: 'src/a.ts', lines: '4', where: 'a b', via: 'breadth' }]],
      [0, [{ id: 'c0', file: 'src/b.ts', lines: '9', where: 'w', via: 'breadth' }]],
    ])
    expect(got.dropped).toEqual({ unknown_id: 1, bad_where: 1, bad_file: 1, not_object: 3, bad_lines: 1 })
  })

  it('keeps at most 10 entries per id, counts the rest, and treats a non-array as none', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: 'c0', file: 'f.ts', lines: String(i + 1), where: 'w' }))
    const capped = sanitizeFirstPassSites(many, ids, 'second_look')
    expect(capped.sites.get(0)).toHaveLength(10)
    expect(capped.dropped).toEqual({ over_keep: 2 })
    expect(sanitizeFirstPassSites(undefined, ids, 'breadth')).toEqual({ sites: new Map(), dropped: {} })
  })

  it('counts a present but non-array value once as not_array instead of dropping it silently', () => {
    for (const raw of [{ id: 'c0', file: 'f.ts', lines: '1', where: 'w' }, 'c0 f.ts:1', null, 3]) {
      expect(sanitizeFirstPassSites(raw, ids, 'breadth')).toEqual({ sites: new Map(), dropped: { not_array: 1 } })
    }
  })
})

describe('prompts and briefings', () => {
  const a: ReviewFinding = { severity: 'HIGH', title: 'A', file: 'src/a.ts', lines: '1', body: 'b' }
  const b: ReviewFinding = { severity: 'LOW', title: 'B', file: 'src/b.ts', body: 'b' }
  const breadthFinding: ReviewFinding = { severity: 'LOW', title: 'C', file: 'src/a.ts', lines: '3', body: 'b' }

  it('is byte-equal with the option off and appends the block after the overlay with it on', () => {
    expect(breadthSystemPrompt('BASE', 2, false, false)).toBe(breadthSystemPrompt('BASE', 2))
    expect(secondLookSystemPrompt('BASE', 2, true, true, false)).toBe(secondLookSystemPrompt('BASE', 2, true, true))
    expect(breadthSystemPrompt('BASE', 0, false, true)).toBe(`BASE\n\n${BREADTH_LENS}\n\n${FIRST_PASS_SITES_SECTION}`)
    expect(secondLookSystemPrompt('BASE', 0, false, true, true)).toBe(`BASE\n\n${withImpactItem(SECOND_LOOK_LENS)}\n\n${FIRST_PASS_SITES_SECTION}`)
    expect(FIRST_PASS_SITES_SECTION).toBe("## OTHER SITES OF FIRST-PASS FINDINGS\nFirst-pass findings in the message carry an id in brackets, e.g. [c3]. When the same root cause makes the same failure happen on an added or modified line in another file you were shown (a sibling call site, a parallel handler or route, the other side of a mismatched contract), list that place in first_pass_sites with the finding's id. Such a place is not a repeat. Never list the finding's own file, a place mentioned only as evidence, cause or where the fix goes, or a different problem. At most 3 places per id; omit the field when there are none.")
  })

  it('tags only the findings given an id, leaving other lines and the no-id output unchanged', () => {
    const ids = new Map([[a, 'c0'], [b, 'c1']])
    expect(breadthBriefing([a, b], ['src/c.ts'], undefined, new Map())).toBe(breadthBriefing([a, b], ['src/c.ts']))
    expect(breadthBriefing([a, b], ['src/c.ts'], undefined, ids)).toBe(breadthBriefing([a, b], ['src/c.ts']).replace('- src/a.ts:1 — A', '- [c0] src/a.ts:1 — A').replace('- src/b.ts — B', '- [c1] src/b.ts — B'))
    expect(secondLookBriefing([a, breadthFinding], ids)).toBe('## Findings already reported (do NOT repeat — find additional distinct problems in these files):\n- [c0] src/a.ts:1 — A\n- src/a.ts:3 — C')
  })
})

describe('runLens with the sites schema', () => {
  const schema = findingsOutputSchema({ firstPassSites: true })

  it('tolerates a malformed sites array in the provider check and returns the raw value for the sanitizer', async () => {
    completeStructured.mockResolvedValue({ object: { findings: [], first_pass_sites: [{ id: 'c0', file: 'b.ts', lines: '20' }] }, usage })
    const result = await runBreadth('k', 'm', 1, 1000, '', prInfo, 'diff', [], 'SYS', 'brief', false, 'breadth', schema)

    expect(completeStructured.mock.calls[0][3]).toEqual({ model: 'm', maxTokens: 1000, maxRetries: 1, effort: undefined, tolerateMissing: ['first_pass_sites'] })
    expect(result.firstPassSites).toEqual([{ id: 'c0', file: 'b.ts', lines: '20' }])
  })

  it('without the property, sends no tolerateMissing and returns no firstPassSites key', async () => {
    completeStructured.mockResolvedValue({ object: { findings: [] }, usage })
    const result = await runLens('k', 'm', 1, 1000, '', prInfo, 'diff', [], 'SYS', 'brief', false, 'lens:x', findingsOutputSchema({ alsoAffects: true }))

    expect(Object.keys(completeStructured.mock.calls[0][3])).toEqual(['model', 'maxTokens', 'maxRetries', 'effort'])
    expect('firstPassSites' in result).toBe(false)
  })
})

describe('applyJudgeDecisions with firstPassSites', () => {
  const candidates: ReviewFinding[] = [
    { severity: 'LOW', title: 'Dropped', file: 'src/a.ts', lines: '1', body: 'b' },
    { severity: 'HIGH', title: 'Kept', file: 'src/a.ts', lines: '2', body: 'b' },
    { severity: 'LOW', title: 'Breadth', file: 'src/a.ts', lines: '3', body: 'b' },
  ]
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,3 @@\n+x\n+y\n+z\n'
  const decision = (id: string, cat: string) => ({ candidate_id: id, reason_category: cat, evidence: 'src/a.ts:1', note: 'n', score: 7 })
  const output = { decisions: [decision('c0', 'incorrect'), decision('c1', 'validated'), decision('c2', 'validated')], summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 50 } as unknown as JudgeOutput
  const s = (id: string): FirstPassSite => ({ id, file: 'src/b.ts', lines: '1', where: `site of ${id}`, via: 'breadth' })

  it('attaches sites by candidate index, so a dropped c0 never shifts its sites onto the kept c1', () => {
    const judged = applyJudgeDecisions(candidates, output, undefined, [], diff, 2, { firstPassSites: new Map([[0, [s('c0')]], [1, [s('c1')]]]) })

    expect(judged.kept.map(k => [k.title, k.sites?.map(x => x.id) ?? null])).toEqual([['Kept', ['c1']], ['Breadth', null]])
    expect(judged.markdown).not.toContain('site of')
    expect(JSON.stringify(judged.scores)).not.toContain('site of')
  })

  it('without the option, kept findings carry no sites key', () => {
    const judged = applyJudgeDecisions(candidates, output, undefined, [], diff, 2)
    expect(judged.kept.some(k => 'sites' in k)).toBe(false)
  })
})

describe('firstPassSiteRows', () => {
  const DIFF = [
    'diff --git a/src/pool.ts b/src/pool.ts\n--- a/src/pool.ts\n+++ b/src/pool.ts\n@@ -1,1 +1,4 @@\n export class Pool {\n+  conns = []\n+  get() {}\n+  put() {}\n',
    'diff --git a/src/cache.ts b/src/cache.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/cache.ts\n@@ -0,0 +1,6 @@\n+a\n+b\n+c\n+d\n+e\n+f\n',
    'diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n',
  ].join('')
  const FILES: ChangedFile[] = [{ path: 'src/pool.ts', status: 'modified' }, { path: 'src/cache.ts', status: 'added' }, { path: 'src/old.ts', status: 'deleted' }]
  const s = (file: string, lines: string, where = 'w', via: FirstPassSite['via'] = 'breadth'): FirstPassSite => ({ id: 'c4', file, lines, where, via })
  const parent = (sites: FirstPassSite[], over: Partial<KeptFinding> = {}): KeptFinding =>
    ({ severity: 'HIGH', title: 'Race on conns', body: 'get/put race.', file: 'src/pool.ts', lines: '2-3', anchorSource: 'reviewer', sites, ...over })
  const prior = (file: string, start: number, end = start, message = 'Other: x'): ReportFinding => ({ file, start_line: start, end_line: end, message, producer: 'agent' })

  it('rejects any prior row on overlapping lines whatever its title, and an earlier site row from either pass', () => {
    const { rows, log } = firstPassSiteRows([parent([
      s('src/cache.ts', '1', 'under an original'), s('src/cache.ts', '2-3', 'overlaps a copy'), s('src/cache.ts', '4', 'free', 'breadth'),
      s('src/cache.ts', '4', 'named again', 'second_look'), s('src/pool.ts', '2'), s('src/old.ts', '1'), s('src/cache.ts', '9'), s('src/cache.ts', '5', ' '),
    ])], [prior('src/cache.ts', 1, 1, 'Unrelated original: x'), prior('src/cache.ts', 3, 3, 'Race on conns: copy')], FILES, DIFF, 'agent')

    expect(log.map(l => [l.via, l.lines, l.status])).toEqual([
      ['breadth', '1', 'duplicate'], ['breadth', '2-3', 'duplicate'], ['breadth', '4', 'row'], ['second_look', '4', 'duplicate'],
      ['breadth', '2', 'own_file'], ['breadth', '1', 'deleted_file'], ['breadth', '9', 'bad_lines'], ['breadth', '5', 'bad_where'],
    ])
    expect(log[2]).toEqual({ id: 'c4', via: 'breadth', parent: 'Race on conns', file: 'src/cache.ts', lines: '4', where: 'free', status: 'row' })
    expect(rows).toEqual([{ file: 'src/cache.ts', start_line: 4, end_line: 4, message: 'Race on conns: get/put race. Same defect here: free.', producer: 'agent' }])
  })

  it('caps accepted sites at 3 per parent and skips an unanchored parent', () => {
    const { rows, log } = firstPassSiteRows([
      parent([s('src/cache.ts', '1'), s('src/cache.ts', '2'), s('src/cache.ts', '3'), s('src/cache.ts', '4')]),
      parent([s('src/cache.ts', '6')], { file: undefined, lines: undefined, anchorSource: 'none' }),
    ], [], FILES, DIFF, 'agent')

    expect(log.map(l => l.status)).toEqual(['row', 'row', 'row', 'over_cap', 'parent_unanchored'])
    expect(rows).toHaveLength(3)
  })

  it('copies never carry sites, and alsoAffectsRows ignores them', () => {
    const p = parent([s('src/cache.ts', '1')], { reviewerBody: 'see src/cache.ts:3' })
    const copies = counterpartFindings([p], FILES, DIFF)
    expect(copies).toHaveLength(1)
    expect('sites' in copies[0]).toBe(false)
    expect(alsoAffectsRows([p], copies, FILES, DIFF, 'agent')).toEqual({ rows: [], log: [] })
  })
})
