import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the LLM seam so runReview never touches the SDK — assert the structured→render wiring.
const complete = vi.fn()
const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({
  createProvider: vi.fn(() => ({ complete, completeStructured })),
}))

import { runReview } from '../client.js'
import type { ReviewObject } from '../../review/formatter.js'
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
