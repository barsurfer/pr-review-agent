import { describe, it, expect } from 'vitest'
import {
  REASON_CATEGORIES, REWRITE_CAP, DEFAULT_JUDGE_POLICY, applyJudgeDecisions, policyAction, renderCandidatesForJudge, locateInDiff,
  type JudgeDecision, type JudgeOutput, type ReasonCategory,
} from '../judge-decisions.js'
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
