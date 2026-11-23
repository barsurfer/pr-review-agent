import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative, sep } from 'path'
import { fileURLToPath } from 'url'
import { TokenEstimator, defaultTokenEstimator } from '../token-estimator.js'

describe('TokenEstimator', () => {
  it('defaults to 4 chars per token', () => {
    expect(new TokenEstimator().charsPerToken).toBe(4)
    expect(defaultTokenEstimator.charsPerToken).toBe(4)
  })

  it('rounds up and maps zero to zero', () => {
    expect(defaultTokenEstimator.estimate(0)).toBe(0)
    expect(defaultTokenEstimator.estimate(1)).toBe(1)
    expect(defaultTokenEstimator.estimate(4)).toBe(1)
    expect(defaultTokenEstimator.estimate(5)).toBe(2)
    expect(defaultTokenEstimator.estimate(69_720 * 4 - 3)).toBe(69_720)
  })

  it('honours a custom ratio', () => {
    expect(new TokenEstimator(2).estimate(5)).toBe(3)
    expect(new TokenEstimator(3).estimate(9)).toBe(3)
  })
})

// A /4 outside the estimator would silently skip any later ratio change or calibration.
const ALLOWED: { file: string; line: string; reason: string }[] = []

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const ESTIMATOR = 'review/token-estimator.ts'
const DIV_BY_FOUR = /\/\s*4(?![\w.])/g

// Blanks comments and string/template contents (keeping newlines) so only code reaches the matcher.
function stripNonCode(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      out += c
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += ' '; i++ }
        if (c !== '`' && src[i] === '\n') break
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < src.length && src[i] === c) { out += c; i++ }
    } else {
      out += c
      i++
    }
  }
  return out
}

function findDivByFour(src: string): number[] {
  const code = stripNonCode(src)
  return [...code.matchAll(DIV_BY_FOUR)].map(m => code.slice(0, m.index).split('\n').length)
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === '__fixtures__' ? [] : sources(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : []
  })
}

describe('division-by-4 matcher', () => {
  it.each([
    'Math.ceil((a.length + b.length) / 4)',
    'Math.ceil((a.length+b.length)/4)',
    'const t = x.length / 4',
    'const t = chars/4;',
    'Math.ceil(\n  (a.length +\n b.length) /\n 4)',
  ])('matches %j', code => {
    expect(findDivByFour(code).length).toBeGreaterThan(0)
  })

  it.each([
    '// chars / 4 is the estimate',
    '/* x / 4 */',
    'const s = "x / 4"',
    'const s = `x / 4 ${y}`',
    'const t = x / 40',
    'const t = x / 4.5',
    'const t = x / 4_000',
  ])('ignores %j', code => {
    expect(findDivByFour(code)).toEqual([])
  })
})

describe('no hand-written token estimate', () => {
  it('keeps chars/4 inside the estimator module', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/')
      if (rel === ESTIMATOR) continue
      const text = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n')
      const lines = text.split('\n')
      for (const n of findDivByFour(text)) {
        const line = lines[n - 1].trim()
        if (ALLOWED.some(a => a.file === rel && a.line === line)) continue
        offenders.push(`${rel}:${n}: ${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
