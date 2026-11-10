import { describe, it, expect, vi, beforeEach } from 'vitest'

const complete = vi.fn()
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete, completeStructured })),
}))

import { runJudge, judgeOutputSchema, JUDGE_OUTPUT_SCHEMA } from '../client.js'
import { applyJudgeDecisions, type JudgeDecision, type JudgeOutput } from '../judge-decisions.js'
import { composeJudgePrompt } from '../judge-quality.js'
import type { ReviewFinding, ReviewObject } from '../formatter.js'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'

const file = (path: string, lines: string[]): string =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`

const DIFF = file('.github/workflows/publish-a.yml', ['name: publish-a', 'run: npm publish --token $NPM_TOKEN', 'echo done'])
  + file('.github/workflows/publish-b.yml', ['name: publish-b', 'run: npm publish --token $NPM_TOKEN', 'echo done'])
  + file('src/other.ts', ['export const x = 1', 'export const y = 2'])

const cand = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({ severity: 'MEDIUM', title: 'Token exposed', file: '.github/workflows/publish-a.yml', lines: '2', body: 'Token leaks in publish-a.yml.', ...over })

const dec = (over: Partial<JudgeDecision> = {}): JudgeDecision =>
  ({ candidate_id: 'c0', reason_category: 'validated', evidence: 'a:2', note: 'real', score: 8, ...over })

const out = (decisions: JudgeDecision[]): JudgeOutput =>
  ({ decisions, summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 })

const ON = { quality: true }
const POLICY = { keepMinor: false, keepUnverified: false }

describe('composeJudgePrompt', () => {
  const base = readFileSync(new URL('../../prompt/judge-prompt.txt', import.meta.url), 'utf-8')

  it('is the identity when both gates are off', () => {
    expect(composeJudgePrompt(base, { quality: false, shownAnchors: false })).toBe(base)
  })

  const LOW_VALUE_SECTION = `## LOW_VALUE EVIDENCE CHECK

Before assigning \`low_value\`, apply this narrow exception only when ALL of the following hold:
- The candidate itself states a specific failing input, execution path, or user interaction and a concrete runtime failure, performance cost, or visible UI failure caused by code this diff adds or modifies.
- The code you were shown demonstrates the stated scenario and its causal mechanism. Quote the specific file:line and code in \`evidence\`, and explain the scenario-to-failure connection in \`note\`.
- The claim is more than a preference, a possible optimization, or an unsupported assertion of impact. For performance claims, identify the repeated work or allocation and the execution path that incurs it; do not infer material overhead merely from an API name or invent workload or timing assumptions.

When all conditions hold and no other rejection category applies, use \`validated\` instead of \`low_value\`. The existing \`unconfirmed_high\` and \`chained_hypothetical\` rules still apply. Do not change or propose a severity; the application derives it from the candidate and category.

A bare request to "add a docstring", "consider configurable", or "verify/ensure X" does not qualify. A proposed fix containing those words does not disqualify an otherwise demonstrated failure. Do not invent a scenario or consequence to rescue a candidate. If the conditions fail, apply the existing category definitions: unsupported defect claims remain \`unverifiable\`, pure asks remain \`low_value\`, and concrete problems without runtime impact remain \`minor\`. This exception does not relax \`incorrect\`, \`already_handled\`, \`style_only\`, \`duplicate\`, or \`out_of_scope\`.`

  it('quality swaps only the duplicate line and appends the evidence check before the multi-file section', () => {
    const p = composeJudgePrompt(base, { quality: true, shownAnchors: false })
    const baseLines = new Set(base.split('\n'))
    const changed = p.split('\n').filter(l => l.startsWith('- `') && !baseLines.has(l))
    expect(changed).toHaveLength(1)
    expect(changed[0]).toContain('set `duplicate_of`')
    for (const name of ['already_handled', 'low_value', 'minor', 'duplicate']) {
      expect(p.split(`- \`${name}\``).length - 1).toBe(1)
    }
    expect(p).toContain(LOW_VALUE_SECTION)
    expect(p.indexOf('## LOW_VALUE EVIDENCE CHECK')).toBeLessThan(p.indexOf('## MULTI-FILE FINDINGS'))
    expect(p).toContain('`additional_locations`')
    expect(p).not.toContain('## DECISION CONSISTENCY')
    expect(p).not.toContain('is not by itself mitigation')
    expect(p).not.toContain('cannot exercise the branch it claims to cover')
  })

  it('quality and shown anchors compose independently', () => {
    const both = composeJudgePrompt(base, { quality: true, shownAnchors: true })
    expect(both).toContain('cannot be confirmed from the code you were shown')
    expect(both).toContain('## LOW_VALUE EVIDENCE CHECK')
    expect(both).toContain('## MULTI-FILE FINDINGS')
  })

  it('shown anchors replace only the omit-numeric rule', () => {
    const p = composeJudgePrompt(base, { quality: false, shownAnchors: true })
    expect(p).toContain('cannot be confirmed from the code you were shown')
    expect(p).not.toContain('Omit both anchor fields when the candidate already shows a numeric line')
    expect(p).toContain('`incorrect`, `already_handled`')
  })

  it('fails loudly when the template drifts instead of silently skipping a replacement', () => {
    expect(() => composeJudgePrompt('no categories here', { quality: true, shownAnchors: false })).toThrow(/not found/)
  })
})

describe('judgeOutputSchema', () => {
  it('returns the shared constant when off, and never mutates it', () => {
    expect(judgeOutputSchema(false, false)).toBe(JUDGE_OUTPUT_SCHEMA)
    judgeOutputSchema(true, true)
    expect(JSON.stringify(JUDGE_OUTPUT_SCHEMA)).not.toContain('duplicate_of')
  })

  it('quality adds optional duplicate_of and additional_locations; shown anchors reword the anchor fields', () => {
    const q = JSON.stringify(judgeOutputSchema(true, false))
    expect(q).toContain('duplicate_of')
    expect(q).toContain('additional_locations')
    expect(q).toContain('Only when the candidate shows no numeric line')
    const s = JSON.stringify(judgeOutputSchema(false, true))
    expect(s).toContain('cannot be confirmed from the code you were shown')
    expect(s).not.toContain('additional_locations')
  })
})

describe('applyJudgeDecisions — duplicate rule (quality)', () => {
  const sameFile = [cand(), cand({ title: 'Token again', lines: '2' })]

  it('keeps a duplicate rejection whose target is a kept candidate in the same file and location', () => {
    const res = applyJudgeDecisions(sameFile, out([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' })]), POLICY, [], DIFF, Infinity, ON)
    expect(res.kept.map(k => k.title)).toEqual(['Token exposed'])
    expect(res.decisions[1]).toMatchObject({ reason_category: 'duplicate', action: 'drop', duplicate_of: 'c0' })
    expect(res.anomalies.invalid_duplicate).toBeUndefined()
  })

  it('treats a cross-file duplicate as invalid: unverifiable, dropped under default policy, flagged', () => {
    const cands = [cand(), cand({ file: '.github/workflows/publish-b.yml', title: 'Token in b' })]
    const decisions = out([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' })])
    const res = applyJudgeDecisions(cands, decisions, POLICY, [], DIFF, Infinity, ON)
    expect(res.decisions[1]).toMatchObject({ reason_category: 'unverifiable', action: 'drop', invalid_duplicate: true, duplicate_of: 'c0' })
    expect(res.anomalies.invalid_duplicate).toBe(1)
  })

  it('follows keepUnverified and its score cap when the invalid duplicate is demoted', () => {
    const cands = [cand(), cand({ file: '.github/workflows/publish-b.yml', title: 'Token in b' })]
    const decisions = out([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0', score: 9 })])
    const res = applyJudgeDecisions(cands, decisions, { keepMinor: false, keepUnverified: true }, [], DIFF, Infinity, ON)
    expect(res.kept.map(k => k.title)).toEqual(['Token exposed', 'Token in b'])
    expect(res.decisions[1]).toMatchObject({ action: 'keep', score: 5, invalid_duplicate: true })
  })

  it('rejects different location, missing/unknown/self targets, dropped targets, cycles and forward order alike', () => {
    const far = cand({ lines: '3', title: 'Elsewhere' })
    const run = (decisions: JudgeDecision[], cands: ReviewFinding[]) => applyJudgeDecisions(cands, out(decisions), POLICY, [], DIFF, Infinity, ON).decisions
    expect(run([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' })], [cand(), far])[1].invalid_duplicate).toBe(true)
    expect(run([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate' })], sameFile)[1].invalid_duplicate).toBe(true)
    expect(run([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c9' })], sameFile)[1].invalid_duplicate).toBe(true)
    expect(run([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c1' })], sameFile)[1].invalid_duplicate).toBe(true)
    expect(run([dec({ reason_category: 'incorrect' }), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' })], sameFile)[1].invalid_duplicate).toBe(true)
    const cycle = run([dec({ reason_category: 'duplicate', duplicate_of: 'c1' }), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' })], sameFile)
    expect(cycle.map(d => d.invalid_duplicate)).toEqual([true, true])
    const forward = run([dec({ reason_category: 'duplicate', duplicate_of: 'c1' }), dec({ candidate_id: 'c1' })], sameFile)
    expect(forward[0]).toMatchObject({ reason_category: 'duplicate', duplicate_of: 'c1' })
    expect(forward[0].invalid_duplicate).toBeUndefined()
  })

  it('a target kept only through keepMinor counts only when that policy keeps it', () => {
    const decisions = out([dec({ reason_category: 'minor' }), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' })])
    expect(applyJudgeDecisions(sameFile, decisions, POLICY, [], DIFF, Infinity, ON).decisions[1].invalid_duplicate).toBe(true)
    expect(applyJudgeDecisions(sameFile, decisions, { keepMinor: true, keepUnverified: false }, [], DIFF, Infinity, ON).decisions[1].invalid_duplicate).toBeUndefined()
  })

  it('rejects a duplicate whose kept target was relocated by the judge out of the claimed file', () => {
    const cands = [cand({ lines: '99' }), cand({ title: 'Token again', lines: '99' })]
    const decisions = out([
      dec({ anchor_file: '.github/workflows/publish-b.yml', anchor_lines: '2' }),
      dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' }),
    ])
    const res = applyJudgeDecisions(cands, decisions, POLICY, [], DIFF, 0, ON)
    expect(res.decisions[0]).toMatchObject({ anchor_file: '.github/workflows/publish-b.yml', anchor_lines: '2' })
    expect(res.decisions[1]).toMatchObject({ reason_category: 'unverifiable', invalid_duplicate: true })
  })

  it('flag off: duplicate_of is ignored and the legacy unconditional drop stands', () => {
    const cands = [cand(), cand({ file: '.github/workflows/publish-b.yml', title: 'Token in b' })]
    const res = applyJudgeDecisions(cands, out([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' })]), POLICY, [], DIFF)
    expect(res.decisions[1]).toMatchObject({ reason_category: 'duplicate', action: 'drop' })
    expect(res.decisions[1]).not.toHaveProperty('invalid_duplicate')
  })
})

describe('applyJudgeDecisions — per-file findings (quality)', () => {
  const parent = cand({ body: 'Token leaks in publish-a.yml and also in publish-b.yml where the same step runs.' })
  const loc = (over: Record<string, string> = {}) => ({
    file: '.github/workflows/publish-b.yml', lines: '2', anchor_quote: 'run: npm publish --token $NPM_TOKEN',
    candidate_excerpt: 'also in publish-b.yml', body: 'Token is exposed in this workflow too.', ...over,
  })
  const run = (locations: ReturnType<typeof loc>[], over: Partial<JudgeDecision> = {}, quality = true) =>
    applyJudgeDecisions([parent], out([dec({ additional_locations: locations, ...over })]), POLICY, [], DIFF, Infinity, quality ? ON : undefined)

  it('emits one extra row per proven additional file, inheriting severity, score and type', () => {
    const res = run([loc()])
    expect(res.kept).toHaveLength(2)
    expect(res.kept[1]).toMatchObject({ file: '.github/workflows/publish-b.yml', lines: '2', severity: 'MEDIUM', score: 8, body: 'Token is exposed in this workflow too.' })
    expect(res.scores).toHaveLength(2)
    expect(res.markdown).toContain('publish-b.yml:2')
    expect(res.decisions[0].expansions).toEqual([{ file: '.github/workflows/publish-b.yml', accepted: true }])
  })

  it('rejects a file the candidate never names, a fabricated quote, a wrong line and a non-verbatim excerpt', () => {
    expect(run([loc({ file: 'src/other.ts', candidate_excerpt: 'also in publish-b.yml', anchor_quote: 'export const y = 2', lines: '2' })]).kept).toHaveLength(1)
    expect(run([loc({ anchor_quote: 'run: something invented entirely' })]).kept).toHaveLength(1)
    expect(run([loc({ lines: '3' })]).kept).toHaveLength(1)
    expect(run([loc({ candidate_excerpt: 'fabricated mention of publish-b.yml' })]).kept).toHaveLength(1)
    expect(run([loc({ candidate_excerpt: 'where the same step runs' })]).kept).toHaveLength(1)
  })

  it('rejects a bare basename shared by two changed files but accepts the full path', () => {
    const diff = file('src/main.ts', ['const shared = 1']) + file('a/index.ts', ['const shared = 1']) + file('b/index.ts', ['const shared = 1'])
    const parentMain = cand({ file: 'src/main.ts', lines: '1', body: 'Shared constant also duplicated in index.ts and in a/index.ts.' })
    const attempt = (excerpt: string) => applyJudgeDecisions([parentMain], out([dec({ additional_locations: [{ file: 'a/index.ts', lines: '1', anchor_quote: 'const shared = 1', candidate_excerpt: excerpt, body: 'Same here.' }] })]), POLICY, [], diff, Infinity, ON)
    expect(attempt('duplicated in index.ts').decisions[0].expansions).toEqual([{ file: 'a/index.ts', accepted: false }])
    expect(attempt('in a/index.ts').decisions[0].expansions).toEqual([{ file: 'a/index.ts', accepted: true }])
  })

  it('rejects a quote on an unchanged context line, an ambiguous quote, and empty body or excerpt', () => {
    const ctxDiff = `diff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c.ts\n@@ -1,2 +1,3 @@\n const ctxLine = keepMe()\n+const added = 1\n unchanged()\n`
      + file('d.ts', ['duplicateLine()', 'duplicateLine()'])
    const p = cand({ file: 'src/other.ts', lines: '1', body: 'Also affects c.ts and d.ts here.' })
    const attempt = (l: Record<string, string>) => applyJudgeDecisions([p], out([dec({ additional_locations: [{ file: 'c.ts', lines: '1', anchor_quote: 'const ctxLine = keepMe()', candidate_excerpt: 'Also affects c.ts', body: 'Same.', ...l }] })]), POLICY, [], DIFF + ctxDiff, Infinity, ON).decisions[0].expansions
    expect(attempt({})).toEqual([{ file: 'c.ts', accepted: false }])
    expect(attempt({ lines: '2', anchor_quote: 'const added = 1' })).toEqual([{ file: 'c.ts', accepted: true }])
    expect(attempt({ file: 'd.ts', lines: '1-2', anchor_quote: 'duplicateLine()', candidate_excerpt: 'd.ts' })).toEqual([{ file: 'd.ts', accepted: false }])
    expect(attempt({ lines: '2', anchor_quote: 'const added = 1', body: '  ' })).toEqual([{ file: 'c.ts', accepted: false }])
    expect(attempt({ lines: '2', anchor_quote: 'const added = 1', candidate_excerpt: '' })).toEqual([{ file: 'c.ts', accepted: false }])
  })

  it('expansion rows inherit the parent type', () => {
    const typed = cand({ type: 'performance', body: 'Token leaks in publish-a.yml and also in publish-b.yml where the same step runs.' })
    const res = applyJudgeDecisions([typed], out([dec({ additional_locations: [loc()] })]), POLICY, [], DIFF, Infinity, ON)
    expect(res.kept.map(k => k.type)).toEqual(['performance', 'performance'])
  })

  it('ignores the parent file and repeated files,and keeps the primary when a secondary is malformed', () => {
    const res = run([loc(), loc(), loc({ file: '.github/workflows/publish-a.yml' }), loc({ anchor_quote: 'zz' })])
    expect(res.kept.map(k => k.file)).toEqual(['.github/workflows/publish-a.yml', '.github/workflows/publish-b.yml'])
    expect(res.decisions[0].expansions?.filter(e => e.accepted)).toHaveLength(1)
  })

  it('never expands a dropped parent, and flag off emits exactly one row', () => {
    expect(run([loc()], { reason_category: 'incorrect' }).kept).toHaveLength(0)
    expect(run([loc()], {}, false).kept).toHaveLength(1)
  })

  it('skips a null or non-object location instead of throwing, and still expands the valid one', () => {
    const res = run([null, undefined, 'publish-b.yml', loc()] as unknown as ReturnType<typeof loc>[])
    expect(res.kept.map(k => k.file)).toEqual(['.github/workflows/publish-a.yml', '.github/workflows/publish-b.yml'])
  })

  it('does not expand to a file whose name is only a substring of the excerpt, but does for a real mention', () => {
    const decoy = cand({ body: 'Token leaks in publish-a.yml and also in old-publish-b.yml, which is deleted.' })
    const runDecoy = (excerpt: string) =>
      applyJudgeDecisions([decoy], out([dec({ additional_locations: [loc({ candidate_excerpt: excerpt })] })]), POLICY, [], DIFF, Infinity, ON)
    expect(runDecoy('also in old-publish-b.yml').kept).toHaveLength(1)
    expect(runDecoy('also in old-publish-b.yml, which').decisions[0].expansions).toEqual([{ file: '.github/workflows/publish-b.yml', accepted: false }])
    expect(run([loc()]).kept).toHaveLength(2)
  })
})

describe('runJudge — single invocation', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })
  const usage = (n: number) => ({ input_tokens: n, output_tokens: n / 2 })
  const review: ReviewObject = {
    summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [],
    findings: [cand(), cand({ title: 'Other', file: 'src/other.ts', lines: '1', body: 'x is wrong' })],
  }
  const twoFiles: ReviewObject = { ...review, findings: [cand(), cand({ file: '.github/workflows/publish-b.yml', title: 'Token in b' })] }
  const contradictory = out([
    dec({ reason_category: 'unverifiable', evidence: '', note: 'The leak is real. Kept as validated.' }),
    dec({ candidate_id: 'c1', reason_category: 'style_only', note: 'naming only' }),
  ])
  const call = (options?: object, r: ReviewObject = review, policy = POLICY) => runJudge('k', 'm', 1, 1000, '', DIFF, r, [], policy, false, undefined, options)

  it('a contradictory note is not re-asked: one call, its decisions and usage stand, no repair fields', async () => {
    completeStructured.mockResolvedValue({ object: contradictory, usage: usage(100) })
    const res = await call(ON)
    expect(completeStructured).toHaveBeenCalledTimes(1)
    expect(completeStructured.mock.calls[0][1]).not.toContain('## Reconsider')
    expect(res.kept).toHaveLength(0)
    expect(res.usage).toEqual(usage(100))
    expect(res.decisions![0]).toMatchObject({ reason_category: 'unverifiable', action: 'drop' })
    expect(JSON.stringify(res)).not.toContain('repair')
  })

  it('an invalid duplicate is demoted locally under both keepUnverified settings, one call each', async () => {
    const first = out([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0', score: 9 })])
    completeStructured.mockResolvedValue({ object: first, usage: usage(100) })

    const dropped = await call(ON, twoFiles)
    expect(dropped.kept?.map(k => k.title)).toEqual(['Token exposed'])
    expect(dropped.decisions![1]).toMatchObject({ reason_category: 'unverifiable', action: 'drop', invalid_duplicate: true })
    expect(completeStructured).toHaveBeenCalledTimes(1)

    const kept = await call(ON, twoFiles, { keepMinor: false, keepUnverified: true })
    expect(kept.kept?.map(k => k.title)).toEqual(['Token exposed', 'Token in b'])
    expect(kept.decisions![1]).toMatchObject({ action: 'keep', score: 5, invalid_duplicate: true })
    expect(kept.anomalies).toMatchObject({ invalid_duplicate: 1 })
    expect(kept.anomalies).not.toHaveProperty('unresolved_repair')
    expect(completeStructured).toHaveBeenCalledTimes(2)
  })

  it('ordinary decisions take one call and the narrative comes from that response', async () => {
    completeStructured.mockResolvedValue({ object: out([dec(), dec({ candidate_id: 'c1', reason_category: 'style_only' })]), usage: usage(100) })
    const res = await call(ON)
    expect(completeStructured).toHaveBeenCalledTimes(1)
    expect(res.text).toContain('Merge Confidence: 70%')
    expect(res.usage).toEqual(usage(100))
  })

  it('an off-enum category on the first response still becomes unverifiable', async () => {
    completeStructured.mockResolvedValue({ object: out([dec({ reason_category: 'bogus' as never }), dec({ candidate_id: 'c1', reason_category: 'style_only' })]), usage: usage(100) })
    const res = await call(ON, review, { keepMinor: false, keepUnverified: true })
    expect(completeStructured).toHaveBeenCalledTimes(1)
    expect(res.decisions![0]).toMatchObject({ reason_category: 'unverifiable', action: 'keep', score: 5 })
  })

  it('sends the composed prompt and the quality schema when on', async () => {
    completeStructured.mockResolvedValue({ object: out([dec(), dec({ candidate_id: 'c1', reason_category: 'style_only' })]), usage: usage(100) })
    await call(ON)
    expect(completeStructured.mock.calls[0][0]).toContain('## LOW_VALUE EVIDENCE CHECK')
    expect(JSON.stringify(completeStructured.mock.calls[0][2])).toContain('additional_locations')
  })
})

describe('flag-off byte identity', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })
  const baseText = readFileSync(new URL('../../prompt/judge-prompt.txt', import.meta.url), 'utf-8')
  const review: ReviewObject = {
    summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [],
    findings: [cand(), cand({ file: '.github/workflows/publish-b.yml', title: 'Token in b' })],
  }
  const stray = out([
    dec({ duplicate_of: 'c0', additional_locations: [{ file: 'src/other.ts', lines: '1', anchor_quote: 'export const x = 1', candidate_excerpt: 'x', body: 'b' }] }),
    dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0', note: 'This is a valid finding.' }),
  ])
  const snapshot = async (options: object | undefined, policy = POLICY) => {
    completeStructured.mockReset()
    completeStructured.mockResolvedValue({ object: stray, usage: { input_tokens: 10, output_tokens: 5 } })
    const res = await runJudge('k', 'm', 2, 1000, '', DIFF, review, [], policy, false, undefined, options)
    return { calls: completeStructured.mock.calls, res }
  }

  it('omitted options and quality:false produce identical requests and results', async () => {
    const a = await snapshot(undefined)
    const b = await snapshot({ quality: false })
    expect(JSON.stringify(b.calls)).toBe(JSON.stringify(a.calls))
    expect(a.calls).toHaveLength(1)
    expect(JSON.stringify(b.res)).toBe(JSON.stringify(a.res))
    expect(a.calls[0][2]).toBe(JUDGE_OUTPUT_SCHEMA)
    expect(a.calls[0][0]).toBe(baseText)
  })

  it('ignores stray quality-only fields: no expansion, no duplicate validation, no repair metadata', async () => {
    const { res } = await snapshot(undefined)
    expect(res.kept).toHaveLength(1)
    expect(res.decisions![1]).toMatchObject({ reason_category: 'duplicate', action: 'drop' })
    expect(JSON.stringify(res.decisions)).not.toMatch(/invalid_duplicate|expansions|repair|"duplicate_of"/)
    expect(res.anomalies).toEqual({ unknown_ids: 0, undecided: 0, duplicate_ids: 0, drop_without_evidence: 0 })
  })

  it('shown-anchor-only keeps its prompt bytes whether quality is omitted or false', async () => {
    const shownAnchors = { judge: new Map() } as never
    const a = await snapshot({ shownAnchors })
    const b = await snapshot({ quality: false, shownAnchors })
    expect(JSON.stringify(b.calls)).toBe(JSON.stringify(a.calls))
    expect(a.calls[0][0]).toBe(composeJudgePrompt(baseText, { quality: false, shownAnchors: true }))
  })

  it('flag-off request and result match the persisted pre-change baseline', async () => {
    const { calls, res } = await snapshot(undefined)
    // normalize CRLF so the baseline hash is stable across Windows/Linux checkouts
    const sha = (s: string) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
    expect({
      system: sha(calls[0][0]), user: sha(calls[0][1]), schema: sha(JSON.stringify(calls[0][2])), options: calls[0].slice(3),
      text: res.text, kept: res.kept, decisions: res.decisions, anomalies: res.anomalies, scores: res.scores, usage: res.usage,
    }).toMatchInlineSnapshot(`
      {
        "anomalies": {
          "drop_without_evidence": 0,
          "duplicate_ids": 0,
          "undecided": 0,
          "unknown_ids": 0,
        },
        "decisions": [
          {
            "action": "keep",
            "anchor_file": ".github/workflows/publish-a.yml",
            "anchor_lines": "2",
            "anchor_source": "reviewer",
            "candidate_id": "c0",
            "evidence": "a:2",
            "final_severity": "MEDIUM",
            "note": "real",
            "original_severity": "MEDIUM",
            "reason_category": "validated",
            "reclassified_from": null,
            "rewritten": false,
            "score": 8,
          },
          {
            "action": "drop",
            "anchor_file": ".github/workflows/publish-b.yml",
            "anchor_lines": "2",
            "anchor_source": "reviewer",
            "candidate_id": "c1",
            "evidence": "a:2",
            "final_severity": null,
            "note": "This is a valid finding.",
            "original_severity": "MEDIUM",
            "reason_category": "duplicate",
            "reclassified_from": null,
            "rewritten": false,
            "score": 8,
          },
        ],
        "kept": [
          {
            "anchorSource": "reviewer",
            "body": "Token leaks in publish-a.yml.",
            "file": ".github/workflows/publish-a.yml",
            "lines": "2",
            "score": 8,
            "severity": "MEDIUM",
            "title": "Token exposed",
            "type": undefined,
          },
        ],
        "options": [
          {
            "effort": undefined,
            "maxRetries": 2,
            "maxTokens": 1000,
            "model": "m",
          },
        ],
        "schema": "40f6be83e39a3172",
        "scores": [
          {
            "file": ".github/workflows/publish-a.yml",
            "lines": "2",
            "score": 8,
            "severity": "MEDIUM",
            "title": "Token exposed",
          },
        ],
        "system": "3c4bdfdaba163339",
        "text": "### Summary
      s

      ### Findings
      - **MEDIUM – Token exposed** (\`.github/workflows/publish-a.yml:2\`)
        Token leaks in publish-a.yml.

      ### Behavioral Diff
      None.

      ### Production Risk
      None.

      ### Unresolved Questions
      None.

      ### Merge Confidence: 70%

      *"This verdict is opinionated and must be validated by a human reviewer."*",
        "usage": {
          "input_tokens": 10,
          "output_tokens": 5,
        },
        "user": "36766c07b42b67da",
      }
    `)
  })

  it('an unset benchmark label (undefined quality) matches omitted options and quality:false', async () => {
    const omitted = await snapshot(undefined)
    for (const options of [{ quality: undefined }, { quality: undefined, shownAnchors: undefined }, { quality: false, shownAnchors: undefined }]) {
      const labelled = await snapshot(options)
      expect(JSON.stringify(labelled.calls)).toBe(JSON.stringify(omitted.calls))
      expect(JSON.stringify(labelled.res)).toBe(JSON.stringify(omitted.res))
    }
  })

  it('shown-anchor results are identical whether quality is omitted or false', async () => {
    const shownAnchors = { judge: new Map([['src/ctx.ts', new Map([[3, 'const unchanged = 3']])]]) }
    const unanchored: ReviewFinding = { severity: 'MEDIUM', title: 'Context bug', body: 'Unchanged helper is wrong.' }
    const decisions = out([dec({ anchor_file: 'src/ctx.ts', anchor_lines: '3' })])
    const omitted = applyJudgeDecisions([unanchored], decisions, POLICY, [], DIFF, Infinity, { shownAnchors })
    const off = applyJudgeDecisions([unanchored], decisions, POLICY, [], DIFF, Infinity, { quality: false, shownAnchors })
    expect(omitted.decisions[0]).toMatchObject({ anchor_source: 'judge', anchor_file: 'src/ctx.ts', anchor_lines: '3' })
    expect(JSON.stringify(off)).toBe(JSON.stringify(omitted))

    const viaClient = async (options: object) => {
      completeStructured.mockReset()
      completeStructured.mockResolvedValue({ object: decisions, usage: { input_tokens: 10, output_tokens: 5 } })
      const res = await runJudge('k', 'm', 2, 1000, '', DIFF, { ...review, findings: [unanchored] }, [], POLICY, false, undefined, options)
      return JSON.stringify({ calls: completeStructured.mock.calls, res })
    }
    expect(await viaClient({ quality: false, shownAnchors })).toBe(await viaClient({ shownAnchors }))
  })

  it('the provider request does not depend on the application policy', async () => {
    const requests = new Set<string>()
    for (const keepMinor of [false, true]) for (const keepUnverified of [false, true]) {
      for (const options of [undefined, ON]) {
        const { calls } = await snapshot(options, { keepMinor, keepUnverified })
        requests.add(`${options ? 'on' : 'off'}:${JSON.stringify(calls)}`)
      }
    }
    expect(requests.size).toBe(2)
  })
})

describe('LOW_VALUE evidence check — classification fixtures', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })
  const diff = file('src/list.ts', ['export function render(items: Item[]) {', '  return items.map(i => new Intl.NumberFormat("en").format(i.n))', '}'])
    + file('src/ui.css', ['.row { overflow: visible }', '.row:hover { display: none }'])
  const fixtures: Array<{ name: string; finding: ReviewFinding; category: JudgeDecision['reason_category']; kept: boolean }> = [
    { name: 'demonstrated per-call allocation on a hot render path', category: 'validated', kept: true, finding: { severity: 'LOW', title: 'Formatter built per row', file: 'src/list.ts', lines: '2', body: 'render() maps every item and constructs a new Intl.NumberFormat per element; with 5k rows this allocates 5k formatters per render. Hoist it.' } },
    { name: 'visible UI failure on hover', category: 'validated', kept: true, finding: { severity: 'LOW', title: 'Row disappears on hover', file: 'src/ui.css', lines: '2', body: 'Hovering a .row sets display:none so the row vanishes under the pointer and cannot be clicked.' } },
    { name: 'unsupported performance claim', category: 'unverifiable', kept: false, finding: { severity: 'LOW', title: 'Possible slowness', file: 'src/list.ts', lines: '2', body: 'Using Intl may be slow; consider optimizing.' } },
    { name: 'pure ask to add a docstring', category: 'low_value', kept: false, finding: { severity: 'LOW', title: 'Add docstring', file: 'src/list.ts', lines: '1', body: 'Add a docstring to render().' } },
    { name: 'verify or ensure request', category: 'low_value', kept: false, finding: { severity: 'LOW', title: 'Ensure items non-null', file: 'src/list.ts', lines: '1', body: 'Verify that items is never null.' } },
    { name: 'already handled defect', category: 'already_handled', kept: false, finding: { severity: 'LOW', title: 'Missing guard', file: 'src/list.ts', lines: '2', body: 'No guard on items; for awareness only.' } },
    { name: 'style preference', category: 'style_only', kept: false, finding: { severity: 'LOW', title: 'Prefer single quotes', file: 'src/list.ts', lines: '2', body: 'Use single quotes.' } },
    { name: 'concrete problem without runtime impact', category: 'minor', kept: false, finding: { severity: 'LOW', title: 'Misleading name', file: 'src/list.ts', lines: '1', body: 'render() returns data, not a view.' } },
    { name: 'claim outside the diff', category: 'out_of_scope', kept: false, finding: { severity: 'LOW', title: 'Legacy loop', file: 'src/list.ts', lines: '3', body: 'The untouched legacy loop elsewhere is slow.' } },
  ]

  it.each(fixtures)('$name', async ({ finding, category, kept }) => {
    completeStructured.mockResolvedValue({ object: out([dec({ reason_category: category, evidence: 'src/list.ts:2 new Intl.NumberFormat', score: 7 })]), usage: { input_tokens: 1, output_tokens: 1 } })
    const res = await runJudge('k', 'm', 1, 1000, '', diff, { summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], findings: [finding] }, [], POLICY, false, undefined, ON)
    expect(completeStructured.mock.calls[0][1]).toContain(finding.title)
    expect(completeStructured.mock.calls[0][0]).toContain('## LOW_VALUE EVIDENCE CHECK')
    expect(res.kept).toHaveLength(kept ? 1 : 0)
    if (kept) expect(res.kept![0].severity).toBe(finding.severity)
  })
})
