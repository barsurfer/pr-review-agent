import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import type { ReviewContext } from '../types.js'

const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))

import { SECOND_LOOK_LENS, IMPACT_ITEM, withImpactItem, secondLookSystemPrompt, allowShownContext, SHOWN_LINE_CLAUSE } from '../breadth.js'
import { LENS_REGISTRY, activeLenses, parseLensList, lensSystemPrompt } from '../lenses.js'
import { findingsOutputSchema, sanitizeFindingExtras, runLens, runBreadth, runJudge, BREADTH_OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA, JUDGE_OUTPUT_SCHEMA } from '../client.js'
import { applyJudgeDecisions, type JudgeOutput } from '../judge-decisions.js'
import { alsoAffectsRows, counterpartFindings, ALSO_AFFECTS_WHERE_NOTE, type KeptFinding } from '../findings-output.js'
import { isPathExcluded, filterDiff } from '../parsers.js'
import type { ReviewFinding, ReviewObject, AlsoAffected } from '../formatter.js'
import type { PRInfo, ChangedFile } from '../../vcs/adapter.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)
const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const prInfo = { title: 't', sourceBranch: 's', targetBranch: 'm', description: '' } as PRInfo

describe('second-look item 4 (ENABLE_HIGH_IMPACT)', () => {
  const ANCHOR = '\nDo not repeat a first-pass finding'

  it('inserts item 4 after item 3 and before "Do not repeat", leaving items 1-3 and the closing lines byte-equal', () => {
    const [head, tail] = SECOND_LOOK_LENS.split(ANCHOR)
    const on = withImpactItem(SECOND_LOOK_LENS)

    expect(on).toBe(`${head}\n${IMPACT_ITEM}${ANCHOR}${tail}`)
    expect(on.indexOf('\n3. Incomplete changes')).toBeLessThan(on.indexOf('\n4. What breaks in a real scenario'))
    expect(on.indexOf('\n4. What breaks in a real scenario')).toBeLessThan(on.indexOf(ANCHOR))
    expect(SECOND_LOOK_LENS).not.toContain(IMPACT_ITEM)
  })

  it('item 4 text is verbatim and asks for nothing outside what was shown', () => {
    expect(IMPACT_ITEM.startsWith('4. What breaks in a real scenario: follow the changed code in these files with a feature, flag or optional dependency it relies on switched off;')).toBe(true)
    expect(IMPACT_ITEM.endsWith('Report it only when you can follow the failure end to end in what you were shown, and name the scenario in the body.')).toBe(true)
    expect(IMPACT_ITEM).not.toMatch(/not shown|unshown|install/)
    expect(IMPACT_ITEM).not.toContain(SHOWN_LINE_CLAUSE)
  })

  it('secondLookSystemPrompt is unchanged unless highImpact is true', () => {
    for (const limit of [0, 7]) {
      for (const shown of [false, true]) {
        expect(secondLookSystemPrompt('P', limit, shown, false)).toBe(secondLookSystemPrompt('P', limit, shown))
        expect(secondLookSystemPrompt('P', limit, shown, true)).not.toBe(secondLookSystemPrompt('P', limit, shown))
      }
    }
    expect(secondLookSystemPrompt('P', 0, false, true)).toBe(`P\n\n${withImpactItem(SECOND_LOOK_LENS)}`)
  })

  it('composes with shown-context anchors: the clause is replaced exactly once and item 4 stays', () => {
    const text = secondLookSystemPrompt('P', 0, true, true)

    expect(text).toBe(`P\n\n${allowShownContext(withImpactItem(SECOND_LOOK_LENS))}`)
    expect(text.split('or on an unchanged line you were shown when it explains a defect this change introduces.')).toHaveLength(2)
    expect(text).not.toContain(SHOWN_LINE_CLAUSE)
    expect(text).toContain(IMPACT_ITEM)
  })

  it('withImpactItem throws unless the anchor occurs exactly once', () => {
    expect(() => withImpactItem('no anchor here')).toThrow('Second-look anchor not found')
    expect(() => withImpactItem(`${SECOND_LOOK_LENS}${ANCHOR} again.`)).toThrow('Second-look anchor not found')
  })

  it('the second-look prompt hash changes only with highImpact', () => {
    expect(hash(secondLookSystemPrompt('BASE', 3, false, false))).toBe(hash(secondLookSystemPrompt('BASE', 3)))
    expect(hash(secondLookSystemPrompt('BASE', 3, false, true))).not.toBe(hash(secondLookSystemPrompt('BASE', 3)))
  })
})

describe('impact lens (an ordinary registry lens)', () => {
  const impact = LENS_REGISTRY.impact
  const names = (list: string, enabled = true) => activeLenses({ enabled, list }).map(l => l.name)

  it('keeps the shared frame: heading, scope lock, uncertainty line, one shown-line clause, closing line', () => {
    expect(impact.name).toBe('impact')
    expect(impact.overlay.startsWith('## IMPACT LENS\n')).toBe(true)
    expect(impact.overlay).toContain('This pass re-reads the whole diff for one concern — what breaks when the change meets a real scenario — to find real problems they missed')
    expect(impact.overlay).toContain('no audit of unchanged code')
    expect(impact.overlay).toContain('When confidence is limited but potential impact is high (data loss, security, corruption), report it with an explicit note on what remains uncertain — do not silently drop it.')
    expect(impact.overlay.split(SHOWN_LINE_CLAUSE)).toHaveLength(2)
    expect(impact.overlay).not.toMatch(/not shown|unshown/)
    expect(impact.overlay.endsWith('Return an empty list if you find nothing.')).toBe(true)
  })

  it('carries the six scenario items and the note verbatim', () => {
    for (const start of ['- clean install or build:', '- a feature, flag or optional dependency switched off:', '- repeated or overlapping use the platform allows', '- existing data and upgrades:', '- order of side effects:', '- contracts across files:']) {
      expect(impact.overlay).toContain(`\n${start}`)
    }
    expect(impact.overlay).toContain('\n- clean install or build: a module, file, plugin or dependency the new code needs that a manifest, published-files list or setup file omits, only when that whole file is shown in the file context;\n')
    expect(impact.overlay).not.toMatch(/in the diff or file context/)
    expect(impact.overlay).toContain('(a nullable value passed where a non-null one is required).\nTrace each scenario from caller to callee through the code you were shown and report a failure only when you can follow it end to end, naming the scenario in the body; report a cross-file mismatch only when both sides are visible. When the same defect occurs in several changed files, report it in each.\n')
  })

  it('has a short trigger phrase within the registry cap that is not part of the overlay', () => {
    expect(impact.when).toBe('changes crossing files, feature gates, persisted data, deferred or repeated work, or side-effect order')
    expect(impact.when.length).toBeLessThanOrEqual(120)
    expect(impact.overlay).not.toContain(impact.when)
  })

  it('alone asks for the scenario tag; the other lenses are unchanged objects', () => {
    expect(impact.scenarioTag).toBe(true)
    for (const name of ['reliability', 'security', 'testing', 'performance', 'architecture']) {
      expect(Object.keys(LENS_REGISTRY[name])).toEqual(['name', 'when', 'defaultPlacement', 'section', 'overlay'])
    }
  })

  it('resolves from impact or imp and runs only when listed, in list order', () => {
    expect(parseLensList('impact')).toEqual({ lenses: [impact], unknown: [] })
    expect(parseLensList('imp')).toEqual({ lenses: [impact], unknown: [] })
    expect(names('imp+rel')).toEqual(['impact', 'reliability'])
    expect(names('rel+imp')).toEqual(['reliability', 'impact'])
    expect(names('rel')).toEqual(['reliability'])
    expect(names('rel+sec')).toEqual(['reliability', 'security'])
    expect(names('0')).toEqual([])
    expect(names('')).toEqual([])
    expect(names('imp', false)).toEqual([])
    expect(parseLensList('impct+imps')).toEqual({ lenses: [], unknown: ['impct', 'imps'] })
  })

  it('goes through lensSystemPrompt like any lens, shown-line allowance included', () => {
    expect(lensSystemPrompt('P', impact, 0)).toBe(`P\n\n${impact.overlay}`)
    expect(lensSystemPrompt('P', impact, 0, true)).toContain('or on an unchanged line you were shown when it explains a defect this change introduces')
  })
})

describe('findingsOutputSchema variants', () => {
  type Variant = { properties: { findings: { items: { properties: Record<string, any>; required: string[] } } } }
  const itemOf = (s: unknown) => (s as Variant).properties.findings.items

  it('no option returns BREADTH_OUTPUT_SCHEMA itself', () => {
    expect(findingsOutputSchema()).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(findingsOutputSchema({})).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(findingsOutputSchema({ alsoAffects: false, scenario: false })).toBe(BREADTH_OUTPUT_SCHEMA)
  })

  it('each combination is its own cached clone with only its optional fields; the shared constants stay untouched', () => {
    const before = [JSON.stringify(BREADTH_OUTPUT_SCHEMA), JSON.stringify(REVIEW_OUTPUT_SCHEMA)]
    const a = findingsOutputSchema({ alsoAffects: true })
    const s = findingsOutputSchema({ scenario: true })
    const both = findingsOutputSchema({ alsoAffects: true, scenario: true })

    expect(new Set([a, s, both, BREADTH_OUTPUT_SCHEMA]).size).toBe(4)
    expect(findingsOutputSchema({ alsoAffects: true, scenario: false })).toBe(a)
    expect(findingsOutputSchema({ scenario: true, alsoAffects: true })).toBe(both)
    const base = Object.keys(BREADTH_OUTPUT_SCHEMA.properties.findings.items.properties)
    expect(Object.keys(itemOf(a).properties)).toEqual([...base, 'also_affects'])
    expect(Object.keys(itemOf(s).properties)).toEqual([...base, 'scenario'])
    expect(Object.keys(itemOf(both).properties)).toEqual([...base, 'also_affects', 'scenario'])
    for (const v of [a, s, both]) expect(itemOf(v).required).toEqual(['severity', 'title', 'body'])
    expect([JSON.stringify(BREADTH_OUTPUT_SCHEMA), JSON.stringify(REVIEW_OUTPUT_SCHEMA)]).toEqual(before)
    expect(BREADTH_OUTPUT_SCHEMA.properties.findings).toBe(REVIEW_OUTPUT_SCHEMA.properties.findings)
  })

  it('also_affects asks for other places of the same defect not reported on their own, at most 3, digits-only lines', () => {
    const field = itemOf(findingsOutputSchema({ alsoAffects: true })).properties.also_affects
    expect(field.type).toBe('array')
    expect(field.description).toContain('that you are not reporting as a finding of their own')
    expect(field.description).toContain('One entry per place, at most 3.')
    expect(field.items.required).toEqual(['file', 'lines', 'where'])
    expect(field.items.additionalProperties).toBe(false)
    expect(field.items.properties.lines.description).toBe('Digits only: the added or changed line or range in that file where the same defect occurs, e.g. "46" or "60-62".')
  })

  it('scenario is a closed enum of the six scenario names', () => {
    const field = itemOf(findingsOutputSchema({ scenario: true })).properties.scenario
    expect(field.enum).toEqual(['install', 'feature_off', 'repeat', 'old_data', 'order', 'contract'])
    expect(field.description).toBe('Only for a finding found by tracing a scenario or contract named in SECOND LOOK item 4 or the IMPACT LENS: which one. Omit otherwise.')
  })
})

describe('sanitizeFindingExtras', () => {
  const base: ReviewFinding = { severity: 'HIGH', title: 'T', file: 'a.ts', lines: '2', body: 'b' }
  const clean = (extra: Record<string, unknown>) => sanitizeFindingExtras({ ...base, ...extra } as ReviewFinding)

  it('keeps well-formed entries trimmed, collapses whitespace in where, and caps at 10', () => {
    const entry = { file: ' src/b.ts ', lines: ' 4-6 ', where: '  take()\n\t hands   out ' }
    expect(clean({ also_affects: [entry] })).toEqual({ ...base, also_affects: [{ file: 'src/b.ts', lines: '4-6', where: 'take() hands out' }] })
    const many = Array.from({ length: 12 }, (_, i) => ({ file: `f${i}.ts`, lines: '1', where: 'w' }))
    expect(clean({ also_affects: many }).also_affects!.map(e => e.file)).toEqual(many.slice(0, 10).map(e => e.file))
  })

  it('drops junk entries and deletes the key when nothing valid is left', () => {
    const junk = [null, 'src/b.ts:4', 7, { file: 'b.ts', lines: '4' }, { file: '  ', lines: '4', where: 'w' }, { file: 'b.ts', lines: 4, where: 'w' }, { file: 'b.ts', lines: '4', where: ' \n ' }]
    expect(clean({ also_affects: junk })).toEqual(base)
    expect(clean({ also_affects: [...junk, { file: 'c.ts', lines: '9', where: 'ok' }] }).also_affects).toEqual([{ file: 'c.ts', lines: '9', where: 'ok' }])
    for (const v of [null, 'b.ts', {}, 3, []]) expect('also_affects' in clean({ also_affects: v })).toBe(false)
  })

  it('keeps scenario only when it is one of the enum values', () => {
    expect(clean({ scenario: 'repeat' }).scenario).toBe('repeat')
    for (const v of ['Repeat', 'race', '', null, 3, ['order']]) expect('scenario' in clean({ scenario: v })).toBe(false)
  })

  it('leaves the other fields alone and passes a non-object through', () => {
    expect(clean({})).toEqual(base)
    expect(sanitizeFindingExtras(null as unknown as ReviewFinding)).toBeNull()
  })
})

describe('runLens / runBreadth with a findings schema variant', () => {
  beforeEach(() => completeStructured.mockReset())
  const raw = { severity: 'HIGH', title: 'Race', file: 'a.ts', lines: '2', body: 'b', scenario: 'nope', also_affects: [{ file: 'b.ts', lines: '3', where: ' x  y ' }, { file: '' }] }

  it('a variant schema is sent as given and the returned findings are sanitized', async () => {
    const schema = findingsOutputSchema({ alsoAffects: true, scenario: true })
    completeStructured.mockResolvedValue({ object: { findings: [raw] }, usage })
    const res = await runLens('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], 'SYS', 'BRIEF', false, 'lens:impact', schema)

    expect(completeStructured.mock.calls[0][2]).toBe(schema)
    expect(res.findings).toEqual([{ severity: 'HIGH', title: 'Race', file: 'a.ts', lines: '2', body: 'b', also_affects: [{ file: 'b.ts', lines: '3', where: 'x y' }] }])
  })

  it('the constant schema returns the model findings array untouched', async () => {
    const findings = [raw]
    completeStructured.mockResolvedValue({ object: { findings }, usage })
    const res = await runLens('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], 'SYS', 'BRIEF')
    expect(completeStructured.mock.calls[0][2]).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(res.findings).toBe(findings)
  })

  it('runBreadth passes the schema through to the same provider call runLens makes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const schema = findingsOutputSchema({ alsoAffects: true })
    completeStructured.mockResolvedValue({ object: { findings: [] }, usage })
    await runBreadth('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], 'SYS', 'BRIEF', false, 'breadth', schema)
    await runLens('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], 'SYS', 'BRIEF', false, 'breadth', schema)
    expect(completeStructured.mock.calls[0]).toEqual(completeStructured.mock.calls[1])
    expect(completeStructured.mock.calls[0][2]).toBe(schema)
    log.mockRestore()
  })
})

describe('the judge never sees also_affects or scenario', () => {
  beforeEach(() => completeStructured.mockReset())
  const review = (findings: ReviewFinding[]): ReviewObject => ({ summary: 'S', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [] })
  const plain: ReviewFinding[] = [{ severity: 'HIGH', title: 'Race', file: 'a.ts', lines: '2', body: 'b' }, { severity: 'LOW', title: 'Nit', body: 'n' }]
  const tagged: ReviewFinding[] = [{ ...plain[0], scenario: 'repeat', also_affects: [{ file: 'b.ts', lines: '3', where: 'w' }] }, plain[1]]
  const judged: JudgeOutput = { decisions: [], summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 50 }

  it('same system prompt, user message, schema and options with or without the fields, also with the alsoAffects option', async () => {
    completeStructured.mockResolvedValue({ object: judged, usage })
    await runJudge('key', 'model', 3, 16000, '', 'DIFF', review(plain), [], undefined, false, 1)
    await runJudge('key', 'model', 3, 16000, '', 'DIFF', review(tagged), [], undefined, false, 1, { alsoAffects: true })

    const [a, b] = completeStructured.mock.calls
    expect(b).toEqual(a)
    expect(a[2]).toBe(JUDGE_OUTPUT_SCHEMA)
    expect(a[1]).not.toMatch(/also_affects|scenario|b\.ts/)
  })
})

describe('kept findings carry also_affects only under the alsoAffects option', () => {
  const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,1 @@\n+const value = take(pool)\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -0,0 +1,1 @@\n+const other = take(pool)\n'
  const list: AlsoAffected[] = [{ file: 'b.ts', lines: '1', where: 'take again' }]
  const candidate: ReviewFinding = { severity: 'HIGH', title: 'Race', file: 'a.ts', lines: '1', body: 'Same in b.ts: take(pool) races.', also_affects: list }
  const out = (extra: Record<string, unknown> = {}): JudgeOutput => ({
    decisions: [{ candidate_id: 'c0', reason_category: 'validated', evidence: 'a.ts:1', note: 'n', score: 8, ...extra }],
    summary: 'S', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 60,
  })

  it('adds alsoAffects to a kept extra-pass finding with the option, never without it or for an empty list', () => {
    expect(applyJudgeDecisions([candidate], out(), undefined, [], DIFF, 0, { alsoAffects: true }).kept[0].alsoAffects).toBe(list)
    expect('alsoAffects' in applyJudgeDecisions([candidate], out(), undefined, [], DIFF, 0).kept[0]).toBe(false)
    expect('alsoAffects' in applyJudgeDecisions([{ ...candidate, also_affects: [] }], out(), undefined, [], DIFF, 0, { alsoAffects: true }).kept[0]).toBe(false)
  })

  it('a first-pass reviewer finding never passes it on, whatever the model invented', () => {
    const extra: ReviewFinding = { ...candidate, title: 'Breadth race' }
    const decided: JudgeOutput = { ...out(), decisions: [out().decisions[0], { ...out().decisions[0], candidate_id: 'c1' }] }
    for (const junk of ['src/b.ts:1', { file: 'b.ts', lines: '1', where: 'w' }, list]) {
      const reviewer = { ...candidate, also_affects: junk } as unknown as ReviewFinding
      const { kept } = applyJudgeDecisions([reviewer, extra], decided, undefined, [], DIFF, 1, { alsoAffects: true })
      expect(kept.map(k => k.alsoAffects ?? null)).toEqual([null, list])
    }
    const noBoundary = applyJudgeDecisions([candidate], out(), undefined, [], DIFF, Infinity, { alsoAffects: true })
    expect('alsoAffects' in noBoundary.kept[0]).toBe(false)
  })

  it('a non-array value on an extra-pass candidate is ignored', () => {
    const odd = { ...candidate, also_affects: 'src/b.ts:1' } as unknown as ReviewFinding
    expect('alsoAffects' in applyJudgeDecisions([odd], out(), undefined, [], DIFF, 0, { alsoAffects: true }).kept[0]).toBe(false)
  })

  it('a J_QUALITY expansion row never carries it', () => {
    const loc = { file: 'b.ts', lines: '1', anchor_quote: 'const other = take(pool)', candidate_excerpt: 'Same in b.ts', body: 'Also here.' }
    const { kept } = applyJudgeDecisions([candidate], out({ additional_locations: [loc] }), undefined, [], DIFF, 0, { quality: true, alsoAffects: true })
    expect(kept.map(k => [k.file, k.quality_action ?? null, 'alsoAffects' in k])).toEqual([['a.ts', null, true], ['b.ts', 'expansion', false]])
  })

  it('the decision log is unchanged by the option', () => {
    const on = applyJudgeDecisions([candidate], out(), undefined, [], DIFF, 0, { alsoAffects: true })
    const off = applyJudgeDecisions([candidate], out(), undefined, [], DIFF, 0)
    expect(on.decisions).toEqual(off.decisions)
    expect(on.markdown).toBe(off.markdown)
  })
})

describe('counterpartFindings', () => {
  it('copies drop the parent\'s alsoAffects as they drop its proposal', () => {
    const files: ChangedFile[] = [{ path: 'src/pool.ts', status: 'modified' }, { path: 'src/cache.ts', status: 'added' }]
    const diff = 'diff --git a/src/cache.ts b/src/cache.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/cache.ts\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n'
    const parent: KeptFinding = { severity: 'HIGH', title: 'Race', body: 'b', file: 'src/pool.ts', lines: '2', anchorSource: 'reviewer', reviewerBody: 'also src/cache.ts:3', proposal: 'Lock it.', alsoAffects: [{ file: 'src/cache.ts', lines: '1', where: 'w' }] }
    const copies = counterpartFindings([parent], files, diff)
    expect(copies.map(c => [c.file, c.lines])).toEqual([['src/cache.ts', '3']])
    expect('alsoAffects' in copies[0] || 'proposal' in copies[0]).toBe(false)
  })
})

describe('alsoAffectsRows', () => {
  const section = (path: string, header: string, start: number, lines: string[]) =>
    `diff --git a/${path} b/${path}\n${header}--- a/${path}\n+++ b/${path}\n@@ -${start},1 +${start},${lines.length} @@\n${lines.join('\n')}\n`
  const DIFF = [
    section('src/pool.ts', '', 1, [' export class Pool {', '+  conns = []', '+  get() { return this.conns.pop() }', '+  put(c) { this.conns.push(c) }']),
    'diff --git a/src/cache.ts b/src/cache.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/cache.ts\n@@ -0,0 +1,4 @@\n+export const cache = new Map()\n+export function take(k) {\n+  return cache.get(k)\n+}\n',
    'diff --git a/src/old.ts b/src/old.ts\ndeleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-export const old = 1\n',
    section('src/util/index.ts', '', 5, ['+export const u = take()']),
    section('lib/index.ts', '', 5, ['+export const l = take()']),
    section('src/side.ts', '', 10, ['+side()', ' unchanged()']),
  ].join('')
  const FILES: ChangedFile[] = [
    { path: 'src/pool.ts', status: 'modified' }, { path: 'src/cache.ts', status: 'added' }, { path: 'src/old.ts', status: 'deleted' },
    { path: 'src/util/index.ts', status: 'modified' }, { path: 'lib/index.ts', status: 'modified' }, { path: 'src/side.ts', status: 'modified' },
  ]
  const e = (file: string, lines: string, where = 'w'): AlsoAffected => ({ file, lines, where })
  const parent = (alsoAffects: AlsoAffected[], over: Partial<KeptFinding> = {}): KeptFinding =>
    ({ severity: 'HIGH', title: 'Race on conns', body: 'get/put race.', file: 'src/pool.ts', lines: '2-3', anchorSource: 'reviewer', alsoAffects, ...over })
  const run = (placed: KeptFinding[], copies: KeptFinding[] = [], note?: boolean) => alsoAffectsRows(placed, copies, FILES, DIFF, 'agent', note)

  it('applies the rules in order, the first failing one naming the status', () => {
    const entries = [
      e('src/cache.ts', '1', '  cache map\n shared;'), e('nope.ts', '1'), e('index.ts', '5'), e('src/old.ts', '1'), e('b/src/pool.ts', '4'),
      e('src/side.ts', 'ten'), e('src/side.ts', '0'), e('src/side.ts', '12-11'), e('src/side.ts', '1-51'), e('src/side.ts', '11'),
      e('src/side.ts', '10', '   '), e('src/cache.ts', '1-2', 'again'), e('src/side.ts', '10', 'side()'), e('src/util/index.ts', '5', 'u'), e('lib/index.ts', '5', 'l'),
    ]
    const { rows, log } = run([parent(entries), parent([e('src/cache.ts', '1')], { title: 'PR-level', file: undefined, lines: undefined, anchorSource: 'none' })])

    expect(log.map(l => l.status)).toEqual([
      'row', 'unresolved_path', 'unresolved_path', 'deleted_file', 'own_file',
      'bad_lines', 'bad_lines', 'bad_lines', 'bad_lines', 'not_changed_line',
      'bad_where', 'duplicate', 'row', 'row', 'over_cap',
      'parent_unanchored',
    ])
    expect(log[0]).toEqual({ parent: 'Race on conns', file: 'src/cache.ts', lines: '1', where: 'cache map shared;', status: 'row' })
    expect(rows).toEqual([
      { file: 'src/cache.ts', start_line: 1, end_line: 1, message: 'Race on conns: get/put race. Same defect here: cache map shared.', producer: 'agent' },
      { file: 'src/side.ts', start_line: 10, end_line: 10, message: 'Race on conns: get/put race. Same defect here: side().', producer: 'agent' },
      { file: 'src/util/index.ts', start_line: 5, end_line: 5, message: 'Race on conns: get/put race. Same defect here: u.', producer: 'agent' },
    ])
  })

  it('accepts a 50-line span that touches a changed line, a b/ prefix and a unique suffix path', () => {
    const { log } = run([parent([e('src/side.ts', '1-50'), e('b/src/cache.ts', '3'), e('util/index.ts', '5')])])
    expect(log.map(l => l.status)).toEqual(['row', 'row', 'row'])
  })

  it('own_file uses the final anchor, so a judge-relocated parent rejects its new file, not its old one', () => {
    const { log } = run([parent([e('src/pool.ts', '4'), e('src/side.ts', '10')], { file: 'src/side.ts', lines: '10', anchorSource: 'judge' })])
    expect(log.map(l => l.status)).toEqual(['row', 'own_file'])
  })

  it('dedups against anchored originals, XROWS copies and earlier rows when the title matches or overlaps', () => {
    const original = parent([], { title: 'Race on conns in cache', file: 'src/cache.ts', lines: '3' })
    const copy = parent([], { file: 'src/side.ts', lines: '10', anchorSource: 'mention', alsoAffects: undefined })
    const other = parent([e('src/cache.ts', '3')], { title: 'Unbounded map growth', body: 'no eviction.', file: 'src/util/index.ts', lines: '5' })
    const twin = parent([e('src/cache.ts', '1')])
    const { rows, log } = run([parent([e('src/cache.ts', '3'), e('src/side.ts', '10'), e('src/cache.ts', '1')]), original, other, twin], [copy])

    expect(log.map(l => [l.parent, l.status])).toEqual([
      ['Race on conns', 'duplicate'], ['Race on conns', 'duplicate'], ['Race on conns', 'row'],
      ['Unbounded map growth', 'row'], ['Race on conns', 'duplicate'],
    ])
    expect(rows.map(r => `${r.file}:${r.start_line}`)).toEqual(['src/cache.ts:1', 'src/cache.ts:3'])
  })

  it('cuts where to 120 chars after stripping trailing punctuation; the note can be switched off', () => {
    const long = `${'x'.repeat(130)}`
    const [a, b] = run([parent([e('src/cache.ts', '1', 'flush...;'), e('src/side.ts', '10', long)])]).rows
    expect(a.message).toBe('Race on conns: get/put race. Same defect here: flush.')
    expect(b.message).toBe(`Race on conns: get/put race. Same defect here: ${'x'.repeat(120)}.`)
    expect(ALSO_AFFECTS_WHERE_NOTE).toBe(true)
    expect(run([parent([e('src/cache.ts', '1')])], [], false).rows[0].message).toBe('Race on conns: get/put race.')
  })

  it('never carries a proposal, keeps parent then entry order, and is deterministic', () => {
    const placed = [parent([e('src/side.ts', '10'), e('src/cache.ts', '2')], { proposal: 'Lock it.' }), parent([e('src/util/index.ts', '5')], { title: 'Leak', body: 'l.', file: 'lib/index.ts', lines: '5' })]
    const first = run(placed)
    expect(first.rows.map(r => `${r.file}:${r.start_line}`)).toEqual(['src/side.ts:10', 'src/cache.ts:2', 'src/util/index.ts:5'])
    expect(first.rows.every(r => !('proposal' in r))).toBe(true)
    expect(JSON.stringify(run(placed))).toBe(JSON.stringify(first))
  })

  it('a range ending past the last line of an added file is bad_lines; a modified file has no upper bound', () => {
    const { log, rows } = run([parent([e('src/cache.ts', '3-50'), e('src/cache.ts', '3-5'), e('src/cache.ts', '4'), e('src/side.ts', '10-40')])])
    expect(log.map(l => l.status)).toEqual(['bad_lines', 'bad_lines', 'row', 'row'])
    expect(rows.map(r => [r.file, r.start_line, r.end_line])).toEqual([['src/cache.ts', 4, 4], ['src/side.ts', 10, 40]])
  })

  it('own_file holds when the parent cites a basename: the path list comes from changedFiles', () => {
    const files: ChangedFile[] = [{ path: 'src/b.ts', status: 'modified' }]
    const diff = 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,1 +1,2 @@\n+one()\n+two()\n'
    const { rows, log } = alsoAffectsRows([parent([e('src/b.ts', '2')], { file: 'b.ts', lines: '1' })], [], files, diff, 'agent')
    expect(log.map(l => l.status)).toEqual(['own_file'])
    expect(rows).toEqual([])
  })

  it('a parent without entries adds nothing', () => {
    expect(run([parent([]), parent(undefined as unknown as AlsoAffected[])])).toEqual({ rows: [], log: [] })
  })
})

describe('DX exclusion list (generated files only)', () => {
  const DX = ['*.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'go.sum', '*.min.js', '*.min.css', '*.map', '*.snap']
  const section = (from: string, to = from) => `diff --git a/${from} b/${to}\n--- a/${from}\n+++ b/${to}\n@@ -1 +1 @@\n-a\n+b\n`

  it('excludes lockfiles and generated assets, keeps manifests, configs and tests', () => {
    for (const p of ['uv.lock', 'yarn.lock', 'web/package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'go.sum', 'dist/app.min.js', 'site.min.css', 'app.js.map', '__snapshots__/a.test.ts.snap']) {
      expect(isPathExcluded(p, DX)).toBe(true)
    }
    for (const p of ['package.json', 'tsconfig.json', 'src/app.spec.ts', 'src/app.ts', 'i18n/en.json', 'go.mod']) {
      expect(isPathExcluded(p, DX)).toBe(false)
    }
  })

  it('filterDiff keeps package.json and spec files and keys a rename on its old path', () => {
    const diff = [section('package.json'), section('src/app.spec.ts'), section('yarn.lock'), section('vendor/x.min.js', 'vendor/x.js'), section('src/a.ts', 'src/a.min.js')].join('')
    const { filtered, removedCount } = filterDiff(diff, DX)
    expect(removedCount).toBe(2)
    expect([...filtered.matchAll(/^diff --git a\/(\S+)/gm)].map(m => m[1])).toEqual(['package.json', 'src/app.spec.ts', 'src/a.ts'])
  })
})

describe('usage record keys', () => {
  let buildUsageRecord: (typeof import('../usage.js'))['buildUsageRecord']
  let config: (typeof import('../../config.js'))['config']
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    ;({ buildUsageRecord } = await import('../usage.js'))
    ;({ config } = await import('../../config.js'))
  })
  let saved: { highImpact: boolean; lenses: typeof config.lenses }
  beforeEach(() => {
    saved = { highImpact: config.review.highImpact, lenses: { ...config.lenses } }
    config.review.highImpact = false
    Object.assign(config.lenses, { enabled: false, list: '' })
  })
  afterEach(() => {
    config.review.highImpact = saved.highImpact
    Object.assign(config.lenses, saved.lenses)
  })

  const candidates = [
    { severity: 'HIGH' as const, title: 'R', body: 'b', origin: 'review' as const },
    { severity: 'MEDIUM' as const, title: 'S', body: 'b', file: 'a.ts', lines: '2', origin: 'second_look' as const, scenario: 'repeat' as const, also_affects: [{ file: 'b.ts', lines: '3', where: 'w' }] },
  ]
  const ctx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
    reviewObject: { summary: 's', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [] },
    judgeDecisions: [], judgeCandidates: candidates,
    ...over,
  } as unknown as ReviewContext)

  it('flag off: the four pinned levers, no candidate scenario or also_affects, no also-affects keys', () => {
    const r = buildUsageRecord(ctx({ outcomeSink: () => {} }), 1, null)
    expect(Object.keys(r.recall_levers)).toEqual(['j_quality', 'sl_breadth', 'j_shown_anchor', 'b_priority'])
    expect(JSON.stringify(r)).not.toMatch(/scenario|also_affects|high_impact/)
  })

  it('flag on in production: high_impact and a scenario on every candidate, but no also_affects', () => {
    config.review.highImpact = true
    const r = buildUsageRecord(ctx(), 1, null)
    expect(Object.keys(r.recall_levers)).toEqual(['j_quality', 'sl_breadth', 'j_shown_anchor', 'b_priority', 'high_impact'])
    expect(r.recall_levers.high_impact).toBe(true)
    expect(r.review_candidates!.map(c => c.scenario)).toEqual([null, 'repeat'])
    expect(r.review_candidates!.some(c => 'also_affects' in c)).toBe(false)
    expect('also_affects_rows' in r || 'lens_runs' in r).toBe(false)
  })

  it('flag on in benchmark mode: also_affects on every candidate ([] when none) and the sink counts', () => {
    config.review.highImpact = true
    const log = [{ parent: 'S', file: 'b.ts', lines: '3', where: 'w', status: 'row' as const }]
    const r = buildUsageRecord(ctx({ outcomeSink: () => {}, alsoAffectsRows: 1, alsoAffectsLog: log }), 1, null)
    expect(r.review_candidates!.map(c => [c.scenario, c.also_affects])).toEqual([[null, []], ['repeat', candidates[1].also_affects]])
    expect([r.also_affects_rows, r.also_affects]).toEqual([1, log])
  })

  it('a first-pass candidate logs scenario null and also_affects [] even when the model invented them', () => {
    config.review.highImpact = true
    const invented = [{ ...candidates[0], scenario: 'repeat', also_affects: 'src/b.ts:3' }, candidates[1]]
    const r = buildUsageRecord(ctx({ outcomeSink: () => {}, judgeCandidates: invented } as Partial<ReviewContext>), 1, null)
    expect(r.review_candidates!.map(c => [c.scenario, c.also_affects])).toEqual([[null, []], ['repeat', candidates[1].also_affects]])
  })

  it('unjudged candidates on a judge-failure error carry the same keys', () => {
    config.review.highImpact = true
    const r = buildUsageRecord(ctx({ outcomeSink: () => {}, judgeDecisions: undefined, judgeStatus: 'failed' }), 1, { type: 'Error', message: 'boom', status: null })
    expect(r.unjudged_candidates!.map(c => [c.scenario, c.also_affects])).toEqual([[null, []], ['repeat', candidates[1].also_affects]])
  })

  it('the bundled path infers a skipped_bundled run for a listed impact lens, with or without the flag', () => {
    config.lenses.enabled = true
    config.lenses.list = 'imp+rel'
    for (const on of [false, true]) {
      config.review.highImpact = on
      const r = buildUsageRecord(ctx({ bundleCount: 3, judgeDecisions: undefined }), 1, null)
      expect(r.lens_runs!.map(l => [l.name, l.status])).toEqual([['impact', 'skipped_bundled'], ['reliability', 'skipped_bundled']])
    }
  })
})
