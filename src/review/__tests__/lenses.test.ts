import { describe, it, expect } from 'vitest'
import { LENS_REGISTRY, LENS_REASON_CAP, parseLensList, lensSystemPrompt, lensBriefing, sanitizeLensRecommendations } from '../lenses.js'
import { breadthSystemPrompt, BREADTH_LENS, SHOWN_LINE_CLAUSE } from '../breadth.js'
import type { ReviewFinding } from '../formatter.js'

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({ severity: 'MEDIUM', title: 'Bug', file: 'src/a.ts', lines: '1', body: 'b', ...over })

const NAMES = ['reliability', 'security', 'testing', 'performance', 'architecture']

describe('LENS_REGISTRY', () => {
  it('holds exactly the starter lenses, keyed by name', () => {
    expect(Object.keys(LENS_REGISTRY).sort()).toEqual([...NAMES].sort())
    for (const [key, lens] of Object.entries(LENS_REGISTRY)) expect(lens.name).toBe(key)
  })

  it.each(NAMES)('%s overlay has its heading, the scope lock, and exactly one shown-line clause', name => {
    const { overlay } = LENS_REGISTRY[name]
    expect(overlay.startsWith(`## ${name.toUpperCase()} LENS\n`)).toBe(true)
    expect(overlay).toContain('added or modified lines')
    expect(overlay).toContain('no audit of unchanged code')
    expect(overlay).toContain('When confidence is limited but potential impact is high (data loss, security, corruption), report it with an explicit note on what remains uncertain — do not silently drop it.')
    expect(overlay).not.toMatch(/not shown|unshown/)
    expect(overlay.split(SHOWN_LINE_CLAUSE)).toHaveLength(2)
    expect(overlay.endsWith('Return an empty list if you find nothing.')).toBe(true)
  })

  it('architecture lens reports a caller/consumer mismatch only when both sides were shown', () => {
    expect(LENS_REGISTRY.architecture.overlay).toContain('Report a mismatch with callers, consumers or implementations only when both sides are visible in what you were shown.')
  })

  it('testing lens reports a missing test only when the tests for the changed area were shown', () => {
    expect(LENS_REGISTRY.testing.overlay).toContain('a test absent from the diff is not evidence none exists: report a missing test only when the shown diff or file context includes the tests for the changed area and they skip the new behavior.')
  })
})

describe('parseLensList', () => {
  const names = (value: string) => parseLensList(value).lenses.map(l => l.name)

  it('accepts plus and comma separators, keeping the given order', () => {
    expect(names('reliability+security')).toEqual(['reliability', 'security'])
    expect(names('performance,testing')).toEqual(['performance', 'testing'])
  })

  it('trims, lowercases, drops empties and mixes separators', () => {
    expect(names(' Security + ,RELIABILITY ,, architecture+ ')).toEqual(['security', 'reliability', 'architecture'])
  })

  it('dedupes, keeping first-seen order', () => {
    expect(names('testing+security+Testing,security')).toEqual(['testing', 'security'])
  })

  it('returns nothing for empty or blank input', () => {
    expect(parseLensList('')).toEqual({ lenses: [], unknown: [] })
    expect(parseLensList('  , + ')).toEqual({ lenses: [], unknown: [] })
  })

  it('reports unknown names while still resolving known ones', () => {
    const res = parseLensList('security+style,Docs+security')
    expect(res.lenses).toEqual([LENS_REGISTRY.security])
    expect(res.unknown).toEqual(['style', 'docs'])
  })

  it('does not resolve inherited object keys', () => {
    expect(parseLensList('constructor+toString')).toEqual({ lenses: [], unknown: ['constructor', 'tostring'] })
  })
})

describe('lensSystemPrompt', () => {
  const lens = LENS_REGISTRY.reliability

  it('appends the overlay to the reviewer prompt', () => {
    expect(lensSystemPrompt('P', lens, 0)).toBe(`P\n\n${lens.overlay}`)
  })

  it('uses the same findings-limit section as the breadth pass', () => {
    const limitOf = (prompt: string, suffix: string) => prompt.slice(0, prompt.length - suffix.length)
    expect(limitOf(lensSystemPrompt('P', lens, 7), lens.overlay)).toBe(limitOf(breadthSystemPrompt('P', 7), BREADTH_LENS))
    expect(lensSystemPrompt('P', lens, 7)).toContain('## FINDINGS LIMIT\nReport at most 7 findings')
  })

  it.each(NAMES)('%s swaps in the shown-line allowance only when asked', name => {
    const text = lensSystemPrompt('P', LENS_REGISTRY[name], 0, true)
    expect(text).toContain('or on an unchanged line you were shown when it explains a defect this change introduces')
    expect(lensSystemPrompt('P', LENS_REGISTRY[name], 0)).not.toContain('unchanged line you were shown')
  })
})

describe('lensBriefing', () => {
  it('lists known findings as anchor + title only, scoped to the whole diff', () => {
    const out = lensBriefing([finding({ body: 'LONG BODY' }), finding({ lines: undefined, title: 'File-level' }), finding({ file: undefined, title: 'PR-level' })])
    expect(out).toContain('- src/a.ts:1 — Bug')
    expect(out).toContain('- src/a.ts — File-level')
    expect(out).toContain('- (no file) — PR-level')
    expect(out).not.toContain('LONG BODY')
    expect(out).toContain('across the whole diff')
    expect(out).not.toContain('in these files')
  })

  it('says None. when nothing is known', () => {
    expect(lensBriefing([])).toMatch(/\):\nNone\.$/)
  })
})

describe('lens trigger phrases', () => {
  it.each(NAMES)('%s has a short one-phrase trigger that is not part of its overlay', name => {
    const { when, overlay } = LENS_REGISTRY[name]
    expect(when.trim()).toBe(when)
    expect(when.length).toBeGreaterThan(0)
    expect(when.length).toBeLessThanOrEqual(120)
    expect(when).not.toMatch(/[.;\n]/)
    expect(overlay).not.toContain(when)
  })
})

describe('sanitizeLensRecommendations', () => {
  it('keeps known lenses in order with trimmed reasons', () => {
    expect(sanitizeLensRecommendations([{ lens: 'security', reason: '  new /login endpoint ' }, { lens: 'reliability', reason: 'retry loop' }]))
      .toEqual([{ lens: 'security', reason: 'new /login endpoint' }, { lens: 'reliability', reason: 'retry loop' }])
  })

  it('drops unknown and inherited names, and wrong-case names the enum would reject', () => {
    expect(sanitizeLensRecommendations([{ lens: 'style', reason: 'x' }, { lens: 'constructor', reason: 'x' }, { lens: 'Security', reason: 'x' }, { lens: 'testing', reason: 'y' }]))
      .toEqual([{ lens: 'testing', reason: 'y' }])
  })

  it('dedupes by lens, first wins', () => {
    expect(sanitizeLensRecommendations([{ lens: 'performance', reason: 'first' }, { lens: 'performance', reason: 'second' }]))
      .toEqual([{ lens: 'performance', reason: 'first' }])
  })

  it('caps a long reason', () => {
    const [rec] = sanitizeLensRecommendations([{ lens: 'architecture', reason: `  ${'x'.repeat(LENS_REASON_CAP + 50)}` }])!
    expect(LENS_REASON_CAP).toBe(200)
    expect(rec.reason).toBe('x'.repeat(LENS_REASON_CAP))
  })

  it('collapses inner whitespace so the reason stays on one log line', () => {
    expect(sanitizeLensRecommendations([{ lens: 'security', reason: '\n new\t/login\r\n\n  endpoint ' }]))
      .toEqual([{ lens: 'security', reason: 'new /login endpoint' }])
  })

  it('returns null when the field is missing or not an array, [] for an empty one, and skips malformed items', () => {
    expect(sanitizeLensRecommendations(undefined)).toBeNull()
    expect(sanitizeLensRecommendations(null)).toBeNull()
    expect(sanitizeLensRecommendations('security')).toBeNull()
    expect(sanitizeLensRecommendations([])).toEqual([])
    expect(sanitizeLensRecommendations([null, 'security', { reason: 'no lens' }, { lens: 'security', reason: 7 }]))
      .toEqual([{ lens: 'security', reason: '' }])
  })
})
