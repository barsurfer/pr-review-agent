import { describe, it, expect, beforeAll } from 'vitest'

// config.ts calls required('ANTHROPIC_API_KEY') at import, so set it before the dynamic import.
let modelContextWindow: (model: string) => number
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;({ modelContextWindow } = await import('../config.js'))
})

describe('modelContextWindow', () => {
  it('maps 4.5-generation reviewers to 200K', () => {
    expect(modelContextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(modelContextWindow('claude-sonnet-4-5-20250929')).toBe(200_000)
    expect(modelContextWindow('claude-opus-4-5')).toBe(200_000)
  })

  it('maps 4.6+/5.x reviewers (incl. Haiku 5.5) to 1M', () => {
    expect(modelContextWindow('claude-haiku-5-5')).toBe(1_000_000)
    expect(modelContextWindow('claude-sonnet-4-6')).toBe(1_000_000)
    expect(modelContextWindow('claude-sonnet-5')).toBe(1_000_000)
    expect(modelContextWindow('claude-sonnet-5-5')).toBe(1_000_000)
    expect(modelContextWindow('claude-opus-4-8')).toBe(1_000_000)
    expect(modelContextWindow('claude-opus-5-5')).toBe(1_000_000)
  })

  it('falls back to a conservative 200K for an unmapped model', () => {
    expect(modelContextWindow('claude-something-7')).toBe(200_000)
  })
})
