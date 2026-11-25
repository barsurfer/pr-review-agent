import { describe, it, expect, vi, beforeEach } from 'vitest'

const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))

import { runJudge } from '../client.js'
import { parseVerdictScore } from '../parsers.js'
import { ContentFilterError } from '../../llm/shared.js'
import type { ReviewObject } from '../formatter.js'

const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,3 @@\n keep\n+added\n+more\n'
const review: ReviewObject = {
  summary: 'Reviewer narrative that is long enough.', behavioral_diff: ['Reviewer behaviour.'], production_risk: ['Reviewer risk.'], unresolved_questions: ['Reviewer question?'],
  findings: [
    { severity: 'MEDIUM', title: 'One', file: 'a.ts', lines: '2', body: 'first' },
    { severity: 'LOW', title: 'Two', file: 'a.ts', lines: '3', body: 'second' },
  ],
}
const decision = (id: string) => ({ candidate_id: id, reason_category: 'validated', evidence: 'a.ts:2', note: 'n', score: 8 })
const good = { decisions: [decision('c0'), decision('c1')], summary: 'A judged summary that is long enough.', behavioral_diff: ['b'], production_risk: ['r'], unresolved_questions: [], merge_confidence: 80 }
const stub = { decisions: [decision('c0'), decision('c1')], summary: 'x', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70 }
const partial = { ...good, decisions: [decision('c0')] }
const usage = (n: number) => ({ input_tokens: 100 * n, output_tokens: 10 * n })
const run = (sanity: boolean) => runJudge('key', 'model', 1, 1000, '', DIFF, review, [], undefined, false, undefined, undefined, undefined, sanity)

beforeEach(() => { completeStructured.mockReset() })

describe('judge sanity check (inline only)', () => {
  it('retries a stub summary once and uses the good retry, pricing both requests', async () => {
    completeStructured.mockResolvedValueOnce({ object: stub, usage: usage(1) }).mockResolvedValueOnce({ object: good, usage: usage(2) })
    const res = await run(true)
    expect(completeStructured).toHaveBeenCalledTimes(2)
    expect(res.sanity).toEqual({ retried: true, degenerate_after_retry: false, reasons: ['summary stub'] })
    expect(res.text).toContain('A judged summary that is long enough.')
    expect(res.usage.input_tokens).toBe(300)
    expect(res.usage.output_tokens).toBe(30)
    expect(res.usage.attempts).toHaveLength(2)
  })

  it('retries an undecided candidate and keeps the retry that decides it', async () => {
    completeStructured.mockResolvedValueOnce({ object: partial, usage: usage(1) }).mockResolvedValueOnce({ object: good, usage: usage(1) })
    const res = await run(true)
    expect(res.sanity).toEqual({ retried: true, degenerate_after_retry: false, reasons: ['1 undecided'] })
    expect(res.anomalies?.undecided).toBe(0)
    expect(res.kept).toHaveLength(2)
  })

  it('degenerate twice: undecided stay dropped and the stub narrative becomes the reviewer narrative with the judge score', async () => {
    const bad = { ...stub, decisions: [decision('c0')] }
    completeStructured.mockResolvedValue({ object: bad, usage: usage(1) })
    const res = await run(true)
    expect(completeStructured).toHaveBeenCalledTimes(2)
    expect(res.sanity).toEqual({ retried: true, degenerate_after_retry: true, reasons: ['summary stub', '1 undecided'] })
    expect(res.anomalies?.undecided).toBe(1)
    expect(res.kept).toHaveLength(1)
    expect(res.text).toContain('Reviewer narrative that is long enough.')
    expect(res.text).toContain('Reviewer risk.')
    expect(res.text).toContain('Reviewer question?')
    expect(parseVerdictScore(res.text)).toBe(70)
  })

  it('double failure picks per field: decisions from the attempt that ruled on more, narrative from whichever has a real summary', async () => {
    const firstGood = { ...good, decisions: [], summary: 'The first attempt had a real summary.' }
    const secondStub = { ...stub, decisions: [decision('c0')], merge_confidence: 55 }
    completeStructured.mockResolvedValueOnce({ object: firstGood, usage: usage(1) }).mockResolvedValueOnce({ object: secondStub, usage: usage(1) })
    const res = await run(true)
    expect(res.sanity?.degenerate_after_retry).toBe(true)
    expect(res.kept).toHaveLength(1)
    expect(res.text).toContain('The first attempt had a real summary.')
    expect(res.text).not.toContain('Reviewer narrative')
    expect(parseVerdictScore(res.text)).toBe(80)
  })

  it('a first-call ContentFilterError is not retried', async () => {
    completeStructured.mockRejectedValue(new ContentFilterError({ signal: 'native_refusal' }))
    await expect(run(true)).rejects.toBeInstanceOf(ContentFilterError)
    expect(completeStructured).toHaveBeenCalledTimes(1)
  })

  it('a ContentFilterError on the retry is returned for recording and the first output is used', async () => {
    const refusal = new ContentFilterError({ signal: 'native_refusal' })
    completeStructured.mockResolvedValueOnce({ object: stub, usage: usage(1) }).mockRejectedValueOnce(refusal)
    const res = await run(true)
    expect(res.retryRefusal).toBe(refusal)
    expect(res.text).toContain('Reviewer narrative that is long enough.')
  })

  it('a still-stub summary without a valid Merge Confidence takes the failure path and keeps the spend', async () => {
    completeStructured.mockResolvedValue({ object: { ...stub, merge_confidence: undefined }, usage: usage(1) })
    const err = await run(true).catch(e => e)
    expect(err.message).toContain('Merge Confidence')
    expect(err.usage.input_tokens).toBe(200)
  })

  it('a failed retry falls back to the first output and keeps its spend', async () => {
    completeStructured.mockResolvedValueOnce({ object: stub, usage: usage(1) }).mockRejectedValueOnce(Object.assign(new Error('boom'), { usage: usage(1) }))
    const res = await run(true)
    expect(res.sanity?.degenerate_after_retry).toBe(true)
    expect(res.text).toContain('Reviewer narrative that is long enough.')
    expect(res.usage.input_tokens).toBe(200)
  })

  it('a clean first output is not retried and carries no sanity record', async () => {
    completeStructured.mockResolvedValue({ object: good, usage: usage(1) })
    const res = await run(true)
    expect(completeStructured).toHaveBeenCalledTimes(1)
    expect(res.sanity).toBeUndefined()
  })

  it('legacy and benchmark (check off): the same stub output is used as is with one request', async () => {
    completeStructured.mockResolvedValue({ object: { ...stub, decisions: [decision('c0')] }, usage: usage(1) })
    const res = await run(false)
    expect(completeStructured).toHaveBeenCalledTimes(1)
    expect(res.sanity).toBeUndefined()
    expect(res.anomalies?.undecided).toBe(1)
    expect(res.text).not.toContain('Reviewer narrative')
    expect(res.usage.attempts).toBeUndefined()
  })
})
