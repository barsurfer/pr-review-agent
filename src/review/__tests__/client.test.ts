import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the LLM seam so runReview never touches the SDK — assert the structured→render wiring.
const complete = vi.fn()
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete, completeStructured })),
}))

import { createHash } from 'crypto'
import { runReview, runJudge, runCommentResponse, runLens, runBreadth, reviewOutputSchema, REVIEW_OUTPUT_SCHEMA, JUDGE_OUTPUT_SCHEMA, BREADTH_OUTPUT_SCHEMA } from '../client.js'
import { LENS_REGISTRY } from '../lenses.js'
import { renderReview, type ReviewObject, type ReviewFinding } from '../formatter.js'
import { REASON_CATEGORIES } from '../judge-decisions.js'
import type { PRInfo, ReviewComment, CommentReply } from '../../vcs/adapter.js'
import type { LoadedPrompt } from '../../prompt/loader.js'

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const prInfo = { title: 't', sourceBranch: 's', targetBranch: 'm', description: '' } as PRInfo
const prompt = { content: 'SYSTEM', source: 'repo' } as LoadedPrompt

describe('runReview (structured output)', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })

  it('calls completeStructured with the schema and renders the object into markdown', async () => {
    const object: ReviewObject = {
      summary: 'Risky.',
      findings: [{ severity: 'HIGH', title: 'boom', file: 'a.ts', lines: '3', body: 'crashes' }],
      behavioral_diff: ['x'],
      production_risk: ['y'],
      unresolved_questions: [],
      delta_stats: { resolved: 1, still_open: 2, new_findings: 1 },
    }
    completeStructured.mockResolvedValue({ object, usage })

    const res = await runReview('key', 'model', 3, 16000, 'high', prInfo, 'DIFF', [], prompt, [])

    expect(completeStructured).toHaveBeenCalledOnce()
    const [system, , schema, opts] = completeStructured.mock.calls[0]
    expect(system).toBe('SYSTEM')
    expect((schema as { properties: Record<string, unknown> }).properties.findings).toBeDefined()
    expect(opts).toMatchObject({ model: 'model', maxTokens: 16000, maxRetries: 3, effort: 'high' })
    expect(res.text).toContain('### Summary\nRisky.')
    expect(res.text).toContain('- **HIGH – boom** (`a.ts:3`)')
    expect(res.text).not.toContain('DELTA_STATS')   // delta rides the object, not the markdown
    expect(res.review).toEqual(object)              // object surfaced for metrics
    expect(res.usage).toEqual(usage)
    expect(complete).not.toHaveBeenCalled()
  })

  it('renders the NO_CHANGE sentinel when the reviewer sets no_change', async () => {
    completeStructured.mockResolvedValue({
      object: { summary: '', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [], no_change: true },
      usage,
    })
    const res = await runReview('key', 'model', 3, 16000, 'high', prInfo, 'DIFF', [], prompt, [])
    expect(res.text).toBe('NO_CHANGE')
  })
})

describe('runReview: null or non-array lists from a strict:false provider', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })
  const run = async (object: Record<string, unknown>, lensRecommendation = false) => {
    completeStructured.mockResolvedValue({ object, usage })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const res = await runReview('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], prompt, [], [], '', false, lensRecommendation)
      return { res, warns: warn.mock.calls.map(c => String(c[0])) }
    } finally {
      warn.mockRestore()
    }
  }
  const empty = { summary: 'S', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [] }

  it('null or non-array findings throws the providers\' missing-required-field error, carrying the paid usage (with or without no_change, either schema variant)', async () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ ...empty, findings: null }, false], [{ ...empty, summary: '', findings: null, no_change: true }, false],
      [{ ...empty, findings: {} }, false], [{ ...empty, findings: 'none' }, false], [{ ...empty, findings: undefined }, false],
      [{ ...empty, findings: null, lens_recommendations: [] }, true],
    ]
    for (const [object, lensRecommendation] of cases) {
      const err = await run(object, lensRecommendation).then(() => null, (e: Error & { usage?: unknown }) => e)
      expect(err, JSON.stringify(object)).toBeInstanceOf(Error)
      expect(err!.constructor).toBe(Error)
      expect(err!.message).toBe('Structured output missing required field(s): findings')
      expect(err!.usage).toEqual(usage)
    }
  })

  it('null or non-array text lists are coerced to [] with one warning; findings are kept', async () => {
    const finding: ReviewFinding = { severity: 'LOW', title: 't', body: 'b' }
    const { res, warns } = await run({ ...empty, findings: [finding], behavioral_diff: null, production_risk: 'none', unresolved_questions: null, can_be_split: null })
    expect(res.review).toEqual({ ...empty, findings: [finding], can_be_split: [] })
    expect(res.text).toBe(renderReview({ ...empty, findings: [finding] }))
    expect(warns).toEqual(['  Reviewer returned behavioral_diff, production_risk, unresolved_questions, can_be_split as a non-list — treated as empty'])
  })

  it('well-formed: the same object back, no warning (absent can_be_split stays absent)', async () => {
    for (const object of [empty, { ...empty, can_be_split: ['a'] }, { ...empty, summary: '', no_change: true }]) {
      const { res, warns } = await run(object)
      expect(res.review).toBe(object)
      expect(warns).toEqual([])
    }
    expect('can_be_split' in (await run(empty)).res.review!).toBe(false)
  })
})

describe('reviewOutputSchema (lens recommendation variant)', () => {
  type Variant = { properties: Record<string, any>; required: string[] }

  it('flag off returns the shared REVIEW_OUTPUT_SCHEMA object itself', () => {
    expect(reviewOutputSchema(false)).toBe(REVIEW_OUTPUT_SCHEMA)
  })

  it('flag on adds one required lens_recommendations property, enum from the registry, cached, constant untouched', () => {
    const before = JSON.stringify(REVIEW_OUTPUT_SCHEMA)
    const on = reviewOutputSchema(true) as unknown as Variant

    expect(on).not.toBe(REVIEW_OUTPUT_SCHEMA)
    expect(reviewOutputSchema(true)).toBe(on)
    expect(Object.keys(on.properties)).toEqual([...Object.keys(REVIEW_OUTPUT_SCHEMA.properties), 'lens_recommendations'])
    expect(on.required).toEqual([...REVIEW_OUTPUT_SCHEMA.required, 'lens_recommendations'])
    const field = on.properties.lens_recommendations
    expect(field.type).toBe('array')
    expect(field.items.properties.lens.enum).toEqual(Object.keys(LENS_REGISTRY))
    expect(field.items.properties.reason.description).toBe('One short clause naming the changed code that gives this concern real surface.')
    expect(field.items.required).toEqual(['lens', 'reason'])
    expect(field.items.additionalProperties).toBe(false)
    for (const lens of Object.values(LENS_REGISTRY)) expect(field.description).toContain(`${lens.name} (${lens.when})`)
    expect(field.description).toContain('empty array for small, cosmetic, or unrelated changes')
    expect(field.description).toContain('not shown to the developer')
    expect(JSON.stringify(REVIEW_OUTPUT_SCHEMA)).toBe(before)
  })
})

describe('runReview lens recommendation', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })
  const base: ReviewObject = {
    summary: 'Adds login.', findings: [{ severity: 'MEDIUM', title: 'boom', file: 'a.ts', lines: '3', body: 'bad' }],
    behavioral_diff: [], production_risk: [], unresolved_questions: [],
  }

  it('flag off: same schema object, same provider options, same review object, no lensRecommendations key', async () => {
    completeStructured.mockResolvedValue({ object: base, usage })
    const res = await runReview('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], prompt, [], [], '', true)
    expect(completeStructured.mock.calls[0][2]).toBe(REVIEW_OUTPUT_SCHEMA)
    expect(completeStructured.mock.calls[0][3]).toEqual({ model: 'model', maxTokens: 16000, maxRetries: 3, effort: undefined })
    expect(Object.keys(completeStructured.mock.calls[0][3])).toEqual(['model', 'maxTokens', 'maxRetries', 'effort'])
    expect(res.review).toBe(base)
    expect('lensRecommendations' in res).toBe(false)
  })

  it('flag on: requests the variant with the same system prompt, strips the field from review and text, returns it sanitized', async () => {
    completeStructured.mockResolvedValue({
      object: { ...base, lens_recommendations: [
        { lens: 'security', reason: ' new /login endpoint ' }, { lens: 'style', reason: 'x' },
        { lens: 'security', reason: 'dup' }, { lens: 'reliability', reason: 'r'.repeat(300) },
      ] },
      usage,
    })
    const res = await runReview('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], prompt, [], [], '', true, true)

    const [system, user, schema, opts] = completeStructured.mock.calls[0]
    expect(schema).toBe(reviewOutputSchema(true))
    expect(opts).toEqual({ model: 'model', maxTokens: 16000, maxRetries: 3, effort: undefined, tolerateMissing: ['lens_recommendations'] })
    expect(system).toBe('SYSTEM')
    expect(user).not.toContain('lens')
    expect(res.review).toEqual(base)
    expect('lens_recommendations' in res.review!).toBe(false)
    expect(res.text).toBe(renderReview(base))
    expect(res.text).not.toMatch(/login endpoint|lens/)
    expect(res.lensRecommendations).toEqual([{ lens: 'security', reason: 'new /login endpoint' }, { lens: 'reliability', reason: 'r'.repeat(200) }])
  })

  it('flag on: a missing or non-array field is null (not answered), an empty one is [] (none recommended)', async () => {
    const cases: Array<[object, unknown]> = [
      [base, null], [{ ...base, lens_recommendations: 'security' }, null], [{ ...base, lens_recommendations: [] }, []],
    ]
    for (const [object, expected] of cases) {
      completeStructured.mockReset()
      completeStructured.mockResolvedValue({ object, usage })
      const res = await runReview('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], prompt, [], [], '', true, true)
      expect(res.lensRecommendations).toEqual(expected)
      expect(res.review).toEqual(base)
    }
  })
})

describe('ENABLE_LINE_NUMBERS: numbered views in the model input', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })
  const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n keep\n+added'
  const object: ReviewObject = { summary: 's', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [] }

  it('off: the reviewer message carries the raw diff and file content byte-for-byte', async () => {
    completeStructured.mockResolvedValue({ object, usage })
    await runReview('key', 'model', 3, 16000, '', prInfo, DIFF, [{ path: 'a.ts', content: 'keep\nadded' }], prompt, [])
    const msg = completeStructured.mock.calls[0][1] as string
    expect(msg).toContain(`## Diff:\n\`\`\`diff\n${DIFF}\n\`\`\``)
    expect(msg).toContain('## Full file context:\n\n### a.ts\n```\nkeep\nadded\n```')
  })

  it('on: the reviewer sees numbered diff and file lines with an instruction to cite them', async () => {
    completeStructured.mockResolvedValue({ object, usage })
    await runReview('key', 'model', 3, 16000, '', prInfo, DIFF, [{ path: 'a.ts', content: 'keep\nadded' }], prompt, [], [], '', true)
    const msg = completeStructured.mock.calls[0][1] as string
    expect(msg).toContain('cite those numbers in `lines`')
    expect(msg).toContain('    1  keep\n    2 +added')
    expect(msg).toContain('    2 added')
  })

  it('on: the re-review delta diff is numbered too', async () => {
    completeStructured.mockResolvedValue({ object, usage })
    const prior: ReviewComment[] = [{ id: '1', body: 'PRIOR', createdOn: '2026-03-10T10:00:00Z' }]
    await runReview('key', 'model', 3, 16000, '', prInfo, DIFF, [], prompt, prior, [], DIFF, true)
    const msg = completeStructured.mock.calls[0][1] as string
    expect(msg.split('## Changes Since Your Last Review:')[1]).toContain('    2 +added')
  })

  it('on: the judge numbers its file context as well', async () => {
    const review: ReviewObject = { ...object, findings: [{ severity: 'LOW', title: 'X', file: 'a.ts', lines: '2', body: 'b' }] }
    completeStructured.mockResolvedValue({
      object: { decisions: [{ candidate_id: 'c0', reason_category: 'validated', evidence: 'a.ts:2', note: 'n', score: 8 }], summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80 },
      usage,
    })
    await runJudge('key', 'model', 3, 16000, '', DIFF, review, [{ path: 'a.ts', content: 'keep\nadded' }], undefined, true)
    expect(completeStructured.mock.calls[0][1]).toContain('### a.ts\n```\n    1 keep\n    2 added\n```')
  })

  it('on: the judge sees the numbered diff, while anchoring still parses the raw one', async () => {
    const review: ReviewObject = { ...object, findings: [{ severity: 'MEDIUM', title: 'X', file: 'a.ts', body: 'b' }] }
    completeStructured.mockResolvedValue({
      object: { decisions: [{ candidate_id: 'c0', reason_category: 'validated', evidence: 'a.ts:2', note: 'n', score: 8, anchor_file: 'a.ts', anchor_lines: '2' }], summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80 },
      usage,
    })
    const res = await runJudge('key', 'model', 3, 16000, '', DIFF, review, [], undefined, true)
    expect(completeStructured.mock.calls[0][1]).toContain('    2 +added')
    expect(res.kept?.[0]).toMatchObject({ file: 'a.ts', lines: '2', anchorSource: 'judge' })
  })
})

// The FSM passes discussion + delta in; if they don't reach the model, a dev's "Fixed in <sha>" goes unseen.
describe('runReview user message (re-review context)', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })

  const object: ReviewObject = { summary: 's', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [] }
  const prior: ReviewComment[] = [
    { id: '1', body: 'OLDER REVIEW BODY', createdOn: '2026-03-09T10:00:00Z' },
    { id: '2', body: 'LATEST REVIEW BODY', createdOn: '2026-03-10T10:00:00Z' },
  ]
  const replies: CommentReply[] = [{ id: '3', parentId: '2', author: 'Fernando', body: 'Fixed in d4f2b43e.', createdOn: '2026-03-10T12:00:00Z' }]

  it('includes the latest prior review, the developer discussion, and the changes-since-last-review diff', async () => {
    completeStructured.mockResolvedValue({ object, usage })

    await runReview('key', 'model', 3, 16000, '', prInfo, 'FULL DIFF', [], prompt, prior, replies, 'DELTA DIFF')

    const userMessage = completeStructured.mock.calls[0][1] as string
    expect(userMessage).toContain('LATEST REVIEW BODY')
    expect(userMessage).not.toContain('OLDER REVIEW BODY')
    expect(userMessage).toContain('Fixed in d4f2b43e.')
    expect(userMessage).toContain('## Changes Since Your Last Review')
    expect(userMessage).toContain('DELTA DIFF')
    expect(userMessage).toContain('FULL DIFF')
  })

  it('omits the delta section on a first review even if a delta is passed', async () => {
    completeStructured.mockResolvedValue({ object, usage })

    await runReview('key', 'model', 3, 16000, '', prInfo, 'FULL DIFF', [], prompt, [], [], 'DELTA DIFF')

    const userMessage = completeStructured.mock.calls[0][1] as string
    expect(userMessage).not.toContain('Changes Since Your Last Review')
    expect(userMessage).not.toContain('DELTA DIFF')
    expect(userMessage).not.toContain('Developer Discussion')
  })
})

describe('runCommentResponse', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })

  it('sends the original review and every pending reply in one call', async () => {
    complete.mockResolvedValue({ text: 'Answer.', usage })
    const pending: CommentReply[] = [
      { id: '3', parentId: '2', author: 'Fernando', body: 'Why HIGH?', createdOn: '2026-03-10T12:00:00Z' },
      { id: '4', parentId: '2', author: 'Vadim', body: 'Also the cache?', createdOn: '2026-03-10T13:00:00Z' },
    ]

    const res = await runCommentResponse('key', 'model', 3, 'DIFF', 'ORIGINAL REVIEW', pending)

    expect(complete).toHaveBeenCalledOnce()
    const userMessage = complete.mock.calls[0][1] as string
    expect(userMessage).toContain('ORIGINAL REVIEW')
    expect(userMessage).toContain('Why HIGH?')
    expect(userMessage).toContain('Also the cache?')
    expect(res.text).toBe('Answer.')
    expect(completeStructured).not.toHaveBeenCalled()
  })
})

describe('runJudge (structured output)', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })

  const review: ReviewObject = {
    summary: 'reviewer summary',
    findings: [
      { severity: 'MEDIUM', title: 'X', file: 'a.ts', lines: '3', body: 'x body' },
      { severity: 'LOW', title: 'Y', file: 'a.ts', lines: '9', body: 'y body' },
    ],
    behavioral_diff: [], production_risk: [], unresolved_questions: [],
  }
  const judged = {
    decisions: [
      { candidate_id: 'c0', reason_category: 'validated', evidence: 'a.ts:3', note: 'real', score: 7 },
      { candidate_id: 'c1', reason_category: 'style_only', evidence: '', note: 'naming', score: 3 },
    ],
    summary: 'ok', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 80,
  }

  it('sends id-tagged candidates and renders the kept ones with the reviewer anchor', async () => {
    completeStructured.mockResolvedValue({ object: judged, usage })

    const res = await runJudge('key', 'model', 3, 16000, '', 'DIFF', review)

    const userMessage = completeStructured.mock.calls[0][1] as string
    expect(userMessage).toContain('- [c0] **MEDIUM – X** (`a.ts:3`)')
    expect(userMessage).not.toContain('## Full file context')
    expect(res.text).toContain('- **MEDIUM – X** (`a.ts:3`)\n  x body')
    expect(res.text).not.toContain('Y')
    expect(res.text).not.toContain('[c0]')
    expect(res.text).toMatch(/### Merge Confidence: 80%\n\n\*"This verdict is opinionated and must be validated by a human reviewer\."\*$/)
    expect(res.scores).toEqual([{ title: 'X', severity: 'MEDIUM', score: 7, file: 'a.ts', lines: '3' }])
    expect(res.notes).toContain('c1 style_only → drop')
    expect(complete).not.toHaveBeenCalled()
  })

  it('anchors a symbol-located candidate from the judge pair and carries can_be_split through to the posted review', async () => {
    const symbolic: ReviewObject = { ...review, findings: [{ ...review.findings[0], lines: 'Pool.get' }], can_be_split: ['Pool', 'Docs'] }
    completeStructured.mockResolvedValue({ object: { ...judged, decisions: [{ ...judged.decisions[0], anchor_file: 'a.ts', anchor_lines: '12-14' }] }, usage })
    // The judge anchor is validated against the diff, so a.ts needs added lines covering 12-14.
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -0,0 +1,20 @@',
      ...Array.from({ length: 20 }, (_, i) => `+const v${i + 1} = ${i + 1}`)].join('\n')

    const res = await runJudge('key', 'model', 3, 16000, '', diff, symbolic)

    expect(res.text).toContain('- **MEDIUM – X** (`a.ts:12-14`)')
    expect(res.text).toContain('### Can Be Split\n- Pool\n- Docs\n\n### Merge Confidence: 80%')
    expect(res.scores).toEqual([{ title: 'X', severity: 'MEDIUM', score: 7, file: 'a.ts', lines: '12-14' }])
    expect(res.kept?.[0].anchorSource).toBe('judge')
  })

  it('adds the file context to the judge input only when given', async () => {
    completeStructured.mockResolvedValue({ object: judged, usage })

    await runJudge('key', 'model', 3, 16000, '', 'DIFF', review, [{ path: 'a.ts', content: 'const a = 1' }])

    expect(completeStructured.mock.calls[0][1]).toContain('## Full file context:\n\n### a.ts\n```\nconst a = 1\n```')
  })
})

describe('runLens (shared reviewer-pass core)', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })

  const finding: ReviewFinding = { severity: 'HIGH', title: 'Leak', file: 'a.ts', lines: '2', body: 'handle never closed' }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

  it('sends an arbitrary system prompt + payload and returns the structured findings', async () => {
    completeStructured.mockResolvedValue({ object: { findings: [finding] }, usage })

    const res = await runLens('key', 'model', 3, 16000, 'high', prInfo, 'DIFF', [{ path: 'a.ts', content: 'x' }], 'LENS SYSTEM', 'LENS BRIEFING', false, 'lens:reliability')

    const [system, userMessage, schema, opts] = completeStructured.mock.calls[0]
    expect(system).toBe('LENS SYSTEM')
    expect(userMessage).toContain('## Diff:\n```diff\nDIFF\n```')
    expect(userMessage).toContain('### a.ts\n```\nx\n```')
    expect(userMessage).toMatch(/```\n\nLENS BRIEFING$/)
    expect(schema).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(opts).toEqual({ model: 'model', maxTokens: 16000, maxRetries: 3, effort: 'high' })
    expect(res).toEqual({ findings: [finding], usage, promptHash: hash('LENS SYSTEM') })
  })

  it('derives promptHash from the system prompt alone', async () => {
    completeStructured.mockResolvedValue({ object: { findings: [] }, usage })
    const a = await runLens('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], 'SYSTEM A', 'BRIEF 1')
    const b = await runLens('key', 'model', 3, 16000, '', prInfo, 'OTHER DIFF', [], 'SYSTEM A', 'BRIEF 2')
    const c = await runLens('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], 'SYSTEM B', 'BRIEF 1')
    expect(a.promptHash).toBe(hash('SYSTEM A'))
    expect(b.promptHash).toBe(a.promptHash)
    expect(c.promptHash).toBe(hash('SYSTEM B'))
  })

  it('logs under the given label and returns no findings when the model omits the array', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    completeStructured.mockResolvedValue({ object: {}, usage })

    const res = await runLens('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], 'SYSTEM', 'BRIEF', false, 'lens:security')

    expect(log.mock.calls.map(c => c[0])).toEqual([
      'Sending to lens:security reviewer (model, maxRetries: 3)...',
      'Lens:security received (100 in / 50 out tokens, 0 findings)',
    ])
    expect(res.findings).toEqual([])
    log.mockRestore()
  })

  it('coerces a non-array findings field to [] so candidate assembly never throws', async () => {
    completeStructured.mockResolvedValue({ object: { findings: {} as unknown as ReviewFinding[] }, usage })
    const res = await runLens('key', 'model', 3, 16000, '', prInfo, 'DIFF', [], 'SYSTEM', 'BRIEF', false, 'lens:security')
    expect(res.findings).toEqual([])
  })
})

describe('runBreadth (delegates to runLens)', () => {
  beforeEach(() => { complete.mockReset(); completeStructured.mockReset() })

  const finding: ReviewFinding = { severity: 'MEDIUM', title: 'Same bug', file: 'b.ts', lines: '4', body: 'b' }

  it('sends the same provider call runLens does for the same args, pinned byte-for-byte', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    completeStructured.mockResolvedValue({ object: { findings: [finding] }, usage })
    const args: Parameters<typeof runBreadth> = ['key', 'model', 3, 16000, '', prInfo, 'DIFF', [], 'BREADTH SYSTEM', 'BRIEF']

    const breadth = await runBreadth(...args)
    const lens = await runLens(...args)

    const [breadthCall, lensCall] = completeStructured.mock.calls
    expect(breadthCall).toEqual(lensCall)
    expect(breadthCall[0]).toBe('BREADTH SYSTEM')
    expect(breadthCall[1]).toBe('## Pull Request: t\n\n## Branch: s → m\n\n## Diff:\n```diff\nDIFF\n```\n\nBRIEF')
    expect(breadthCall[2]).toBe(BREADTH_OUTPUT_SCHEMA)
    expect(breadthCall[3]).toEqual({ model: 'model', maxTokens: 16000, maxRetries: 3, effort: undefined })
    expect(breadth).toEqual(lens)
    expect(log.mock.calls.slice(0, 2).map(c => c[0])).toEqual([
      'Sending to breadth reviewer (model, maxRetries: 3)...',
      'Breadth received (100 in / 50 out tokens, 1 findings)',
    ])
    log.mockRestore()
  })

  it('forwards lineNumbers and a custom label', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    completeStructured.mockResolvedValue({ object: { findings: [] }, usage })
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n keep\n+added'

    await runBreadth('key', 'model', 3, 16000, '', prInfo, diff, [], 'SYSTEM', 'BRIEF', true, 'second-look')

    expect(completeStructured.mock.calls[0][1]).toContain('    1  keep\n    2 +added')
    expect(log.mock.calls[0][0]).toBe('Sending to second-look reviewer (model, maxRetries: 3)...')
    log.mockRestore()
  })
})

// Drift canary: the JSON schemas (client.ts) and the TS types (formatter.ts) are one contract
// maintained by hand. Change a schema here → update ReviewObject/FindingScore in formatter.ts
// (and vice versa); these assertions break to force that.
describe('output schema ↔ type parity (drift canary)', () => {
  it('REVIEW_OUTPUT_SCHEMA required + property keys match ReviewObject', () => {
    expect([...REVIEW_OUTPUT_SCHEMA.required].sort()).toEqual(
      ['behavioral_diff', 'findings', 'production_risk', 'summary', 'unresolved_questions'])
    expect(Object.keys(REVIEW_OUTPUT_SCHEMA.properties).sort()).toEqual(
      ['behavioral_diff', 'can_be_split', 'delta_stats', 'findings', 'no_change', 'production_risk', 'summary', 'unresolved_questions'])
    expect(Object.keys(REVIEW_OUTPUT_SCHEMA.properties.findings.items.properties).sort()).toEqual(
      ['body', 'file', 'lines', 'severity', 'title', 'type'])
  })

  it('JUDGE_OUTPUT_SCHEMA keys match JudgeOutput / JudgeDecision', () => {
    expect([...JUDGE_OUTPUT_SCHEMA.required].sort()).toEqual(
      ['behavioral_diff', 'decisions', 'merge_confidence', 'production_risk', 'summary', 'unresolved_questions'])
    const decision = JUDGE_OUTPUT_SCHEMA.properties.decisions.items
    expect(Object.keys(decision.properties).sort()).toEqual(
      ['anchor_file', 'anchor_lines', 'anchor_quote', 'candidate_id', 'evidence', 'note', 'question', 'reason_category', 'rewritten_body', 'score'])
    expect([...decision.required].sort()).toEqual(['candidate_id', 'evidence', 'note', 'reason_category', 'score'])
    expect(decision.properties.reason_category.enum).toEqual([...REASON_CATEGORIES])
  })

  it('renderReview of a schema-required-only object emits no "undefined" (renderer reads only guaranteed fields)', () => {
    const md = renderReview({ summary: 's', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [] })
    expect(md).not.toContain('undefined')
  })
})
