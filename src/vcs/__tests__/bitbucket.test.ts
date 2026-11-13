import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BitbucketAdapter } from '../bitbucket.js'
import { buildReviewFooter, buildReplyFooter } from '../../review/formatter.js'

// ---------------------------------------------------------------------------
// Agent comment detection against a realistic PR thread.
// If detection breaks, the agent stops recognizing its own comments:
// dedup fails (re-review on every trigger) and the reply flow can answer
// its own replies — both are loop conditions. These tests pin the wiring
// using the REAL footer builders.
// ---------------------------------------------------------------------------

const { clientMock } = vi.hoisted(() => ({
  clientMock: { get: vi.fn(), post: vi.fn() },
}))

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => clientMock),
    get: vi.fn(),
    isAxiosError: vi.fn(() => false),
  },
}))

function comment(id: number, body: string, createdOn: string, author = 'Dev One', parentId?: number) {
  return {
    id,
    parent: parentId ? { id: parentId } : undefined,
    content: { raw: body },
    user: { display_name: author },
    created_on: createdOn,
  }
}

const REVIEW_BODY = '### Summary\nAll good.' + buildReviewFooter('bot@co.com', 'claude-haiku-4-5-20251001', 'repo', 1, 'aabbcc112233', '919a10b')
const AGENT_REPLY_BODY = 'Because the null path is unguarded.' + buildReplyFooter('bot@co.com', 'claude-haiku-4-5-20251001')

function makeAdapter(): BitbucketAdapter {
  const adapter = new BitbucketAdapter('https://api.bitbucket.org/2.0', 'ws', 'bot@co.com', 'token')
  adapter.setRepoSlug('repo')
  return adapter
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getPreviousReviewComments — agent review detection', () => {
  it('returns only comments carrying the real agent footer', async () => {
    clientMock.get.mockResolvedValue({
      data: {
        values: [
          comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
          comment(2, 'Reviewed by me, LGTM', '2026-07-01T11:00:00Z'),
          comment(3, 'Please split this PR', '2026-07-01T11:05:00Z'),
          comment(4, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', 'Review Bot', 1),
        ],
      },
    })

    const reviews = await makeAdapter().getPreviousReviewComments('100')

    expect(reviews.map(r => r.id)).toEqual(['1'])
  })

  it('ignores deleted comments (tombstones)', async () => {
    clientMock.get.mockResolvedValue({
      data: {
        values: [
          comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
          { ...comment(2, REVIEW_BODY, '2026-07-01T11:00:00Z', 'Review Bot'), deleted: true },
        ],
      },
    })

    const reviews = await makeAdapter().getPreviousReviewComments('100')

    expect(reviews.map(r => r.id)).toEqual(['1'])
  })
})

describe('getPreviousReviewComments — resolved flag', () => {
  it('marks a review resolved only when Bitbucket reports a non-null resolution', async () => {
    clientMock.get.mockResolvedValue({
      data: {
        values: [
          { ...comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'), resolution: { type: 'comment_resolution', user: { display_name: 'Dev One' }, created_on: '2026-07-01T15:00:00Z' } },
          { ...comment(2, REVIEW_BODY, '2026-07-01T11:00:00Z', 'Review Bot'), resolution: null },
          // Older payloads omit the field entirely — must read as unresolved, not resolved
          comment(3, REVIEW_BODY, '2026-07-01T12:00:00Z', 'Review Bot'),
        ],
      },
    })

    const reviews = await makeAdapter().getPreviousReviewComments('100')

    expect(reviews.map(r => [r.id, r.resolved])).toEqual([['1', true], ['2', false], ['3', false]])
  })
})

describe('getRepliesToReviewComments — no self-reply loops', () => {
  const thread = [
    comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
    comment(3, 'Why is this HIGH severity?', '2026-07-01T11:00:00Z', 'Dev One', 1),
    comment(4, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', 'Review Bot', 1),
  ]

  it('never returns the agent own reply as unanswered', async () => {
    clientMock.get.mockResolvedValue({ data: { values: thread } })

    const { replies, agentReplyCount } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(agentReplyCount).toBe(1)
    expect(replies).toEqual([])
  })

  it('returns only human replies newer than the latest agent reply', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [...thread, comment(5, 'One more question', '2026-07-01T13:00:00Z', 'Dev One', 4)] },
    })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(replies.map(r => r.id)).toEqual(['5'])
  })

  it('returns unanswered human replies when the agent has not replied yet', async () => {
    clientMock.get.mockResolvedValue({ data: { values: [thread[0], thread[1]] } })

    const { replies, agentReplyCount } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(agentReplyCount).toBe(0)
    expect(replies.map(r => r.id)).toEqual(['3'])
  })

  it('ignores a deleted agent-reply tombstone, so the human reply stays unanswered (PR 82 case)', async () => {
    clientMock.get.mockResolvedValue({
      data: {
        values: [
          thread[0],
          thread[1],
          { ...comment(4, '', '2026-07-01T12:00:00Z', 'Review Bot', 1), deleted: true },
        ],
      },
    })

    const { replies, agentReplyCount } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(agentReplyCount).toBe(0)
    expect(replies.map(r => r.id)).toEqual(['3'])
  })

  it('includeAnswered returns the full discussion with agent replies labeled', async () => {
    clientMock.get.mockResolvedValue({ data: { values: thread } })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'], true)

    expect(replies.map(r => r.author)).toEqual(['Dev One', 'Agent (prior reply)'])
  })
})

// ---------------------------------------------------------------------------
// filterAddressedToAgent — skip replies @-directed at someone else.
// IDs mirror live PR 82: agent "HeyTech" is NNN:uuid; Fernando (a dev) is legacy 24-hex.
// ---------------------------------------------------------------------------

const AGENT_ID = '712020:1257b717-eb9e-4c24-905e-59185f811af3'
const AGENT_UUID = '{1886cb80-0000-0000-0000-000000000000}'
const FERNANDO = '5cf55f9a3fa1890e7f16e51f'

function richComment(id: number, body: string, createdOn: string, user: any, parentId?: number) {
  return { id, parent: parentId ? { id: parentId } : undefined, content: { raw: body }, user, created_on: createdOn }
}

const agentUser = { account_id: AGENT_ID, uuid: AGENT_UUID, display_name: 'HeyTech', nickname: 'HeyTech' }
const devUser = { account_id: FERNANDO, uuid: '{2222cb80-0000-0000-0000-000000000000}', display_name: 'Fernando' }

describe('filterAddressedToAgent — directed-elsewhere drop rule', () => {
  it('drops a reply @-directed at a dev, keeps one @-directed at the agent (PR 82 fixture)', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        richComment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', agentUser),
        richComment(2, `@{${FERNANDO}} Hey, there's no need to point out the fixes`, '2026-07-01T11:00:00Z', devUser, 1),
        richComment(3, `@{${AGENT_ID}} why is this HIGH?`, '2026-07-01T11:30:00Z', devUser, 1),
      ] },
    })
    const adapter = makeAdapter()
    const { replies } = await adapter.getRepliesToReviewComments('100', ['1'])

    const kept = await adapter.filterAddressedToAgent!(replies, new Set())

    expect(kept.map(r => r.id)).toEqual(['3'])
  })

  it('derives the agent id-set from account_id AND uuid of agent-authored comments', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        richComment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', agentUser),
        // addresses the agent by its bare uuid (brace-stripped on both sides)
        richComment(2, `@{1886cb80-0000-0000-0000-000000000000} explain`, '2026-07-01T11:00:00Z', devUser, 1),
      ] },
    })
    const adapter = makeAdapter()
    const { replies } = await adapter.getRepliesToReviewComments('100', ['1'])

    const kept = await adapter.filterAddressedToAgent!(replies, new Set())

    expect(kept.map(r => r.id)).toEqual(['2'])
  })

  it('preserves order of the kept subset', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        richComment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', agentUser),
        richComment(2, `@{${AGENT_ID}} a`, '2026-07-01T11:00:00Z', devUser, 1),
        richComment(3, `@{${FERNANDO}} drop me`, '2026-07-01T11:30:00Z', devUser, 1),
        richComment(4, 'plain question', '2026-07-01T12:00:00Z', devUser, 1),
      ] },
    })
    const adapter = makeAdapter()
    const { replies } = await adapter.getRepliesToReviewComments('100', ['1'])

    const kept = await adapter.filterAddressedToAgent!(replies, new Set())

    expect(kept.map(r => r.id)).toEqual(['2', '4'])
  })

  it('keeps all replies and warns when the agent id-set cannot be derived', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // No account_id/uuid on the review author → empty derived set.
    clientMock.get.mockResolvedValue({
      data: { values: [
        richComment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', { display_name: 'HeyTech' }),
        richComment(2, `@{${FERNANDO}} take this`, '2026-07-01T11:00:00Z', { display_name: 'Fernando' }, 1),
      ] },
    })
    const adapter = makeAdapter()
    const { replies } = await adapter.getRepliesToReviewComments('100', ['1'])

    const kept = await adapter.filterAddressedToAgent!(replies, new Set())

    expect(kept.map(r => r.id)).toEqual(['2'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('getRepliesToReviewComments — authorId', () => {
  const withUser = (user: object) =>
    ({ id: 2, parent: { id: 1 }, content: { raw: 'q' }, user, created_on: '2026-07-01T11:00:00Z' })
  const fetchReply = async (user: object) => {
    clientMock.get.mockResolvedValue({ data: { values: [comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'), withUser(user)] } })
    return (await makeAdapter().getRepliesToReviewComments('100', ['1'])).replies[0]
  }

  it('uses user.uuid, falling back to user.account_id', async () => {
    expect((await fetchReply({ display_name: 'Ann', uuid: '{u-1}', account_id: 'acc-1' })).authorId).toBe('{u-1}')
    expect((await fetchReply({ display_name: 'Ann', account_id: 'acc-1' })).authorId).toBe('acc-1')
  })

  it('leaves authorId absent when the payload has neither', async () => {
    const reply = await fetchReply({ display_name: 'Ann' })
    expect('authorId' in reply).toBe(false)
    expect(reply.author).toBe('Ann')
  })
})
