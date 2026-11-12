import { describe, it, expect, vi, beforeEach } from 'vitest'

const complete = vi.fn()
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete, completeStructured })),
}))

import { runJudge, judgeOutputSchema, JUDGE_OUTPUT_SCHEMA } from '../client.js'
import { applyJudgeDecisions, sanitizeProposal, PROPOSAL_CAP, type JudgeDecision, type JudgeOutput } from '../judge-decisions.js'
import { composeJudgePrompt } from '../judge-quality.js'
import { keptToReportFindings, anchorToFile, type KeptFinding } from '../findings-output.js'
import type { ReviewFinding, ReviewObject } from '../formatter.js'
import { readFileSync } from 'fs'

const file = (path: string, lines: string[]): string =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`

const DIFF = file('src/a.ts', ['export const a = 1', 'export const b = 2', 'export const c = 3'])
  + file('src/b.ts', ['export const a = 1', 'export const b = 2'])

const cand = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({ severity: 'MEDIUM', title: 'Leak', file: 'src/a.ts', lines: '2', body: 'Leaks the client.', ...over })

const dec = (over: Partial<JudgeDecision> = {}): JudgeDecision =>
  ({ candidate_id: 'c0', reason_category: 'validated', evidence: 'a:2', note: 'real', score: 8, ...over })

const out = (decisions: JudgeDecision[]): JudgeOutput =>
  ({ decisions, summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 })

const ON = { proposals: true }
const FIX = 'Wrap the query in try/finally and call client.release() in the finally block.'

describe('sanitizeProposal', () => {
  const fenced = (n: number) => `Do it:\n\`\`\`ts\n${Array.from({ length: n }, (_, i) => `x${i}()`).join('\n')}\n\`\`\``

  it('omits non-strings and blank strings', () => {
    for (const v of [undefined, null, false, 5, {}, ['a'], '', '   \n']) expect(sanitizeProposal(v)).toBeUndefined()
  })

  it('trims and accepts plain text up to exactly the cap, omits (never truncates) over it', () => {
    expect(sanitizeProposal(`  ${FIX}  `)).toBe(FIX)
    expect(sanitizeProposal('x'.repeat(PROPOSAL_CAP))).toHaveLength(PROPOSAL_CAP)
    expect(sanitizeProposal('x'.repeat(PROPOSAL_CAP + 1))).toBeUndefined()
  })

  it('accepts a short proposal with one small snippet, omits one that runs long', () => {
    expect(sanitizeProposal(fenced(4))).toBe(fenced(4))      // 7 non-blank lines
    expect(sanitizeProposal(fenced(5))).toBeUndefined()      // 8 non-blank lines
  })

  it('counts non-blank lines only, ignoring blanks, fence punctuation and inline backticks', () => {
    const blanks = 'Do it:\n```ts\na()\n\nb()\n\nc()\nd()\n```'
    expect(sanitizeProposal(blanks)).toBe(blanks)                             // blanks not counted -> 7 non-blank
    expect(sanitizeProposal(`${fenced(1)}\n${fenced(1)}`)).toBeUndefined()    // two blocks -> 8 non-blank
    const inline = 'Fix:\n```ts\nconst d = "```"\nuse(d)\n```'
    expect(sanitizeProposal(inline)).toBe(inline)                            // inline backticks are text -> 5 non-blank
  })

  it('accepts a legitimate list-indented snippet', () => {
    const listed = '- Release in finally:\n\n    ```ts\n    try { q() }\n    finally { c.release() }\n    ```'
    expect(sanitizeProposal(listed)).toBe(listed)                           // 5 non-blank lines
  })

  it('cannot be bypassed by any fence or whitespace trick — all forms count toward the line cap', () => {
    const over = [
      'Fix:\r\n~~~ts\r\na()\r\nb()\r\nc()\r\nd()\r\ne()\r\n~~~',                               // CRLF
      'Fix:\r~~~ts\ra()\rb()\rc()\rd()\re()\r~~~',                                             // lone CR
      '- Fix:\n\n    ```ts\n    a()\n    b()\n    c()\n    d()\n    e()\n    ```',               // list-indented snippet
    ]
    for (const s of over) expect(sanitizeProposal(s)).toBeUndefined()
  })
})

describe('proposal schema and prompt', () => {
  const base = readFileSync(new URL('../../prompt/judge-prompt.txt', import.meta.url), 'utf-8')

  it('flag-off returns the shared schema and never mutates it', () => {
    expect(judgeOutputSchema(false, false, false)).toBe(JUDGE_OUTPUT_SCHEMA)
    expect(judgeOutputSchema(false, false)).toBe(JUDGE_OUTPUT_SCHEMA)
    judgeOutputSchema(true, true, true)
    expect(JSON.stringify(JUDGE_OUTPUT_SCHEMA)).not.toContain('proposal')
  })

  it('the variant has an optional proposal and is cached per key', () => {
    const v = judgeOutputSchema(false, false, true) as { properties: { decisions: { items: { properties: Record<string, unknown>; required: string[] } } } }
    expect(v.properties.decisions.items.properties.proposal).toMatchObject({ type: 'string' })
    expect(v.properties.decisions.items.required).not.toContain('proposal')
    expect(judgeOutputSchema(false, false, true)).toBe(v)
    expect(judgeOutputSchema(true, false, true)).not.toBe(v)
    expect(JSON.stringify(judgeOutputSchema(true, false, false))).not.toContain('"proposal"')
  })

  it('proposals-off schema never adds the proposal property across every quality x shown-anchor combo', () => {
    for (const q of [false, true]) for (const a of [false, true]) {
      expect(JSON.stringify(judgeOutputSchema(q, a, false))).not.toContain('"proposal"')
      expect(judgeOutputSchema(q, a, false)).toBe(judgeOutputSchema(q, a))
    }
  })

  it('prompt is the identity when off or omitted, and gains the PROPOSAL section last when on', () => {
    expect(composeJudgePrompt(base, { quality: false, shownAnchors: false, proposals: false })).toBe(base)
    expect(composeJudgePrompt(base, { quality: false, shownAnchors: false })).toBe(base)
    const p = composeJudgePrompt(base, { quality: true, shownAnchors: false, proposals: true })
    expect(p).toContain('## MULTI-FILE FINDINGS')
    expect(p.indexOf('## PROPOSAL')).toBeGreaterThan(p.indexOf('## MULTI-FILE FINDINGS'))
    expect(p.trimEnd().endsWith('Dropped candidates get no proposal.')).toBe(true)
  })
})

describe('applyJudgeDecisions proposals', () => {
  const run = (cands: ReviewFinding[], decisions: JudgeDecision[], options?: object, breadthFrom?: number, keepUnverified = false) =>
    applyJudgeDecisions(cands, out(decisions), { keepMinor: false, keepUnverified }, [], DIFF, breadthFrom, options)

  it('flag on: a kept candidate carries the proposal on kept and decisions', () => {
    const r = run([cand()], [dec({ proposal: FIX })], ON)
    expect(r.kept[0].proposal).toBe(FIX)
    expect(r.decisions[0].proposal).toBe(FIX)
  })

  it('flag off: a stray proposal is ignored everywhere', () => {
    const r = run([cand()], [dec({ proposal: FIX })])
    expect('proposal' in r.kept[0]).toBe(false)
    expect('proposal' in r.decisions[0]).toBe(false)
    expect(r.kept[0]).toEqual(run([cand()], [dec()]).kept[0])
    expect(r.decisions).toEqual(run([cand()], [dec()]).decisions)
  })

  it('dropped and moved candidates get no proposal', () => {
    const r = run([cand(), cand({ title: 'Q' })], [
      dec({ reason_category: 'incorrect', proposal: FIX }),
      dec({ candidate_id: 'c1', reason_category: 'framework_uncertainty', question: 'q?', proposal: FIX }),
    ], ON)
    expect(r.kept).toHaveLength(0)
    expect(r.decisions.every(d => !('proposal' in d))).toBe(true)
  })

  it('blank, non-string and over-cap proposals leave the key absent', () => {
    for (const proposal of ['  ', 7, 'x'.repeat(PROPOSAL_CAP + 1)]) {
      const r = run([cand()], [dec({ proposal })], ON)
      expect('proposal' in r.kept[0]).toBe(false)
      expect('proposal' in r.decisions[0]).toBe(false)
    }
  })

  it('expansion rows carry no proposal even when quality is on', () => {
    const r = run([cand({ body: 'Leaks the client in src/a.ts and src/b.ts.' })], [dec({
      proposal: FIX,
      additional_locations: [{ file: 'src/b.ts', lines: '2', anchor_quote: 'export const b = 2', candidate_excerpt: 'src/b.ts', body: 'Same leak.' }],
    })], { quality: true, proposals: true })
    expect(r.kept).toHaveLength(2)
    expect(r.kept[0].proposal).toBe(FIX)
    expect('proposal' in r.kept[1]).toBe(false)
  })

  it('a quality-promoted invalid duplicate keeps its proposal (gated on final status)', () => {
    const r = run([cand(), cand({ title: 'Twin' })], [
      dec({ proposal: FIX }),
      dec({ candidate_id: 'c1', reason_category: 'duplicate', duplicate_of: 'c9', proposal: 'Release the client in finally.' }),
    ], { quality: true, proposals: true }, undefined, true)
    expect(r.decisions[1]).toMatchObject({ invalid_duplicate: true, action: 'keep', proposal: 'Release the client in finally.' })
    expect(r.kept[1].proposal).toBe('Release the client in finally.')
  })

  it('breadth and second-look origin candidates keep their proposal', () => {
    const r = run([cand(), cand({ title: 'Breadth' }), cand({ title: 'SL' })], [
      dec({ proposal: 'one' }), dec({ candidate_id: 'c1', proposal: 'two' }), dec({ candidate_id: 'c2', proposal: 'three' }),
    ], ON, 1)
    expect(r.kept.map(k => k.proposal)).toEqual(['one', 'two', 'three'])
  })

  it('flag-off serialized kept + decisions + report is pinned and proposal-free (quality off/on)', () => {
    const serialize = (quality: boolean) => JSON.stringify((() => {
      const r = run([cand(), cand({ title: 'Other', lines: '3' })], [dec({ proposal: FIX }), dec({ candidate_id: 'c1', proposal: FIX })], quality ? { quality: true } : undefined)
      return { kept: r.kept, decisions: r.decisions, report: keptToReportFindings(r.kept, 'p') }
    })())
    expect(serialize(false)).not.toContain('proposal')
    expect(serialize(true)).not.toContain('proposal')
    expect(serialize(false)).toMatchInlineSnapshot(`"{"kept":[{"severity":"MEDIUM","title":"Leak","body":"Leaks the client.","file":"src/a.ts","lines":"2","score":8,"anchorSource":"reviewer"},{"severity":"MEDIUM","title":"Other","body":"Leaks the client.","file":"src/a.ts","lines":"3","score":8,"anchorSource":"reviewer"}],"decisions":[{"candidate_id":"c0","reason_category":"validated","reclassified_from":null,"action":"keep","original_severity":"MEDIUM","final_severity":"MEDIUM","score":8,"evidence":"a:2","note":"real","rewritten":false,"anchor_source":"reviewer","anchor_file":"src/a.ts","anchor_lines":"2"},{"candidate_id":"c1","reason_category":"validated","reclassified_from":null,"action":"keep","original_severity":"MEDIUM","final_severity":"MEDIUM","score":8,"evidence":"a:2","note":"real","rewritten":false,"anchor_source":"reviewer","anchor_file":"src/a.ts","anchor_lines":"3"}],"report":[{"file":"src/a.ts","start_line":2,"end_line":2,"message":"Leak: Leaks the client.","producer":"p"},{"file":"src/a.ts","start_line":3,"end_line":3,"message":"Other: Leaks the client.","producer":"p"}]}"`)
    expect(serialize(true)).toMatchInlineSnapshot(`"{"kept":[{"severity":"MEDIUM","title":"Leak","body":"Leaks the client.","file":"src/a.ts","lines":"2","score":8,"anchorSource":"reviewer"},{"severity":"MEDIUM","title":"Other","body":"Leaks the client.","file":"src/a.ts","lines":"3","score":8,"anchorSource":"reviewer"}],"decisions":[{"candidate_id":"c0","reason_category":"validated","reclassified_from":null,"action":"keep","original_severity":"MEDIUM","final_severity":"MEDIUM","score":8,"evidence":"a:2","note":"real","rewritten":false,"anchor_source":"reviewer","anchor_file":"src/a.ts","anchor_lines":"2"},{"candidate_id":"c1","reason_category":"validated","reclassified_from":null,"action":"keep","original_severity":"MEDIUM","final_severity":"MEDIUM","score":8,"evidence":"a:2","note":"real","rewritten":false,"anchor_source":"reviewer","anchor_file":"src/a.ts","anchor_lines":"3"}],"report":[{"file":"src/a.ts","start_line":2,"end_line":2,"message":"Leak: Leaks the client.","producer":"p"},{"file":"src/a.ts","start_line":3,"end_line":3,"message":"Other: Leaks the client.","producer":"p"}]}"`)
  })
})

describe('findings-output proposal', () => {
  const k = (over: Partial<KeptFinding> = {}): KeptFinding => ({ severity: 'HIGH', title: 'Leak', body: 'b', file: 'src/a.ts', lines: '2', ...over })

  it('keptToReportFindings includes proposal only when set, and message is unchanged', () => {
    const [a, b] = keptToReportFindings([k({ proposal: FIX }), k({ title: 'Other' })], 'p')
    expect(a).toEqual({ file: 'src/a.ts', start_line: 2, end_line: 2, message: 'Leak: b', producer: 'p', proposal: FIX })
    expect('proposal' in b).toBe(false)
    expect(JSON.stringify(keptToReportFindings([k()], 'p'))).not.toContain('proposal')
  })

  it('anchorToFile preserves it and dedup is unaffected', () => {
    const placed = anchorToFile([k({ file: 'src/a.ts', lines: undefined, proposal: FIX })], new Map([['src/a.ts', 1]]))
    expect(placed[0].proposal).toBe(FIX)
    expect(keptToReportFindings([k({ proposal: FIX }), k({ proposal: 'dup' })], 'p')).toHaveLength(1)
  })
})

describe('runJudge proposals', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })
  const baseText = readFileSync(new URL('../../prompt/judge-prompt.txt', import.meta.url), 'utf-8')
  const review: ReviewObject = { summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], findings: [cand()] }
  const policy = { keepMinor: false, keepUnverified: false }
  const call = async (options?: object) => {
    completeStructured.mockResolvedValue({ object: out([dec({ proposal: FIX })]), usage: { input_tokens: 10, output_tokens: 5 } })
    return runJudge('k', 'm', 2, 1000, '', DIFF, review, [], policy, false, undefined, options)
  }

  it('flag-off sends the raw prompt and shared schema, and drops a stray proposal', async () => {
    const res = await call()
    expect(completeStructured.mock.calls[0][0]).toBe(baseText)
    expect(completeStructured.mock.calls[0][2]).toBe(JUDGE_OUTPUT_SCHEMA)
    expect(JSON.stringify(res.kept)).not.toContain('proposal')
    expect(JSON.stringify(res.decisions)).not.toContain('proposal')
  })

  it('proposals:false is the same request as omitted options', async () => {
    await call()
    const a = JSON.stringify(completeStructured.mock.calls)
    completeStructured.mockReset()
    await call({ proposals: false })
    expect(JSON.stringify(completeStructured.mock.calls)).toBe(a)
  })

  it('flag-on sends the PROPOSAL prompt and variant schema and returns the proposal', async () => {
    const res = await call(ON)
    expect(completeStructured.mock.calls[0][0]).toContain('## PROPOSAL')
    expect(JSON.stringify(completeStructured.mock.calls[0][2])).toContain('"proposal"')
    expect(res.kept![0].proposal).toBe(FIX)
  })

  it('proposals alone return no renderWith and keep the prose contract', async () => {
    const res = await call(ON)
    expect('renderWith' in res).toBe(false)
    expect(completeStructured.mock.calls[0][0]).not.toContain('only the corrected code')
  })

  it('codeProposals sends the code contract and schema, dedents the proposal and returns renderWith', async () => {
    completeStructured.mockResolvedValue({ object: out([dec({ proposal: '    try {\n      q()\n    } finally {' })]), usage: { input_tokens: 10, output_tokens: 5 } })
    const res = await runJudge('k', 'm', 2, 1000, '', DIFF, review, [], policy, false, undefined, { proposals: true, codeProposals: true })
    const [prompt, , schema] = completeStructured.mock.calls[0]
    expect(prompt).toBe(composeJudgePrompt(baseText, { quality: false, shownAnchors: false, proposals: true, codeProposals: true }))
    expect(schema).toBe(judgeOutputSchema(false, false, true, true))
    expect(res.kept![0].proposal).toBe('try {\n  q()\n} finally {')
    expect(res.renderWith!(new Map())).toBe(res.text)
    expect(res.promptHash).not.toBe((await call(ON)).promptHash)
  })
})

describe('code proposal contract (ENABLE_SUGGESTED_FIXES)', () => {
  const base = readFileSync(new URL('../../prompt/judge-prompt.txt', import.meta.url), 'utf-8')
  type Props = { properties: { decisions: { items: { properties: Record<string, { description: string }>; required: string[] } } } }

  it('the prompt swaps in the code-only PROPOSAL section, last, and only when proposals are on', () => {
    const code = composeJudgePrompt(base, { quality: true, shownAnchors: false, proposals: true, codeProposals: true })
    expect(code).toContain('## PROPOSAL\n\nFor each candidate you keep, give `proposal`: only the corrected code for the lines that change')
    expect(code).not.toContain('written as an instruction')
    expect(code.indexOf('## PROPOSAL')).toBeGreaterThan(code.indexOf('## MULTI-FILE FINDINGS'))
    expect(code.trimEnd().endsWith('Dropped candidates get no proposal.')).toBe(true)
    expect(composeJudgePrompt(base, { quality: false, shownAnchors: false, proposals: false, codeProposals: true })).toBe(base)
    expect(composeJudgePrompt(base, { quality: false, shownAnchors: false, proposals: true, codeProposals: false })).toBe(composeJudgePrompt(base, { quality: false, shownAnchors: false, proposals: true }))
  })

  it('the schema variant carries the code description, is cached under its own key and leaves the others untouched', () => {
    const code = judgeOutputSchema(false, false, true, true) as Props
    expect(code.properties.decisions.items.properties.proposal.description).toMatch(/^Only for a candidate you keep: the corrected code/)
    expect(code.properties.decisions.items.required).not.toContain('proposal')
    expect(judgeOutputSchema(false, false, true, true)).toBe(code)
    expect(judgeOutputSchema(false, false, true)).not.toBe(code)
    expect(judgeOutputSchema(false, false, true, false)).toBe(judgeOutputSchema(false, false, true))
    expect((judgeOutputSchema(false, false, true) as Props).properties.decisions.items.properties.proposal.description).toMatch(/imperative instruction/)
    for (const q of [false, true]) for (const a of [false, true]) expect(judgeOutputSchema(q, a, false, true)).toBe(judgeOutputSchema(q, a, false))
  })
})
