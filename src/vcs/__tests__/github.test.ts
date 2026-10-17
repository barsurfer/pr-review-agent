import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GitHubAdapter } from '../github.js'
import { PrTooLargeError } from '../adapter.js'
import { buildReviewFooter, buildReplyFooter } from '../../review/formatter.js'

const { clientMock, isAxiosError } = vi.hoisted(() => ({
  clientMock: { get: vi.fn(), post: vi.fn() },
  isAxiosError: vi.fn(() => false),
}))

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => clientMock),
    isAxiosError,
  },
}))

function comment(id: number, body: string, createdAt: string, login = 'dev1') {
  return { id, body, created_at: createdAt, user: { login } }
}

const REVIEW_BODY = '### Summary\nAll good.' + buildReviewFooter('bot', 'claude-haiku-4-5-20251001', 'repo', 1, 'aabbcc112233', '919a10b')
const AGENT_REPLY_BODY = 'Because the null path is unguarded.' + buildReplyFooter('bot', 'claude-haiku-4-5-20251001')

function makeAdapter(): GitHubAdapter {
  const adapter = new GitHubAdapter('https://api.github.com', 'org', 'token')
  adapter.setRepoSlug('repo')
  return adapter
}

beforeEach(() => {
  vi.resetAllMocks()
  isAxiosError.mockReturnValue(false)
})

describe('getPullRequestInfo', () => {
  it('maps fields and defaults a null body to empty string', async () => {
    clientMock.get.mockResolvedValue({
      data: { number: 7, title: 'T', body: null, user: { login: 'alice' }, head: { ref: 'feat/x', sha: 'abc' }, base: { ref: 'main' } },
    })

    const info = await makeAdapter().getPullRequestInfo('7')

    expect(clientMock.get).toHaveBeenCalledWith('/repos/org/repo/pulls/7')
    expect(info).toEqual({
      id: '7', title: 'T', description: '', author: 'alice',
      sourceBranch: 'feat/x', targetBranch: 'main', sourceCommit: 'abc',
    })
  })
})

describe('getDiff / getCommitDiff', () => {
  it('requests the diff media type as text', async () => {
    clientMock.get.mockResolvedValue({ data: 'diff --git a b' })

    const diff = await makeAdapter().getDiff('7')

    expect(diff).toBe('diff --git a b')
    expect(clientMock.get).toHaveBeenCalledWith('/repos/org/repo/pulls/7', {
      headers: { Accept: 'application/vnd.github.diff' }, responseType: 'text',
    })
  })

  it('uses the compare endpoint with from...to', async () => {
    clientMock.get.mockResolvedValue({ data: 'delta' })

    const diff = await makeAdapter().getCommitDiff('old1', 'new2')

    expect(diff).toBe('delta')
    expect(clientMock.get).toHaveBeenCalledWith('/repos/org/repo/compare/old1...new2', {
      headers: { Accept: 'application/vnd.github.diff' }, responseType: 'text',
    })
  })

  it('propagates compare failures so the caller falls back to the full diff', async () => {
    clientMock.get.mockRejectedValue(new Error('404'))
    await expect(makeAdapter().getCommitDiff('gone', 'new2')).rejects.toThrow('404')
  })
})

describe('getDiff large-PR fallback (406 → compare)', () => {
  const CAP = 25 * 1024 * 1024
  const COMPARE_TIMEOUT = 120_000
  const prJson = (over: Partial<any> = {}) => ({
    data: { state: 'open', changed_files: 336, base: { ref: 'main', sha: 'base00sha' }, head: { sha: 'head11sha' }, ...over },
  })

  it('on 406, fetches PR JSON then compare (base.ref for an open PR), in order', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get
      .mockRejectedValueOnce({ response: { status: 406 } })
      .mockResolvedValueOnce(prJson())
      .mockResolvedValueOnce({ data: 'COMPARE DIFF' })

    const diff = await makeAdapter().getDiff('7')

    expect(diff).toBe('COMPARE DIFF')
    expect(clientMock.get).toHaveBeenNthCalledWith(1, '/repos/org/repo/pulls/7', {
      headers: { Accept: 'application/vnd.github.diff' }, responseType: 'text',
    })
    expect(clientMock.get).toHaveBeenNthCalledWith(2, '/repos/org/repo/pulls/7')
    expect(clientMock.get).toHaveBeenNthCalledWith(3, '/repos/org/repo/compare/main...head11sha', {
      headers: { Accept: 'application/vnd.github.diff' },
      responseType: 'text',
      timeout: COMPARE_TIMEOUT,
      maxContentLength: CAP,
      maxBodyLength: CAP,
    })
  })

  it('uses base.sha as the anchor for a closed PR', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get
      .mockRejectedValueOnce({ response: { status: 406 } })
      .mockResolvedValueOnce(prJson({ state: 'closed', changed_files: 10 }))
      .mockResolvedValueOnce({ data: 'X' })

    await makeAdapter().getDiff('7')

    expect(clientMock.get).toHaveBeenNthCalledWith(3, '/repos/org/repo/compare/base00sha...head11sha', expect.anything())
  })

  it('percent-encodes a slash in the base branch name', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get
      .mockRejectedValueOnce({ response: { status: 406 } })
      .mockResolvedValueOnce(prJson({ changed_files: 10, base: { ref: 'release/1.0', sha: 's' }, head: { sha: 'h' } }))
      .mockResolvedValueOnce({ data: 'X' })

    await makeAdapter().getDiff('7')

    expect(clientMock.get).toHaveBeenNthCalledWith(3, '/repos/org/repo/compare/release%2F1.0...h', expect.anything())
  })

  it.each([
    ['an axios 404', true, { response: { status: 404 } }],
    ['a non-axios error', false, new Error('network down')],
  ])('rethrows %s without attempting the fallback', async (_label, axiosErr, rejection) => {
    isAxiosError.mockReturnValue(axiosErr)
    clientMock.get.mockRejectedValueOnce(rejection)

    await expect(makeAdapter().getDiff('7')).rejects.toEqual(rejection)
    expect(clientMock.get).toHaveBeenCalledTimes(1)
  })

  it('throws PrTooLargeError when changed_files exceeds the cap (compare not attempted)', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get
      .mockRejectedValueOnce({ response: { status: 406 } })
      .mockResolvedValueOnce(prJson({ changed_files: 3001 }))

    await expect(makeAdapter().getDiff('7')).rejects.toBeInstanceOf(PrTooLargeError)
    expect(clientMock.get).toHaveBeenCalledTimes(2)
  })

  it('attempts compare at exactly the file cap (3000, not over)', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get
      .mockRejectedValueOnce({ response: { status: 406 } })
      .mockResolvedValueOnce(prJson({ changed_files: 3000 }))
      .mockResolvedValueOnce({ data: 'COMPARE DIFF' })

    await expect(makeAdapter().getDiff('7')).resolves.toBe('COMPARE DIFF')
    expect(clientMock.get).toHaveBeenCalledTimes(3)
  })

  it('throws PrTooLargeError when the compare body exceeds the 25 MB cap', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get
      .mockRejectedValueOnce({ response: { status: 406 } })
      .mockResolvedValueOnce(prJson({ changed_files: 100 }))
      .mockRejectedValueOnce({ code: 'ERR_BAD_RESPONSE', message: 'maxContentLength size of 26214400 exceeded' })

    await expect(makeAdapter().getDiff('7')).rejects.toBeInstanceOf(PrTooLargeError)
  })

  it('throws PrTooLargeError when the compare request times out', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get
      .mockRejectedValueOnce({ response: { status: 406 } })
      .mockResolvedValueOnce(prJson({ changed_files: 100 }))
      .mockRejectedValueOnce({ code: 'ECONNABORTED', message: 'timeout of 120000ms exceeded' })

    await expect(makeAdapter().getDiff('7')).rejects.toBeInstanceOf(PrTooLargeError)
  })

  it('throws PrTooLargeError for a closed PR over the file cap (compare not attempted)', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get
      .mockRejectedValueOnce({ response: { status: 406 } })
      .mockResolvedValueOnce(prJson({ state: 'closed', changed_files: 3001 }))

    await expect(makeAdapter().getDiff('7')).rejects.toBeInstanceOf(PrTooLargeError)
    expect(clientMock.get).toHaveBeenCalledTimes(2)
  })

  it('rethrows a non-size compare failure with context (not PrTooLargeError)', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get
      .mockRejectedValueOnce({ response: { status: 406 } })
      .mockResolvedValueOnce(prJson({ changed_files: 100 }))
      .mockRejectedValueOnce({ code: 'ERR_BAD_RESPONSE', response: { status: 500 }, message: 'Request failed with status code 500' })

    const err = await makeAdapter().getDiff('7').catch(e => e)
    expect(err).not.toBeInstanceOf(PrTooLargeError)
    expect(err.message).toMatch(/compare fallback failed/i)
  })
})

describe('getChangedFiles', () => {
  it('maps removed to deleted and passes other statuses through', async () => {
    clientMock.get.mockResolvedValue({
      headers: {},
      data: [
        { filename: 'a.ts', status: 'added' },
        { filename: 'b.ts', status: 'modified' },
        { filename: 'c.ts', status: 'removed' },
        { filename: 'd.ts', status: 'renamed' },
      ],
    })

    const files = await makeAdapter().getChangedFiles('7')

    expect(files).toEqual([
      { path: 'a.ts', status: 'added' },
      { path: 'b.ts', status: 'modified' },
      { path: 'c.ts', status: 'deleted' },
      { path: 'd.ts', status: 'renamed' },
    ])
  })

  it('follows the Link header rel="next" until exhausted', async () => {
    const next = 'https://api.github.com/repositories/1/pulls/7/files?per_page=100&page=2'
    clientMock.get
      .mockResolvedValueOnce({
        headers: { link: `<${next}>; rel="next", <https://api.github.com/x?page=2>; rel="last"` },
        data: [{ filename: 'a.ts', status: 'added' }],
      })
      .mockResolvedValueOnce({
        headers: { link: '<https://api.github.com/x?page=1>; rel="prev"' },
        data: [{ filename: 'b.ts', status: 'added' }],
      })

    const files = await makeAdapter().getChangedFiles('7')

    expect(files.map(f => f.path)).toEqual(['a.ts', 'b.ts'])
    expect(clientMock.get).toHaveBeenCalledTimes(2)
    expect(clientMock.get).toHaveBeenNthCalledWith(2, next)
  })
})

describe('file content', () => {
  it('fetches raw content with an encoded path and ref', async () => {
    clientMock.get.mockResolvedValue({ data: 'content' })

    const text = await makeAdapter().getFileContent('src/my file.ts', 'abc')

    expect(text).toBe('content')
    expect(clientMock.get).toHaveBeenCalledWith('/repos/org/repo/contents/src/my%20file.ts', {
      params: { ref: 'abc' }, headers: { Accept: 'application/vnd.github.raw' }, responseType: 'text',
    })
  })

  it('omits ref for the default branch', async () => {
    clientMock.get.mockResolvedValue({ data: 'x' })

    await makeAdapter().getRepoFileContent('a.md')

    expect(clientMock.get.mock.calls[0][1].params).toBeUndefined()
  })

  it('returns null on 404 and rethrows other errors', async () => {
    isAxiosError.mockReturnValue(true)
    clientMock.get.mockRejectedValueOnce({ response: { status: 404 } })
    expect(await makeAdapter().getRepoFileContent('missing.md', 'main')).toBeNull()

    clientMock.get.mockRejectedValueOnce({ response: { status: 500 } })
    await expect(makeAdapter().getRepoFileContent('a.md', 'main')).rejects.toEqual({ response: { status: 500 } })
  })
})

describe('postComment / postReply', () => {
  it('posts a flat issue comment for both', async () => {
    clientMock.post.mockResolvedValue({})
    const adapter = makeAdapter()

    await adapter.postComment('7', 'review')
    await adapter.postReply('7', '99', 'answer')

    expect(clientMock.post).toHaveBeenNthCalledWith(1, '/repos/org/repo/issues/7/comments', { body: 'review' })
    expect(clientMock.post).toHaveBeenNthCalledWith(2, '/repos/org/repo/issues/7/comments', { body: 'answer' })
  })
})

describe('getPreviousReviewComments', () => {
  it('returns only comments carrying the real review footer, across pages', async () => {
    clientMock.get
      .mockResolvedValueOnce({
        headers: { link: '<https://api.github.com/p2>; rel="next"' },
        data: [
          comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'github-actions[bot]'),
          comment(2, 'Reviewed by me, LGTM', '2026-07-01T11:00:00Z'),
        ],
      })
      .mockResolvedValueOnce({
        headers: {},
        data: [comment(3, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', 'github-actions[bot]')],
      })

    const reviews = await makeAdapter().getPreviousReviewComments('7')

    expect(reviews.map(r => r.id)).toEqual(['1'])
    expect(reviews[0].resolved).toBeUndefined()
  })
})

describe('getRepliesToReviewComments — timestamp model', () => {
  const thread = [
    comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'github-actions[bot]'),
    comment(2, 'Why is this null?', '2026-07-01T11:00:00Z'),
    comment(3, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', 'github-actions[bot]'),
    comment(4, 'Thanks, one more thing', '2026-07-01T13:00:00Z'),
  ]

  it('returns only human comments after the latest agent comment and counts agent replies', async () => {
    clientMock.get.mockResolvedValue({ headers: {}, data: thread })

    const result = await makeAdapter().getRepliesToReviewComments('7', ['1'])

    expect(result.agentReplyCount).toBe(1)
    expect(result.replies.map(r => r.id)).toEqual(['4'])
    expect(result.replies[0].parentId).toBe('1')
    expect(result.replies[0].author).toBe('dev1')
  })

  it('returns nothing when the agent already answered the last human comment', async () => {
    clientMock.get.mockResolvedValue({ headers: {}, data: thread.slice(0, 3) })

    const result = await makeAdapter().getRepliesToReviewComments('7', ['1'])

    expect(result.replies).toEqual([])
    expect(result.agentReplyCount).toBe(1)
  })

  it('includeAnswered returns all human comments plus labeled agent replies', async () => {
    clientMock.get.mockResolvedValue({ headers: {}, data: thread })

    const result = await makeAdapter().getRepliesToReviewComments('7', ['1'], true)

    expect(result.replies.map(r => [r.id, r.author])).toEqual([
      ['2', 'dev1'],
      ['3', 'Agent (prior reply)'],
      ['4', 'dev1'],
    ])
  })

  it('returns no replies when the agent has not reviewed yet', async () => {
    clientMock.get.mockResolvedValue({ headers: {}, data: [comment(1, 'hello', '2026-07-01T10:00:00Z')] })

    const result = await makeAdapter().getRepliesToReviewComments('7', [])

    expect(result).toEqual({ replies: [], agentReplyCount: 0 })
  })
})
