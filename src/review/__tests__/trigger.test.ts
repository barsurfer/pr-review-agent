import { describe, it, expect } from 'vitest'
import { vi, afterEach } from 'vitest'
import { isCommentEvent, normalizeAuthorId, resolveTrigger, ignoredCommentAuthor } from '../trigger.js'
import { isCommentTrigger } from '../trigger.js'
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

describe('isCommentEvent: provider event names', () => {
  const legacy = (event: string) => /comment/i.test(event)
  const NEWLY_COMMENT = ['note', 'Note Hook', 'pull_request_review']
  const TABLE: Array<[provider: string, event: string, comment: boolean]> = [
    ...['pullrequest:comment_created', 'pullrequest:comment_updated', 'pullrequest:comment_deleted', 'pullrequest:comment_resolved', 'pullrequest:comment_reopened']
      .map(e => ['bitbucket', e, true] as [string, string, boolean]),
    ...['pullrequest:created', 'pullrequest:updated', 'pullrequest:approved', 'pullrequest:unapproved', 'pullrequest:changes_request_created',
      'pullrequest:changes_request_removed', 'pullrequest:fulfilled', 'pullrequest:rejected', 'repo:push']
      .map(e => ['bitbucket', e, false] as [string, string, boolean]),
    ...['pr:comment:added', 'pr:comment:edited', 'pr:comment:deleted'].map(e => ['bitbucket-dc', e, true] as [string, string, boolean]),
    ...['pr:opened', 'pr:from_ref_updated', 'pr:modified', 'pr:merged', 'pr:declined', 'pr:reviewer:approved'].map(e => ['bitbucket-dc', e, false] as [string, string, boolean]),
    ...['issue_comment', 'pull_request_review_comment', 'pull_request_review'].map(e => ['github', e, true] as [string, string, boolean]),
    ...['pull_request', 'pull_request_target', 'push', 'pull_request_review_thread', 'pull_request_review.submitted', 'opened', 'synchronize', 'edited', 'reopened']
      .map(e => ['github', e, false] as [string, string, boolean]),
    ['azure', 'ms.vss-code.git-pullrequest-comment-event', true],
    ...['git.pullrequest.created', 'git.pullrequest.updated', 'git.pullrequest.merged', 'git.push', 'PullRequest'].map(e => ['azure', e, false] as [string, string, boolean]),
    ...['note', 'Note Hook', 'note hook', 'NOTE'].map(e => ['gitlab', e, true] as [string, string, boolean]),
    ...['merge_request_event', 'Merge Request Hook', 'merge_request', 'push', 'Push Hook', 'Tag Push Hook', 'trigger', 'notes', 'note_hook']
      .map(e => ['gitlab', e, false] as [string, string, boolean]),
  ]

  it.each(TABLE)('%s %s → comment=%s', (_provider, event, expected) => {
    expect(isCommentEvent(event)).toBe(expected)
  })

  it('only the GitLab note and GitHub review names change class; every other name keeps the substring rule', () => {
    for (const [, event] of TABLE) {
      const changed = NEWLY_COMMENT.some(n => n.toLowerCase() === event.toLowerCase())
      expect(isCommentEvent(event), event).toBe(changed ? true : legacy(event))
      if (changed) expect(legacy(event), event).toBe(false)
    }
  })

  it('surrounding whitespace (an untrimmed env value) changes no class: exact names still match, every other name keeps the substring rule', () => {
    for (const [, event, expected] of TABLE) {
      for (const padded of [` ${event}`, `${event} `, `\t${event}\n`]) {
        expect(isCommentEvent(padded), JSON.stringify(padded)).toBe(expected)
      }
    }
  })
})

describe('event kind override (--event-kind / TRIGGER_EVENT_KIND)', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const NONE = { event: '', commentAuthor: '' }

  it('kind decides over the name, both ways; no kind keeps the name rule', () => {
    expect(isCommentTrigger({ event: 'relay:pr-note', commentAuthor: 'a', kind: 'comment' })).toBe(true)
    expect(isCommentTrigger({ event: 'pullrequest:comment_created', commentAuthor: 'a', kind: 'other' })).toBe(false)
    expect(isCommentTrigger({ event: '', commentAuthor: 'a', kind: 'comment' })).toBe(true)
    expect(isCommentTrigger({ event: 'pullrequest:comment_created', commentAuthor: 'a' })).toBe(true)
    expect(isCommentTrigger({ event: 'relay:pr-note', commentAuthor: 'a' })).toBe(false)
  })

  it('ignoredCommentAuthor follows the kind', () => {
    expect(ignoredCommentAuthor({ event: 'relay:pr-note', commentAuthor: '{BOT}', kind: 'comment' }, ['bot'])).toBe('bot')
    expect(ignoredCommentAuthor({ event: 'pullrequest:comment_created', commentAuthor: '{BOT}', kind: 'other' }, ['bot'])).toBeNull()
    expect(ignoredCommentAuthor({ event: 'relay:pr-note', commentAuthor: '{BOT}' }, ['bot'])).toBeNull()
  })

  it('resolves CLI over env, an empty CLI value falls back, and the value is trimmed and case-insensitive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveTrigger({ event: 'e', eventKind: 'other' }, { ...NONE, eventKind: 'comment' })).toEqual({ event: 'e', commentAuthor: '', kind: 'other' })
    expect(resolveTrigger({ event: 'e', eventKind: ' ' }, { ...NONE, eventKind: 'comment' })).toEqual({ event: 'e', commentAuthor: '', kind: 'comment' })
    expect(resolveTrigger({ commentAuthor: 'a', eventKind: ' Comment ' }, NONE)).toEqual({ event: '', commentAuthor: 'a', kind: 'comment' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('no kind given: the result has no kind key, exactly as before', () => {
    const r = resolveTrigger({ event: 'e' }, { ...NONE, eventKind: '' })
    expect(r).toEqual({ event: 'e', commentAuthor: '' })
    expect('kind' in r!).toBe(false)
  })

  it('a kind alone, without event or author, gives no trigger', () => {
    expect(resolveTrigger({ eventKind: 'comment' }, NONE)).toBeUndefined()
  })

  it('an invalid kind warns once and is ignored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = resolveTrigger({ event: 'pullrequest:comment_created', commentAuthor: 'a' }, { ...NONE, eventKind: 'Comments' })
    expect(r).toEqual({ event: 'pullrequest:comment_created', commentAuthor: 'a' })
    expect('kind' in r!).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Warning: ignoring the event kind "comments" (--event-kind/TRIGGER_EVENT_KIND) - expected comment or other')
  })

  it('an invalid kind warns even when no event or author was given', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveTrigger({ eventKind: 'yes' }, NONE)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
