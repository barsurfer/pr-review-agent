import { describe, it, expect } from 'vitest'
import { planBundles, splitDiffByFile } from '../bundler.js'
import { parseReviewMarkdown, dedupeFindings, mergeReviews } from '../aggregate.js'
import type { ReviewFinding } from '../formatter.js'

const unit = (path: string, tokens: number) => ({ path, tokens })

describe('splitDiffByFile', () => {
  it('keys sections by new path', () => {
    const diff = 'diff --git a/x/a.ts b/x/a.ts\n+a\ndiff --git a/y/b.ts b/y/b.ts\n+b\n'
    const m = splitDiffByFile(diff)
    expect([...m.keys()]).toEqual(['x/a.ts', 'y/b.ts'])
    expect(m.get('y/b.ts')).toContain('+b')
  })
})

describe('planBundles', () => {
  it('keeps everything in one bundle when it fits', () => {
    const { bundles } = planBundles([unit('a/x.ts', 10), unit('b/y.ts', 10)], 100)
    expect(bundles).toHaveLength(1)
  })

  it('splits by directory and never exceeds the budget', () => {
    const units = [unit('a/1.ts', 60), unit('a/2.ts', 30), unit('b/1.ts', 60), unit('b/2.ts', 30)]
    const { bundles } = planBundles(units, 100)
    expect(bundles.map(b => b.files)).toEqual([['a/1.ts', 'a/2.ts'], ['b/1.ts', 'b/2.ts']])
    expect(bundles.every(b => b.tokens <= 100)).toBe(true)
  })

  it('merges adjacent small directories to save calls', () => {
    const units = [unit('a/1.ts', 40), unit('b/1.ts', 40), unit('c/1.ts', 40), unit('d/1.ts', 40)]
    expect(planBundles(units, 100).bundles).toHaveLength(2)
  })

  it('descends into subdirectories of one oversized top-level dir', () => {
    const units = [unit('src/x/1.ts', 70), unit('src/y/1.ts', 70)]
    expect(planBundles(units, 100).bundles.map(b => b.files)).toEqual([['src/x/1.ts'], ['src/y/1.ts']])
  })

  it('fills in path order when a flat directory is too big', () => {
    const units = [unit('f/3.ts', 40), unit('f/1.ts', 40), unit('f/2.ts', 40)]
    expect(planBundles(units, 100).bundles.map(b => b.files)).toEqual([['f/1.ts', 'f/2.ts'], ['f/3.ts']])
  })

  it('reports a single file larger than the budget as oversized', () => {
    const { bundles, oversized } = planBundles([unit('a/big.ts', 500), unit('a/s.ts', 10)], 100)
    expect(oversized.map(u => u.path)).toEqual(['a/big.ts'])
    expect(bundles).toHaveLength(1)
  })

  it('handles root-level files', () => {
    const { bundles } = planBundles([unit('a.ts', 60), unit('b.ts', 60)], 100)
    expect(bundles).toHaveLength(2)
  })
})

const f = (over: Partial<ReviewFinding>): ReviewFinding =>
  ({ severity: 'MEDIUM', title: 'Null deref in handler', file: 'src/a.ts', lines: '10-20', body: 'b', ...over })

describe('dedupeFindings', () => {
  it('collapses same file, overlapping lines, similar title; keeps highest severity', () => {
    const out = dedupeFindings([f({}), f({ severity: 'HIGH', lines: '15', title: 'Null deref in the handler' })])
    expect(out).toHaveLength(1)
    expect(out[0].severity).toBe('HIGH')
  })

  it('keeps findings on different files, disjoint lines, or different titles', () => {
    expect(dedupeFindings([f({}), f({ file: 'src/b.ts' })])).toHaveLength(2)
    expect(dedupeFindings([f({}), f({ lines: '50' })])).toHaveLength(2)
    expect(dedupeFindings([f({}), f({ title: 'Unbounded retry loop' })])).toHaveLength(2)
  })

  it('dedupes file-less findings only on near-identical titles', () => {
    expect(dedupeFindings([f({ file: undefined, lines: undefined }), f({ file: undefined, lines: undefined })])).toHaveLength(1)
  })
})

const MD = (finding: string, conf?: number) =>
  `### Summary\nSomething changed.\n\n### Findings\n${finding}\n\n### Behavioral Diff\n- did a thing\n\n### Production Risk\nNone.\n\n### Unresolved Questions\nNone.` +
  (conf !== undefined ? `\n\n### Merge Confidence: ${conf}%\n\n*"x"*` : '')

describe('parseReviewMarkdown', () => {
  it('parses judge-style (file:line) and renderer-style findings', () => {
    const p = parseReviewMarkdown(MD('- **HIGH – Boom** (src/a.ts:12)\n  It breaks.\n\n- **LOW – Meh** (`src/b.ts:3-4`)\n  Minor.', 72))
    expect(p.findings).toMatchObject([
      { severity: 'HIGH', title: 'Boom', file: 'src/a.ts', lines: '12', body: 'It breaks.' },
      { severity: 'LOW', file: 'src/b.ts', lines: '3-4' },
    ])
    expect(p.confidence).toBe(72)
    expect(p.behavioral).toEqual(['did a thing'])
    expect(p.risk).toEqual([])
  })

  it('treats "No actionable findings." as empty', () => {
    expect(parseReviewMarkdown(MD('No actionable findings.')).findings).toEqual([])
  })
})

describe('mergeReviews', () => {
  it('merges bundles, dedupes, takes min confidence, notes unreviewed files', () => {
    const a = { label: 'a/', parsed: parseReviewMarkdown(MD('- **MEDIUM – Dup issue here** (src/a.ts:5)\n  x', 90)) }
    const b = { label: 'b/', parsed: parseReviewMarkdown(MD('- **MEDIUM – Dup issue here** (src/a.ts:5)\n  x\n\n- **LOW – Other** (src/z.ts:1)\n  y', 60)) }
    const m = mergeReviews([a, b], ['huge.ts'])
    expect(m.object.findings).toHaveLength(2)
    expect(m.confidence).toBe(60)
    expect(m.markdown).toMatch(/### Merge Confidence: 60%/)
    expect(m.markdown).toContain('`huge.ts` was too large')
    expect(m.markdown.startsWith('### Summary')).toBe(true)
  })

  it('omits Merge Confidence when no bundle was judged', () => {
    const a = { label: 'a/', parsed: parseReviewMarkdown(MD('No findings.')) }
    expect(mergeReviews([a]).markdown).not.toContain('Merge Confidence')
  })
})
