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

const REVIEW_BODY = '### Summary\nAll good.' + buildReviewFooter('bot@co.com', 'claude-haiku-4-5-20251001', 'repo', 1, 'aabbcc112233')
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

  it('includeAnswered returns the full discussion with agent replies labeled', async () => {
    clientMock.get.mockResolvedValue({ data: { values: thread } })

    const { replies } = await makeAdapter().getRepliesToReviewComments('100', ['1'], true)

    expect(replies.map(r => r.author)).toEqual(['Dev One', 'Agent (prior reply)'])
  })
})
