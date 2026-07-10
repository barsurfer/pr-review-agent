import { describe, it, expect, vi } from 'vitest'

// provider.ts imports config, which requires ANTHROPIC_API_KEY at load — mock it so this
// pure-helper test doesn't depend on the env (CI has no .env).
vi.mock('../../config.js', () => ({ config: { llmProvider: 'anthropic' } }))

import { missingRequired } from '../provider.js'

describe('missingRequired', () => {
  const schema = { required: ['a', 'b'] } as Record<string, unknown>

  it('returns [] when all required keys are present', () => {
    expect(missingRequired({ a: 1, b: 2, c: 3 }, schema)).toEqual([])
  })

  it('lists the missing required keys', () => {
    expect(missingRequired({ a: 1 }, schema)).toEqual(['b'])
  })

  it('treats null / non-object as all-missing', () => {
    expect(missingRequired(null, schema)).toEqual(['a', 'b'])
  })

  it('returns [] when the schema has no required list', () => {
    expect(missingRequired({}, {})).toEqual([])
  })
})
