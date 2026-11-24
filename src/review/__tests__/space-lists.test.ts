import { describe, it, expect } from 'vitest'
import { spaceLists } from '../formatter.js'

describe('spaceLists', () => {
  it('adds a blank line between a paragraph and a list', () => {
    expect(spaceLists('Intro:\n- a\n- b')).toBe('Intro:\n\n- a\n- b')
  })
  it('handles numbered 1. and 1) items', () => {
    expect(spaceLists('Steps:\n1. a\n2. b')).toBe('Steps:\n\n1. a\n2. b')
    expect(spaceLists('Steps:\n1) a\n2) b')).toBe('Steps:\n\n1) a\n2) b')
  })
  it('leaves spaced lists, continuations and fenced lists alone', () => {
    for (const t of ['Intro:\n\n- a\n- b', '- a\n  more\n- b', 'x\n\n```\ntext\n- a\n```', 'x\n~~~\ntext\n1. a\n~~~']) expect(spaceLists(t)).toBe(t)
  })
  it('is idempotent', () => {
    const once = spaceLists('Intro:\n- a\n\ntext\n1. b')
    expect(spaceLists(once)).toBe(once)
  })
})
