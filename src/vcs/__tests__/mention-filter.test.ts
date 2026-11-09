import { describe, it, expect } from 'vitest'
import { decideDirectedElsewhere } from '../mention-filter.js'

// Live PR 82: agent "HeyTech" is NNN:uuid; Fernando (a dev) is legacy 24-hex.
const AGENT_ID = '712020:1257b717-eb9e-4c24-905e-59185f811af3'
const AGENT_UUID = '1886cb80-0000-0000-0000-000000000000'
const FERNANDO = '5cf55f9a3fa1890e7f16e51f'
const AGENT_IDS = new Set([AGENT_ID, AGENT_UUID])
const AGENT_NAMES = new Set(['heytech'])

const decide = (body: string, ids = AGENT_IDS, names = AGENT_NAMES) => decideDirectedElsewhere(body, ids, names)

describe('decideDirectedElsewhere — drop rule', () => {
  it('drops a leading account_id mention of another user (the PR 82 fixture)', () => {
    const d = decide(`@{${FERNANDO}} Hey, there's no need to explicitly point out the fixes`)
    expect(d.drop).toBe(true)
    expect(d.matchedToken).toBe(FERNANDO)
  })

  it('keeps a leading mention of the agent by account_id', () => {
    expect(decide(`@{${AGENT_ID}} why is this HIGH?`).drop).toBe(false)
  })

  it('matches the agent by uuid as a secondary id', () => {
    expect(decide(`@{${AGENT_UUID}} please explain`).drop).toBe(false)
  })

  it('tolerates the @{{uuid}} double-brace echo for the agent', () => {
    expect(decide(`@{{${AGENT_UUID}}} explain`).drop).toBe(false)
  })

  it('drops a leading team/other mention with no agent id anywhere', () => {
    expect(decide(`@{557058:da3d2616-0000-4000-8000-000000000000} can you take this?`).drop).toBe(true)
  })

  it('keeps @{vm.name}-style data-binding (not id-shaped)', () => {
    expect(decide('@{vm.name} is the binding here').drop).toBe(false)
  })

  it('keeps @{vm.name} inside a code fence', () => {
    expect(decide('```xml\nandroid:text="@{vm.name}"\n```\nwhy flag this?').drop).toBe(false)
  })

  it('keeps @{vm.name} inside inline code', () => {
    expect(decide('`@{vm.name}` why?').drop).toBe(false)
  })

  it('keeps an incidental mid-sentence mention of another user', () => {
    expect(decide(`Per @{${FERNANDO}}'s suggestion we did X, why is this HIGH?`).drop).toBe(false)
  })

  it('keeps when a later token is the agent (leading other + agent later)', () => {
    expect(decide(`@{${FERNANDO}} @{${AGENT_ID}} please both look`).drop).toBe(false)
  })

  it('keeps a picker-less plain-text @agentname after a leading other mention', () => {
    expect(decide(`@{${FERNANDO}} @HeyTech please explain`).drop).toBe(false)
  })

  it('keeps everything when the agent id-set is empty', () => {
    expect(decide(`@{${FERNANDO}} anything`, new Set(), new Set()).drop).toBe(false)
  })

  it('parses both legacy 24-hex and NNN:uuid forms as id-shaped', () => {
    expect(decide(`@{${FERNANDO}} x`).drop).toBe(true)
    expect(decide(`@{712020:a48e4db6-0000-4000-8000-000000000000} x`).drop).toBe(true)
  })

  it('keeps a reply with no mention at all', () => {
    expect(decide('Fixed in d4f2b43e.').drop).toBe(false)
  })
})
