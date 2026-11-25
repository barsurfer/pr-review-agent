import { describe, it, expect } from 'vitest'
import { composeSummary, carryNarrative, type ComposeInput } from '../compose.js'
import { COMMENT_BUDGET } from '../../review/suggested-fix.js'
import { verify } from '../state.js'
import { renderBlock, parseSectionBlocks, type SectionBlock } from '../../review/section-render.js'

const AGENT = 'acc-1'
const C = 'a1b2c3d4e5f6'
const HEADING = '### Cleanup'
const LEGEND = 'Low-value code added in this PR; not counted in the findings or the verdict.'

const narrative = (extra = ''): string =>
  `### Summary\nA change.\n\n### Findings\nNo findings.\n\n### Behavioral Diff\nNone.\n\n### Production Risk\nNone.\n\n### Unresolved Questions\nNone.\n\n### Merge Confidence: 90%\n\n*"This verdict is opinionated and must be validated by a human reviewer."*${extra}`

const rows = (n: number, body = false) => Array.from({ length: n }, (_, i) => ({ text: `- \`src/f${i}.ts:${i + 1}\` · Restating comment · reason ${i}`, ...(body ? { body: 'x'.repeat(200) } : {}) }))
const block = (n: number, body = false, more = 0): SectionBlock => ({ lens: 'slop', heading: HEADING, legend: LEGEND, order: 100, rows: rows(n, body), more })

const base = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  review: { plain: narrative(), findings: [] }, threads: [], summaryOnly: [], resolved: [], history: [], historyText: 'first review', todoSection: '',
  footer: { identity: 'review-bot', model: 'claude-sonnet-5-5' }, head12: C, state: { n: 1, commits: [C] }, agentId: AGENT, ...over,
})

describe('composeSummary with section blocks', () => {
  it('puts the block after the narrative tail and above a fresh TODO list', () => {
    const { body, sectionRowsHidden } = composeSummary(base({ todoSection: '\n\n### TODOs Introduced\n- `a.ts:1` — TODO: x', sections: [block(2)] }))
    expect(body.indexOf('verdict is opinionated')).toBeLessThan(body.indexOf(HEADING))
    expect(body.indexOf(HEADING)).toBeLessThan(body.indexOf('### TODOs Introduced'))
    expect(body.indexOf('### TODOs Introduced')).toBeLessThan(body.indexOf('### Review History'))
    expect(sectionRowsHidden).toBe(0)
    expect(verify(body, AGENT)).toEqual({ n: 1, commits: [C] })
  })

  it('puts the block above a TODO list carried inside the narrative', () => {
    const plain = narrative('\n\n### TODOs Introduced\n- `a.ts:1` — TODO: x')
    const { body } = composeSummary(base({ review: { plain, findings: [] }, sections: [block(2)] }))
    expect(body.indexOf(HEADING)).toBeLessThan(body.indexOf('### TODOs Introduced'))
    expect(body.match(/### TODOs Introduced/g)).toHaveLength(1)
  })

  it('sits after the rule that replaces Merge Confidence when it is hidden', () => {
    const { body } = composeSummary(base({ hideConfidence: true, sections: [block(1)] }))
    expect(body).not.toContain('### Merge Confidence')
    expect(body.indexOf('\n---\n')).toBeLessThan(body.indexOf(HEADING))
  })

  it('renders nothing for an empty block', () => {
    expect(composeSummary(base({ sections: [block(0)] })).body).not.toContain(HEADING)
  })

  it('trims bodies and rows first, then a count, then drops the blocks, always within the budget and counting what it hid', () => {
    const big = (n: number, body: boolean) => composeSummary(base({ review: { plain: narrative('\n\n' + 'y'.repeat(39_000)), findings: [] }, sections: [block(n, body)] }))
    const bodies = big(10, true)
    expect(bodies.body.length).toBeLessThanOrEqual(COMMENT_BUDGET)
    const parsed = parseSectionBlocks(bodies.body)
    expect(parsed[0]?.rows.every(r => !r.body)).toBe(true)
    expect(parsed[0].rows.length).toBeLessThanOrEqual(5)
    expect(bodies.sectionRowsHidden).toBe(10 - parsed[0].rows.length)

    const huge = composeSummary(base({ review: { plain: narrative('\n\n' + 'y'.repeat(100)), findings: [] }, sections: [block(10, true, 0)], threads: Array.from({ length: 50 }, (_, i) => ({ kind: 'thread' as const, severity: 'MEDIUM' as const, title: 'T'.repeat(90) + i, file: 'src/' + 'p'.repeat(150) + '.ts', lines: '1', base: C, id: `F${i + 1}`, url: 'https://x/' + 'u'.repeat(200) + i })) }))
    expect(huge.body.length).toBeLessThanOrEqual(COMMENT_BUDGET)
  })

  it('counts as hidden only the rows the size trim removed, not the rows over the row cap', () => {
    const capped = composeSummary(base({ sections: [block(10, false, 3)] }))
    expect(capped.sectionRowsHidden).toBe(0)
    expect(capped.sectionRowsShown.get('slop')).toBe(10)
    expect(capped.body).toContain('- and 3 more Cleanup items')
  })

  it('reports how many rows each block really shows after the trim', () => {
    const tight = composeSummary(base({ review: { plain: narrative('\n\n' + 'y'.repeat(39_000)), findings: [] }, sections: [block(10, true)] }))
    const shown = parseSectionBlocks(tight.body)[0]?.rows.length ?? 0
    expect(tight.sectionRowsShown.get('slop')).toBe(shown)
    expect(shown).toBeLessThan(10)
  })

  it('leaves every composition without sections exactly as before', () => {
    const a = composeSummary(base())
    expect(a.sectionRowsHidden).toBe(0)
    expect(composeSummary(base({ sections: [] })).body).toBe(a.body)
  })
})

describe('carryNarrative with section blocks', () => {
  it('leaves a recognized block out and keeps the rest of the tail', () => {
    const body = composeSummary(base({ todoSection: '\n\n### TODOs Introduced\n- `a.ts:1` — TODO: x', sections: [block(2)] })).body
    const carried = carryNarrative(body)!
    expect(carried).not.toContain(HEADING)
    expect(carried).toContain('### TODOs Introduced')
    expect(carried).toContain('verdict is opinionated')
    expect(carried).not.toMatch(/\n{3,}/)
  })

  it('round-trips the carried block through a re-render', () => {
    const body = composeSummary(base({ sections: [block(3, true)] })).body
    const [again] = parseSectionBlocks(body)
    expect(renderBlock(again)).toBe(renderBlock(block(3, true)))
  })
})
