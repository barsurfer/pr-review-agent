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

// Live PR 9099 thread: the bot's review, Fernando @-ing the PR author, a dev @-ing Fernando, the same dev @-ing the bot.
const PR_AUTHOR_ID = '557058:00000000-0000-4000-8000-0000000000aa'
const DEV_B_ID = '557058:00000000-0000-4000-8000-0000000000bb'
const devB = { account_id: DEV_B_ID, uuid: '{3333cb80-0000-0000-0000-000000000000}', display_name: 'Dev B' }
const reportedThread = () => [
  richComment(901359884, REVIEW_BODY, '2026-11-12T20:26:37.646496+00:00', agentUser),
  richComment(901796414, `@{${PR_AUTHOR_ID}} is this covered by the e2e suite?`, '2026-11-13T12:27:34.015078+00:00', devUser, 901359884),
  richComment(901876223, `@{${FERNANDO}} yes, the attachment tests cover it`, '2026-11-13T14:10:02.118001+00:00', devB, 901796414),
  richComment(901878728, `@{${AGENT_ID}} does our comments thread makes sense? `, '2026-11-13T14:14:33.208848+00:00', devB, 901876223),
]
const idsAndParents = (replies: { id: string; parentId: string }[]) => replies.map(r => [r.id, r.parentId])

// A straight chain under review 1: comment k+1 replies to comment k, one minute apart.
function humanChain(depth: number) {
  const out = [comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot')]
  for (let k = 2; k <= depth + 1; k++) out.push(comment(k, `q${k}`, `2026-07-01T11:0${k}:00Z`, 'Dev One', k - 1))
  return out
}

describe('getRepliesToReviewComments — the whole thread under a review', () => {
  it('returns every reply of the reported thread, each with its direct parent', async () => {
    clientMock.get.mockResolvedValue({ data: { values: reportedThread() } })

    const { replies, agentReplyCount } = await makeAdapter().getRepliesToReviewComments('100', ['901359884'])

    expect(agentReplyCount).toBe(0)
    expect(idsAndParents(replies)).toEqual([
      ['901796414', '901359884'],
      ['901876223', '901796414'],
      ['901878728', '901876223'],
    ])
  })

  it('directed-reply filter keeps only the question put to the bot, with its parent as the answer target', async () => {
    clientMock.get.mockResolvedValue({ data: { values: reportedThread() } })
    const adapter = makeAdapter()
    const { replies } = await adapter.getRepliesToReviewComments('100', ['901359884'])

    const kept = await adapter.filterAddressedToAgent!(replies, new Set())

    expect(idsAndParents(kept)).toEqual([['901878728', '901876223']])
  })

  it('an answer posted under the question parent answers the whole thread, so the next run finds nothing', async () => {
    const answer = richComment(901880001, AGENT_REPLY_BODY, '2026-11-13T14:16:00.000000+00:00', agentUser, 901876223)
    clientMock.get.mockResolvedValue({ data: { values: [...reportedThread(), answer] } })

    const unanswered = await makeAdapter().getRepliesToReviewComments('100', ['901359884'])
    const discussion = await makeAdapter().getRepliesToReviewComments('100', ['901359884'], true)

    expect(unanswered).toEqual({ replies: [], agentReplyCount: 1 })
    expect(discussion.agentReplyCount).toBe(1)
    expect(discussion.replies.map(r => [r.id, r.parentId, r.author])).toEqual([
      ['901796414', '901359884', 'Fernando'],
      ['901876223', '901796414', 'Dev B'],
      ['901878728', '901876223', 'Dev B'],
      ['901880001', '901876223', 'Agent (prior reply)'],
    ])
  })

  it.each([2, 3, 5])('finds every reply of a human chain %i deep', async depth => {
    clientMock.get.mockResolvedValue({ data: { values: humanChain(depth) } })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(idsAndParents(replies)).toEqual(Array.from({ length: depth }, (_, i) => [String(i + 2), String(i + 1)]))
  })

  it('does not depend on the API listing a parent before its child, and returns replies oldest first', async () => {
    const [review, c2, c3, c4] = humanChain(3)
    clientMock.get.mockResolvedValue({ data: { values: [c4, review, c3, c2] } })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(idsAndParents(replies)).toEqual([['2', '1'], ['3', '2'], ['4', '3']])
  })

  it('an agent reply in the middle of a human chain answers what came before it', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
        comment(2, 'Why?', '2026-07-01T11:00:00Z', 'Dev One', 1),
        comment(3, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', 'Review Bot', 2),
        comment(4, 'Still unclear', '2026-07-01T13:00:00Z', 'Dev Two', 3),
        comment(5, 'Agreed, unclear', '2026-07-01T14:00:00Z', 'Dev One', 4),
      ] },
    })

    const unanswered = await makeAdapter().getRepliesToReviewComments('100', ['1'])
    const discussion = await makeAdapter().getRepliesToReviewComments('100', ['1'], true)

    expect(unanswered.agentReplyCount).toBe(1)
    expect(idsAndParents(unanswered.replies)).toEqual([['4', '3'], ['5', '4']])
    expect(discussion.replies.map(r => [r.id, r.author])).toEqual([
      ['2', 'Dev One'], ['3', 'Agent (prior reply)'], ['4', 'Dev Two'], ['5', 'Dev One'],
    ])
  })

  it('counts agent replies anywhere in a review thread, never under an unrelated comment', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
        comment(2, 'Why?', '2026-07-01T11:00:00Z', 'Dev One', 1),
        comment(3, 'Because of X', '2026-07-01T11:30:00Z', 'Dev Two', 2),
        comment(4, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', 'Review Bot', 3),
        comment(20, 'Unrelated top-level note', '2026-07-01T12:10:00Z', 'Dev One'),
        comment(21, AGENT_REPLY_BODY, '2026-07-01T12:20:00Z', 'Review Bot', 20),
      ] },
    })

    const { replies, agentReplyCount } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(agentReplyCount).toBe(1)
    expect(replies).toEqual([])
  })

  it('follows the threads of every review and nothing outside them', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
        comment(2, 'old thread q', '2026-07-01T11:00:00Z', 'Dev One', 1),
        comment(3, 'old thread follow-up', '2026-07-01T11:30:00Z', 'Dev Two', 2),
        comment(10, REVIEW_BODY, '2026-07-02T10:00:00Z', 'Review Bot'),
        comment(11, 'new thread q', '2026-07-02T11:00:00Z', 'Dev One', 10),
        comment(12, 'new thread follow-up', '2026-07-02T11:30:00Z', 'Dev Two', 11),
        comment(20, 'Unrelated top-level note', '2026-07-02T12:00:00Z', 'Dev One'),
        comment(21, 'Reply to the unrelated note', '2026-07-02T12:30:00Z', 'Dev Two', 20),
        comment(13, 'late reply in the old thread', '2026-07-02T13:00:00Z', 'Dev One', 3),
      ] },
    })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1', '10'])

    expect(idsAndParents(replies)).toEqual([['2', '1'], ['3', '2'], ['11', '10'], ['12', '11'], ['13', '3']])
  })

  it('leaves out replies whose parent was deleted (the chain to the review is broken)', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
        { ...comment(2, '', '2026-07-01T11:00:00Z', 'Dev One', 1), deleted: true },
        comment(3, 'reply to the deleted comment', '2026-07-01T11:30:00Z', 'Dev Two', 2),
        comment(4, 'and under that', '2026-07-01T11:45:00Z', 'Dev One', 3),
        comment(5, 'direct question', '2026-07-01T12:00:00Z', 'Dev Two', 1),
      ] },
    })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'], true)

    expect(idsAndParents(replies)).toEqual([['5', '1']])
  })

  it('survives parent cycles, self-parents and missing parents', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
        comment(7, 'cycle a', '2026-07-01T11:00:00Z', 'Dev One', 8),
        comment(8, 'cycle b', '2026-07-01T11:01:00Z', 'Dev One', 7),
        comment(9, 'into the cycle', '2026-07-01T11:02:00Z', 'Dev One', 8),
        comment(10, 'self parent', '2026-07-01T11:03:00Z', 'Dev One', 10),
        comment(11, 'missing parent', '2026-07-01T11:04:00Z', 'Dev One', 999),
        comment(2, 'direct question', '2026-07-01T12:00:00Z', 'Dev Two', 1),
      ] },
    })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(idsAndParents(replies)).toEqual([['2', '1']])
  })

  it('one agent reply anywhere marks every older reply answered, since one bundled answer covers all pending', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
        comment(2, 'thread X', '2026-07-01T11:00:00Z', 'Dev One', 1),
        comment(3, 'thread X deeper', '2026-07-01T11:30:00Z', 'Dev Two', 2),
        comment(4, 'thread Y', '2026-07-01T11:40:00Z', 'Dev One', 1),
        comment(5, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', 'Review Bot', 1),
        comment(6, 'thread X after the answer', '2026-07-01T13:00:00Z', 'Dev Two', 3),
      ] },
    })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(idsAndParents(replies)).toEqual([['6', '3']])
  })

  it('direct replies and replies to agent replies come back exactly as before', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
        richComment(3, 'Why is this HIGH?', '2026-07-01T11:00:00Z', devUser, 1),
        comment(4, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', 'Review Bot', 1),
        richComment(5, 'One more question', '2026-07-01T13:00:00Z', devUser, 4),
        comment(6, 'Unrelated top-level note', '2026-07-01T13:10:00Z', 'Dev Two'),
        comment(7, 'Direct follow-up', '2026-07-01T14:00:00Z', 'Dev Two', 1),
      ] },
    })

    const unanswered = await makeAdapter().getRepliesToReviewComments('100', ['1'])
    const discussion = await makeAdapter().getRepliesToReviewComments('100', ['1'], true)

    const fernando = { author: 'Fernando', authorId: devUser.uuid }
    expect(unanswered).toEqual({
      replies: [
        { id: '5', parentId: '4', ...fernando, body: 'One more question', createdOn: '2026-07-01T13:00:00Z' },
        { id: '7', parentId: '1', author: 'Dev Two', body: 'Direct follow-up', createdOn: '2026-07-01T14:00:00Z' },
      ],
      agentReplyCount: 1,
    })
    expect(discussion).toEqual({
      replies: [
        { id: '3', parentId: '1', ...fernando, body: 'Why is this HIGH?', createdOn: '2026-07-01T11:00:00Z' },
        { id: '4', parentId: '1', author: 'Agent (prior reply)', body: AGENT_REPLY_BODY, createdOn: '2026-07-01T12:00:00Z' },
        { id: '5', parentId: '4', ...fernando, body: 'One more question', createdOn: '2026-07-01T13:00:00Z' },
        { id: '7', parentId: '1', author: 'Dev Two', body: 'Direct follow-up', createdOn: '2026-07-01T14:00:00Z' },
      ],
      agentReplyCount: 1,
    })
  })
})

describe('getRepliesToReviewComments — a reply to a human is for the agent only when it @-mentions the agent', () => {
  const marks = (replies: { id: string; contextOnly?: true }[]) => replies.map(r => [r.id, r.contextOnly ?? false])
  const nestedUnderDev = (body: string) => [
    richComment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', agentUser),
    richComment(2, 'Why HIGH?', '2026-07-01T11:00:00Z', devUser, 1),
    richComment(3, body, '2026-07-01T12:00:00Z', devB, 2),
  ]

  it('reported thread: only the nested reply that does not mention the bot is context, in both variants', async () => {
    clientMock.get.mockResolvedValue({ data: { values: reportedThread() } })

    const unanswered = await makeAdapter().getRepliesToReviewComments('100', ['901359884'])
    const discussion = await makeAdapter().getRepliesToReviewComments('100', ['901359884'], true)

    const expected = [['901796414', false], ['901876223', true], ['901878728', false]]
    expect(marks(unanswered.replies)).toEqual(expected)
    expect(marks(discussion.replies)).toEqual(expected)
  })

  it.each([
    ['mid-sentence by account id', `does our comments thread make sense @{${AGENT_ID}}?`],
    ['after a mention of a human', `@{${FERNANDO}} agreed, and @{${AGENT_ID}} please confirm`],
    ['by double-braced uuid', '@{{1886cb80-0000-0000-0000-000000000000}} please confirm'],
    ['by plain-text name', 'what do you think @HeyTech?'],
  ])('a nested reply that mentions the bot %s is a question', async (_, body) => {
    clientMock.get.mockResolvedValue({ data: { values: nestedUnderDev(body) } })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(marks(replies)).toEqual([['2', false], ['3', false]])
  })

  it.each([
    ['no mention at all', 'I think it is fine'],
    ['a mention of a human only', `@{${FERNANDO}} yes, the attachment tests cover it`],
    ['a code-like token that is not an id', 'see `@{vm.name}` in the template'],
  ])('a nested reply with %s is context', async (_, body) => {
    clientMock.get.mockResolvedValue({ data: { values: nestedUnderDev(body) } })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(marks(replies)).toEqual([['2', false], ['3', true]])
  })

  it('a reply to an agent reply needs no mention; one more level down under a human does', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        richComment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', agentUser),
        richComment(2, 'Why HIGH?', '2026-07-01T11:00:00Z', devUser, 1),
        richComment(3, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', agentUser, 2),
        richComment(4, 'Still unclear', '2026-07-01T13:00:00Z', devB, 3),
        richComment(5, 'Same for me', '2026-07-01T14:00:00Z', devUser, 4),
      ] },
    })

    const { replies, agentReplyCount } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(agentReplyCount).toBe(1)
    expect(marks(replies)).toEqual([['4', false], ['5', true]])
  })

  it('the directed-reply filter keeps a nested reply that mentions a human first and the bot later', async () => {
    clientMock.get.mockResolvedValue({ data: { values: nestedUnderDev(`@{${FERNANDO}} agreed, and @{${AGENT_ID}} please confirm`) } })
    const adapter = makeAdapter()
    const { replies } = await adapter.getRepliesToReviewComments('100', ['1'])

    const kept = await adapter.filterAddressedToAgent!(replies, new Set())

    expect(kept.map(r => r.id)).toEqual(['2', '3'])
  })

  it('marks never change the agent reply count or what counts as answered', async () => {
    clientMock.get.mockResolvedValue({
      data: { values: [
        richComment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', agentUser),
        richComment(2, 'Why HIGH?', '2026-07-01T11:00:00Z', devUser, 1),
        richComment(3, 'chatter before the answer', '2026-07-01T11:30:00Z', devB, 2),
        richComment(4, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', agentUser, 1),
        richComment(5, 'chatter after the answer', '2026-07-01T13:00:00Z', devUser, 3),
        richComment(6, `@{${AGENT_ID}} and this one?`, '2026-07-01T14:00:00Z', devB, 3),
      ] },
    })

    const unanswered = await makeAdapter().getRepliesToReviewComments('100', ['1'])
    const discussion = await makeAdapter().getRepliesToReviewComments('100', ['1'], true)

    expect(unanswered.agentReplyCount).toBe(1)
    expect(marks(unanswered.replies)).toEqual([['5', true], ['6', false]])
    expect(discussion.agentReplyCount).toBe(1)
    expect(marks(discussion.replies)).toEqual([['2', false], ['3', true], ['4', false], ['5', true], ['6', false]])
  })

  it('without a derivable agent id-set nothing is marked, with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    clientMock.get.mockResolvedValue({ data: { values: humanChain(3) } })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'])

    expect(marks(replies)).toEqual([['2', false], ['3', false], ['4', false]])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('Could not derive the agent id-set')
    warn.mockRestore()
  })
})

describe('rate-limit retry wiring', () => {
  it('resends a file lookup that got 429 instead of failing the run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const limited = Object.assign(new Error('Request failed with status code 429'), { config: { method: 'get', url: '/src/abc/x.md' }, response: { status: 429, headers: { 'retry-after': '0.01' } } })
    clientMock.get.mockRejectedValueOnce(limited).mockResolvedValue({ data: 'content' })

    expect(await makeAdapter().getRepoFileContent('x.md', 'abc')).toBe('content')
    expect(clientMock.get).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
