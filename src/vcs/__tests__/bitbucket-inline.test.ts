import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.hoisted(() => { process.env.ANTHROPIC_API_KEY ??= 'test-key' })

import { BitbucketAdapter } from '../bitbucket.js'

const { clientMock } = vi.hoisted(() => ({ clientMock: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }))

vi.mock('axios', () => ({
  default: { create: vi.fn(() => clientMock), get: vi.fn(), isAxiosError: vi.fn(() => false) },
}))

const COMMENTS = '/repositories/ws/repo/pullrequests/7/comments'
const marked = (b: string) => b.includes('*Finding')
const user = { display_name: 'Bot', account_id: 'acc-1', uuid: '{uuid-1}', nickname: 'bot' }

function c(id: number, raw: string, extra: Record<string, unknown> = {}) {
  return { id, content: { raw }, user, created_on: `2026-01-01T10:00:${String(id).padStart(2, '0')}Z`, ...extra }
}

function makeAdapter(): BitbucketAdapter {
  const adapter = new BitbucketAdapter('https://api.bitbucket.org/2.0', 'ws', 'bot', 'token')
  adapter.setRepoSlug('repo')
  return adapter
}

beforeEach(() => { vi.clearAllMocks() })

describe('creates', () => {
  it('postInlineComment sends the inline anchor and returns the html link and author ids', async () => {
    clientMock.post.mockResolvedValue({ data: { id: 11, links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7#comment-11' } }, created_on: 'T', user } })
    const r = await makeAdapter().postInlineComment('7', { path: 'src/a.ts', line: 42 }, 'body')
    expect(clientMock.post).toHaveBeenCalledWith(COMMENTS, { content: { raw: 'body' }, inline: { path: 'src/a.ts', to: 42 } })
    expect(r).toEqual({ id: '11', url: 'https://bitbucket.org/ws/repo/pull-requests/7#comment-11', createdOn: 'T', authorIds: ['acc-1', 'uuid-1'] })
  })

  it('postTopLevelComment sends content only and falls back to the PR link plus the comment anchor', async () => {
    clientMock.post.mockResolvedValue({ data: { id: 12, created_on: 'T', user } })
    const r = await makeAdapter().postTopLevelComment('7', 'sum')
    expect(clientMock.post).toHaveBeenCalledWith(COMMENTS, { content: { raw: 'sum' } })
    expect(r.url).toBe('https://bitbucket.org/ws/repo/pull-requests/7#comment-12')
  })

  it('postThreadComment sends parent.id and returns authorIds', async () => {
    clientMock.post.mockResolvedValue({ data: { id: 13, links: { html: { href: 'u' } }, created_on: 'T', user: { account_id: 'other' } } })
    const r = await makeAdapter().postThreadComment('7', '5', 'answer')
    expect(clientMock.post).toHaveBeenCalledWith(COMMENTS, { parent: { id: 5 }, content: { raw: 'answer' } })
    expect(r.authorIds).toEqual(['other'])
  })

  it('postReply and postComment keep their exact bodies', async () => {
    clientMock.post.mockResolvedValue({ data: {} })
    const a = makeAdapter()
    await a.postReply('7', '5', 'r')
    await a.postComment('7', 'x')
    expect(clientMock.post).toHaveBeenNthCalledWith(1, COMMENTS, { parent: { id: 5 }, content: { raw: 'r' } })
    expect(clientMock.post).toHaveBeenNthCalledWith(2, COMMENTS, { content: { raw: 'x' } })
  })
})

describe('editComment and getAgentIdentity', () => {
  it('PUTs the new body to the comment', async () => {
    clientMock.put.mockResolvedValue({ data: {} })
    await makeAdapter().editComment('7', '9', 'new')
    expect(clientMock.put).toHaveBeenCalledWith(`${COMMENTS}/9`, { content: { raw: 'new' } })
  })

  it('reads ids and lowercase names from GET /user', async () => {
    clientMock.get.mockResolvedValue({ data: user })
    expect(await makeAdapter().getAgentIdentity()).toEqual({ ids: ['acc-1', 'uuid-1'], names: ['bot'] })
    expect(clientMock.get).toHaveBeenCalledWith('/user')
  })

  it('returns an empty identity on error', async () => {
    clientMock.get.mockRejectedValue(new Error('403'))
    expect(await makeAdapter().getAgentIdentity()).toEqual({ ids: [], names: [] })
  })
})

describe('listMarkedThreads', () => {
  const list = async (values: any[]) => {
    clientMock.get.mockResolvedValue({ data: { values } })
    return makeAdapter().listMarkedThreads('7', marked)
  }

  it('lists marked roots inline or not, with seq, resolved, inline and author ids from one fetch', async () => {
    const t = await list([
      c(3, 'x\n\n*Finding F2 | opened at aaaaaaaaaaaa*', { inline: { path: 'a.ts', to: 9 }, resolution: { type: 'x' }, links: { html: { href: 'L3' } } }),
      c(2, 'y\n\n*Finding F1 | opened at aaaaaaaaaaaa*'),
      c(4, 'a human comment'),
    ])
    expect(clientMock.get).toHaveBeenCalledTimes(1)
    expect(t.map(x => x.root.id)).toEqual(['2', '3'])
    expect(t[0].root).toMatchObject({ seq: 2, url: 'https://bitbucket.org/ws/repo/pull-requests/7#comment-2', authorIds: ['acc-1', 'uuid-1'] })
    expect(t[0].root.inline).toBeUndefined()
    expect(t[0].resolved).toBe(false)
    expect(t[1]).toMatchObject({ resolved: true, root: { url: 'L3', inline: { path: 'a.ts', line: 9 } } })
  })

  it('attributes a reverse-listed deep chain to its root', async () => {
    const t = await list([
      c(14, 'd', { parent: { id: 13 } }),
      c(13, 'c', { parent: { id: 12 } }),
      c(12, 'b', { parent: { id: 10 } }),
      c(10, '*Finding F1 | opened at aaaaaaaaaaaa*'),
    ])
    expect(t).toHaveLength(1)
    expect(t[0].comments.map(x => x.id)).toEqual(['12', '13', '14'])
    expect(t[0].comments[0].parentId).toBe('10')
  })

  it('drops a branch under a deleted ancestor and a cycle', async () => {
    const t = await list([
      c(10, '*Finding F1 | opened at aaaaaaaaaaaa*'),
      c(12, 'orphan child of deleted 11', { parent: { id: 11 } }),
      c(13, 'under orphan', { parent: { id: 12 } }),
      c(20, 'cycle a', { parent: { id: 21 } }),
      c(21, 'cycle b', { parent: { id: 20 } }),
      c(14, 'kept', { parent: { id: 10 } }),
    ])
    expect(t[0].comments.map(x => x.id)).toEqual(['14'])
  })

  it('does not treat a marked reply as a root', async () => {
    const t = await list([c(10, '*Finding F1 | opened at aaaaaaaaaaaa*'), c(11, '*Finding F9 | opened at aaaaaaaaaaaa*', { parent: { id: 10 } })])
    expect(t).toHaveLength(1)
    expect(t[0].comments.map(x => x.id)).toEqual(['11'])
  })
})
