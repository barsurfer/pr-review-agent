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
    const lines = [buildRootMarker('F7', C), buildAnswerMarker('F7', '1'), buildNoteMarker('F7'), buildStateLine(2, [C], '0123456789abcdef'), ...SUMMARY_HEADER.split('\n')]
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
