import { describe, it, expect, vi, afterEach } from 'vitest'

// provider.ts imports config, which requires ANTHROPIC_API_KEY at load — mock it so this
// pure-helper test doesn't depend on the env (CI has no .env).
vi.mock('../../config.js', () => ({ config: { llmProvider: 'anthropic', anthropic: { baseUrl: '', workspaceId: '' } } }))

import { missingRequired, anthropicBaseUrl, anthropicClientOptions } from '../provider.js'
import { config } from '../../config.js'

const cfg = config as unknown as { anthropic: { baseUrl: string; workspaceId: string } }

describe('anthropicClientOptions', () => {
  afterEach(() => { cfg.anthropic.baseUrl = ''; cfg.anthropic.workspaceId = '' })

  it('passes only the apiKey by default', () => {
    expect(anthropicClientOptions('k')).toEqual({ apiKey: 'k' })
  })

  it('adds the anthropic-workspace-id header when ANTHROPIC_WORKSPACE_ID is set', () => {
    cfg.anthropic.workspaceId = 'wrksp_123'
    expect(anthropicClientOptions('k')).toEqual({ apiKey: 'k', defaultHeaders: { 'anthropic-workspace-id': 'wrksp_123' } })
  })

  it('adds a normalized baseURL when set', () => {
    cfg.anthropic.baseUrl = 'https://api.anthropic.com/v1/'
    expect(anthropicClientOptions('k')).toEqual({ apiKey: 'k', baseURL: 'https://api.anthropic.com' })
  })
})

describe('anthropicBaseUrl', () => {
  it('is undefined when unset, keeping the SDK default', () => {
    expect(anthropicBaseUrl('')).toBeUndefined()
    expect(anthropicBaseUrl('  ')).toBeUndefined()
  })

  it.each([
    ['https://api.anthropic.com', 'https://api.anthropic.com'],
    ['https://api.anthropic.com/', 'https://api.anthropic.com'],
    ['https://api.anthropic.com/v1', 'https://api.anthropic.com'],
    ['https://proxy.example.com/anthropic/v1/', 'https://proxy.example.com/anthropic'],
  ])('%s → %s (the SDK appends /v1/messages itself)', (input, expected) => {
    expect(anthropicBaseUrl(input)).toBe(expected)
  })
})

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
