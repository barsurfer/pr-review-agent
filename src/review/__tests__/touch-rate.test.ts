import { describe, it, expect } from 'vitest'
import { parseDeltaStats } from '../parsers.js'

// ---------------------------------------------------------------------------
// Touch rate calculation — mirrors the logic in usage.ts buildUsageRecord()
// ---------------------------------------------------------------------------

function calcTouchRate(reviewText: string): number | null {
  const stats = parseDeltaStats(reviewText)
  const resolved = stats?.resolved ?? 0
  const stillOpen = stats?.still_open ?? 0
  const total = resolved + stillOpen
  return total > 0 ? Math.round((resolved / total) * 100) : null
}

describe('touch rate calculation', () => {
  it('returns 100 when all findings resolved', () => {
    const text = '<!-- DELTA_STATS: resolved=5 still_open=0 new=1 -->'
    expect(calcTouchRate(text)).toBe(100)
  })

  it('returns 0 when no findings resolved', () => {
    const text = '<!-- DELTA_STATS: resolved=0 still_open=3 new=0 -->'
    expect(calcTouchRate(text)).toBe(0)
  })

  it('returns correct percentage for partial resolution', () => {
    const text = '<!-- DELTA_STATS: resolved=2 still_open=1 new=0 -->'
    expect(calcTouchRate(text)).toBe(67) // 2/3 = 66.67 → 67
  })

  it('returns 50 for equal resolved and open', () => {
    const text = '<!-- DELTA_STATS: resolved=3 still_open=3 new=2 -->'
    expect(calcTouchRate(text)).toBe(50)
  })

  it('returns null when no DELTA_STATS present', () => {
    expect(calcTouchRate('### Merge Confidence: 90%')).toBeNull()
  })

  it('returns null when resolved and still_open are both 0', () => {
    const text = '<!-- DELTA_STATS: resolved=0 still_open=0 new=2 -->'
    expect(calcTouchRate(text)).toBeNull()
  })

  it('returns null for first review (no delta stats)', () => {
    const text = [
      '### Summary',
      'First review.',
      '### Findings',
      '- **HIGH – Issue**',
      '### Merge Confidence: 80%',
    ].join('\n')
    expect(calcTouchRate(text)).toBeNull()
  })

  it('handles 1 resolved out of many', () => {
    const text = '<!-- DELTA_STATS: resolved=1 still_open=9 new=0 -->'
    expect(calcTouchRate(text)).toBe(10)
  })

  it('rounds correctly at boundary', () => {
    // 1/3 = 33.33 → 33
    const text = '<!-- DELTA_STATS: resolved=1 still_open=2 new=0 -->'
    expect(calcTouchRate(text)).toBe(33)
  })
})
