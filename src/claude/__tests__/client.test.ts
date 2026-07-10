import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the LLM seam so runReview never touches the SDK — assert the structured→render wiring.
const complete = vi.fn()
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete, completeStructured })),
}))

import { runReview, runJudge, REVIEW_OUTPUT_SCHEMA, JUDGE_OUTPUT_SCHEMA } from '../client.js'
import { renderReview, type ReviewObject } from '../../review/formatter.js'
import type { PRInfo } from '../../vcs/adapter.js'
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

    const res = await runReview('key', 'model', 3, prInfo, 'DIFF', [], prompt, [])

    expect(completeStructured).toHaveBeenCalledOnce()
    const [system, , schema, opts] = completeStructured.mock.calls[0]
    expect(system).toBe('SYSTEM')
    expect((schema as { properties: Record<string, unknown> }).properties.findings).toBeDefined()
    expect(opts).toMatchObject({ model: 'model', maxRetries: 3 })
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
    const res = await runReview('key', 'model', 3, prInfo, 'DIFF', [], prompt, [])
    expect(res.text).toBe('NO_CHANGE')
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

    const res = await runJudge('key', 'model', 3, 'DIFF', '### Summary\nreviewer text')

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
