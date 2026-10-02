import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the LLM seam so runReview never touches the SDK — assert the structured→render wiring.
const complete = vi.fn()
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete, completeStructured })),
}))

import { runReview, runJudge, runCommentResponse, REVIEW_OUTPUT_SCHEMA, JUDGE_OUTPUT_SCHEMA } from '../client.js'
import { renderReview, type ReviewObject } from '../../review/formatter.js'
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

  it('passes the judged markdown, notes, and per-finding scores through', async () => {
    completeStructured.mockResolvedValue({
      object: {
        review_markdown: '### Summary\nok\n\n### Merge Confidence: 80%',
        judge_notes: 'dropped a LOW',
        finding_scores: [{ title: 'X', severity: 'MEDIUM', score: 7 }],
      },
      usage,
    })

    const res = await runJudge('key', 'model', 3, 16000, '', 'DIFF', '### Summary\nreviewer text')

    expect(res.text).toBe('### Summary\nok\n\n### Merge Confidence: 80%')
    expect(res.notes).toBe('dropped a LOW')
    expect(res.scores).toEqual([{ title: 'X', severity: 'MEDIUM', score: 7 }])
    expect(complete).not.toHaveBeenCalled()
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
  })

  it('JUDGE_OUTPUT_SCHEMA required keys match JudgeResult usage', () => {
    expect([...JUDGE_OUTPUT_SCHEMA.required].sort()).toEqual(['finding_scores', 'judge_notes', 'review_markdown'])
  })

  it('renderReview of a schema-required-only object emits no "undefined" (renderer reads only guaranteed fields)', () => {
    const md = renderReview({ summary: 's', findings: [], behavioral_diff: [], production_risk: [], unresolved_questions: [] })
    expect(md).not.toContain('undefined')
  })
})
