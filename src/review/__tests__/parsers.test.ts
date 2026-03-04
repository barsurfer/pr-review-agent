import { describe, it, expect } from 'vitest'
import { filterDiff, countChangedLines, parseVerdictScore, parseFindings, parseDeltaStats } from '../parsers.js'

// ---------------------------------------------------------------------------
// filterDiff
// ---------------------------------------------------------------------------

const DEFAULT_PATTERNS = ['*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '*.json', '*.spec.ts']

describe('filterDiff', () => {
  it('removes lock files with default patterns', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '+const x = 1',
      'diff --git a/package-lock.json b/package-lock.json',
      '+lots of lock stuff',
    ].join('\n')
    const { filtered, removedCount } = filterDiff(diff, DEFAULT_PATTERNS)
    expect(removedCount).toBe(1)
    expect(filtered).not.toContain('package-lock.json')
    expect(filtered).toContain('src/app.ts')
  })

  it('removes yarn.lock and pnpm-lock.yaml', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '+hello',
      'diff --git a/yarn.lock b/yarn.lock',
      '+lock',
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
      '+lock',
    ].join('\n')
    const { filtered, removedCount } = filterDiff(diff, DEFAULT_PATTERNS)
    expect(removedCount).toBe(2)
    expect(filtered).toContain('src/index.ts')
  })

  it('removes .json files', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '+code',
      'diff --git a/public/i18n/en.json b/public/i18n/en.json',
      '+translations',
      'diff --git a/public/i18n/fr.json b/public/i18n/fr.json',
      '+translations',
    ].join('\n')
    const { filtered, removedCount } = filterDiff(diff, DEFAULT_PATTERNS)
    expect(removedCount).toBe(2)
    expect(filtered).toContain('src/app.ts')
  })

  it('removes .spec.ts files', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '+code',
      'diff --git a/src/app.spec.ts b/src/app.spec.ts',
      '+test code',
    ].join('\n')
    const { filtered, removedCount } = filterDiff(diff, DEFAULT_PATTERNS)
    expect(removedCount).toBe(1)
    expect(filtered).not.toContain('spec.ts')
  })

  it('removes generic .lock files', () => {
    const diff = [
      'diff --git a/Gemfile.lock b/Gemfile.lock',
      '+lock',
      'diff --git a/src/main.ts b/src/main.ts',
      '+code',
    ].join('\n')
    const { filtered, removedCount } = filterDiff(diff, DEFAULT_PATTERNS)
    expect(removedCount).toBe(1)
  })

  it('keeps everything when no patterns match', () => {
    const diff = 'diff --git a/src/app.ts b/src/app.ts\n+code'
    const { filtered, removedCount } = filterDiff(diff, DEFAULT_PATTERNS)
    expect(removedCount).toBe(0)
    expect(filtered).toBe(diff)
  })

  it('uses custom patterns', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '+code',
      'diff --git a/src/app.test.tsx b/src/app.test.tsx',
      '+test',
    ].join('\n')
    const { filtered, removedCount } = filterDiff(diff, ['*.test.tsx'])
    expect(removedCount).toBe(1)
    expect(filtered).toContain('src/app.ts')
  })

  it('handles empty patterns list', () => {
    const diff = [
      'diff --git a/package-lock.json b/package-lock.json',
      '+lock',
    ].join('\n')
    const { filtered, removedCount } = filterDiff(diff, [])
    expect(removedCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// countChangedLines
// ---------------------------------------------------------------------------

describe('countChangedLines', () => {
  it('counts added and removed lines', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,4 @@',
      ' unchanged',
      '-removed line',
      '+added line 1',
      '+added line 2',
    ].join('\n')
    expect(countChangedLines(diff)).toBe(3) // 1 removed + 2 added
  })

  it('ignores --- and +++ headers', () => {
    const diff = '--- a/file.ts\n+++ b/file.ts\n'
    expect(countChangedLines(diff)).toBe(0)
  })

  it('returns 0 for empty diff', () => {
    expect(countChangedLines('')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseVerdictScore
// ---------------------------------------------------------------------------

describe('parseVerdictScore', () => {
  it('extracts score from ### Merge Confidence: XX%', () => {
    expect(parseVerdictScore('### Merge Confidence: 85%')).toBe(85)
  })

  it('extracts score from ## Merge Confidence: XX%', () => {
    expect(parseVerdictScore('## Merge Confidence: 92%')).toBe(92)
  })

  it('extracts score from legacy ### Verdict: XX%', () => {
    expect(parseVerdictScore('### Verdict: 100%')).toBe(100)
  })

  it('extracts score from #### Merge Confidence: XX%', () => {
    expect(parseVerdictScore('#### Merge Confidence: 77%')).toBe(77)
  })

  it('returns null when no score found', () => {
    expect(parseVerdictScore('no verdict here')).toBeNull()
  })

  it('returns null for malformed score', () => {
    expect(parseVerdictScore('### Merge Confidence: high')).toBeNull()
  })

  it('finds score in longer text', () => {
    const text = '### Summary\nAll good.\n\n### Merge Confidence: 95%\nSome notes.'
    expect(parseVerdictScore(text)).toBe(95)
  })
})

// ---------------------------------------------------------------------------
// parseFindings
// ---------------------------------------------------------------------------

describe('parseFindings', () => {
  it('counts HIGH, MEDIUM, LOW in Findings section', () => {
    const text = [
      '### Summary',
      'Looks risky.',
      '',
      '### Findings',
      '',
      '- **HIGH – SQL injection**',
      '  Description.',
      '',
      '- **MEDIUM – Missing validation**',
      '  Description.',
      '',
      '- **MEDIUM – Race condition**',
      '  Description.',
      '',
      '- **LOW – Naming convention**',
      '  Description.',
      '',
      '### Production Risk',
      'Some risk.',
    ].join('\n')

    expect(parseFindings(text)).toEqual({ high: 1, medium: 2, low: 1 })
  })

  it('does not count severity keywords outside Findings section', () => {
    const text = [
      '### Findings',
      '',
      '- **HIGH – Real finding**',
      '',
      '### Production Risk',
      '',
      '- **HIGH** impact if this breaks.',
      '- **MEDIUM** likelihood.',
      '- **LOW** priority.',
    ].join('\n')

    expect(parseFindings(text)).toEqual({ high: 1, medium: 0, low: 0 })
  })

  it('returns zeros when no Findings section', () => {
    expect(parseFindings('### Summary\nAll good.')).toEqual({ high: 0, medium: 0, low: 0 })
  })

  it('returns zeros when Findings section is empty', () => {
    const text = '### Findings\n\n### Production Risk\nSome risk.'
    expect(parseFindings(text)).toEqual({ high: 0, medium: 0, low: 0 })
  })

  it('handles ## heading level', () => {
    const text = [
      '## Findings',
      '',
      '- **HIGH – Issue**',
      '- **LOW – Nitpick**',
      '',
      '## Merge Confidence: 80%',
    ].join('\n')

    expect(parseFindings(text)).toEqual({ high: 1, medium: 0, low: 1 })
  })

  it('handles Findings at end of text (no next heading)', () => {
    const text = [
      '### Findings',
      '',
      '- **MEDIUM – Issue one**',
      '- **MEDIUM – Issue two**',
      '- **LOW – Minor thing**',
    ].join('\n')

    expect(parseFindings(text)).toEqual({ high: 0, medium: 2, low: 1 })
  })
})

// ---------------------------------------------------------------------------
// parseDeltaStats
// ---------------------------------------------------------------------------

describe('parseDeltaStats', () => {
  it('extracts stats from valid DELTA_STATS comment', () => {
    const text = '<!-- DELTA_STATS: resolved=2 still_open=1 new=0 -->'
    expect(parseDeltaStats(text)).toEqual({ resolved: 2, still_open: 1, new_findings: 0 })
  })

  it('extracts stats embedded in larger text', () => {
    const text = [
      '### Merge Confidence: 90%',
      '*This verdict is opinionated.*',
      '<!-- DELTA_STATS: resolved=5 still_open=0 new=3 -->',
    ].join('\n')
    expect(parseDeltaStats(text)).toEqual({ resolved: 5, still_open: 0, new_findings: 3 })
  })

  it('handles extra whitespace', () => {
    const text = '<!--  DELTA_STATS:  resolved=1  still_open=2  new=1  -->'
    expect(parseDeltaStats(text)).toEqual({ resolved: 1, still_open: 2, new_findings: 1 })
  })

  it('returns null when no DELTA_STATS comment', () => {
    expect(parseDeltaStats('### Merge Confidence: 90%\nNo delta here.')).toBeNull()
  })

  it('returns null for malformed comment', () => {
    expect(parseDeltaStats('<!-- DELTA_STATS: resolved=abc -->')).toBeNull()
  })
})
