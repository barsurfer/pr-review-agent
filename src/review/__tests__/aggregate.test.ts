import { describe, it, expect } from 'vitest'
import { parseReviewMarkdown, mergeReviews } from '../aggregate.js'
import { findingsFromJudgedMarkdown } from '../findings-output.js'

describe('parseReviewMarkdown — multi-file findings', () => {
  it('splits a multi-file citation into one finding per file', () => {
    const md = '### Findings\n- **HIGH – Public search** (`src/a.ts:23-30`, `src/b.ts:22-28`)\n  both lost the perm check.\n\n### Merge Confidence: 50%'
    const f = parseReviewMarkdown(md).findings
    expect(f.map(x => `${x.file}:${x.lines}`)).toEqual(['src/a.ts:23-30', 'src/b.ts:22-28'])
    expect(f.every(x => x.title === 'Public search' && x.body === 'both lost the perm check.')).toBe(true)
  })

  it('keeps a single-file finding as one', () => {
    const md = '### Findings\n- **MEDIUM – X** (`src/a.ts:5`)\n  body.'
    const f = parseReviewMarkdown(md).findings
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ file: 'src/a.ts', lines: '5' })
  })
})

describe('bundled multi-file finding survives the merge round-trip', () => {
  it('a judged bundle with a two-file finding reports two located findings', () => {
    const md = '### Findings\n- **HIGH – Public search** (`src/a.ts:23-30`, `src/b.ts:22-28`)\n  both lost the perm check.\n\n### Merge Confidence: 50%'
    const merged = mergeReviews([{ label: 'bundle', parsed: parseReviewMarkdown(md) }])
    const out = findingsFromJudgedMarkdown(merged.markdown, 'rb')
    expect(out.map(f => f.file)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(out.map(f => `${f.start_line}-${f.end_line}`)).toEqual(['23-30', '22-28'])
  })
})
