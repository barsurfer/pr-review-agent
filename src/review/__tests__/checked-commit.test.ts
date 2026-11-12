import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveCheckedCommit, headMatches } from '../checked-commit.js'

const H40 = '0123456789abcdef0123456789abcdef01234567'
const H12 = H40.slice(0, 12)
const H64 = `${H40}89abcdef0123456789abcdef`

describe('resolveCheckedCommit', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore() })

  it('CC1 unset CLI and empty env give undefined with no warning', () => {
    expect(resolveCheckedCommit(undefined, '')).toBeUndefined()
    expect(resolveCheckedCommit('', '')).toBeUndefined()
    expect(resolveCheckedCommit('   ', '')).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('CC2 an empty CLI value falls back to env; a non-empty CLI value wins', () => {
    expect(resolveCheckedCommit('', H40)).toBe(H40)
    expect(resolveCheckedCommit(' ', H40)).toBe(H40)
    expect(resolveCheckedCommit(undefined, H40)).toBe(H40)
    expect(resolveCheckedCommit(H12, H40)).toBe(H12)
    expect(warn).not.toHaveBeenCalled()
  })

  it('CC3 trims and lowercases', () => {
    expect(resolveCheckedCommit(`  ${H40.toUpperCase()}  `, '')).toBe(H40)
    expect(resolveCheckedCommit(undefined, H12.toUpperCase())).toBe(H12)
  })

  it('CC4 rejects <12, >64 and non-hex values with exactly one warning each', () => {
    for (const bad of ['0123456789a', `${H64}0`, 'g123456789abc', '0123-56789abc', 'garbage']) {
      warn.mockClear()
      expect(resolveCheckedCommit(bad, '')).toBeUndefined()
      expect(resolveCheckedCommit(undefined, bad)).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[0][0])).toContain('expected 12 to 64 hex characters')
    }
  })

  it('CC4 accepts 41 to 64 hex characters (SHA-256 repositories) without a warning', () => {
    expect(resolveCheckedCommit(`${H40}0`, '')).toBe(`${H40}0`)
    expect(resolveCheckedCommit(H64.toUpperCase(), '')).toBe(H64)
    expect(warn).not.toHaveBeenCalled()
  })

  it('CC4 truncates a long rejected value in the warning', () => {
    resolveCheckedCommit('x'.repeat(500), '')
    expect(String(warn.mock.calls[0][0])).toContain(`"${'x'.repeat(64)}"`)
    expect(String(warn.mock.calls[0][0])).not.toContain('x'.repeat(65))
  })

  it('CC6 resolves every CLI/env pair exactly as the former inline fallback, warnings included', () => {
    const legacy = (cli: string | undefined, env: string) => {
      const value = (cli?.trim() || env).toLowerCase()
      return value && /^[0-9a-f]{12,64}$/.test(value) ? value : undefined
    }
    for (const cli of [undefined, '', ' ', '\t', H12, ` ${H40.toUpperCase()} `, 'garbage', ' x ']) {
      for (const env of ['', H40, H12.toUpperCase(), 'garbage', ' ']) {
        warn.mockClear()
        expect(resolveCheckedCommit(cli, env), JSON.stringify([cli, env])).toBe(legacy(cli, env))
        expect(warn.mock.calls.length, JSON.stringify([cli, env])).toBe((cli?.trim() || env) && !legacy(cli, env) ? 1 : 0)
      }
    }
  })
})

describe('headMatches', () => {
  it('CC5 equal, 12-char prefix of a 40-char head, 40-char value against a 12-char head', () => {
    expect(headMatches(H40, H40)).toBe(true)
    expect(headMatches(H12, H40)).toBe(true)
    expect(headMatches(H40, H12)).toBe(true)
    expect(headMatches(H40.slice(0, 20), H40)).toBe(true)
  })

  it('CC5 a 64-char SHA-256 head matches itself and its 12-char prefix, either way round', () => {
    expect(headMatches(H64, H64)).toBe(true)
    expect(headMatches(H12, H64)).toBe(true)
    expect(headMatches(H64, H12)).toBe(true)
  })

  it('CC5 mismatch, and an 11-char head never matches', () => {
    expect(headMatches(H40, 'f'.repeat(40))).toBe(false)
    expect(headMatches(`${H12.slice(0, 11)}f`, H40)).toBe(false)
    expect(headMatches(H40, H40.slice(0, 11))).toBe(false)
    expect(headMatches(H40.slice(0, 11), H40.slice(0, 11))).toBe(false)
  })

  it('CC6 compares the head case-insensitively', () => {
    expect(headMatches(H40, H40.toUpperCase())).toBe(true)
    expect(headMatches(H12, H40.toUpperCase())).toBe(true)
  })
})
