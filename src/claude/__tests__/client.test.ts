import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the LLM seam so runReview never touches the SDK — assert the structured→render wiring.
const complete = vi.fn()
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete, completeStructured })),
}))

import { runReview, runJudge, runCommentResponse, REVIEW_OUTPUT_SCHEMA, JUDGE_OUTPUT_SCHEMA } from '../client.js'
import { renderReview, type ReviewObject } from '../../review/formatter.js'
import { REASON_CATEGORIES } from '../../review/judge-decisions.js'
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
