import { describe, it, expect, vi, beforeEach } from 'vitest'

const complete = vi.fn()
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete, completeStructured })),
}))

import { runJudge, judgeOutputSchema, JUDGE_OUTPUT_SCHEMA } from '../client.js'
import { applyJudgeDecisions, type JudgeDecision, type JudgeOutput } from '../judge-decisions.js'
import { composeJudgePrompt, contradictoryDrop } from '../judge-quality.js'
import type { ReviewFinding, ReviewObject } from '../formatter.js'
import { readFileSync } from 'fs'

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

describe('contradictoryDrop', () => {
  it('flags an affirmative conclusion paired with a dropping category', () => {
    expect(contradictoryDrop({ reason_category: 'unverifiable', note: 'The pinned version is wrong. Kept as validated.' })).toBe(true)
    expect(contradictoryDrop({ reason_category: 'incorrect', note: 'This is a valid finding: the quote shows the leak.' })).toBe(true)
    expect(contradictoryDrop({ reason_category: 'low_value', note: 'The finding is correct and the code confirms it.' })).toBe(true)
  })

  it('does not flag a consistent rejection, a negation, an attribution, or a quoted phrase', () => {
    expect(contradictoryDrop({ reason_category: 'incorrect', note: 'The guard on line 4 disproves the claim.' })).toBe(false)
    expect(contradictoryDrop({ reason_category: 'incorrect', note: 'This is not a valid finding.' })).toBe(false)
    expect(contradictoryDrop({ reason_category: 'incorrect', note: "The reviewer claims the finding is correct, but line 4 guards it." })).toBe(false)
    expect(contradictoryDrop({ reason_category: 'incorrect', note: 'The body says "the finding is correct" yet the code differs.' })).toBe(false)
    expect(contradictoryDrop({ reason_category: 'incorrect', note: 'Valid syntax, but the claim is wrong.' })).toBe(false)
  })

  it('never flags a surviving category', () => {
    expect(contradictoryDrop({ reason_category: 'validated', note: 'Kept as validated.' })).toBe(false)
    expect(contradictoryDrop({ reason_category: 'minor', note: 'This is a valid finding.' })).toBe(false)
  })
})

describe('composeJudgePrompt', () => {
  const base = readFileSync(new URL('../../prompt/judge-prompt.txt', import.meta.url), 'utf-8')

  it('is the identity when both gates are off', () => {
    expect(composeJudgePrompt(base, { quality: false, shownAnchors: false })).toBe(base)
  })

  it('quality swaps the four category lines once each and appends the consistency and multi-file sections', () => {
    const p = composeJudgePrompt(base, { quality: true, shownAnchors: false })
    for (const name of ['already_handled', 'low_value', 'minor', 'duplicate']) {
      expect(p.split(`- \`${name}\``).length - 1).toBe(1)
    }
    expect(p).toContain('is not by itself mitigation')
    expect(p).toContain('set `duplicate_of`')
    expect(p).toContain('cannot exercise the branch it claims to cover')
    expect(p).toContain('## DECISION CONSISTENCY')
    expect(p).toContain('`additional_locations`')
    expect(p).not.toContain('merely ask the developer to "verify" or "ensure" something already in the diff')
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

  it('rejects a file the candidate never names, a fabricated quote, a wrong line, a non-verbatim excerpt and an ambiguous basename', () => {
    expect(run([loc({ file: 'src/other.ts', candidate_excerpt: 'also in publish-b.yml', anchor_quote: 'export const y = 2', lines: '2' })]).kept).toHaveLength(1)
    expect(run([loc({ anchor_quote: 'run: something invented entirely' })]).kept).toHaveLength(1)
    expect(run([loc({ lines: '3' })]).kept).toHaveLength(1)
    expect(run([loc({ candidate_excerpt: 'fabricated mention of publish-b.yml' })]).kept).toHaveLength(1)
    expect(run([loc({ candidate_excerpt: 'where the same step runs' })]).kept).toHaveLength(1)
  })

  it('ignores the parent file and repeated files, and keeps the primary when a secondary is malformed', () => {
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

describe('runJudge — repair call (quality)', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })
  const usage = (n: number) => ({ input_tokens: n, output_tokens: n / 2 })
  const review: ReviewObject = {
    summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [],
    findings: [cand(), cand({ title: 'Other', file: 'src/other.ts', lines: '1', body: 'x is wrong' })],
  }
  const contradictory = out([
    dec({ reason_category: 'unverifiable', evidence: '', note: 'The leak is real. Kept as validated.' }),
    dec({ candidate_id: 'c1', reason_category: 'style_only', note: 'naming only' }),
  ])
  const call = (options?: object) => runJudge('k', 'm', 1, 1000, '', DIFF, review, [], POLICY, false, undefined, options)

  it('replaces the contradictory drop with the repaired decision, sums usage, and records provenance', async () => {
    completeStructured
      .mockResolvedValueOnce({ object: contradictory, usage: usage(100) })
      .mockResolvedValueOnce({ object: out([dec({ reason_category: 'validated', note: 'confirmed by the quoted line' })]), usage: usage(40) })

    const res = await call(ON)

    expect(completeStructured).toHaveBeenCalledTimes(2)
    expect(completeStructured.mock.calls[1][1]).toContain('## Reconsider')
    expect(completeStructured.mock.calls[1][1]).toContain('c0')
    expect(completeStructured.mock.calls[1][1]).not.toContain('- c1:')
    expect(res.kept?.map(k => k.title)).toEqual(['Token exposed'])
    expect(res.usage.input_tokens).toBe(140)
    expect(res.decisions![0].repair).toEqual({ status: 'replaced', original_reason: 'unverifiable', original_note: 'The leak is real. Kept as validated.' })
    expect(res.decisions![1].repair).toBeUndefined()
  })

  it('keeps the original drop and records an unresolved repair when the replacement is still contradictory or missing', async () => {
    completeStructured
      .mockResolvedValueOnce({ object: contradictory, usage: usage(100) })
      .mockResolvedValueOnce({ object: out([dec({ reason_category: 'incorrect', note: 'This is a valid finding.' })]), usage: usage(40) })
    const res = await call(ON)
    expect(res.kept).toHaveLength(0)
    expect(res.decisions![0].repair?.status).toBe('unresolved')
    expect(res.anomalies?.unresolved_repair).toBe(1)
    expect(completeStructured).toHaveBeenCalledTimes(2)
  })

  it('rejects a repair with an off-enum category: the original decision stands even under keepUnverified', async () => {
    const original = out([dec({ reason_category: 'incorrect', note: 'This is a valid finding.' }), dec({ candidate_id: 'c1', reason_category: 'style_only' })])
    for (const bad of ['', 'bogus']) {
      completeStructured.mockReset()
      completeStructured
        .mockResolvedValueOnce({ object: original, usage: usage(100) })
        .mockResolvedValueOnce({ object: out([dec({ reason_category: bad as never, note: 'fine' })]), usage: usage(40) })
      const res = await runJudge('k', 'm', 1, 1000, '', DIFF, review, [], { keepMinor: false, keepUnverified: true }, false, undefined, ON)
      expect(res.kept).toHaveLength(0)
      expect(res.decisions![0]).toMatchObject({ reason_category: 'incorrect', action: 'drop', repair: { status: 'unresolved' } })
    }
  })

  it('survives a failed repair call and still counts its usage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    completeStructured
      .mockResolvedValueOnce({ object: contradictory, usage: usage(100) })
      .mockRejectedValueOnce(Object.assign(new Error('truncated'), { usage: usage(60) }))
    const res = await call(ON)
    expect(res.kept).toHaveLength(0)
    expect(res.usage.input_tokens).toBe(160)
    expect(res.decisions![0].repair?.status).toBe('unresolved')
    warn.mockRestore()
  })

  it('ignores replacements for ids it did not request, and for duplicate on an invalid-duplicate repair', async () => {
    completeStructured
      .mockResolvedValueOnce({ object: contradictory, usage: usage(100) })
      .mockResolvedValueOnce({ object: out([dec(), dec({ candidate_id: 'c1', reason_category: 'validated' })]), usage: usage(40) })
    const res = await call(ON)
    expect(res.kept?.map(k => k.title)).toEqual(['Token exposed'])
    expect(res.decisions![1]).toMatchObject({ reason_category: 'style_only', action: 'drop' })
  })

  it('repairs an invalid duplicate once, in the same single repair call, and bans duplicate for it', async () => {
    const twoFiles: ReviewObject = { ...review, findings: [cand(), cand({ file: '.github/workflows/publish-b.yml', title: 'Token in b' })] }
    const first = out([dec(), dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' })])
    completeStructured
      .mockResolvedValueOnce({ object: first, usage: usage(100) })
      .mockResolvedValueOnce({ object: out([dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c0' })]), usage: usage(40) })
    const res = await runJudge('k', 'm', 1, 1000, '', DIFF, twoFiles, [], POLICY, false, undefined, ON)
    expect(completeStructured).toHaveBeenCalledTimes(2)
    expect(res.decisions![1]).toMatchObject({ reason_category: 'unverifiable', invalid_duplicate: true, repair: { status: 'unresolved' } })

    completeStructured.mockReset()
    completeStructured
      .mockResolvedValueOnce({ object: first, usage: usage(100) })
      .mockResolvedValueOnce({ object: out([dec({ candidate_id: 'c1', reason_category: 'validated' })]), usage: usage(40) })
    const fixed = await runJudge('k', 'm', 1, 1000, '', DIFF, twoFiles, [], POLICY, false, undefined, ON)
    expect(fixed.kept?.map(k => k.title)).toEqual(['Token exposed', 'Token in b'])
  })

  it('makes no repair call when decisions are consistent, and flag off never repairs', async () => {
    completeStructured.mockResolvedValue({ object: out([dec(), dec({ candidate_id: 'c1', reason_category: 'style_only' })]), usage: usage(100) })
    await call(ON)
    expect(completeStructured).toHaveBeenCalledTimes(1)

    completeStructured.mockReset()
    completeStructured.mockResolvedValue({ object: contradictory, usage: usage(100) })
    const off = await call(undefined)
    expect(completeStructured).toHaveBeenCalledTimes(1)
    expect(completeStructured.mock.calls[0][2]).toBe(JUDGE_OUTPUT_SCHEMA)
    expect(off.kept).toHaveLength(0)
  })

  it('sends the composed prompt and the quality schema when on', async () => {
    completeStructured.mockResolvedValue({ object: out([dec(), dec({ candidate_id: 'c1', reason_category: 'style_only' })]), usage: usage(100) })
    await call(ON)
    expect(completeStructured.mock.calls[0][0]).toContain('## DECISION CONSISTENCY')
    expect(JSON.stringify(completeStructured.mock.calls[0][2])).toContain('additional_locations')
  })
})
