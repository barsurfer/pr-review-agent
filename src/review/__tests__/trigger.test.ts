import { describe, it, expect } from 'vitest'
import { isCommentEvent, normalizeAuthorId, resolveTrigger, ignoredCommentAuthor } from '../trigger.js'
import { cliOrEnv } from '../cli-value.js'

const comment = (commentAuthor: string) => ({ event: 'pullrequest:comment_created', commentAuthor })

describe('isCommentEvent', () => {
  it('matches Bitbucket, GitHub and Azure comment events', () => {
    for (const e of ['pullrequest:comment_created', 'pullrequest:comment_reopened', 'issue_comment', 'ms.vss-code.git-pullrequest-comment-event']) {
      expect(isCommentEvent(e)).toBe(true)
    }
  })

  it('rejects non-comment and empty events', () => {
    for (const e of ['pullrequest:updated', 'pullrequest:created', 'pullrequest:fulfilled', 'repo:push', 'pull_request', '']) {
      expect(isCommentEvent(e)).toBe(false)
    }
  })
})

describe('normalizeAuthorId', () => {
  it('strips braces, whitespace and case', () => {
    expect(normalizeAuthorId(' {ABC-1} ')).toBe('abc-1')
    expect(normalizeAuthorId('{ abc-1 }')).toBe('abc-1')
    expect(normalizeAuthorId('557058:Xy')).toBe('557058:xy')
    expect(normalizeAuthorId('{}')).toBe('')
  })
})

describe('resolveTrigger', () => {
  const env = { event: 'pullrequest:updated', commentAuthor: '{env-uuid}' }

  it('CLI wins over env', () => {
    expect(resolveTrigger({ event: 'pullrequest:comment_created', commentAuthor: '{cli}' }, env))
      .toEqual({ event: 'pullrequest:comment_created', commentAuthor: '{cli}' })
  })

  it('an empty or whitespace CLI value falls back to env, per field', () => {
    expect(resolveTrigger({ event: '', commentAuthor: '  ' }, env)).toEqual(env)
    expect(resolveTrigger({ event: ' pullrequest:comment_created ' }, env)).toEqual({ event: 'pullrequest:comment_created', commentAuthor: '{env-uuid}' })
  })

  it('is undefined when nothing is given anywhere', () => {
    expect(resolveTrigger({}, { event: '', commentAuthor: '' })).toBeUndefined()
    expect(resolveTrigger({ event: ' ', commentAuthor: '' }, { event: '', commentAuthor: '' })).toBeUndefined()
  })

  it('keeps a lone event or a lone author', () => {
    expect(resolveTrigger({ event: 'pullrequest:updated' }, { event: '', commentAuthor: '' })).toEqual({ event: 'pullrequest:updated', commentAuthor: '' })
    expect(resolveTrigger({ commentAuthor: '{a}' }, { event: '', commentAuthor: '' })).toEqual({ event: '', commentAuthor: '{a}' })
  })

  it('resolves every CLI/env combination exactly as the former inline fallback', () => {
    const values = [undefined, '', ' ', '\t\n', 'x', ' x ', '{X}']
    const envs = ['', 'e', ' e ']
    for (const event of values) for (const commentAuthor of values) for (const envEvent of envs) for (const envAuthor of envs) {
      const e = event?.trim() || envEvent
      const a = commentAuthor?.trim() || envAuthor
      const legacy = e || a ? { event: e, commentAuthor: a } : undefined
      expect(resolveTrigger({ event, commentAuthor }, { event: envEvent, commentAuthor: envAuthor }), JSON.stringify([event, commentAuthor, envEvent, envAuthor])).toEqual(legacy)
    }
  })
})

describe('cliOrEnv (shared CLI-over-env fallback)', () => {
  it('is the trimmed CLI value when non-empty, else the env value untouched', () => {
    for (const cli of [undefined, '', ' ', '\t\n', 'x', ' x ', '0']) {
      for (const env of ['', 'e', ' e ']) expect(cliOrEnv(cli, env), JSON.stringify([cli, env])).toBe(cli?.trim() || env)
    }
    expect(cliOrEnv(' a ', 'e')).toBe('a')
    expect(cliOrEnv('  ', ' e ')).toBe(' e ')
  })
})

describe('ignoredCommentAuthor', () => {
  it('matches a listed author on a comment event, across brace and case variants, and returns the entry', () => {
    expect(ignoredCommentAuthor(comment('{BOT-UUID}'), ['other', 'bot-uuid'])).toBe('bot-uuid')
    expect(ignoredCommentAuthor(comment('bot-uuid'), ['{Bot-Uuid}'])).toBe('{Bot-Uuid}')
  })

  it('never skips a non-comment event from a listed author (a bot push)', () => {
    for (const event of ['pullrequest:updated', 'pullrequest:created', 'pullrequest:fulfilled']) {
      expect(ignoredCommentAuthor({ event, commentAuthor: '{bot}' }, ['bot'])).toBeNull()
    }
  })

  it('never skips without an event, without an author, or with an empty list', () => {
    expect(ignoredCommentAuthor({ event: '', commentAuthor: 'bot' }, ['bot'])).toBeNull()
    expect(ignoredCommentAuthor(comment(''), ['bot'])).toBeNull()
    expect(ignoredCommentAuthor(comment('{}'), ['{}'])).toBeNull()
    expect(ignoredCommentAuthor(comment('bot'), [])).toBeNull()
  })

  it('has no substring or wildcard match', () => {
    expect(ignoredCommentAuthor(comment('bot2'), ['bot'])).toBeNull()
    expect(ignoredCommentAuthor(comment('bot'), ['bot2'])).toBeNull()
    expect(ignoredCommentAuthor(comment('xbot'), ['*bot'])).toBeNull()
  })
})
