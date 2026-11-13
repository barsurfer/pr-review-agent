import { describe, it, expect } from 'vitest'
import { orderPosted, severityPermutation, fencesSelfContained } from '../posted-order.js'
import { renderReview, stripPreviousFooter, markdownHasFindings, type ReviewObject, type ReviewFinding } from '../formatter.js'
import { applyJudgeDecisions, renderJudgedReview, DEFAULT_JUDGE_POLICY, type JudgeOutput } from '../judge-decisions.js'
import { composeSuggestedFixes, stripSuggestedFixes, renderFixBlock } from '../suggested-fix.js'
import { parseFindings } from '../parsers.js'
import type { KeptFinding } from '../findings-output.js'

const f = (severity: ReviewFinding['severity'], title: string, body = `${title} body.`): ReviewFinding => ({ severity, title, file: 'src/a.ts', lines: '10', body })
const obj = (findings: ReviewFinding[], over: Partial<ReviewObject> = {}): ReviewObject =>
  ({ summary: 'Adds a pool.', findings, behavioral_diff: ['x'], production_risk: ['y'], unresolved_questions: ['q?'], ...over })
const byReviewer = (o: ReviewObject, plain = renderReview(o)) => orderPosted(plain, o.findings, order => renderReview(o, { order }))
const OUT: JudgeOutput = { decisions: [], summary: 'Judged.', behavioral_diff: ['b'], production_risk: [], unresolved_questions: [], merge_confidence: 70 }

const H1 = f('HIGH', 'Crash on null')
const H2 = f('HIGH', 'Second crash')
const M1 = f('MEDIUM', 'Missing await', 'Await foo().\n```ts\nawait foo()\n```\nOtherwise the rejection is lost.')
const M2 = f('MEDIUM', 'Leak')
const L1 = f('LOW', 'Unused import', 'Remove it.\nSecond line of the body.\n\nA second paragraph.')
const L2 = f('LOW', 'Typo')

describe('severityPermutation', () => {
  it('orders HIGH → MEDIUM → LOW, stable within a level', () => {
    expect(severityPermutation([L1, M1, H1, L2, M2, H2])).toEqual([2, 5, 1, 4, 0, 3])
    expect(severityPermutation([H1, M1, L1])).toEqual([0, 1, 2])
  })

  it('a label the renderers never emit keeps its slot', () => {
    const odd = (severity: string) => ({ ...M2, severity }) as unknown as ReviewFinding
    expect(severityPermutation([L1, odd('CRITICAL'), H1, odd('High'), M1])).toEqual([2, 1, 4, 3, 0])
  })
})

describe('fencesSelfContained', () => {
  it('accepts fences that open with a bare tag and close on the identical fence line', () => {
    for (const t of ['no fences', 'a\n```ts\nx\n```\nb', '  ```\nx\n  ```  ', '~~~\nx\n~~~', '``` c++\nx\n```\r\n']) expect(fencesSelfContained(t), t).toBe(true)
  })

  it('rejects an unclosed fence and fences that renderers pair differently', () => {
    for (const t of ['a\n```ts\nx', '```\nx\n````', '````\n```\nx\n```\n````', '  ```ts\nx\n```', '```ts title\nx\n```', '~~~\nx\n```', '```a`b\nx\n```']) expect(fencesSelfContained(t), t).toBe(false)
  })
})

describe('orderPosted: reviewer render', () => {
  it('an already-ordered review returns the same string and never re-renders', () => {
    const o = obj([H1, H2, M1, M2, L1, L2])
    const plain = renderReview(o)
    let renders = 0
    const r = orderPosted(plain, o.findings, order => { renders++; return renderReview(o, { order }) })
    expect(r.text).toBe(plain)
    expect(r.order).toBeUndefined()
    expect(renders).toBe(0)
  })

  it('mixed order posts HIGH, MEDIUM, LOW, stable within a level; multi-line and fenced bodies move intact; other sections are byte-identical', () => {
    const o = obj([L1, M1, H1, L2, M2, H2], { can_be_split: ['Split me'] })
    const plain = renderReview(o)
    const r = byReviewer(o)
    expect(r.order).toEqual([2, 5, 1, 4, 0, 3])
    expect(r.text).toBe(renderReview({ ...o, findings: [H1, H2, M1, M2, L1, L2] }))
    const around = (t: string) => [t.slice(0, t.indexOf('### Findings')), t.slice(t.indexOf('### Behavioral Diff'))]
    expect(around(r.text)).toEqual(around(plain))
    expect(parseFindings(r.text)).toEqual(parseFindings(plain))
    expect(r.text.length).toBe(plain.length)
  })

  it('a fenced line shaped like a finding stays inside its body and moves with it', () => {
    const fenced = f('LOW', 'Docs drift', 'The README example is stale:\n```md\n- **HIGH – fake finding** (`x.ts:1`)\n  not a finding\n```\nUpdate it.')
    const o = obj([fenced, M2, H1])
    const r = byReviewer(o)
    expect(r.text).toBe(renderReview({ ...o, findings: [H1, M2, fenced] }))
    expect(r.text.split('fake finding')).toHaveLength(2)
    expect(r.text.indexOf('fake finding')).toBeGreaterThan(r.text.indexOf('**LOW – Docs drift**'))
    expect(r.text.endsWith('\n```\nUpdate it.\n\n### Behavioral Diff\n- x\n\n### Production Risk\n- y\n\n### Unresolved Questions\n- q?')).toBe(true)
  })

  it('a text changed by cleanup (summary, tail or a finding body) is left as is', () => {
    const footerInSummary = obj([L2, H1], { summary: 'Risky.\n---\n*Reviewed by someone*' })
    const cleaned = stripPreviousFooter(renderReview(footerInSummary))
    expect(cleaned).not.toBe(renderReview(footerInSummary))
    expect(byReviewer(footerInSummary, cleaned)).toEqual({ text: cleaned })

    const trailing = obj([L2, H1], { unresolved_questions: ['q? '] })
    const trimmed = renderReview(trailing).trimEnd()
    expect(byReviewer(trailing, trimmed)).toEqual({ text: trimmed })

    const editedBody = renderReview(obj([L2, H1])).replace('Typo body.', 'Typo body')
    expect(byReviewer(obj([L2, H1]), editedBody)).toEqual({ text: editedBody })
  })

  it('a finding body with an unclosed fence is left as is', () => {
    const open = obj([f('LOW', 'Open', 'See:\n```ts\nconst x = 1'), H1])
    expect(byReviewer(open)).toEqual({ text: renderReview(open) })
  })

  it('a summary that leaves a fence open before the findings is left as is', () => {
    const o = obj([L2, M1, H1], { summary: 'Watch this:\n```ts\nconst y = 2' })
    expect(byReviewer(o)).toEqual({ text: renderReview(o) })
  })

  it('a body whose fences renderers would pair differently is left as is', () => {
    for (const body of ['x\n```\ncode\n````\nmore', 'x\n```ts title\ncode\n```']) {
      const o = obj([f('LOW', 'Odd fence', body), H1])
      expect(byReviewer(o), body).toEqual({ text: renderReview(o) })
    }
  })

  it('a render that changes anything but the order is left as is', () => {
    const o = obj([L2, H1])
    const plain = renderReview(o)
    expect(orderPosted(plain, o.findings, order => renderReview(o, { order }).replace('q?', 'q!'))).toEqual({ text: plain })
  })

  it('an unknown label keeps its slot while the known ones are ordered around it', () => {
    const odd = { ...M2, severity: 'CRITICAL' } as unknown as ReviewFinding
    const o = obj([L1, odd, H1])
    expect(byReviewer(o).text).toBe(renderReview({ ...o, findings: [H1, odd, L1] }))
  })

  it('markdownHasFindings reads the ordered text the same', () => {
    const o = obj([L2, H1])
    expect(markdownHasFindings(byReviewer(o).text)).toBe(markdownHasFindings(renderReview(o)))
  })
})

describe('orderPosted: judged render', () => {
  const decision = (i: number, reason_category = 'validated') => ({ candidate_id: `c${i}`, reason_category: reason_category as never, evidence: 'src/a.ts:10', note: 'n', score: 8 })

  it('a judge-downgraded HIGH and a breadth-appended HIGH post in severity order; kept order and markdown are untouched', () => {
    const candidates = [f('HIGH', 'Race'), L2, M2, f('HIGH', 'Breadth crash')]
    const judged = applyJudgeDecisions(candidates, { ...OUT, decisions: [decision(0, 'unconfirmed_high'), decision(1), decision(2), decision(3)] }, DEFAULT_JUDGE_POLICY, [], '', 3)
    expect(judged.kept.map(k => `${k.severity} ${k.title}`)).toEqual(['MEDIUM Race', 'LOW Typo', 'MEDIUM Leak', 'HIGH Breadth crash'])
    const markdown = judged.markdown

    const r = orderPosted(markdown, judged.kept, order => judged.render(new Map(), order))
    const k = judged.kept
    expect(r.text).toBe(renderJudgedReview([k[3], k[0], k[2], k[1]], OUT))
    expect(judged.kept.map(x => x.title)).toEqual(['Race', 'Typo', 'Leak', 'Breadth crash'])
    expect(judged.markdown).toBe(markdown)
  })

  it('an already-ordered judged review returns the same string', () => {
    const judged = applyJudgeDecisions([H1, M2, L2], { ...OUT, decisions: [decision(0), decision(1), decision(2)] })
    expect(orderPosted(judged.markdown, judged.kept, order => judged.render(new Map(), order))).toEqual({ text: judged.markdown })
  })
})

describe('orderPosted with suggested fixes', () => {
  const kept = (severity: KeptFinding['severity'], title: string, proposal?: string): KeptFinding =>
    ({ severity, title, body: `${title} body.`, file: 'src/a.ts', lines: '10', ...(proposal ? { proposal } : {}) })
  const rows = [kept('LOW', 'Typo', 'fixTypo()'), kept('HIGH', 'Crash', 'guard()'), kept('MEDIUM', 'Leak')]
  const render = (s: ReadonlyMap<number, string>, order?: readonly number[]) => renderJudgedReview(rows, OUT, [], [], s, order)
  const plain = render(new Map())

  it('each block stays under its own finding after reordering, and the strip returns the unblocked ordered text', () => {
    const posted = orderPosted(plain, rows, order => render(new Map(), order))
    const composed = composeSuggestedFixes(rows, s => render(s, posted.order), posted.text, 32_000)
    const expected = renderJudgedReview([rows[1], rows[2], rows[0]], OUT, [], [], new Map([[0, renderFixBlock('guard()', '```')], [2, renderFixBlock('fixTypo()', '```')]]))
    expect(composed.text).toBe(expected)
    expect(composed.stats).toEqual(composeSuggestedFixes(rows, render, plain, 32_000).stats)
    expect(stripSuggestedFixes(composed.text)).toBe(posted.text)
  })

  it('the size skip still applies and posts the ordered text without blocks', () => {
    const posted = orderPosted(plain, rows, order => render(new Map(), order))
    const composed = composeSuggestedFixes(rows, s => render(s, posted.order), posted.text, posted.text.length)
    expect(composed).toEqual({ text: posted.text, stats: { rendered: 0, rejected: 0, skipped: 'size' } })
    expect(posted.text).not.toBe(plain)
  })
})
