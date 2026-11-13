import { describe, it, expect } from 'vitest'
import {
  REASON_CATEGORIES, REWRITE_CAP, PROPOSAL_CAP, DEFAULT_JUDGE_POLICY, applyJudgeDecisions, isTestGap, policyAction, renderCandidatesForJudge, renderJudgedReview, locateInDiff,
  type JudgeDecision, type JudgeOutput, type ReasonCategory,
} from '../judge-decisions.js'
import { isAnchored, parseLineRange } from '../findings-output.js'
import type { ReviewFinding } from '../formatter.js'
import { parseFindings, parseVerdictScore } from '../parsers.js'
import { parseReviewMarkdown } from '../aggregate.js'

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({ severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put race.', ...over })

const decision = (over: Partial<JudgeDecision> = {}): JudgeDecision =>
  ({ candidate_id: 'c0', reason_category: 'validated', evidence: 'src/pool.ts:2', note: 'n', score: 8, ...over })

const output = (decisions: JudgeDecision[], over: Partial<JudgeOutput> = {}): JudgeOutput =>
  ({ decisions, summary: 'Adds a pool.', behavioral_diff: ['Pool added.'], production_risk: [], unresolved_questions: [], merge_confidence: 72, ...over })

const ON = { keepMinor: true, keepUnverified: true }

describe('policyAction — the policy table', () => {
  // Defaults must reproduce the pre-contract judge: only these categories ever reach the PR.
  const DEFAULTS: Record<ReasonCategory, string> = {
    validated: 'keep MEDIUM',
    unconfirmed_high: 'keep MEDIUM',
    chained_hypothetical: 'downgrade LOW',
    incorrect: 'drop',
    already_handled: 'drop',
    unverifiable: 'drop',
    style_only: 'drop',
    low_value: 'drop',
    minor: 'drop',
    duplicate: 'drop',
    out_of_scope: 'drop',
    framework_uncertainty: 'move_to_unresolved',
  }

  it('covers every reason category', () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual([...REASON_CATEGORIES].sort())
  })

  it.each(Object.entries(DEFAULTS))('default policy: %s → %s', (reason, expected) => {
    const { action, severity } = policyAction(reason as ReasonCategory, 'MEDIUM', DEFAULT_JUDGE_POLICY)
    expect(severity ? `${action} ${severity}` : action).toBe(expected)
  })

  it('downgrades only when the category caps below the candidate severity', () => {
    expect(policyAction('unconfirmed_high', 'HIGH', DEFAULT_JUDGE_POLICY)).toEqual({ action: 'downgrade', severity: 'MEDIUM' })
    expect(policyAction('chained_hypothetical', 'LOW', DEFAULT_JUDGE_POLICY)).toEqual({ action: 'keep', severity: 'LOW' })
  })

  it('keepMinor keeps minor as LOW and changes nothing else', () => {
    const policy = { keepMinor: true, keepUnverified: false }
    expect(policyAction('minor', 'HIGH', policy)).toEqual({ action: 'downgrade', severity: 'LOW' })
    expect(policyAction('unverifiable', 'MEDIUM', policy).action).toBe('drop')
    expect(policyAction('framework_uncertainty', 'MEDIUM', policy).action).toBe('move_to_unresolved')
  })

  it('keepUnverified keeps unverifiable and framework_uncertainty at their severity and changes nothing else', () => {
    const policy = { keepMinor: false, keepUnverified: true }
    expect(policyAction('unverifiable', 'HIGH', policy)).toEqual({ action: 'keep', severity: 'HIGH' })
    expect(policyAction('framework_uncertainty', 'MEDIUM', policy)).toEqual({ action: 'keep', severity: 'MEDIUM' })
    expect(policyAction('minor', 'MEDIUM', policy).action).toBe('drop')
  })

  it.each(['incorrect', 'already_handled', 'style_only', 'low_value', 'duplicate', 'out_of_scope'] as ReasonCategory[])(
    '%s drops under every flag combination', reason => {
      expect(policyAction(reason, 'HIGH', ON).action).toBe('drop')
    })
})

describe('applyJudgeDecisions', () => {
  it('keeps a validated candidate with the reviewer anchor and the judge score', () => {
    const r = applyJudgeDecisions([finding()], output([decision()]))
    expect(r.kept).toEqual([{ severity: 'MEDIUM', title: 'Race on conns', body: 'get/put race.', file: 'src/pool.ts', lines: '2-3', score: 8, anchorSource: 'reviewer' }])
    expect(r.scores).toEqual([{ title: 'Race on conns', severity: 'MEDIUM', score: 8, file: 'src/pool.ts', lines: '2-3' }])
  })

  it('marks a locationless kept candidate as unanchored', () => {
    const r = applyJudgeDecisions([finding({ file: undefined, lines: undefined })], output([decision()]))
    expect(r.kept[0].anchorSource).toBe('none')
  })

  it.each(['incorrect', 'already_handled'] as const)('reclassifies a %s drop with no evidence as unverifiable and counts it', reason => {
    const r = applyJudgeDecisions([finding()], output([decision({ reason_category: reason, evidence: '  ' })]))
    expect(r.decisions[0]).toMatchObject({ reason_category: 'unverifiable', reclassified_from: reason, action: 'drop' })
    expect(r.anomalies.drop_without_evidence).toBe(1)

    const kept = applyJudgeDecisions([finding()], output([decision({ reason_category: reason, evidence: '', score: 9 })]), ON)
    expect(kept.decisions[0]).toMatchObject({ action: 'keep', score: 5 })
  })

  it('leaves an evidenced incorrect drop alone', () => {
    const r = applyJudgeDecisions([finding()], output([decision({ reason_category: 'incorrect', evidence: 'src/pool.ts:4 guard' })]))
    expect(r.decisions[0]).toMatchObject({ reason_category: 'incorrect', reclassified_from: null, action: 'drop' })
    expect(r.anomalies.drop_without_evidence).toBe(0)
  })

  it('caps the score of an unproven candidate kept by policy', () => {
    const r = applyJudgeDecisions([finding()], output([decision({ reason_category: 'unverifiable', score: 9 })]), ON)
    expect(r.kept[0].score).toBe(5)
  })

  it('ignores unknown ids, accepts a bracketed id, and drops undecided candidates', () => {
    const r = applyJudgeDecisions([finding(), finding({ title: 'Other' })], output([decision({ candidate_id: '[C0]' }), decision({ candidate_id: 'c9' })]))
    expect(r.anomalies).toEqual({ unknown_ids: 1, undecided: 1, duplicate_ids: 0, drop_without_evidence: 0 })
    expect(r.kept.map(k => k.title)).toEqual(['Race on conns'])
    expect(r.decisions[1]).toMatchObject({ candidate_id: 'c1', reason_category: null, action: 'drop', score: null })
  })

  it('resolves duplicate decisions for one id to the dropping one', () => {
    const r = applyJudgeDecisions([finding()], output([decision(), decision({ reason_category: 'style_only' })]))
    expect(r.anomalies.duplicate_ids).toBe(1)
    expect(r.decisions[0].action).toBe('drop')
    expect(r.kept).toEqual([])
  })

  it('treats a category outside the enum as unverifiable', () => {
    const r = applyJudgeDecisions([finding()], output([decision({ reason_category: 'keep_it' as ReasonCategory })]))
    expect(r.decisions[0]).toMatchObject({ reason_category: 'unverifiable', action: 'drop' })
  })

  it('uses a capped rewrite and falls back to the reviewer body over the cap', () => {
    const short = applyJudgeDecisions([finding()], output([decision({ rewritten_body: 'Terse.' })]))
    expect(short.kept[0].body).toBe('Terse.')
    expect(short.decisions[0].rewritten).toBe(true)

    const long = applyJudgeDecisions([finding()], output([decision({ rewritten_body: 'x'.repeat(REWRITE_CAP + 1) })]))
    expect(long.kept[0].body).toBe('get/put race.')
    expect(long.decisions[0].rewritten).toBe(false)
  })

  it('moves framework_uncertainty to Unresolved Questions by default, without duplicating an existing question', () => {
    const r = applyJudgeDecisions(
      [finding(), finding({ title: 'Lib retries?' })],
      output([decision({ reason_category: 'framework_uncertainty', question: 'Does the driver retry?' }), decision({ candidate_id: 'c1', reason_category: 'framework_uncertainty' })],
        { unresolved_questions: ['Does the driver retry?'] }),
    )
    expect(r.kept).toEqual([])
    expect(parseReviewMarkdown(r.markdown).questions).toEqual(['Does the driver retry?', 'Lib retries?'])
  })
})

describe('anchors: reviewer first when strictly numeric, else the judge pair', () => {
  const bare = (over: Partial<ReviewFinding> = {}) => finding({ file: undefined, lines: undefined, ...over })
  // The judge anchor is validated against the diff, so these cases supply one whose added lines (1–40 of src/pool.ts) cover the anchors below.
  const POOL_DIFF = [
    'diff --git a/src/pool.ts b/src/pool.ts',
    '--- a/src/pool.ts',
    '+++ b/src/pool.ts',
    '@@ -0,0 +1,40 @@',
    ...Array.from({ length: 40 }, (_, i) => `+  const line${i + 1} = ${i + 1}`),
  ].join('\n')

  it('anchors a locationless candidate from the judge pair, in the finding, the score and the rendered review', () => {
    const r = applyJudgeDecisions([bare()], output([decision({ anchor_file: '`src/pool.ts`', anchor_lines: '10-12' })]), DEFAULT_JUDGE_POLICY, [], POOL_DIFF)
    expect(r.kept[0]).toMatchObject({ file: 'src/pool.ts', lines: '10-12', anchorSource: 'judge' })
    expect(r.decisions[0].anchor_source).toBe('judge')
    expect(r.scores[0]).toMatchObject({ file: 'src/pool.ts', lines: '10-12' })
    expect(parseReviewMarkdown(r.markdown).findings[0]).toMatchObject({ file: 'src/pool.ts', lines: '10-12' })
  })

  it('takes the file from the candidate when the judge supplies only lines', () => {
    const r = applyJudgeDecisions([finding({ lines: 'ExchangeCode' })], output([decision({ anchor_lines: '7' })]), DEFAULT_JUDGE_POLICY, [], POOL_DIFF)
    expect(r.kept[0]).toMatchObject({ file: 'src/pool.ts', lines: '7', anchorSource: 'judge' })
  })

  it.each(['_F2C_RETURN_TYPES / _PTR_ARG', 'Phase 4 idiomisation block', 'ExchangeCode: if sess.CodeChallenge != "" {', 'validate2()'])(
    'a symbol-only reviewer location (%s) is not an anchor, even when it contains digits', symbol => {
      const unanchored = applyJudgeDecisions([finding({ lines: symbol })], output([decision()]), DEFAULT_JUDGE_POLICY, [], POOL_DIFF)
      expect(unanchored.kept[0].anchorSource).toBe('none')

      const rescued = applyJudgeDecisions([finding({ lines: symbol })], output([decision({ anchor_file: 'src/pool.ts', anchor_lines: '31' })]), DEFAULT_JUDGE_POLICY, [], POOL_DIFF)
      expect(rescued.kept[0]).toMatchObject({ file: 'src/pool.ts', lines: '31', anchorSource: 'judge' })
    })

  it.each(['42', '26-31', 'L10-L12', '4, 9', '12 – 14'])('keeps a numeric reviewer location (%s) over the judge pair', lines => {
    const r = applyJudgeDecisions([finding({ lines })], output([decision({ anchor_file: 'other.ts', anchor_lines: '99' })]))
    expect(r.kept[0]).toMatchObject({ file: 'src/pool.ts', lines, anchorSource: 'reviewer' })
  })

  it('stays unanchored when the judge pair is not numeric either, and logs it per decision', () => {
    const r = applyJudgeDecisions([bare()], output([decision({ anchor_file: 'src/pool.ts', anchor_lines: 'Pool.get' })]))
    expect(r.kept[0].anchorSource).toBe('none')
    expect(r.decisions[0].anchor_source).toBe('none')
  })

  it('records the resolved anchor on dropped/moved decisions so an offline re-score can place them', () => {
    const r = applyJudgeDecisions(
      [finding({ lines: '42' }), finding({ title: 'Lib?', lines: '7' })],
      output([decision({ reason_category: 'style_only' }), decision({ candidate_id: 'c1', reason_category: 'framework_uncertainty' })]),
    )
    expect(r.decisions[0]).toMatchObject({ action: 'drop', anchor_source: 'reviewer', anchor_file: 'src/pool.ts', anchor_lines: '42' })
    expect(r.decisions[1]).toMatchObject({ action: 'move_to_unresolved', anchor_source: 'reviewer', anchor_lines: '7' })
  })

  it('leaves the anchor null for an undecided candidate (no judge ruling)', () => {
    const r = applyJudgeDecisions([finding({ lines: '42' })], output([]))
    expect(r.decisions[0]).toMatchObject({ action: 'drop', reason_category: null, anchor_source: null, anchor_file: null, anchor_lines: null })
  })
})

describe('locateInDiff — deterministic anchor resolver (correct line or null, never a wrong line)', () => {
  // pool.ts added lines: 2 `conns: Conn[] = []`, 3 `get() { return this.conns.pop() }`, 4 `put(c: Conn) { this.conns.push(c) }`; context 1, 5.
  // cache.ts added lines: 11 `conns: Conn[] = []` (same text as pool.ts:2 — ambiguous), 12 `function store(k) { cache[k] = 1 }` (unique).
  const DIFF = [
    'diff --git a/src/pool.ts b/src/pool.ts',
    '--- a/src/pool.ts',
    '+++ b/src/pool.ts',
    '@@ -1,3 +1,6 @@',
    ' export class Pool {',
    '+  conns: Conn[] = []',
    '+  get() { return this.conns.pop() }',
    '+  put(c: Conn) { this.conns.push(c) }',
    ' }',
    'diff --git a/src/cache.ts b/src/cache.ts',
    '--- a/src/cache.ts',
    '+++ b/src/cache.ts',
    '@@ -10,2 +10,4 @@',
    ' const cache = {}',
    '+  conns: Conn[] = []',
    '+  function store(k) { cache[k] = 1 }',
    ' export {}',
  ].join('\n')

  const bare = (over: Partial<ReviewFinding> = {}) => finding({ file: undefined, lines: undefined, ...over })
  // No path:line prefix in evidence — otherwise the file source resolves and scopes the quote search.
  const quoteOnly = (over: Partial<JudgeDecision> = {}) => decision({ evidence: '', ...over })

  it('matches a quote copied with the numbered gutter or the `+` marker', () => {
    for (const anchor_quote of ['   12 +  function store(k) { cache[k] = 1 }', '+  function store(k) { cache[k] = 1 }']) {
      expect(locateInDiff(bare(), quoteOnly({ anchor_quote }), DIFF)).toEqual({ file: 'src/cache.ts', lines: '12', source: 'diff' })
    }
  })

  it('keeps a judge-named changed file when its line is rejected, so file-level placement can still use it', () => {
    expect(locateInDiff(bare(), quoteOnly({ anchor_file: 'src/pool.ts', anchor_lines: '5' }), DIFF)).toEqual({ file: 'src/pool.ts', lines: undefined, source: 'none' })
    expect(locateInDiff(bare(), quoteOnly({ anchor_file: 'src/nope.ts', anchor_lines: '5' }), DIFF)).toEqual({ file: undefined, lines: undefined, source: 'none' })
  })

  it('step 1: passes a numeric reviewer anchor through ungated, even for a line not in the diff', () => {
    expect(locateInDiff(finding({ lines: '99' }), decision(), DIFF)).toEqual({ file: 'src/pool.ts', lines: '99', source: 'reviewer' })
  })

  it('step 1 no-regression: a numeric reviewer anchor on an unchanged context line still resolves', () => {
    expect(locateInDiff(finding({ lines: '5' }), decision(), DIFF)).toEqual({ file: 'src/pool.ts', lines: '5', source: 'reviewer' })
  })

  it('step 2: accepts a judge numeric anchor on a changed (added) line', () => {
    expect(locateInDiff(bare(), decision({ anchor_file: 'src/pool.ts', anchor_lines: '3' }), DIFF))
      .toEqual({ file: 'src/pool.ts', lines: '3', source: 'judge' })
  })

  it('step 2: rejects a judge numeric anchor on a context line or an out-of-diff file (falls through to none)', () => {
    expect(locateInDiff(bare(), quoteOnly({ anchor_file: 'src/pool.ts', anchor_lines: '5' }), DIFF).source).toBe('none')
    expect(locateInDiff(bare(), quoteOnly({ anchor_file: 'nope.ts', anchor_lines: '3' }), DIFF).source).toBe('none')
  })

  it('step 3: locates a verbatim quote to its changed line, scoped to the resolved file', () => {
    expect(locateInDiff(bare({ file: 'src/pool.ts' }), quoteOnly({ anchor_quote: 'get() { return this.conns.pop() }' }), DIFF))
      .toEqual({ file: 'src/pool.ts', lines: '3', source: 'diff' })
    // The reviewer file scopes the search, so the quote that is ambiguous across files anchors uniquely within it.
    expect(locateInDiff(bare({ file: 'src/pool.ts' }), quoteOnly({ anchor_quote: 'conns: Conn[] = []' }), DIFF))
      .toEqual({ file: 'src/pool.ts', lines: '2', source: 'diff' })
  })

  it('step 3: a short quote is never guessed', () => {
    expect(locateInDiff(bare(), quoteOnly({ anchor_quote: 'pop()' }), DIFF).source).toBe('none')
  })

  it('step 3: a quote ambiguous across files resolves to none; a unique cross-file quote anchors', () => {
    expect(locateInDiff(bare(), quoteOnly({ anchor_quote: 'conns: Conn[] = []' }), DIFF).source).toBe('none')
    expect(locateInDiff(bare(), quoteOnly({ anchor_quote: 'function store(k) { cache[k] = 1 }' }), DIFF))
      .toEqual({ file: 'src/cache.ts', lines: '12', source: 'diff' })
  })

  it('a judge numeric anchor is accepted only when a present diff validates it against a changed line, else none', () => {
    expect(locateInDiff(bare(), decision({ anchor_file: 'src/pool.ts', anchor_lines: '3' }), DIFF).source).toBe('judge')
    // No diff to validate against → a model-typed line is not trusted (it would otherwise post a ghost anchor).
    expect(locateInDiff(bare(), decision({ anchor_file: 'src/pool.ts', anchor_lines: '3' }), '').source).toBe('none')
  })
})

describe('breadth-origin candidates: numeric anchors honored only on changed lines', () => {
  const DIFF = [
    'diff --git a/src/pool.ts b/src/pool.ts',
    '--- a/src/pool.ts',
    '+++ b/src/pool.ts',
    '@@ -1,3 +1,6 @@',
    ' export class Pool {',
    '+  conns: Conn[] = []',
    '+  get() { return this.conns.pop() }',
    '+  put(c: Conn) { this.conns.push(c) }',
    ' }',
  ].join('\n')
  const applyAt = (lines: string, d: JudgeDecision, breadthFrom?: number, diff = DIFF) =>
    applyJudgeDecisions([finding({ lines })], output([d]), DEFAULT_JUDGE_POLICY, [], diff, breadthFrom)

  it('keeps the numeric anchor of a breadth candidate on an added line', () => {
    const r = applyAt('3', decision(), 0)
    expect(r.kept[0]).toMatchObject({ file: 'src/pool.ts', lines: '3', anchorSource: 'reviewer' })
    expect(r.decisions[0]).toMatchObject({ anchor_source: 'reviewer', anchor_lines: '3' })
  })

  it.each([['a context line', '5'], ['a line outside the diff', '99']])('drops the numeric anchor of a breadth candidate on %s, keeping the file', (_name, lines) => {
    const r = applyAt(lines, decision(), 0)
    expect(r.kept[0]).toMatchObject({ file: 'src/pool.ts', lines: undefined, anchorSource: 'none' })
    expect(r.decisions[0]).toMatchObject({ anchor_source: 'none', anchor_file: 'src/pool.ts', anchor_lines: null })
  })

  it('falls through to the judge anchor, then the verbatim quote, when the breadth line is off the diff', () => {
    expect(applyAt('99', decision({ anchor_file: 'src/pool.ts', anchor_lines: '4' }), 0).kept[0])
      .toMatchObject({ file: 'src/pool.ts', lines: '4', anchorSource: 'judge' })
    expect(applyAt('99', decision({ evidence: '', anchor_quote: 'get() { return this.conns.pop() }' }), 0).kept[0])
      .toMatchObject({ file: 'src/pool.ts', lines: '3', anchorSource: 'diff' })
  })

  it('does not trust a breadth line when there is no diff to validate it against', () => {
    expect(applyAt('3', decision(), 0, '').kept[0]).toMatchObject({ lines: undefined, anchorSource: 'none' })
  })

  it.each([['a context line', '5'], ['a line outside the diff', '99']])('leaves the same %s ungated for a reviewer candidate', (_name, lines) => {
    expect(applyAt(lines, decision()).kept[0]).toMatchObject({ file: 'src/pool.ts', lines, anchorSource: 'reviewer' })
    expect(applyAt(lines, decision(), 1).kept[0]).toMatchObject({ file: 'src/pool.ts', lines, anchorSource: 'reviewer' })
  })

  it('gates only the candidates from breadthFrom on', () => {
    const r = applyJudgeDecisions(
      [finding({ lines: '99' }), finding({ title: 'Breadth', lines: '99' })],
      output([decision(), decision({ candidate_id: 'c1' })]), DEFAULT_JUDGE_POLICY, [], DIFF, 1,
    )
    expect(r.kept.map(k => [k.lines, k.anchorSource])).toEqual([['99', 'reviewer'], [undefined, 'none']])
  })
})

describe('reviewer issue-type carry-through', () => {
  it('carries the reviewer type onto the kept finding and leaves it undefined when omitted', () => {
    expect(applyJudgeDecisions([finding({ type: 'performance' })], output([decision()])).kept[0].type).toBe('performance')
    expect(applyJudgeDecisions([finding()], output([decision()])).kept[0].type).toBeUndefined()
  })
})

describe('applyJudgeDecisions edge rules', () => {
  it('drops on a duplicate decision regardless of order, and keeps first-wins among non-drops', () => {
    const dropFirst = applyJudgeDecisions([finding()], output([decision({ reason_category: 'style_only' }), decision()]))
    expect(dropFirst.kept).toEqual([])
    expect(dropFirst.anomalies.duplicate_ids).toBe(1)

    const keepFirst = applyJudgeDecisions([finding()], output([decision(), decision({ reason_category: 'framework_uncertainty', question: 'Q?' })]))
    expect(keepFirst.kept).toHaveLength(1)
    expect(parseReviewMarkdown(keepFirst.markdown).questions).toEqual([])
  })

  it('borrows a capped rewrite when the reviewer body is empty, but an over-cap rewrite falls back to the (empty) reviewer body', () => {
    const borrowed = applyJudgeDecisions([finding({ body: '' })], output([decision({ rewritten_body: 'Race between get and put.' })]))
    expect(borrowed.kept[0].body).toBe('Race between get and put.')

    const over = applyJudgeDecisions([finding({ body: '' })], output([decision({ rewritten_body: 'x'.repeat(REWRITE_CAP + 1) })]))
    expect(over.kept[0].body).toBe('')
    expect(over.decisions[0].rewritten).toBe(false)
  })

  it('does not throw on a non-string question from a provider that ignores the schema', () => {
    const bad = decision({ reason_category: 'framework_uncertainty', question: 42 as unknown as string })
    expect(() => applyJudgeDecisions([finding()], output([bad]))).not.toThrow()
  })

  it('carries the reviewer can_be_split section into the rendered review without disturbing the verdict line', () => {
    const r = applyJudgeDecisions([finding()], output([decision()]), DEFAULT_JUDGE_POLICY, ['Auth rework', 'Billing rework'])
    expect(r.markdown).toContain('### Unresolved Questions\nNone.\n\n### Can Be Split\n- Auth rework\n- Billing rework\n\n### Merge Confidence: 72%')
    expect(parseVerdictScore(r.markdown)).toBe(72)
    expect(applyJudgeDecisions([finding()], output([decision()])).markdown).not.toContain('Can Be Split')
  })
})

describe('rendered judged review', () => {
  it('stays parseable by the downstream markdown readers', () => {
    const r = applyJudgeDecisions(
      [finding({ severity: 'HIGH' }), finding({ title: 'Dropped one', lines: '9' })],
      output([decision({ reason_category: 'unconfirmed_high' }), decision({ candidate_id: 'c1', reason_category: 'style_only' })]),
    )
    expect(parseVerdictScore(r.markdown)).toBe(72)
    expect(parseFindings(r.markdown)).toEqual({ high: 0, medium: 1, low: 0 })
    expect(parseReviewMarkdown(r.markdown).findings).toEqual([{ severity: 'MEDIUM', title: 'Race on conns', file: 'src/pool.ts', lines: '2-3', body: 'get/put race.' }])
    expect(r.markdown).not.toContain('Dropped one')
    expect(r.markdown.startsWith('### Summary\nAdds a pool.')).toBe(true)
  })

  it('says "No actionable findings." when nothing survives, and clamps merge confidence', () => {
    const r = applyJudgeDecisions([finding()], output([decision({ reason_category: 'low_value' })], { merge_confidence: 140 }))
    expect(r.markdown).toContain('### Findings\nNo actionable findings.')
    expect(r.markdown).toContain('### Merge Confidence: 100%')
  })

  it('tags judge input with candidate ids', () => {
    const md = renderCandidatesForJudge({ summary: 's', findings: [finding(), finding({ title: 'B', file: undefined, lines: undefined })], behavioral_diff: [], production_risk: [], unresolved_questions: [] })
    expect(md).toContain('- [c0] **MEDIUM – Race on conns** (`src/pool.ts:2-3`)')
    expect(md).toContain('- [c1] **MEDIUM – B**\n')
  })
})

describe('keepTestGaps: a low_value test gap with a numeric line is kept as LOW', () => {
  const POOL_DIFF = [
    'diff --git a/src/pool.ts b/src/pool.ts',
    '--- a/src/pool.ts',
    '+++ b/src/pool.ts',
    '@@ -0,0 +1,40 @@',
    ...Array.from({ length: 40 }, (_, i) => `+  const line${i + 1} = ${i + 1}`),
  ].join('\n')
  const TGAP = { keepMinor: false, keepUnverified: false, keepTestGaps: true }
  const gap = (over: Partial<ReviewFinding> = {}) =>
    finding({ severity: 'LOW', title: 'Null getFileStats branch has no test', lines: '12', body: 'Add a test for the null branch.', ...over })
  const lowValue = (over: Partial<JudgeDecision> = {}) => decision({ reason_category: 'low_value', evidence: '', note: 'Asks for an added test.', score: 4, ...over })
  const apply = (cands: ReviewFinding[], decisions: JudgeDecision[], policy: typeof DEFAULT_JUDGE_POLICY = TGAP, breadthFrom = Infinity, options?: Parameters<typeof applyJudgeDecisions>[6]) =>
    applyJudgeDecisions(cands, output(decisions), policy, [], POOL_DIFF, breadthFrom, options)
  const DROPPED_GAP = {
    candidate_id: 'c0', reason_category: 'low_value', reclassified_from: null, action: 'drop', original_severity: 'LOW', final_severity: null, score: 4,
    evidence: '', note: 'Asks for an added test.', rewritten: false, anchor_source: 'reviewer', anchor_file: 'src/pool.ts', anchor_lines: '12',
  }

  it('off (absent or false): drops the test gap and the decision deep-equals the pre-flag shape', () => {
    for (const policy of [DEFAULT_JUDGE_POLICY, { ...DEFAULT_JUDGE_POLICY, keepTestGaps: false }]) {
      const r = apply([gap()], [lowValue()], policy)
      expect(r.kept).toEqual([])
      expect(r.decisions[0]).toStrictEqual(DROPPED_GAP)
    }
  })

  it('flag-off pin: a serialized mixed decision set matches the pre-flag output byte for byte', () => {
    const PIN = '[{"candidate_id":"c0","reason_category":"validated","reclassified_from":null,"action":"keep","original_severity":"MEDIUM","final_severity":"MEDIUM","score":8,"evidence":"src/pool.ts:2","note":"n","rewritten":false,"anchor_source":"reviewer","anchor_file":"src/pool.ts","anchor_lines":"2-3"},{"candidate_id":"c1","reason_category":"low_value","reclassified_from":null,"action":"drop","original_severity":"MEDIUM","final_severity":null,"score":4,"evidence":"","note":"Asks for an added test.","rewritten":false,"anchor_source":"reviewer","anchor_file":"src/pool.ts","anchor_lines":"12"},{"candidate_id":"c2","reason_category":"low_value","reclassified_from":null,"action":"drop","original_severity":"LOW","final_severity":null,"score":2,"evidence":"","note":"Preference.","rewritten":false,"anchor_source":"reviewer","anchor_file":"src/pool.ts","anchor_lines":"20"},{"candidate_id":"c3","reason_category":"duplicate","reclassified_from":null,"action":"drop","original_severity":"LOW","final_severity":null,"score":3,"evidence":"src/pool.ts:12","note":"Same as c1.","rewritten":false,"anchor_source":"reviewer","anchor_file":"src/pool.ts","anchor_lines":"30"},{"candidate_id":"c4","reason_category":"low_value","reclassified_from":null,"action":"drop","original_severity":"HIGH","final_severity":null,"score":5,"evidence":"","note":"Asks for tests.","rewritten":false,"anchor_source":"none","anchor_file":null,"anchor_lines":null}]'
    const cands = [
      finding(),
      gap({ severity: 'MEDIUM' }),
      gap({ title: 'Hardcoded colors bypass the palette tokens', lines: '20', body: 'Use the palette tokens.' }),
      gap({ title: 'Pagination test never exercises has_more=true', lines: '30', body: 'Same gap as c1.' }),
      gap({ severity: 'HIGH', title: 'New PlatformNotSupported branch and once-only guard have no tests', file: undefined, lines: undefined, body: 'No test covers the guard.' }),
    ]
    const decisions = [
      decision(),
      lowValue({ candidate_id: 'c1' }),
      lowValue({ candidate_id: 'c2', note: 'Preference.', score: 2 }),
      decision({ candidate_id: 'c3', reason_category: 'duplicate', evidence: 'src/pool.ts:12', note: 'Same as c1.', score: 3 }),
      lowValue({ candidate_id: 'c4', note: 'Asks for tests.', score: 5 }),
    ]
    const absent = apply(cands, decisions, DEFAULT_JUDGE_POLICY)
    const off = apply(cands, decisions, { ...DEFAULT_JUDGE_POLICY, keepTestGaps: false })
    expect(JSON.stringify(absent.decisions)).toBe(PIN)
    expect(JSON.stringify(off.decisions)).toBe(PIN)
    expect(JSON.stringify([off.kept, off.scores, off.anomalies, off.markdown])).toBe(JSON.stringify([absent.kept, absent.scores, absent.anomalies, absent.markdown]))
    expect(absent.kept.map(k => k.title)).toEqual(['Race on conns'])
  })

  it('on: keeps the test gap as LOW with policy_override, in kept, scores and the rendered review', () => {
    const r = apply([finding(), gap()], [decision(), lowValue({ candidate_id: 'c1' })])
    expect(r.decisions[1]).toStrictEqual({ ...DROPPED_GAP, candidate_id: 'c1', action: 'keep', final_severity: 'LOW', policy_override: 'test_gap' })
    expect('policy_override' in r.decisions[0]).toBe(false)
    expect(r.kept[1]).toEqual({ severity: 'LOW', title: 'Null getFileStats branch has no test', body: 'Add a test for the null branch.', file: 'src/pool.ts', lines: '12', score: 4, anchorSource: 'reviewer' })
    expect(r.scores[1]).toEqual({ title: 'Null getFileStats branch has no test', severity: 'LOW', score: 4, file: 'src/pool.ts', lines: '12' })
    expect(parseFindings(r.markdown)).toEqual({ high: 0, medium: 1, low: 1 })
    expect(parseReviewMarkdown(r.markdown).findings[1]).toEqual({ severity: 'LOW', title: 'Null getFileStats branch has no test', file: 'src/pool.ts', lines: '12', body: 'Add a test for the null branch.' })
  })

  it.each(['HIGH', 'MEDIUM'] as const)('on: a %s test gap is downgraded to LOW', severity => {
    const r = apply([gap({ severity })], [lowValue()])
    expect(r.decisions[0]).toMatchObject({ reason_category: 'low_value', action: 'downgrade', original_severity: severity, final_severity: 'LOW', policy_override: 'test_gap' })
    expect(r.kept[0].severity).toBe('LOW')
  })

  it('on: a judge anchor or a verbatim quote on a changed line makes the gap placeable', () => {
    expect(apply([gap({ lines: 'getFileStats' })], [lowValue({ anchor_file: 'src/pool.ts', anchor_lines: '7' })]).decisions[0])
      .toMatchObject({ action: 'keep', anchor_source: 'judge', anchor_lines: '7', policy_override: 'test_gap' })
    expect(apply([gap({ lines: undefined })], [lowValue({ anchor_quote: 'const line9 = 9' })]).decisions[0])
      .toMatchObject({ action: 'keep', anchor_source: 'diff', anchor_lines: '9', policy_override: 'test_gap' })
  })

  it.each([
    ['a symbol-only reviewer location', { lines: 'getFileStats' }, Infinity],
    ['no file and no line', { file: undefined, lines: undefined }, Infinity],
    ['a numeric line but no file', { file: undefined, lines: '12' }, Infinity],
    ['a breadth line off the diff', { lines: '99' }, 0],
  ] as const)('on: drops a test gap with %s', (_name, over, breadthFrom) => {
    const r = apply([gap(over)], [lowValue()], TGAP, breadthFrom)
    expect(r.kept).toEqual([])
    expect(r.decisions[0]).toMatchObject({ reason_category: 'low_value', action: 'drop', anchor_source: 'none' })
    expect('policy_override' in r.decisions[0]).toBe(false)
  })

  it.each(['0', '0-0', 'L0'])('on: drops a test gap whose reviewer line %s has no positive line number', lines => {
    const r = apply([gap({ lines })], [lowValue()])
    expect(r.kept).toEqual([])
    expect(r.decisions[0]).toMatchObject({ reason_category: 'low_value', action: 'drop', anchor_source: 'reviewer', anchor_lines: lines })
    expect('policy_override' in r.decisions[0]).toBe(false)
  })

  it.each(['', 'getFileStats'])('on: drops a test gap whose reviewer line "%s" is not a line', lines => {
    const r = apply([gap({ lines })], [lowValue()])
    expect(r.kept).toEqual([])
    expect('policy_override' in r.decisions[0]).toBe(false)
  })

  it.each(['12', '12-14'])('on: keeps a test gap on line %s', lines => {
    const r = apply([gap({ lines })], [lowValue()])
    expect(r.decisions[0]).toMatchObject({ action: 'keep', anchor_lines: lines, policy_override: 'test_gap' })
    expect(r.kept[0]).toMatchObject({ lines, anchorSource: 'reviewer' })
  })

  it('on: overrides exactly when the downstream placement check accepts the kept finding, at the range it places', () => {
    const cases: Array<[string, { start: number; end: number } | null]> = [['0', null], ['0-0', null], ['', null], ['getFileStats', null], ['12', { start: 12, end: 12 }], ['12-14', { start: 12, end: 14 }], ['0-3', { start: 3, end: 3 }], ['5-2', { start: 2, end: 5 }]]
    for (const [lines, placed] of cases) {
      const r = apply([gap({ lines })], [lowValue()])
      const overridden = r.decisions[0].policy_override === 'test_gap'
      expect(overridden).toBe(placed !== null)
      if (overridden) {
        expect(isAnchored(r.kept[0])).toBe(true)
        expect(parseLineRange(r.kept[0].lines)).toEqual(placed)
      }
    }
  })

  it('on: a low_value finding that names no test gap still drops', () => {
    const r = apply([gap({ title: 'Hardcoded colors bypass the palette tokens', body: 'Use the palette tokens.' })], [lowValue()])
    expect(r.kept).toEqual([])
    expect(r.decisions[0]).toStrictEqual({ ...DROPPED_GAP })
  })

  it('on: the body counts too', () => {
    const r = apply([gap({ title: 'Lazy-rotation tests miss the CAS conflict branch and unknown-key path', body: 'The VersionConflict skip branch is never exercised.' })], [lowValue()])
    expect(r.decisions[0]).toMatchObject({ action: 'keep', policy_override: 'test_gap' })
  })

  it.each(['incorrect', 'already_handled', 'duplicate', 'style_only', 'out_of_scope', 'unverifiable', 'minor', 'framework_uncertainty'] as ReasonCategory[])(
    'on: a %s test gap follows the policy table, only low_value is overridden', reason => {
      const r = apply([gap()], [lowValue({ reason_category: reason, evidence: 'src/pool.ts:12 guard' })])
      expect(r.kept).toEqual([])
      expect(r.decisions[0]).toMatchObject({ reason_category: reason, action: policyAction(reason, 'LOW', TGAP).action })
      expect('policy_override' in r.decisions[0]).toBe(false)
    })

  it('on: an incorrect drop without evidence is reclassified unverifiable, not overridden', () => {
    const r = apply([gap()], [lowValue({ reason_category: 'incorrect', evidence: '' })])
    expect(r.decisions[0]).toMatchObject({ reason_category: 'unverifiable', reclassified_from: 'incorrect', action: 'drop' })
    expect('policy_override' in r.decisions[0]).toBe(false)
  })

  it('keepMinor on or off: the test gap is kept either way and minor still follows keepMinor', () => {
    const cands = [gap(), gap({ title: 'Dead helper left behind', lines: '20', body: 'Unused.' }), gap({ title: 'Prefer a config flag', lines: '21', body: 'Make it configurable.' })]
    const decisions = [lowValue(), decision({ candidate_id: 'c1', reason_category: 'minor' }), lowValue({ candidate_id: 'c2' })]
    for (const keepMinor of [false, true]) {
      const r = apply(cands, decisions, { keepMinor, keepUnverified: false, keepTestGaps: true })
      expect(r.kept.map(k => k.title)).toEqual(keepMinor ? ['Null getFileStats branch has no test', 'Dead helper left behind'] : ['Null getFileStats branch has no test'])
      expect(r.decisions.map(d => d.policy_override)).toEqual(['test_gap', undefined, undefined])
    }
    expect(apply(cands, decisions, { keepMinor: true, keepUnverified: false }).kept.map(k => k.title)).toEqual(['Dead helper left behind'])
  })

  it('with J_QUALITY: a gap the evidence check already validated is not overridden, a low_value gap is overridden once, a demoted duplicate is not', () => {
    const r = apply(
      [gap({ severity: 'MEDIUM' }), gap({ severity: 'MEDIUM', title: 'Pagination test never exercises has_more=true', lines: '30' }), gap({ title: 'No test covers the centimeters unit path', lines: '35' })],
      [decision({ evidence: 'src/pool.ts:12' }), lowValue({ candidate_id: 'c1' }), decision({ candidate_id: 'c2', reason_category: 'duplicate', duplicate_of: 'c9' })],
      TGAP, Infinity, { quality: true },
    )
    expect(r.decisions[0]).toMatchObject({ reason_category: 'validated', action: 'keep', final_severity: 'MEDIUM' })
    expect(r.decisions[1]).toMatchObject({ reason_category: 'low_value', action: 'downgrade', final_severity: 'LOW', policy_override: 'test_gap' })
    expect(r.decisions[2]).toMatchObject({ reason_category: 'unverifiable', invalid_duplicate: true, action: 'drop' })
    expect([r.decisions[0], r.decisions[2]].some(d => 'policy_override' in d)).toBe(false)
    expect(r.kept.map(k => [k.title, k.severity])).toEqual([['Null getFileStats branch has no test', 'MEDIUM'], ['Pagination test never exercises has_more=true', 'LOW']])
  })

  it('on: the kept gap carries the judge score, a capped rewrite and a proposal like any kept finding', () => {
    const plain = apply([gap()], [lowValue({ score: 9 })])
    expect(plain.kept[0]).toMatchObject({ score: 9, body: 'Add a test for the null branch.' })
    expect(plain.decisions[0].rewritten).toBe(false)
    const rewritten = apply([gap()], [lowValue({ rewritten_body: 'No test reaches the null branch.' })])
    expect(rewritten.kept[0].body).toBe('No test reaches the null branch.')
    expect(rewritten.decisions[0].rewritten).toBe(true)
    const withFix = apply([gap()], [lowValue({ proposal: 'Add a test that passes null stats.' })], TGAP, Infinity, { proposals: true })
    expect(withFix.kept[0].proposal).toBe('Add a test that passes null stats.')
    expect(withFix.decisions[0]).toMatchObject({ policy_override: 'test_gap', proposal: 'Add a test that passes null stats.' })
  })

  const REPLAY_TEST_GAP_TITLES = [
    'New exception-handling branches have no test coverage',
    'New note-parsing branches and JSON round-trip are untested',
    'Promise connect() traced path has no test',
    'Null getFileStats branch has no test',
    'Pagination test never exercises has_more=true',
    'Test never asserts layer-order re-init',
    'No regression test for the download language fix',
    'Integration test does not cover pagination or clamping',
    'No test covers the centimeters unit path',
    'Freshness logic added without tests',
    'Threading and invokeAndWait error paths are untested',
    'Test coverage does not match the PR description: only one test, no zonos case',
  ]
  const REPLAY_OTHER_LOW_VALUE_TITLES = [
    'Hardcoded colors bypass the palette tokens',
    'Queries without a callback are silently untraced',
    'Global state cleared inline, not in a fixture',
    'Janitor goroutine has no stop path',
    'Unchecked `as Locale` cast on download language',
    'CHANGELOG omits the new path file-size cap',
    'Default OAuth scopes are broader than a review tool needs',
    'Named palettes have no size cap',
    'Rotation test covers only the success path',
    'Tests are absent for new branching logic',
    'Sweep test never checks that tracked files survive',
    'Hard-coded variant count lets missing variants pass the test',
  ]

  const GENERIC_PHRASE_NON_TEST_TITLES = [
    'Remove the redundant catch: this operation cannot fail',
    'Add a docstring: the documentation does not cover retries',
    'Tautological comparison: x === x is always true',
    'Handler does not assert that the caller owns the resource',
    "Retry fallback can't fail, so the error branch is dead code",
    'Empty-list validation trivially passes and skips the size check',
    'The handler never tests the return value of write()',
    'Error path is not covered by the circuit breaker',
    'EU region has no coverage in the pricing table',
    'The README does not cover the new environment variables',
  ]

  it.each(REPLAY_TEST_GAP_TITLES)('isTestGap accepts %s', title => {
    expect(isTestGap(title, '')).toBe(true)
  })

  it.each([...REPLAY_OTHER_LOW_VALUE_TITLES, ...GENERIC_PHRASE_NON_TEST_TITLES])('isTestGap rejects %s', title => {
    expect(isTestGap(title, '')).toBe(false)
  })

  it('isTestGap: a generic phrase counts with a testing word anywhere in the title or body, outside the phrase itself', () => {
    expect(isTestGap('Pagination branch is never exercised', 'The new test only requests the first page.')).toBe(true)
    expect(isTestGap('Pagination branch is never exercised', 'Only the first page is ever requested.')).toBe(false)
    expect(isTestGap('Fallback cannot fail', 'The mock always resolves, so the error branch is dead.')).toBe(true)
    expect(isTestGap('The parser never tests for an empty buffer', '')).toBe(false)
    expect(isTestGap('Fallback path is never tested', '')).toBe(true)
  })

  it('on: end to end, every matching title is kept and every other one dropped', () => {
    const titles = [...REPLAY_TEST_GAP_TITLES, ...REPLAY_OTHER_LOW_VALUE_TITLES, ...GENERIC_PHRASE_NON_TEST_TITLES]
    const r = apply(titles.map((title, i) => gap({ title, body: 'See the title.', lines: String(i + 1) })), titles.map((_, i) => lowValue({ candidate_id: `c${i}` })))
    expect(r.kept.map(k => k.title)).toEqual(REPLAY_TEST_GAP_TITLES)
  })
})

describe('renderJudgedReview suffixes and renderWith', () => {
  const cands = [finding({ severity: 'HIGH' }), finding({ title: 'Dropped one', lines: '9' }), finding({ title: 'Third', lines: '4' })]
  const out = output([decision(), decision({ candidate_id: 'c1', reason_category: 'style_only' }), decision({ candidate_id: 'c2', question: 'q?', reason_category: 'framework_uncertainty' })])

  it('no suffix map and an empty map render the bytes applyJudgeDecisions posts today', () => {
    const r = applyJudgeDecisions(cands, out, DEFAULT_JUDGE_POLICY, ['Split me'])
    expect(renderJudgedReview(r.kept, out, ['q?'], ['Split me'])).toBe(r.markdown)
    expect(renderJudgedReview(r.kept, out, ['q?'], ['Split me'], new Map())).toBe(r.markdown)
  })

  it('renderWith exists only with codeProposals and re-renders the same review, suffixes keyed by kept index', () => {
    expect('renderWith' in applyJudgeDecisions(cands, out, DEFAULT_JUDGE_POLICY, ['Split me'], '', Infinity, { proposals: true })).toBe(false)
    const r = applyJudgeDecisions(cands, out, DEFAULT_JUDGE_POLICY, ['Split me'], '', Infinity, { proposals: true, codeProposals: true })
    expect(r.renderWith!(new Map())).toBe(r.markdown)
    expect(r.markdown).toContain('- q?')
    expect(r.renderWith!(new Map([[0, '\n\nBLOCK']]))).toBe(r.markdown.replace('  get/put race.', '  get/put race.\n\nBLOCK'))
  })

  it('codeProposals dedents a kept proposal where prose mode trims it', () => {
    const raw = '    try {\n      q()\n    } finally {'
    const code = applyJudgeDecisions([finding()], output([decision({ proposal: raw })]), DEFAULT_JUDGE_POLICY, [], '', Infinity, { proposals: true, codeProposals: true })
    const prose = applyJudgeDecisions([finding()], output([decision({ proposal: raw })]), DEFAULT_JUDGE_POLICY, [], '', Infinity, { proposals: true })
    expect(code.kept[0].proposal).toBe('try {\n  q()\n} finally {')
    expect(prose.kept[0].proposal).toBe(raw.trim())
  })

  it('codeProposals counts the kept proposals the sanitizer omits; absent, blank and dropped-candidate proposals are not counted', () => {
    const over = 'x'.repeat(PROPOSAL_CAP + 1)
    const cands = [finding(), finding({ title: 'B', lines: '3' }), finding({ title: 'C', lines: '4' }), finding({ title: 'D', lines: '5' }), finding({ title: 'E', lines: '6' })]
    const out = output([
      decision({ proposal: over }), decision({ candidate_id: 'c1', proposal: '  \n ' }), decision({ candidate_id: 'c2' }),
      decision({ candidate_id: 'c3', reason_category: 'style_only', proposal: over }), decision({ candidate_id: 'c4', proposal: 'a()\n'.repeat(8) }),
    ])
    const r = applyJudgeDecisions(cands, out, DEFAULT_JUDGE_POLICY, [], '', Infinity, { proposals: true, codeProposals: true })
    expect(r.kept.map(k => k.title)).toEqual(['Race on conns', 'B', 'C', 'E'])
    expect(r.proposalsDropped).toBe(2)
    expect('proposalsDropped' in applyJudgeDecisions(cands, out, DEFAULT_JUDGE_POLICY, [], '', Infinity, { proposals: true })).toBe(false)
  })
})
