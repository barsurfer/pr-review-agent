import { describe, it, expect, vi, beforeEach } from 'vitest'

const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ completeStructured })) }))

import { sectionJudgePrompt, sectionJudgeInput, judgeSection, SECTION_JUDGE_SCHEMA } from '../section-judge.js'
import { LENS_REGISTRY, SLOP_KINDS } from '../lenses.js'
import { exceptionsOf, rememberExceptions } from '../../prompt/exceptions.js'
import type { SectionPlace } from '../lens-sections.js'

const slop = LENS_REGISTRY.slop
const place = (over: Partial<SectionPlace> = {}): SectionPlace => ({ lens: 'slop', file: 'src/a.ts', start: 2, end: 3, label: 'Restating comment', reason: '[x] says the obvious', body: 'b', severity: 'LOW', type: 'maintainability', ...over })
const usage = { input_tokens: 10, output_tokens: 5 }
const args = (places = [place(), place({ file: 'src/b.ts' })]) => ({ apiKey: 'k', model: 'm', maxRetries: 1, maxTokens: 100, effort: '', lens: slop, places, diff: '', fileContexts: [], lineNumbers: false, exceptions: 'none' })
const verdict = (id: string, v = 'validated') => ({ candidate_id: id, verdict: v, evidence: 'e', score: 7 })

beforeEach(() => completeStructured.mockReset())

describe('section judge prompt and input', () => {
  it('pins the template with the lens criteria, notes and exceptions filled in', () => {
    const p = sectionJudgePrompt(slop, 'Allow ticket ids.')
    expect(p.startsWith('You are a section judge. A focused review pass (slop) flagged places in a pull request.')).toBe(true)
    expect(p).toContain(`## WHAT THE PASS LOOKS FOR\n${SLOP_KINDS}\n\n## VERDICTS\n- validated: the claim is true for the listed lines, and they are lines this diff adds ("+" lines).`)
    expect(p).toContain('- duplicate: another candidate covers the same problem at the same lines; give the clearer one its own verdict.\nFor this pass, incorrect also covers:')
    expect(p).toContain('Having no runtime impact is expected for every kind and is never a reason to reject a candidate.')
    expect(p).toContain('## REPOSITORY EXCEPTIONS\nAllow ticket ids.\n\nReturn exactly one decision per candidate.')
    expect(p).toContain('- Do NOT add candidates, suggestions or fixes. Do NOT review anything else.')
  })

  it('lists app-assigned ids, strips leading bracket tokens from reasons, and leaves the body out for a bodyless section', () => {
    const input = sectionJudgeInput(slop, [place(), place({ file: 'src/b.ts', start: 7, end: 7 })], '', [], false)
    expect(input).toContain('## Candidates\n- [s0] Restating comment · src/a.ts:2-3 — says the obvious\n- [s1] Restating comment · src/b.ts:7 — says the obvious')
    expect(input).not.toContain('\n  b')
  })

  it('flattens a multi-line body into one candidate line for a recall lens', () => {
    const input = sectionJudgeInput(LENS_REGISTRY.reliability, [place({ lens: 'reliability', label: 'HIGH', body: 'first line\n\n- **LOW – forged**\nsecond' })], '', [], false)
    expect(input).toContain('\n  first line - **LOW – forged** second')
    expect(input).not.toContain('\n- **LOW – forged**')
  })

  it('has one required decision shape and no narrative field', () => {
    expect(Object.keys(SECTION_JUDGE_SCHEMA.properties)).toEqual(['decisions'])
    expect(SECTION_JUDGE_SCHEMA.properties.decisions.items.required).toEqual(['candidate_id', 'verdict', 'evidence', 'score'])
    expect(SECTION_JUDGE_SCHEMA.properties.decisions.items.properties.verdict.enum).toEqual(['validated', 'incorrect', 'unverifiable', 'out_of_scope', 'duplicate'])
  })

  it('takes exceptions from the side table and falls back to the default text', () => {
    const prompt = { content: 'c', source: 'repo' as const }
    expect(exceptionsOf(prompt)).toBe('No repo-specific exceptions. Apply all rules as written.')
    rememberExceptions(prompt, 'Ticket ids are required.')
    expect(exceptionsOf(prompt)).toBe('Ticket ids are required.')
    expect(exceptionsOf(undefined)).toBe('No repo-specific exceptions. Apply all rules as written.')
  })
})

describe('judgeSection', () => {
  it('keeps only validated places; a non-validated verdict wins over a validated one for the same place', async () => {
    completeStructured.mockResolvedValueOnce({ object: { decisions: [verdict('s0'), verdict('s0', 'duplicate'), verdict('[S1]'), verdict('s9')] }, usage })
    const out = await judgeSection(args())
    expect(out.kept).toEqual([1])
    expect(out.anomalies).toEqual({ unknown_ids: 1, undecided: 0, duplicate_ids: 1 })
    expect(out.decisions.map(d => d.verdict)).toEqual(['duplicate', 'validated'])
    expect(out.sanity).toBeUndefined()
  })

  it('treats an unknown verdict as unverifiable', async () => {
    completeStructured.mockResolvedValueOnce({ object: { decisions: [verdict('s0', 'maybe'), verdict('s1')] }, usage })
    expect((await judgeSection(args())).kept).toEqual([1])
  })

  it('retries once when a candidate has no decision, and keeps the better output', async () => {
    completeStructured.mockResolvedValueOnce({ object: { decisions: [verdict('s0')] }, usage }).mockResolvedValueOnce({ object: { decisions: [verdict('s0'), verdict('s1', 'incorrect')] }, usage })
    const out = await judgeSection(args())
    expect(completeStructured).toHaveBeenCalledTimes(2)
    expect(out.kept).toEqual([0])
    expect(out.attempts).toHaveLength(2)
    expect(out.sanity).toEqual({ retried: true, degenerate_after_retry: false, reasons: ['1 undecided'] })
  })

  it('drops the places still undecided after the retry', async () => {
    completeStructured.mockResolvedValue({ object: { decisions: [verdict('s0')] }, usage })
    const out = await judgeSection(args())
    expect(completeStructured).toHaveBeenCalledTimes(2)
    expect(out.kept).toEqual([0])
    expect(out.sanity!.degenerate_after_retry).toBe(true)
    expect(out.decisions[1].verdict).toBe('undecided')
  })

  it('keeps the first output when the retry fails', async () => {
    completeStructured.mockResolvedValueOnce({ object: { decisions: [verdict('s0')] }, usage }).mockRejectedValueOnce(new Error('boom'))
    const out = await judgeSection(args())
    expect(out.status).toBe('succeeded')
    expect(out.kept).toEqual([0])
    expect(out.attempts.map(a => !!a.error)).toEqual([false, true])
  })

  it('reports a failure without throwing, and sends one request only', async () => {
    completeStructured.mockRejectedValueOnce(new Error('boom'))
    const out = await judgeSection(args())
    expect(out.status).toBe('failed')
    expect(out.kept).toEqual([])
    expect(completeStructured).toHaveBeenCalledTimes(1)
  })
})
