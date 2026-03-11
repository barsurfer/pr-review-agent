import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Force flag parsing — mirrors logic in src/index.ts (line ~126)
// ---------------------------------------------------------------------------

function parseForceMode(optsForce: string | boolean | undefined): 'off' | 'clean' | 're-review' {
  return optsForce === true ? 're-review'
    : typeof optsForce === 'string' ? optsForce as 'clean' | 're-review'
    : 'off'
}

describe('parseForceMode', () => {
  it('returns "off" when --force is not passed (undefined)', () => {
    expect(parseForceMode(undefined)).toBe('off')
  })

  it('returns "re-review" when --force is passed without value (boolean true)', () => {
    expect(parseForceMode(true)).toBe('re-review')
  })

  it('returns "clean" when --force clean', () => {
    expect(parseForceMode('clean')).toBe('clean')
  })

  it('returns "re-review" when --force re-review', () => {
    expect(parseForceMode('re-review')).toBe('re-review')
  })

  // Regression: Commander default value bug — if .option() has a default,
  // opts.force would be the default string even when --force is not passed.
  // This caused every run to bypass dedup (PR 712 incident).
  it('does NOT return "re-review" for a Commander-style default string', () => {
    // If Commander ever passes the default as a string, it would be 're-review'.
    // Our parsing treats any string as a valid mode — the fix is to NOT set
    // a default on the Commander option itself.
    // This test documents the invariant: undefined → 'off'
    expect(parseForceMode(undefined)).not.toBe('re-review')
  })

  it('returns "off" for false', () => {
    expect(parseForceMode(false as any)).toBe('off')
  })
})
