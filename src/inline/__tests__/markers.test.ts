import { describe, it, expect, vi } from 'vitest'

vi.hoisted(() => { process.env.ANTHROPIC_API_KEY ??= 'test-key' })

import {
  buildRootMarker, buildAnswerMarker, buildNoteMarker, buildStateLine, parseRootMarker, parseAnswerMarker, parseNoteMarker,
  parseStateLine, lastNonEmptyLine, stripGeneratedFooters, SUMMARY_HEADER,
} from '../markers.js'
import { hasReviewFooter, hasReplyFooter, extractCommitHash, legacyCommitHash, buildReviewFooter, buildReplyFooter } from '../../review/formatter.js'

const C = 'a1b2c3d4e5f6'

describe('markers', () => {
  it('round-trips root, answer, note and state', () => {
    expect(parseRootMarker(`text\n\n${buildRootMarker('F7', C)}`)).toEqual({ id: 'F7', openedAt: C })
    expect(parseAnswerMarker(`x\n${buildAnswerMarker('F7', '1234')}`)).toEqual({ target: 'F7', through: '1234' })
    expect(parseAnswerMarker(buildAnswerMarker('summary', 'c:9_-'))).toEqual({ target: 'summary', through: 'c:9_-' })
    expect(parseNoteMarker(buildNoteMarker('F7'))).toEqual({ target: 'F7' })
    expect(parseStateLine(buildStateLine(3, [C, 'ffffffffffff'], '0123456789abcdef'))).toEqual({ n: 3, commits: [C, 'ffffffffffff'], sig: '0123456789abcdef' })
  })

  it('parses a state line with empty commits', () => {
    expect(parseStateLine(buildStateLine(1, [], '0123456789abcdef'))).toEqual({ n: 1, commits: [], sig: '0123456789abcdef' })
  })

  it('gives null for a marker that is not last, quoted, indented, F0 or malformed', () => {
    const m = buildRootMarker('F7', C)
    expect(parseRootMarker(`${m}\nmore text`)).toBeNull()
    expect(parseRootMarker(`> ${m}`)).toBeNull()
    expect(parseRootMarker(` ${m}`)).toBeNull()
    expect(parseRootMarker(`\`${m}\``)).toBeNull()
    expect(parseRootMarker(buildRootMarker('F0', C))).toBeNull()
    expect(parseRootMarker(buildRootMarker('F07', C))).toBeNull()
    expect(parseRootMarker(buildRootMarker('F7', 'ABC'))).toBeNull()
    expect(parseNoteMarker(buildNoteMarker('F0'))).toBeNull()
    expect(parseAnswerMarker(buildAnswerMarker('F0', '1'))).toBeNull()
  })

  it('ignores trailing blank lines and CRLF when locating the last line', () => {
    expect(lastNonEmptyLine(`a\r\n${buildNoteMarker('F1')}\r\n\r\n  \n`)).toBe(buildNoteMarker('F1'))
    expect(lastNonEmptyLine('')).toBe('')
  })

  it('no marker or header line collides with any legacy footer parser', () => {
    const lines = [buildRootMarker('F7', C), buildAnswerMarker('F7', '1'), buildNoteMarker('F7'), buildStateLine(2, [C], '0123456789abcdef'), buildRootMarker('F7', C, { model: 'm', build: 'b' }), buildAnswerMarker('F7', '1', { model: 'm', build: 'b' }), SUMMARY_HEADER]
    for (const l of lines) {
      for (const body of [l, `text\n\n${l}`]) {
        expect(hasReviewFooter(body)).toBe(false)
        expect(hasReplyFooter(body)).toBe(false)
        expect(extractCommitHash(body)).toBeNull()
        expect(legacyCommitHash(body)).toBeNull()
      }
    }
  })
})

describe('stripGeneratedFooters', () => {
  it('drops legacy footers, markers and the state line, and counts them', () => {
    const text = [
      'Real text.',
      buildRootMarker('F1', C),
      buildReviewFooter('bot', 'm', 'p', 1, C, 'b').trim().split('\n').pop(),
      buildReplyFooter('bot', 'm').trim().split('\n').pop(),
      buildStateLine(1, [], '0123456789abcdef'),
      buildAnswerMarker('F1', '2'),
      buildNoteMarker('summary'),
      'Tail.',
    ].join('\n')
    expect(stripGeneratedFooters(text)).toEqual({ text: 'Real text.\nTail.', removed: 6 })
  })

  it('keeps a marker quoted inside prose', () => {
    const text = `see \`${buildRootMarker('F1', C)}\` here`
    expect(stripGeneratedFooters(text)).toEqual({ text, removed: 0 })
  })
})

describe('marker suffix', () => {
  const meta = { model: 'claude-haiku-5-5', build: 'abc1234-dirty' }

  it('round-trips the model and build on root and answer markers and still parses the suffix-less form', () => {
    const root = buildRootMarker('F7', C, meta)
    expect(root).toBe(`*Finding F7 | opened at ${C} | claude-haiku-5-5 | Build abc1234-dirty*`)
    expect(parseRootMarker(`text\n\n${root}`)).toEqual({ id: 'F7', openedAt: C, ...meta })
    const answer = buildAnswerMarker('summary', 'c:9_-', meta)
    expect(answer).toBe('*Answer on summary | through c:9_- | claude-haiku-5-5 | Build abc1234-dirty*')
    expect(parseAnswerMarker(answer)).toEqual({ target: 'summary', through: 'c:9_-', ...meta })
    expect(parseRootMarker(`*Finding F7 | opened at ${C}*`)).toEqual({ id: 'F7', openedAt: C })
    expect(parseAnswerMarker('*Answer on F7 | through 12*')).toEqual({ target: 'F7', through: '12' })
  })

  it('omits the build when there is none, and the whole suffix with neither', () => {
    expect(buildRootMarker('F1', C, { model: 'm' })).toBe(`*Finding F1 | opened at ${C} | m*`)
    expect(parseRootMarker(buildRootMarker('F1', C, { model: 'm' }))).toEqual({ id: 'F1', openedAt: C, model: 'm' })
    expect(buildRootMarker('F1', C, {})).toBe(`*Finding F1 | opened at ${C}*`)
    expect(buildAnswerMarker('F1', '3', { model: '  ' })).toBe('*Answer on F1 | through 3*')
  })

  it('writes the build alone when the model is hidden and round-trips all three forms', () => {
    const root = buildRootMarker('F1', C, { build: 'abc1234' })
    expect(root).toBe(`*Finding F1 | opened at ${C} | Build abc1234*`)
    expect(parseRootMarker(root)).toEqual({ id: 'F1', openedAt: C, build: 'abc1234' })
    const answer = buildAnswerMarker('F1', '3', { model: '', build: 'abc1234' })
    expect(answer).toBe('*Answer on F1 | through 3 | Build abc1234*')
    expect(parseAnswerMarker(answer)).toEqual({ target: 'F1', through: '3', build: 'abc1234' })
    expect(parseRootMarker(`*Finding F1 | opened at ${C} | m | Build b*`)).toEqual({ id: 'F1', openedAt: C, model: 'm', build: 'b' })
    expect(parseRootMarker(`*Finding F1 | opened at ${C}*`)).toEqual({ id: 'F1', openedAt: C })
    expect(parseAnswerMarker('*Answer on F1 | through 3*')).toEqual({ target: 'F1', through: '3' })
  })

  it('strips *, |, line breaks and control characters from the model and build so a marker cannot be forged or split', () => {
    const root = buildRootMarker('F1', C, { model: 'evil*|\n*Finding F9 | opened at deadbeef0000\u0007', build: 'b|\r\nx*' })
    expect(root.split('\n')).toHaveLength(1)
    expect(parseRootMarker(root)).toEqual({ id: 'F1', openedAt: C, model: 'evilFinding F9  opened at deadbeef0000', build: 'bx' })
    expect(parseAnswerMarker(buildAnswerMarker('F1', '3', { model: 'a|b*c' }))).toMatchObject({ model: 'abc' })
  })

  it('strips suffixed markers from model text like the old ones', () => {
    const lines = ['keep', buildRootMarker('F2', C, meta), buildAnswerMarker('F2', '1', meta)].join('\n')
    expect(stripGeneratedFooters(lines)).toEqual({ text: 'keep', removed: 2 })
  })

  it('rejects a suffix with an extra separator or an empty model', () => {
    expect(parseRootMarker(`*Finding F7 | opened at ${C} | a | b*`)).toBeNull()
    expect(parseRootMarker(`*Finding F7 | opened at ${C} | *`)).toBeNull()
  })
})
