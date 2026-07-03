import { describe, it, expect } from 'vitest'
import { buildReviewFooter, buildReplyFooter, stripPreviousFooter, stripDeltaStats, stripPreamble, isNoChange, extractCommitHash } from '../formatter.js'

// ---------------------------------------------------------------------------
// buildReviewFooter
// ---------------------------------------------------------------------------

describe('buildReviewFooter', () => {
  it('includes all fields', () => {
    const footer = buildReviewFooter('alice@co.com', 'claude-sonnet-4-6', 'repo', 2, 'a1b2c3d4e5f6')
    expect(footer).toContain('alice@co.com')
    expect(footer).toContain('claude-sonnet-4-6')
    expect(footer).toContain('Prompt: repo')
    expect(footer).toContain('Review #2')
    expect(footer).toContain('Commit: a1b2c3d4e5f6')
  })
})

// ---------------------------------------------------------------------------
// buildReplyFooter
// ---------------------------------------------------------------------------

describe('buildReplyFooter', () => {
  it('includes identity and model', () => {
    const footer = buildReplyFooter('bot@co.com', 'claude-haiku-4-5-20251001')
    expect(footer).toContain('bot@co.com')
    expect(footer).toContain('claude-haiku-4-5-20251001')
  })
})

// ---------------------------------------------------------------------------
// stripPreviousFooter
// ---------------------------------------------------------------------------

describe('stripPreviousFooter', () => {
  it('removes a standard review footer', () => {
    const text = '### Summary\nAll good.\n---\n*Reviewed by alice@co.com (claude-sonnet-4-6) | Prompt: repo | Review #1 | Commit: abc123*'
    expect(stripPreviousFooter(text)).toBe('### Summary\nAll good.')
  })

  it('returns text unchanged when no footer present', () => {
    const text = '### Summary\nAll good.'
    expect(stripPreviousFooter(text)).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// stripDeltaStats
// ---------------------------------------------------------------------------

describe('stripDeltaStats', () => {
  it('removes DELTA_STATS comment from end of text', () => {
    const text = '### Merge Confidence: 90%\n<!-- DELTA_STATS: resolved=2 still_open=1 new=0 -->'
    expect(stripDeltaStats(text)).toBe('### Merge Confidence: 90%')
  })

  it('removes DELTA_STATS with extra whitespace', () => {
    const text = '### Merge Confidence: 90%\n\n<!--  DELTA_STATS:  resolved=1  still_open=0  new=3  -->\n'
    expect(stripDeltaStats(text)).toBe('### Merge Confidence: 90%')
  })

  it('returns text unchanged when no DELTA_STATS present', () => {
    const text = '### Summary\nNo issues.'
    expect(stripDeltaStats(text)).toBe(text)
  })

  it('removes DELTA_STATS from the middle of text', () => {
    const text = '### Merge Confidence: 88%\n<!-- DELTA_STATS: resolved=0 still_open=2 new=1 -->\nSome trailing text'
    const result = stripDeltaStats(text)
    expect(result).not.toContain('DELTA_STATS')
    expect(result).toContain('### Merge Confidence: 88%')
    expect(result).toContain('Some trailing text')
  })
})

// ---------------------------------------------------------------------------
// isNoChange
// ---------------------------------------------------------------------------

describe('isNoChange', () => {
  it('detects NO_CHANGE', () => {
    expect(isNoChange('NO_CHANGE')).toBe(true)
  })

  it('detects NO_CHANGE with whitespace', () => {
    expect(isNoChange('  NO_CHANGE  \n')).toBe(true)
  })

  it('rejects other text', () => {
    expect(isNoChange('### Summary\nNO_CHANGE found')).toBe(false)
  })

  it('detects NO_CHANGE on a standalone line after a summary (PR 8718 regression)', () => {
    expect(isNoChange('### Summary\n\nNo new findings. Cosmetic changes only.\n\nNO_CHANGE')).toBe(true)
  })

  it('rejects inline NO_CHANGE mention', () => {
    expect(isNoChange('Found NO_CHANGE in the diff')).toBe(false)
  })

  it('rejects quoted NO_CHANGE line', () => {
    expect(isNoChange('> NO_CHANGE\nsome reply text')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// stripPreamble
// ---------------------------------------------------------------------------

describe('stripPreamble', () => {
  it('drops judge deliberation before ### Summary (PR 45 regression)', () => {
    const text = 'I need to validate each finding against the actual diff.\n\n**Finding 1: MEDIUM** — visible in the diff, keep.\n\n### Summary\nRefactor is risky.\n\n### Findings\n\nNone.'
    expect(stripPreamble(text)).toBe('### Summary\nRefactor is risky.\n\n### Findings\n\nNone.')
  })

  it('returns text unchanged when it already starts with ### Summary', () => {
    const text = '### Summary\nAll good.\n\n### Findings\n\nNone.'
    expect(stripPreamble(text)).toBe(text)
  })

  it('returns text unchanged when no Summary heading exists', () => {
    expect(stripPreamble('NO_CHANGE')).toBe('NO_CHANGE')
    expect(stripPreamble('free-form review without headings')).toBe('free-form review without headings')
  })

  it('matches heading depth and case variations', () => {
    expect(stripPreamble('preamble\n\n#### summary\ntext')).toBe('#### summary\ntext')
  })

  it('does not cut on inline "Summary" mention in the preamble', () => {
    const text = 'Checking the Summary claim first.\n\n### Summary\nreal one'
    expect(stripPreamble(text)).toBe('### Summary\nreal one')
  })
})

// ---------------------------------------------------------------------------
// extractCommitHash
// ---------------------------------------------------------------------------

describe('extractCommitHash', () => {
  it('extracts hash from review footer', () => {
    const body = '*Reviewed by alice@co.com (claude-sonnet-4-6) | Prompt: repo | Review #1 | Commit: a1b2c3d4e5f6*'
    expect(extractCommitHash(body)).toBe('a1b2c3d4e5f6')
  })

  it('returns null when no commit hash', () => {
    expect(extractCommitHash('No footer here')).toBeNull()
  })
})
