import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Branch pattern matching — mirrors CHECK_BRANCHES logic in index.ts
// ---------------------------------------------------------------------------

function matchesPattern(branch: string, patterns: string[]): boolean {
  return patterns.some(p => p.includes('*')
    ? new RegExp('^' + p.replace(/\*/g, '.*') + '$').test(branch)
    : p === branch)
}

const SOURCE_DEFAULTS = ['main', 'master', 'release/*', 'hotfix/*']
const TARGET_DEFAULTS = ['main', 'master']

describe('matchesPattern', () => {
  describe('exact matches', () => {
    it('matches "main" exactly', () => {
      expect(matchesPattern('main', ['main', 'master'])).toBe(true)
    })

    it('matches "master" exactly', () => {
      expect(matchesPattern('master', ['main', 'master'])).toBe(true)
    })

    it('does not match partial names', () => {
      expect(matchesPattern('main-fix', ['main'])).toBe(false)
    })

    it('does not match substrings', () => {
      expect(matchesPattern('not-main', ['main'])).toBe(false)
    })
  })

  describe('wildcard patterns', () => {
    it('matches release/* branches', () => {
      expect(matchesPattern('release/1.2.3', ['release/*'])).toBe(true)
    })

    it('matches release with nested path', () => {
      expect(matchesPattern('release/2024/q1', ['release/*'])).toBe(true)
    })

    it('matches hotfix/* branches', () => {
      expect(matchesPattern('hotfix/urgent-fix', ['hotfix/*'])).toBe(true)
    })

    it('does not match unrelated branches', () => {
      expect(matchesPattern('feature/AL-1234', ['release/*', 'hotfix/*'])).toBe(false)
    })

    it('does not match when prefix differs', () => {
      expect(matchesPattern('my-release/1.0', ['release/*'])).toBe(false)
    })
  })

  describe('empty and edge cases', () => {
    it('returns false for empty patterns', () => {
      expect(matchesPattern('main', [])).toBe(false)
    })

    it('matches with mixed exact and wildcard patterns', () => {
      const patterns = ['main', 'master', 'release/*', 'hotfix/*']
      expect(matchesPattern('main', patterns)).toBe(true)
      expect(matchesPattern('release/v2', patterns)).toBe(true)
      expect(matchesPattern('feature/test', patterns)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Default skip scenarios — verifies expected behavior with default config
// ---------------------------------------------------------------------------

describe('default branch exclusions', () => {
  describe('source branch (skip merge-back PRs)', () => {
    it.each([
      ['main', true],
      ['master', true],
      ['release/1.5.0', true],
      ['release/2024/q1', true],
      ['hotfix/urgent', true],
      ['feature/AL-1234', false],
      ['bugfix/fix-crash', false],
      ['develop', false],
      ['chore/update-deps', false],
    ])('source="%s" → skip=%s', (branch, shouldSkip) => {
      expect(matchesPattern(branch, SOURCE_DEFAULTS)).toBe(shouldSkip)
    })
  })

  describe('target branch (skip release PRs)', () => {
    it.each([
      ['main', true],
      ['master', true],
      ['develop', false],
      ['staging', false],
      ['release/1.0', false],
    ])('target="%s" → skip=%s', (branch, shouldSkip) => {
      expect(matchesPattern(branch, TARGET_DEFAULTS)).toBe(shouldSkip)
    })
  })
})
