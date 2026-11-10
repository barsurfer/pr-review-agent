import { describe, it, expect } from 'vitest'
import { buildShownSource, coversRange } from '../shown-anchors.js'
import { applyJudgeDecisions, type JudgeDecision, type JudgeOutput } from '../judge-decisions.js'
import type { ReviewFinding } from '../formatter.js'

// Lines 10-12 are context, 13 is added, 14 is context; a gap separates the second hunk (30-31).
const DIFF = [
  'diff --git a/src/pool.ts b/src/pool.ts',
  'index 1..2 100644',
  '--- a/src/pool.ts',
  '+++ b/src/pool.ts',
  '@@ -10,4 +10,5 @@',
  ' const a = 1',
  ' const b = 2',
  ' const c = 3',
  '+const added = compute(a, b, c)',
  ' const d = 4',
  '-removed line',
  '@@ -30,2 +31,2 @@',
  ' tail one',
  ' tail two',
  '',
].join('\n')

const FULL = { path: 'src/pool.ts', content: Array.from({ length: 40 }, (_, i) => `file line ${i + 1}`).join('\n') }

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({ severity: 'MEDIUM', title: 'T', file: 'src/pool.ts', lines: '11', body: 'b', ...over })
const dec = (over: Partial<JudgeDecision> = {}): JudgeDecision =>
  ({ candidate_id: 'c1', reason_category: 'validated', evidence: 'x', note: 'n', score: 8, ...over })
const out = (decisions: JudgeDecision[]): JudgeOutput =>
  ({ decisions, summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 })
const POLICY = { keepMinor: false, keepUnverified: false }

describe('buildShownSource', () => {
  it('records new-side added and context lines with their numbers, never removed lines or headers', () => {
    const src = buildShownSource(DIFF)
    const lines = src.get('src/pool.ts')!
    expect([...lines.keys()]).toEqual([10, 11, 12, 13, 14, 31, 32])
    expect(lines.get(13)).toBe('const added = compute(a, b, c)')
    expect(lines.get(14)).toBe('const d = 4')
  })

  it('adds every line of a supplied full-file context', () => {
    const lines = buildShownSource(DIFF, [FULL]).get('src/pool.ts')!
    expect(lines.size).toBe(40)
    expect(lines.get(1)).toBe('file line 1')
  })

  it('validates every line of a range, so a hunk gap or a fabricated span fails', () => {
    const src = buildShownSource(DIFF)
    expect(coversRange(src, 'src/pool.ts', '11-13')).toBe(true)
    expect(coversRange(src, 'src/pool.ts', '14-31')).toBe(false)
    expect(coversRange(src, 'src/pool.ts', '1-9000')).toBe(false)
    expect(coversRange(src, 'src/pool.ts', '20')).toBe(false)
    expect(coversRange(src, 'src/other.ts', '11')).toBe(false)
    expect(coversRange(src, 'pool.ts', '11')).toBe(true)
  })
})

describe('applyJudgeDecisions — shown-context anchors', () => {
  const breadth = finding({ lines: '11' })
  const run = (cands: ReviewFinding[], decisions: JudgeDecision[], shownAnchors?: Parameters<typeof applyJudgeDecisions>[6]) =>
    applyJudgeDecisions(cands, out(decisions), POLICY, [], DIFF, 1, shownAnchors)

  it('flag off: a breadth context-line number is still rejected to file level', () => {
    const res = run([finding({ lines: '1' }), breadth], [dec({ candidate_id: 'c0' }), dec()])
    expect(res.kept[1]).toMatchObject({ lines: undefined, anchorSource: 'none' })
    expect(res.decisions[1]).not.toHaveProperty('anchor_basis')
  })

  it('keeps a breadth anchor on a context line its own pass was shown, and labels the basis', () => {
    const shown = { judge: buildShownSource(DIFF), breadth: buildShownSource(DIFF), secondLookFrom: 99 }
    const res = run([finding({ lines: '1' }), breadth], [dec({ candidate_id: 'c0' }), dec()], { shownAnchors: shown })
    expect(res.kept[1]).toMatchObject({ file: 'src/pool.ts', lines: '11', anchorSource: 'reviewer' })
    expect(res.decisions[1].anchor_basis).toBe('shown_context')
  })

  it('rejects the same number on an unseen line, and a second-look pass cannot borrow breadth-only context', () => {
    const shown = { judge: buildShownSource(DIFF), breadth: buildShownSource(DIFF, [FULL]), secondLook: buildShownSource(DIFF), secondLookFrom: 2 }
    const unseen = run([finding({ lines: '1' }), finding({ lines: '45' })], [dec({ candidate_id: 'c0' }), dec()], { shownAnchors: shown })
    expect(unseen.kept[1]).toMatchObject({ lines: undefined, anchorSource: 'none' })
    expect(unseen.decisions[1].anchor_basis).toBe('fallback')

    const borrowed = applyJudgeDecisions([finding({ lines: '1' }), finding({ lines: '1' }), finding({ lines: '45' })],
      out([dec({ candidate_id: 'c0' }), dec({ candidate_id: 'c1' }), dec({ candidate_id: 'c2' })]), POLICY, [], DIFF, 1, { shownAnchors: shown })
    expect(borrowed.kept[1].lines).toBe('1')   // breadth context file line 1 is real for breadth
    expect(borrowed.kept[2]).toMatchObject({ lines: undefined, anchorSource: 'none' })   // second-look never saw line 20
  })

  it('accepts a judge replacement numeric anchor only on lines the judge was shown', () => {
    const shown = { judge: buildShownSource(DIFF) }
    const noNumber = finding({ lines: 'compute()' })
    const ok = run([finding({ lines: '1' }), noNumber], [dec({ candidate_id: 'c0' }), dec({ anchor_file: 'src/pool.ts', anchor_lines: '12' })], { shownAnchors: shown })
    expect(ok.kept[1]).toMatchObject({ lines: '12', anchorSource: 'judge' })
    const bad = run([finding({ lines: '1' }), noNumber], [dec({ candidate_id: 'c0' }), dec({ anchor_file: 'src/pool.ts', anchor_lines: '20' })], { shownAnchors: shown })
    expect(bad.kept[1]).toMatchObject({ lines: undefined, anchorSource: 'none' })
    const gap = run([finding({ lines: '1' }), noNumber], [dec({ candidate_id: 'c0' }), dec({ anchor_file: 'src/pool.ts', anchor_lines: '14-31' })], { shownAnchors: shown })
    expect(gap.kept[1].anchorSource).toBe('none')
  })

  it('recovers a wrong number through a unique verbatim quote of a shown context line, but not a short or ambiguous one', () => {
    const shown = { judge: buildShownSource(DIFF, [FULL]) }
    const noNumber = finding({ lines: 'n/a' })
    const uniq = run([finding({ lines: '1' }), noNumber], [dec({ candidate_id: 'c0' }), dec({ anchor_lines: '9999', anchor_quote: 'file line 15', anchor_file: 'src/pool.ts' })], { shownAnchors: shown })
    expect(uniq.kept[1]).toMatchObject({ lines: '15', anchorSource: 'diff' })
    expect(uniq.decisions[1].anchor_basis).toBe('shown_context')
    const short = run([finding({ lines: '1' }), noNumber], [dec({ candidate_id: 'c0' }), dec({ anchor_quote: 'line 15', anchor_file: 'src/pool.ts' })], { shownAnchors: shown })
    expect(short.kept[1].anchorSource).toBe('none')
    const twice = { judge: buildShownSource(DIFF, [{ path: 'src/pool.ts', content: ['same long line here', 'same long line here'].join('\n') }]) }
    const ambiguous = run([finding({ lines: '1' }), noNumber], [dec({ candidate_id: 'c0' }), dec({ anchor_quote: 'same long line here', anchor_file: 'src/pool.ts' })], { shownAnchors: twice })
    expect(ambiguous.kept[1].anchorSource).toBe('none')
  })

  it('reviewer-origin numeric anchors keep legacy ungated behavior either way', () => {
    const shown = { judge: buildShownSource(DIFF) }
    const res = run([finding({ lines: '500' })], [dec({ candidate_id: 'c0' })], { shownAnchors: shown })
    expect(res.kept[0]).toMatchObject({ lines: '500', anchorSource: 'reviewer' })
  })
})
