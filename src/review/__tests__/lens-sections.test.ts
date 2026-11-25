import { describe, it, expect, vi } from 'vitest'

vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn() }))

import { activeLenses, resolvePlacements, LENS_REGISTRY, SLOP_KINDS, lensSystemPrompt } from '../lenses.js'
import { intakeSection, makeRoute, buildRows, finalizeSections, markSectionsPosted, placeLines, type SectionPlace } from '../lens-sections.js'
import { renderBlock, renderBlocks, parseSectionBlocks, stripOwnSections, type SectionBlock } from '../section-render.js'
import { applyJudgeDecisions, type JudgeOutput } from '../judge-decisions.js'
import { markdownHasFindings, type ReviewFinding } from '../formatter.js'
import { parseRows, parseHistoryLine } from '../../inline/rows.js'
import { SHOWN_LINE_CLAUSE } from '../breadth.js'
import type { LensRun, ReviewContext } from '../types.js'

const slop = LENS_REGISTRY.slop
const settings = (list: string, sections = '') => ({ enabled: true, list, sections })

describe('placement', () => {
  it('treats a list of only separators like an unset value', () => {
    for (const sections of [',', ' , + ', '+']) {
      const { placements, warnings } = resolvePlacements({ list: 'rel,slop', sections })
      expect([...placements]).toEqual([['reliability', 'findings'], ['slop', 'section']])
      expect(warnings).toEqual([])
    }
  })

  it('uses each lens default when LENS_SECTIONS is unset or empty', () => {
    for (const sections of [undefined, '', '  ']) {
      const { placements } = resolvePlacements({ list: 'rel,slop', sections })
      expect([...placements]).toEqual([['reliability', 'findings'], ['slop', 'section']])
    }
  })

  it('none puts every lens in Findings and warns about slop', () => {
    const { placements, warnings } = resolvePlacements({ list: 'rel,slop', sections: 'NONE' })
    expect([...placements.values()]).toEqual(['findings', 'findings'])
    expect(warnings.join('\n')).toContain('slop is placed in Findings')
  })

  it('a list makes exactly those lenses sections, takes aliases and ignores unknown names', () => {
    const { placements, warnings } = resolvePlacements({ list: 'rel,slop,imp', sections: 'REL+bogus' })
    expect([...placements]).toEqual([['reliability', 'section'], ['slop', 'findings'], ['impact', 'findings']])
    expect(warnings.join('\n')).toContain('ignoring unknown lens name(s) bogus')
  })

  it('only unknown names keep each lens default placement instead of moving all to Findings', () => {
    const { placements, warnings } = resolvePlacements({ list: 'rel,slop', sections: 'slpo,bogus' })
    expect([...placements]).toEqual([['reliability', 'findings'], ['slop', 'section']])
    expect(warnings.join('\n')).toContain('no known lens name - using each lens default placement')
  })

  it('none mixed with names counts as none and warns', () => {
    const { placements, warnings } = resolvePlacements({ list: 'rel', sections: 'none,rel' })
    expect(placements.get('reliability')).toBe('findings')
    expect(warnings.join('\n')).toContain('mixes none with lens names')
  })

  it('a name outside LENSES has no effect', () => {
    expect([...resolvePlacements({ list: 'rel', sections: 'perf' }).placements]).toEqual([['reliability', 'findings']])
  })

  it('runs findings lenses first and section lenses after, each in list order', () => {
    expect(activeLenses(settings('slop,rel,imp')).map(l => l.name)).toEqual(['reliability', 'impact', 'slop'])
    expect(activeLenses(settings('slop,rel,imp', 'rel')).map(l => l.name)).toEqual(['slop', 'impact', 'reliability'])
    expect(activeLenses({ enabled: false, list: 'slop' })).toEqual([])
  })

  it('does not change today\'s order or placement for recall lenses', () => {
    expect(activeLenses({ enabled: true, list: 'imp+rel' }).map(l => l.name)).toEqual(['impact', 'reliability'])
    expect(Object.values(LENS_REGISTRY).filter(l => l.defaultPlacement === 'section').map(l => l.name)).toEqual(['slop'])
  })
})

describe('slop definition', () => {
  it('pins the overlay frame, the kinds and the FORBIDDEN exception', () => {
    expect(slop.overlay.startsWith('## SLOP LENS\nThis pass looks for one thing only: low-value code this change adds')).toBe(true)
    expect(slop.overlay).toContain('For this pass only, the FORBIDDEN rules on style, nitpicks and refactoring and the failing-scenario requirement for lower-severity findings do not apply')
    expect(slop.overlay).toContain(`:\n${SLOP_KINDS}\nReport one finding per place`)
    expect(slop.overlay.endsWith('Return an empty list if you find nothing.')).toBe(true)
    expect(slop.overlay).not.toContain('{SLOP_KINDS}')
    expect(SLOP_KINDS.split('\n')).toHaveLength(10)
    expect(slop.section.criteria).toBe(SLOP_KINDS)
  })

  it('has no shown-line clause, so the allowance can never throw for it', () => {
    expect(slop.overlay).not.toContain(SHOWN_LINE_CLAUSE)
    expect(() => lensSystemPrompt('base', slop, 25, false)).not.toThrow()
  })
})

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,6 @@',
  ' keep', '+// one', '+const a = 1', '+// three', '+const b = 2', ' tail',
  'diff --git a/src/a.test.ts b/src/a.test.ts', 'new file mode 100644', 'index 0..3', '--- /dev/null', '+++ b/src/a.test.ts', '@@ -0,0 +1,3 @@',
  '+it("x", () => {', '+  run()', '+})',
  'diff --git a/README.md b/README.md', 'index 1..2 100644', '--- a/README.md', '+++ b/README.md', '@@ -1,1 +1,2 @@', ' x', '+docs',
  'diff --git a/vendor/lib.js b/vendor/lib.js', 'index 1..2 100644', '--- a/vendor/lib.js', '+++ b/vendor/lib.js', '@@ -1,1 +1,2 @@', ' x', '+// comment',
  '',
].join('\n')

const f = (over: Partial<ReviewFinding>): ReviewFinding => ({ severity: 'MEDIUM', title: 'Restating comment: says the obvious', file: 'src/a.ts', lines: '2', body: 'Delete it.', ...over })
const env = { filteredDiff: DIFF, fileContexts: [] as Array<{ path: string }> }

describe('section intake', () => {
  it('keeps a valid place and sets severity, type and the lens marker itself', () => {
    const r = intakeSection(slop, [f({})], env)
    expect(r.places).toEqual([{ lens: 'slop', file: 'src/a.ts', start: 2, end: 2, label: 'Restating comment', reason: 'says the obvious', body: 'Delete it.', severity: 'LOW', type: 'maintainability', kind: 'Restating comment' }])
    expect(r.received).toBe(1)
  })

  it.each([
    ['unknown_kind', f({ title: 'Something vague' })],
    ['unknown_kind', f({ title: 'Restating comment:' })],
    ['excluded_file', f({ file: 'src/missing.ts' })],
    ['excluded_file', f({ file: 'README.md' })],
    ['excluded_file', f({ file: 'vendor/lib.js', lines: '2' })],
    ['wrong_path', f({ title: 'Hollow test: asserts nothing', file: 'src/a.ts' })],
    ['wrong_path', f({ title: 'Debug leftover: console.log of a value', file: 'src/a.test.ts', lines: '1' })],
    ['too_wide', f({ lines: '2-60' })],
    ['not_added_line', f({ lines: '1' })],
    ['not_added_line', f({ lines: 'foo' })],
    ['not_added_line', f({ lines: '2-6' })],
  ])('counts a %s drop', (reason, finding) => {
    const r = intakeSection(slop, [finding], env)
    expect(r.places).toEqual([])
    expect(r.dropped[reason as keyof typeof r.dropped]).toBe(1)
  })

  it('accepts plurals and the three separators, in any case', () => {
    for (const title of ['restating comments: x', 'Restating comment – x', 'Restating comment — x', 'RESTATING COMMENT - x']) {
      expect(intakeSection(slop, [f({ title })], env).places).toHaveLength(1)
    }
  })

  it('splits a comma list into one place per item', () => {
    const r = intakeSection(slop, [f({ lines: '2, 4' })], env)
    expect(r.places.map(placeLines)).toEqual(['2', '4'])
  })

  it('applies the test path rule both ways', () => {
    expect(intakeSection(slop, [f({ title: 'Hollow test: asserts nothing', file: 'src/a.test.ts', lines: '1-2' })], env).places[0]).toMatchObject({ type: 'tests', label: 'Hollow test' })
  })

  it('requires a fully shown file for a single-use abstraction', () => {
    const t = f({ title: 'Single-use abstraction: forwards once' })
    expect(intakeSection(slop, [t], env).dropped.wrong_path).toBe(1)
    expect(intakeSection(slop, [t], { ...env, fileContexts: [{ path: 'src/a.ts' }] }).places).toHaveLength(1)
  })

  it('scopes places to the delta when one is given', () => {
    const delta = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@', ' keep', '+// one', ''].join('\n')
    expect(intakeSection(slop, [f({ lines: '2' }), f({ lines: '4' })], { ...env, deltaDiff: delta }).places.map(placeLines)).toEqual(['2'])
  })

  it('caps places at 25 and counts the rest', () => {
    const many = Array.from({ length: 30 }, () => f({}))
    const r = intakeSection(slop, many, env)
    expect(r.places).toHaveLength(25)
    expect(r.dropped.over_cap).toBe(5)
  })

  it('lets a recall lens placed in a section keep the severity it reported', () => {
    const r = intakeSection(LENS_REGISTRY.reliability, [f({ title: 'Unhandled rejection', severity: 'HIGH', type: 'reliability' })], env)
    expect(r.places[0]).toMatchObject({ severity: 'HIGH', type: 'reliability', label: 'HIGH', reason: 'Unhandled rejection' })
  })
})

const place = (over: Partial<SectionPlace> = {}): SectionPlace => ({ lens: 'slop', file: 'src/a.ts', start: 2, end: 2, label: 'Restating comment', reason: 'says the obvious', body: 'b', severity: 'LOW', type: 'maintainability', ...over })
const section = { def: slop.section, places: [place({ start: 2, end: 3 })] }
const kept = (over: Record<string, unknown> = {}) => ({ severity: 'LOW' as const, title: 't', body: 'b', file: 'src/a.ts', lines: '3', type: 'maintainability' as const, ...over })

describe('routing', () => {
  const paths = ['src/a.ts']

  it('moves a LOW maintainability, tests, other or untyped finding on a place', () => {
    for (const type of ['maintainability', 'tests', 'other', undefined]) {
      expect([...makeRoute([section], [], paths).route([kept({ type })]).entries()]).toEqual([[0, 'slop']])
    }
  })

  it('leaves runtime-typed LOWs, MEDIUM and HIGH, and other lines alone', () => {
    const { route } = makeRoute([section], [], paths)
    expect(route([kept({ type: 'correctness' }), kept({ severity: 'MEDIUM' }), kept({ severity: 'HIGH' }), kept({ lines: '9' }), kept({ file: 'src/b.ts' }), kept({ lines: undefined })]).size).toBe(0)
  })

  it('lets an open thread on the same lines win', () => {
    const { route } = makeRoute([section], [{ file: 'src/a.ts', lines: '3-4' }], paths)
    expect(route([kept()]).size).toBe(0)
  })

  it('never moves into a section that does not absorb', () => {
    const rel = { def: LENS_REGISTRY.reliability.section, places: [place({ lens: 'reliability' })] }
    expect(makeRoute([rel], [], paths).route([kept({ lines: '2' })]).size).toBe(0)
  })

  it('reports the places that absorbed, and resets on every call', () => {
    const r = makeRoute([section], [], paths)
    r.route([kept(), kept({ lines: '2' })])
    expect([...r.absorbed().values()]).toEqual([2])
    r.route([])
    expect(r.absorbed().size).toBe(0)
  })
})

describe('the judge route option', () => {
  const output = (n: number): JudgeOutput => ({
    decisions: Array.from({ length: n }, (_, i) => ({ candidate_id: `c${i}`, reason_category: 'validated' as const, evidence: 'e', note: 'n', score: 8 })),
    summary: 'A summary of the pull request.', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80,
  })
  const candidates: ReviewFinding[] = [
    { severity: 'LOW', title: 'Stale comment', file: 'src/a.ts', lines: '2', body: 'x', type: 'maintainability' },
    { severity: 'MEDIUM', title: 'Real bug', file: 'src/a.ts', lines: '4', body: 'y', type: 'correctness' },
  ]

  it('removes a routed finding before scores, render and decisions are built, and marks its decision', () => {
    const judged = applyJudgeDecisions(candidates, output(2), undefined, [], DIFF, undefined, { route: k => new Map(k.flatMap((x, n) => (x.severity === 'LOW' ? [[n, 'slop'] as const] : []))) })
    expect(judged.kept.map(k => k.title)).toEqual(['Real bug'])
    expect(judged.scores.map(s => s.title)).toEqual(['Real bug'])
    expect(judged.markdown).not.toContain('Stale comment')
    expect(judged.markdown).toContain('Real bug')
    expect(judged.decisions.map(d => d.routed_to_section)).toEqual(['slop', undefined])
    expect(judged.render(new Map([[0, ' [x]']]))).toContain('Real bug')
  })

  it('renders like a judge that kept nothing when every finding is routed', () => {
    const all = applyJudgeDecisions(candidates, output(2), undefined, [], DIFF, undefined, { route: k => new Map(k.map((_, n) => [n, 'slop'] as const)) })
    const none = applyJudgeDecisions(candidates, { ...output(2), decisions: [] }, undefined, [], DIFF)
    expect(all.markdown).toBe(none.markdown)
    expect(all.kept).toEqual([])
  })

  it('is byte-identical to today when no route is given', () => {
    expect(applyJudgeDecisions(candidates, output(2), undefined, [], DIFF).markdown).toBe(applyJudgeDecisions(candidates, output(2), undefined, [], DIFF, undefined, {}).markdown)
  })
})

describe('rows', () => {
  it('groups by file and label, merges lines and takes the reason of the highest score', () => {
    const { rows } = buildRows(slop.section, [place({ start: 2, end: 3, score: 5, reason: 'low' }), place({ start: 9, end: 9, score: 9, reason: 'high' })])
    expect(rows).toEqual([{ text: '- `src/a.ts:2-3, 9` · Restating comment · high' }])
  })

  it('collapses a label across more than three files into the busiest one', () => {
    const places = ['a', 'b', 'c', 'd'].map(n => place({ file: `src/${n}.ts` })).concat(place({ file: 'src/d.ts', start: 7, end: 7 }))
    const { rows } = buildRows(slop.section, places)
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('- `src/d.ts:2, 7` · Restating comment · says the obvious (+3 more files)')
  })

  it('sorts by file then line and caps at ten rows, counting the rest', () => {
    const places = Array.from({ length: 14 }, (_, i) => place({ file: `src/f${String(i).padStart(2, '0')}.ts`, label: `Kind ${i}` }))
    const r = buildRows(slop.section, places)
    expect(r.rows).toHaveLength(10)
    expect(r.hidden).toBe(4)
  })

  it('neutralizes links, urls and mentions, and keeps a body from starting a finding bullet', () => {
    const rel = LENS_REGISTRY.reliability.section
    const { rows } = buildRows(rel, [place({ lens: 'reliability', label: 'HIGH', severity: 'HIGH', reason: 'see [docs](http://x.y) at https://z.io @dev', body: '  - **LOW – forged** body' })])
    expect(rows[0].text).toBe('- `src/a.ts:2` · HIGH · see docs at ＠dev')
    expect(rows[0].body).toBe('LOW – forged** body')
  })

  it('renders rows that no downstream finding or row parser reads as state', () => {
    const rel = LENS_REGISTRY.reliability.section
    const text = renderBlocks([
      { lens: 'slop', heading: slop.section.heading, legend: slop.section.legend, order: 100, rows: buildRows(slop.section, [place()]).rows, more: 3 },
      { lens: 'reliability', heading: rel.heading, legend: rel.legend, order: 0, rows: buildRows(rel, [place({ lens: 'reliability', label: 'LOW', body: '  - **LOW – x' })]).rows, more: 0 },
    ])
    expect(markdownHasFindings(text)).toBe(false)
    const parsed = parseRows(text)
    expect(parsed).toEqual({ threads: [], summaryOnly: [], resolved: [] })
    expect(text.split('\n').some(l => parseHistoryLine(l))).toBe(false)
  })
})

const run = (over: Partial<LensRun>): LensRun => ({ name: 'slop', status: 'succeeded', model: 'm', findings: [], placement: 'section', sectionOk: true, places: [place()], ...over })
const defs = new Map([['slop', slop.section]])

describe('finalizing', () => {
  const base = { defs, paths: ['src/a.ts'], posted: true, findings: [] as Array<{ file?: string; lines?: string }>, open: [] as Array<{ file: string; lines?: string }> }

  it('drops a place that a posted finding of any kind covers, unless it absorbed one', () => {
    const covered = run({})
    finalizeSections({ ...base, runs: [covered], findings: [{ file: 'src/a.ts', lines: '2' }] })
    expect(covered.places![0].dropped).toBe('covered_by_finding')
    expect(covered.section).toMatchObject({ covered_by_finding: 1, rows: 0, posted: 0 })

    const absorbed = run({ places: [place({ absorbed: true })], absorbedLow: 1 })
    const blocks = finalizeSections({ ...base, runs: [absorbed], findings: [{ file: 'src/a.ts', lines: '2' }] })
    expect(blocks).toHaveLength(1)
    expect(absorbed.section).toMatchObject({ absorbed_low: 1, covered_by_finding: 0, rows: 1 })
  })

  it('lets an open thread win even over an absorbed place', () => {
    const r = run({ places: [place({ absorbed: true })] })
    expect(finalizeSections({ ...base, runs: [r], open: [{ file: 'src/a.ts', lines: '1-3' }] })).toEqual([])
    expect(r.places![0].dropped).toBe('covered_by_thread')
  })

  it('does nothing when the recorded range no longer intersects (moved code)', () => {
    expect(finalizeSections({ ...base, runs: [run({})], open: [{ file: 'src/a.ts', lines: '40-41' }] })).toHaveLength(1)
  })

  it('shows no block for a lens or judge that did not complete, and orders blocks ascending', () => {
    expect(finalizeSections({ ...base, runs: [run({ sectionOk: false })] })).toEqual([])
    const rel = LENS_REGISTRY.reliability.section
    const both = finalizeSections({
      ...base, defs: new Map([['slop', slop.section], ['reliability', rel]]),
      runs: [run({}), run({ name: 'reliability', places: [place({ lens: 'reliability', label: 'LOW' })] })],
    })
    expect(both.map(b => b.lens)).toEqual(['reliability', 'slop'])
  })

  it('logs places unposted when nothing was posted', () => {
    const r = run({})
    finalizeSections({ ...base, runs: [r], posted: false })
    expect(r.section!.posted).toBe(0)
  })

  it('counts as posted only the places a row shows, not those behind "and N more"', () => {
    const places = Array.from({ length: 12 }, (_, i) => place({ file: `src/f${String(i).padStart(2, '0')}.ts`, label: `Kind ${i}` }))
    const r = run({ places })
    const blocks = finalizeSections({ ...base, runs: [r], posted: true })
    expect(blocks[0]).toMatchObject({ more: 2 })
    expect(r.section).toMatchObject({ rows: 10, rows_hidden: 2, posted: 10 })
    expect(places.filter(p => p.shown)).toHaveLength(10)
  })

  it('marks rows posted only once the comment really went out', () => {
    const places = [place()]
    const r = run({ places })
    finalizeSections({ ...base, runs: [r], posted: false })
    const ctx = { lensRuns: [r] } as ReviewContext
    expect(ctx.sectionsPosted).toBeUndefined()
    expect(r.section!.posted).toBe(0)
    markSectionsPosted(ctx)
    expect(ctx.sectionsPosted).toBe(true)
    expect(r.section!.posted).toBe(1)
  })
})

describe('recognition', () => {
  const block: SectionBlock = { lens: 'slop', heading: slop.section.heading, legend: slop.section.legend, order: 100, rows: [{ text: '- `src/a.ts:2` · Restating comment · x' }, { text: '- `src/b.ts:3` · Hollow test · y', body: 'detail' }], more: 2 }
  const body = (extra = '') => `### Summary\nok\n\n### Merge Confidence: 80%\n\n${renderBlock(block)}\n\n### TODOs Introduced\n- \`a:1\` — TODO${extra}\n\n---\n*Reviewed by bot (m) | Prompt: repo | Review #1 | Commit: abc123*`

  it('round-trips a rendered block, including bodies and the overflow count', () => {
    expect(parseSectionBlocks(body())).toEqual([block])
    expect(renderBlock(parseSectionBlocks(body())[0])).toBe(renderBlock(block))
  })

  it('needs the exact heading and the exact legend', () => {
    expect(parseSectionBlocks('### Cleanup\nSomething else\n\n- `a:1` · x · y')).toEqual([])
    expect(parseSectionBlocks('### Cleanup items\nLow-value code added in this PR; not counted in the findings or the verdict.\n\n- `a:1` · x · y')).toEqual([])
  })

  it('ignores a block inside a code fence', () => {
    expect(parseSectionBlocks(`\`\`\`\n${renderBlock(block)}\n\`\`\``)).toEqual([])
  })

  it('strips blocks from an agent review only, and returns the same string when there is nothing to strip', () => {
    const stripped = stripOwnSections(body())
    expect(stripped).not.toContain('### Cleanup')
    expect(stripped).toContain('### TODOs Introduced')
    const plain = '### Summary\nok\n\n---\n*Reviewed by bot (m) | Prompt: repo | Review #1 | Commit: abc123*'
    expect(stripOwnSections(plain)).toBe(plain)
    const human = `### Summary\n${renderBlock(block)}\nthanks`
    expect(stripOwnSections(human)).toBe(human)
  })

  it('trims to bodies off, five rows with a count line, and a bare count', () => {
    const many: SectionBlock = { ...block, rows: Array.from({ length: 8 }, (_, i) => ({ text: `- \`f${i}:1\` · k · r`, body: 'b' })), more: 0 }
    expect(renderBlock(many, { bodies: false, maxRows: 5 }).split('\n').filter(l => l.startsWith('- '))).toHaveLength(6)
    expect(renderBlock(many, { bodies: false, maxRows: 5 })).toContain('- and 3 more Cleanup items')
    expect(renderBlock(many, { count: true })).toContain('- 8 Cleanup items; list omitted to fit the size limit')
  })
})
