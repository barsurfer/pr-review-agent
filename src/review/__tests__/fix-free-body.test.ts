import { describe, it, expect, vi, beforeEach } from 'vitest'

const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })),
}))

import { readFileSync } from 'fs'
import { runJudge, judgeOutputSchema, JUDGE_OUTPUT_SCHEMA } from '../client.js'
import { composeJudgePrompt } from '../judge-quality.js'
import {
  applyJudgeDecisions, renderJudgedReview, sanitizeBodyWithoutFix, REWRITE_CAP, PROPOSAL_CAP, DEFAULT_JUDGE_POLICY,
  type JudgeDecision, type JudgeOutput, type RenderJudged,
} from '../judge-decisions.js'
import { composeSuggestedFixes, stripSuggestedFixes, stripOwnSuggestedFixes, renderFixBlock, fixFreeContent, MAX_FENCE, SUGGESTED_FIX_MARKER } from '../suggested-fix.js'
import { orderPosted } from '../posted-order.js'
import { buildReviewFooter, type ReviewFinding, type ReviewObject } from '../formatter.js'
import { keptToReportFindings, type KeptFinding } from '../findings-output.js'
import { pmBlocks } from './helpers/pm-fences.js'

const BASE = readFileSync(new URL('../../prompt/judge-prompt.txt', import.meta.url), 'utf-8')
const ADDED = 'When you give `proposal`, also give `body_without_fix`: the finding text as posted (your `rewritten_body`, else the candidate\'s body) with the fix left out - only the problem and why it matters, in at most 1–3 sentences. Keep every fact needed to understand the problem. No fix, no "should", no code snippet.'
const CODE_SECTION_BEFORE = '## PROPOSAL\n\nFor each candidate you keep, give `proposal`: the fix, posted to the developer as a copyable plain-text block. Start with one or two short lines that say what to change and where (file, function or line). When the fix is a local edit you can write from the code you were shown, follow with the corrected code as it should read after the fix, with its original indentation, at most 5 lines. When it is not (a choice between options, a config or design change, a change across files), give only the instruction lines. Plain text only: no markdown, no fences, no diff markers, no line-number gutter. Keep each line under ~100 characters, and the whole under 7 lines and ~450 characters. Do not restate the problem or why it matters. Omit `proposal` only when you cannot name a concrete change; never write "consider", "verify" or "ensure". Dropped candidates get no proposal.'

const OUT: JudgeOutput = { decisions: [], summary: 'Adds a pool.', behavioral_diff: ['x'], production_risk: [], unresolved_questions: [], merge_confidence: 70 }
const kept = (over: Partial<KeptFinding> = {}): KeptFinding => ({ severity: 'MEDIUM', title: 'Leak', body: 'Leaks the client. Release it in finally.', file: 'src/a.ts', lines: '2', ...over })
const renderFor = (rows: KeptFinding[]): RenderJudged => (s, order, fixFree) => renderJudgedReview(rows, OUT, [], [], s, order, fixFree)
const compose = (rows: KeptFinding[], budget = 32_000) => {
  const r = renderFor(rows)
  const plain = r(new Map())
  return { plain, r, ...composeSuggestedFixes(rows, s => r(s), plain, budget, (s, ff) => r(s, undefined, ff)) }
}
const B = (code: string, fence = '```') => renderFixBlock(code, fence)
const ownBlocks = (text: string) => pmBlocks(text).blocks.filter(b => b.opener.endsWith(SUGGESTED_FIX_MARKER)).map(b => b.code)

describe('judge prompt and schema for body_without_fix', () => {
  type Props = { properties: { decisions: { items: { properties: Record<string, { description: string }>; required: string[] } } } }
  const props = (s: unknown) => (s as Props).properties.decisions.items.properties

  it('flag off: the prompt and schema never mention it, in any other flag combination', () => {
    for (const quality of [false, true]) for (const shownAnchors of [false, true]) for (const proposals of [false, true]) {
      expect(composeJudgePrompt(BASE, { quality, shownAnchors, proposals })).not.toContain('body_without_fix')
      expect(composeJudgePrompt(BASE, { quality, shownAnchors, proposals, codeProposals: !proposals })).not.toContain('body_without_fix')
      expect(JSON.stringify(judgeOutputSchema(quality, shownAnchors, proposals))).not.toContain('body_without_fix')
    }
    expect(composeJudgePrompt(BASE, { quality: false, shownAnchors: false })).toBe(BASE)
  })

  it('flag on: the code PROPOSAL section gains exactly the new paragraph before its last sentence, nothing else changes', () => {
    const on = composeJudgePrompt(BASE, { quality: false, shownAnchors: false, proposals: true, codeProposals: true })
    expect(on).toContain(`\n\n${ADDED}\n\nDropped candidates get no proposal.\n`)
    expect(on.replace(`\n\n${ADDED}\n\n`, ' ')).toBe(`${BASE.trimEnd()}\n\n${CODE_SECTION_BEFORE}\n`)
    const q = composeJudgePrompt(BASE, { quality: true, shownAnchors: true, proposals: true, codeProposals: true })
    expect(q.split('body_without_fix')).toHaveLength(2)
  })

  it('flag on: the code schema gains exactly one optional property', () => {
    const code = judgeOutputSchema(false, false, true, true)
    const prose = judgeOutputSchema(false, false, true)
    expect(Object.keys(props(code)).sort()).toEqual([...Object.keys(props(prose)), 'body_without_fix'].sort())
    expect(props(code).body_without_fix).toMatchObject({ type: 'string' })
    expect((code as Props).properties.decisions.items.required).toEqual(JUDGE_OUTPUT_SCHEMA.properties.decisions.items.required)
  })
})

describe('runJudge request', () => {
  beforeEach(() => completeStructured.mockReset())
  const cand: ReviewFinding = { severity: 'MEDIUM', title: 'Leak', file: 'src/a.ts', lines: '1', body: 'Leaks. Release it.' }
  const review: ReviewObject = { summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], findings: [cand] }
  const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,1 @@\n+export const a = 1\n'
  const call = async (options?: object) => {
    completeStructured.mockResolvedValue({
      object: { ...OUT, decisions: [{ candidate_id: 'c0', reason_category: 'validated', evidence: 'e', note: 'n', score: 8, proposal: 'release()', body_without_fix: 'Leaks.' }] },
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    return runJudge('k', 'm', 1, 1000, '', DIFF, review, [], DEFAULT_JUDGE_POLICY, false, undefined, options)
  }

  it('flag off: raw prompt, shared schema; a stray body_without_fix is ignored everywhere', async () => {
    const res = await call()
    expect(completeStructured.mock.calls[0][0]).toBe(BASE)
    expect(completeStructured.mock.calls[0][2]).toBe(JUDGE_OUTPUT_SCHEMA)
    expect(JSON.stringify([res.kept, res.decisions])).not.toMatch(/without_?fix|WithoutFix/i)
  })

  it('ENABLE_JUDGE_PROPOSALS alone (prose contract): never asked for and ignored', async () => {
    const res = await call({ proposals: true })
    expect(JSON.stringify(completeStructured.mock.calls[0].slice(0, 3))).not.toContain('body_without_fix')
    expect(JSON.stringify([res.kept, res.decisions])).not.toMatch(/without_?fix|WithoutFix/i)
  })

  it('flag on: asked for in prompt and schema, carried on the kept finding and the decision; the judged markdown keeps the normal text', async () => {
    const res = await call({ proposals: true, codeProposals: true })
    expect(completeStructured.mock.calls[0][0]).toContain(ADDED)
    expect(completeStructured.mock.calls[0][2]).toBe(judgeOutputSchema(false, false, true, true))
    expect(res.kept![0].bodyWithoutFix).toBe('Leaks.')
    expect(res.decisions![0].body_without_fix).toBe('Leaks.')
    expect(res.text).toContain('  Leaks. Release it.')
    expect(res.text).not.toContain('  Leaks.\n')
  })
})

describe('sanitizeBodyWithoutFix', () => {
  it('omits non-strings and blank strings, trims the rest', () => {
    for (const v of [undefined, null, 5, {}, '', '  \n ']) expect(sanitizeBodyWithoutFix(v, 'body text')).toBeUndefined()
    expect(sanitizeBodyWithoutFix('  Leaks.  ', 'Leaks. Release it.')).toBe('Leaks.')
  })

  it('omits a text over REWRITE_CAP or more than half again as long as the normal text', () => {
    const body = 'x'.repeat(100)
    expect(sanitizeBodyWithoutFix('y'.repeat(150), body)).toHaveLength(150)
    expect(sanitizeBodyWithoutFix('y'.repeat(151), body)).toBeUndefined()
    expect(sanitizeBodyWithoutFix('y'.repeat(REWRITE_CAP + 1), 'x'.repeat(REWRITE_CAP))).toBeUndefined()
    expect(sanitizeBodyWithoutFix('y', '')).toBeUndefined()
  })
})

describe('applyJudgeDecisions body_without_fix', () => {
  const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+export const a = 1\n+export const b = 2\n'
  const cand = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({ severity: 'MEDIUM', title: 'Leak', file: 'src/a.ts', lines: '2', body: 'Leaks the client. Release it in finally.', ...over })
  const dec = (over: Partial<JudgeDecision> = {}): JudgeDecision => ({ candidate_id: 'c0', reason_category: 'validated', evidence: 'a:2', note: 'n', score: 8, proposal: 'release()', body_without_fix: 'Leaks the client.', ...over })
  const CODE = { proposals: true, codeProposals: true }
  const run = (cands: ReviewFinding[], decisions: JudgeDecision[], options?: object) => applyJudgeDecisions(cands, { ...OUT, decisions }, DEFAULT_JUDGE_POLICY, [], DIFF, Infinity, options)

  it('kept with a usable proposal: on kept and on the decision; the markdown and report keep the normal text', () => {
    const r = run([cand()], [dec()], CODE)
    expect(r.kept[0]).toMatchObject({ body: 'Leaks the client. Release it in finally.', bodyWithoutFix: 'Leaks the client.' })
    expect(r.decisions[0].body_without_fix).toBe('Leaks the client.')
    expect(r.markdown).toBe(run([cand()], [dec({ body_without_fix: undefined })], CODE).markdown)
    expect(keptToReportFindings(r.kept, 'p')).toEqual(keptToReportFindings(run([cand()], [dec({ body_without_fix: undefined })], CODE).kept, 'p'))
  })

  it('absent without a proposal, with a proposal the sanitizer drops, on a dropped candidate, under prose proposals and flag off', () => {
    const cases = [
      run([cand()], [dec({ proposal: undefined })], CODE),
      run([cand()], [dec({ proposal: 'x'.repeat(PROPOSAL_CAP + 1) })], CODE),
      run([cand()], [dec({ reason_category: 'incorrect' })], CODE),
      run([cand()], [dec()], { proposals: true }),
      run([cand()], [dec()]),
    ]
    for (const r of cases) {
      expect(JSON.stringify([r.kept, r.decisions])).not.toMatch(/without_?fix|WithoutFix/i)
    }
  })

  it('measured against rewritten_body when the judge gives one', () => {
    const long = 'Leaks the client on every failed query, so the pool drains.'
    const short = run([cand({ body: 'x'.repeat(200) })], [dec({ rewritten_body: 'Leaks. Use finally.', body_without_fix: long })], CODE)
    expect(short.kept[0].body).toBe('Leaks. Use finally.')
    expect('bodyWithoutFix' in short.kept[0]).toBe(false)
    const ok = run([cand({ body: 'x' })], [dec({ rewritten_body: `${long} Release it in finally.`, body_without_fix: long })], CODE)
    expect(ok.kept[0].bodyWithoutFix).toBe(long)
  })
})

describe('composeSuggestedFixes with fix-free texts', () => {
  const A = kept({ severity: 'HIGH', title: 'A', body: 'A leaks the client. Release it in finally.', bodyWithoutFix: 'A leaks the client.', proposal: 'a()' })
  const Bn = kept({ title: 'B', body: 'B drops the error. Await it.', proposal: 'await b()' })
  const C = kept({ severity: 'LOW', title: 'C', body: 'C is unused. Remove it.', bodyWithoutFix: 'C is unused.' })

  it('the literal posted form: the finding text loses its fix sentence only above its block', () => {
    const rows = [kept({
      severity: 'HIGH', title: 'Client leaked on query error', file: 'src/db/pool.ts', lines: '42-47',
      body: '`client.release()` is skipped when `query` throws, so the pool drains. Release in `finally`.',
      bodyWithoutFix: '`client.release()` is skipped when `query` throws, so the pool drains.',
      proposal: 'try {\n  return await client.query(sql, params)\n} finally {\n  client.release()\n}',
    })]
    const { text, stats } = compose(rows)
    expect(stats).toEqual({ rendered: 1, rejected: 0, fix_free: 1 })
    expect(text).toContain([
      '- **HIGH – Client leaked on query error** (`src/db/pool.ts:42-47`)',
      '  `client.release()` is skipped when `query` throws, so the pool drains.',
      '',
      '**Suggested fix:**',
      '',
      '```suggested-fix-v1',
      'try {',
      '  return await client.query(sql, params)',
      '} finally {',
      '  client.release()',
      '}',
      '```',
      '',
      '### Behavioral Diff',
    ].join('\n'))
  })

  it('same review: fix-free text above a rendered block, the normal text for a block without one and for a finding without a block', () => {
    const rows = [A, Bn, C]
    const { text, stats, plain } = compose(rows)
    expect(stats).toEqual({ rendered: 2, rejected: 0, fix_free: 1 })
    expect(text).toBe(renderJudgedReview(rows, OUT, [], [], new Map([[0, B('a()')], [1, B('await b()')]]), undefined, new Set([0])))
    expect(text).toContain(`  A leaks the client.${B('a()')}`)
    expect(text).toContain(`  B drops the error. Await it.${B('await b()')}`)
    expect(text).toContain('  C is unused. Remove it.')
    expect(text).not.toContain('Release it in finally.')
    expect(plain).toContain('Release it in finally.')
  })

  it('strip round trip: the posted text strips to the block-free comment with the fix-free texts, no longer to the plain review', () => {
    const rows = [A, Bn, C]
    const { text, plain, r } = compose(rows)
    const footer = buildReviewFooter('bot', 'm', 'repo', 1, 'aaa111222333', 'b')
    expect(stripSuggestedFixes(text)).toBe(r(new Map(), undefined, new Set([0])))
    expect(stripOwnSuggestedFixes(text + footer, 'review')).toBe(r(new Map(), undefined, new Set([0])) + footer)
    expect(stripSuggestedFixes(text)).not.toBe(plain)
  })

  it('every skip falls back to the plain review: normal texts for all findings, no block', () => {
    const cases: Array<[string, KeptFinding[], number?, ((s: string) => string)?]> = [
      ['size', [A, Bn, C], 10],
      ['unbalanced', [{ ...A, body: 'see\n```ts\nfoo()' }]],
      ['unbalanced', [{ ...A, body: 'see\n```ts\nfoo()' }, { ...Bn, body: 'more\n```' }]],
      ['fence', [A, { ...Bn, proposal: `s = "${'`'.repeat(MAX_FENCE)}"` }]],
      ['cleanup', [A, Bn], undefined, s => s.replace('### Summary', '### Summary ')],
    ]
    for (const [skipped, rows, budget, edit] of cases) {
      const r = renderFor(rows)
      const plain = (edit ?? (s => s))(r(new Map()))
      const res = composeSuggestedFixes(rows, s => r(s), plain, budget ?? 32_000, (s, ff) => r(s, undefined, ff))
      expect(res, skipped).toEqual({ text: plain, stats: { rendered: 0, rejected: 0, skipped } })
      expect(res.text).not.toContain('  A leaks the client.\n')
    }
  })

  it('a rejected proposal, no proposal, or no fix-free render closure: the normal text', () => {
    const rejected = compose([{ ...A, proposal: 'a()\n*Reply by bot (m)*' }])
    expect(rejected.stats).toEqual({ rendered: 0, rejected: 1 })
    expect(rejected.text).toBe(rejected.plain)
    const none = compose([{ ...A, proposal: undefined }])
    expect(none.text).toBe(none.plain)
    const r = renderFor([A])
    const noClosure = composeSuggestedFixes([A], s => r(s), r(new Map()), 32_000)
    expect(noClosure).toEqual({ text: r(new Map([[0, B('a()')]])), stats: { rendered: 1, rejected: 0 } })
  })

  it('an invalid fix-free text falls back to the normal text and the block still renders', () => {
    const bad = [
      '', 'A leaks.\n```ts\nx()\n```', 'A leaks.\n  ~~~', 'A leaks.\n*Reviewed by bot (m) | Prompt: p | Review #1 | Commit: deadbeef0000*', 'A leaks.\n*Reply by bot (m)*',
      'A leaks.\u{2028}*Reply by bot (m)*', 'A leaks.\r\nIt drains.', 'A leaks.\nNO_CHANGE', 'A leaks. <!-- JUDGE_NOTES: x -->', 'A leaks.\n---\n*Reviewed by x*', 'A leaks. ',
    ]
    for (const bodyWithoutFix of bad) {
      const rows = [{ ...A, bodyWithoutFix }]
      const { text, stats, r } = compose(rows)
      expect(stats, JSON.stringify(bodyWithoutFix)).toEqual({ rendered: 1, rejected: 0 })
      expect(text).toBe(r(new Map([[0, B('a()')]])))
    }
    expect(fixFreeContent('A leaks; see *Reply by bot (m)* above.')).toBe('A leaks; see *Reply by bot (m)* above.')
    expect(fixFreeContent('A leaks the `client` when `query()` throws.')).toBe('A leaks the `client` when `query()` throws.')
  })

  it('a fix-free text that breaks a whole-review check falls back to the normal texts with their blocks, never to a lone fix-free text', () => {
    const longer = { ...A, body: 'A leaks. Use finally.', bodyWithoutFix: 'A leaks the client on errors.' }
    const r = renderFor([longer])
    const normal = r(new Map([[0, B('a()')]]))
    const res = composeSuggestedFixes([longer], s => r(s), r(new Map()), normal.length, (s, ff) => r(s, undefined, ff))
    expect(res).toEqual({ text: normal, stats: { rendered: 1, rejected: 0 } })
    expect(composeSuggestedFixes([longer], s => r(s), r(new Map()), normal.length + 100, (s, ff) => r(s, undefined, ff)).stats).toEqual({ rendered: 1, rejected: 0, fix_free: 1 })
  })

  it('a fix-free render closure that does not reproduce the plain text is not used', () => {
    const rows = [A, Bn]
    const r = renderFor(rows)
    const res = composeSuggestedFixes(rows, s => r(s), r(new Map()), 32_000, (s, ff) => r(s, [1, 0], ff))
    expect(res).toEqual({ text: r(new Map([[0, B('a()')], [1, B('await b()')]])), stats: { rendered: 2, rejected: 0 } })
  })

  it('ordering + blocks + fix-free texts: each block and fix-free text stays with its own finding after the move', () => {
    const rows = [kept({ severity: 'LOW', title: 'Typo', body: 'Typo in name. Rename it.', bodyWithoutFix: 'Typo in name.', proposal: 'fixTypo()' }), A, kept({ title: 'Leak', body: 'Leak body. Close it.', proposal: 'close()' })]
    const r = renderFor(rows)
    const plain = r(new Map())
    const posted = orderPosted(plain, rows, order => r(new Map(), order))
    expect(posted.order).toEqual([1, 2, 0])
    const res = composeSuggestedFixes(rows, s => r(s, posted.order), posted.text, 32_000, (s, ff) => r(s, posted.order, ff))
    const fixFree = { ...rows[0], body: 'Typo in name.' }
    const fixFreeA = { ...A, body: 'A leaks the client.' }
    expect(res.text).toBe(renderJudgedReview([fixFreeA, rows[2], fixFree], OUT, [], [], new Map([[0, B('a()')], [1, B('close()')], [2, B('fixTypo()')]])))
    expect(res.stats).toEqual({ rendered: 3, rejected: 0, fix_free: 2 })
    expect(stripSuggestedFixes(res.text)).toBe(r(new Map(), posted.order, new Set([0, 1])))
    expect(ownBlocks(res.text).sort()).toEqual(['a()', 'close()', 'fixTypo()'])
  })

  it('a fix-free text that drops a fence paired across findings cannot rescue blocks today\'s check skips', () => {
    const rows = [{ ...A, body: 'see\n```ts\nfoo()', bodyWithoutFix: 'A leaks.' }, { ...Bn, body: 'more\n```', proposal: undefined }]
    const { text, plain, stats } = compose(rows)
    expect(stats).toEqual({ rendered: 0, rejected: 0, skipped: 'unbalanced' })
    expect(text).toBe(plain)
  })
})
