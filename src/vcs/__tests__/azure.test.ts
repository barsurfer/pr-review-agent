import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'
import { AzureDevOpsAdapter } from '../azure.js'
import { config, validateAzureConfig } from '../../config.js'
import { buildReviewFooter, buildReplyFooter } from '../../review/formatter.js'
import { filterDiff, countChangedLines, scanTodos } from '../../review/parsers.js'

// ---------------------------------------------------------------------------
// Azure DevOps adapter (WIP). The risk lives in diff reconstruction: Azure has
// no native unified diff, so getDiff rebuilds one from the change list + blob
// content. These tests pin that the reconstructed diff is byte-compatible with
// the existing parsers (filterDiff / countChangedLines / scanTodos) and that
// thread ⇄ composite-id comment handling never loops on the agent's own replies.
// ---------------------------------------------------------------------------

const { clientMock } = vi.hoisted(() => {
  // config.ts (imported, not mocked here) requires ANTHROPIC_API_KEY at load.
  process.env.ANTHROPIC_API_KEY ??= 'test-key'
  return { clientMock: { get: vi.fn(), post: vi.fn() } }
})

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => clientMock),
    isAxiosError: (e: any) => Boolean(e && e.isAxiosError),
  },
}))

// --- Fixtures --------------------------------------------------------------

const PR = {
  pullRequestId: 42,
  title: 'Add feature',
  description: 'Does things',
  createdBy: { displayName: 'Dev One' },
  sourceRefName: 'refs/heads/feature/x',
  targetRefName: 'refs/heads/main',
  lastMergeSourceCommit: { commitId: 'HEAD' },
  lastMergeTargetCommit: { commitId: 'BASE' },
}

const COMMIT_DIFF = {
  baseCommit: 'BASE',
  targetCommit: 'HEAD',
  allChangesIncluded: true,
  changes: [
    { item: { path: '/src/app.ts', gitObjectType: 'blob' }, changeType: 'edit' },
    { item: { path: '/src/new.ts', gitObjectType: 'blob' }, changeType: 'add' },
    { item: { path: '/src/old.ts', gitObjectType: 'blob' }, changeType: 'delete' },
    { item: { path: '/src/b.ts', gitObjectType: 'blob', originalPath: '/src/a.ts' }, changeType: 'rename' },
    { item: { path: '/src', gitObjectType: 'tree', isFolder: true }, changeType: 'edit' },   // folder — must be skipped
    { item: { path: '/package-lock.json', gitObjectType: 'blob' }, changeType: 'add' },
  ],
}

// keyed by "path@version"
const FILES: Record<string, string> = {
  '/src/app.ts@BASE': 'const a = 1\nconst b = 2\nconst c = 3\n',
  '/src/app.ts@HEAD': 'const a = 1\nconst b = 20\nconst c = 3\n',
  '/src/new.ts@HEAD': 'export const x = 1\n// TODO: wire this up\n',
  '/src/old.ts@BASE': 'export const gone = true\n',
  '/src/a.ts@BASE': "export const name = 'a'\n",
  '/src/b.ts@HEAD': "export const name = 'b'\n",
  '/package-lock.json@HEAD': '{"lockfileVersion":3}\n',
}

function routeGet(url: string, config: any = {}): Promise<any> {
  if (url.includes('/threads')) return Promise.resolve({ data: { value: [] } })
  if (url.includes('/items')) {
    const key = `${config.params.path}@${config.params['versionDescriptor.version'] ?? 'DEFAULT'}`
    if (key in FILES) return Promise.resolve({ data: FILES[key] })
    return Promise.reject({ isAxiosError: true, response: { status: 404 } })
  }
  if (url.includes('/diffs/commits')) return Promise.resolve({ data: COMMIT_DIFF })
  if (url.includes('/pullRequests/')) return Promise.resolve({ data: PR })
  return Promise.reject(new Error('unexpected url ' + url))
}

const REVIEW_BODY = '### Summary\nAll good.' + buildReviewFooter('bot@co.com', 'claude-haiku-4-5-20251001', 'repo', 1, 'aabbcc112233', '919a10b')
const AGENT_REPLY_BODY = 'Because the null path is unguarded.' + buildReplyFooter('bot@co.com', 'claude-haiku-4-5-20251001')

function comment(id: number, content: string, publishedDate: string, author = 'Dev One', parentCommentId = 0) {
  return { id, content, author: { displayName: author }, parentCommentId, publishedDate }
}

function makeAdapter(): AzureDevOpsAdapter {
  const a = new AzureDevOpsAdapter('https://dev.azure.com', 'org', 'proj', 'pat')
  a.setRepoSlug('repo')
  return a
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})   // silence the WIP banner
})

// --- Auth selection --------------------------------------------------------

describe('auth header — Bearer (zero-PAT) vs Basic PAT', () => {
  const authOf = () => (axios.create as any).mock.calls.at(-1)[0].headers.Authorization

  it('uses Bearer when an access token is provided', () => {
    new AzureDevOpsAdapter('https://dev.azure.com', 'org', 'proj', '', 'oauth-tok')
    expect(authOf()).toBe('Bearer oauth-tok')
  })

  it('uses Basic base64(":{PAT}") when only a PAT is provided', () => {
    new AzureDevOpsAdapter('https://dev.azure.com', 'org', 'proj', 'mypat', '')
    expect(authOf()).toBe('Basic ' + Buffer.from(':mypat').toString('base64'))
  })

  it('prefers the access token when both are set', () => {
    new AzureDevOpsAdapter('https://dev.azure.com', 'org', 'proj', 'mypat', 'oauth-tok')
    expect(authOf()).toBe('Bearer oauth-tok')
  })
})

describe('validateAzureConfig — org, project, and at least one credential', () => {
  beforeEach(() => {
    config.azure.org = 'o'
    config.azure.project = 'p'
    config.azure.pat = ''
    config.azure.accessToken = ''
  })

  it('throws when neither PAT nor access token is set', () => {
    expect(() => validateAzureConfig()).toThrow(/AZURE_PAT or AZURE_ACCESS_TOKEN/)
  })

  it('passes with only a PAT', () => {
    config.azure.pat = 'x'
    expect(() => validateAzureConfig()).not.toThrow()
  })

  it('passes with only an access token', () => {
    config.azure.accessToken = 'x'
    expect(() => validateAzureConfig()).not.toThrow()
  })
})

// --- PR info ---------------------------------------------------------------

describe('getPullRequestInfo', () => {
  it('strips refs/heads/ and reads the source commit + author', async () => {
    clientMock.get.mockResolvedValue({ data: PR })

    const info = await makeAdapter().getPullRequestInfo('42')

    expect(info).toEqual({
      id: '42',
      title: 'Add feature',
      description: 'Does things',
      author: 'Dev One',
      sourceBranch: 'feature/x',
      targetBranch: 'main',
      sourceCommit: 'HEAD',
    })
  })
})

// --- Changed files ---------------------------------------------------------

describe('getChangedFiles', () => {
  it('maps change types to status and drops folder/tree entries', async () => {
    clientMock.get.mockImplementation(routeGet)

    const files = await makeAdapter().getChangedFiles('42')

    expect(files).toEqual([
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'added' },
      { path: 'src/old.ts', status: 'deleted' },
      { path: 'src/b.ts', status: 'renamed' },
      { path: 'package-lock.json', status: 'added' },
    ])
  })
})

// --- Diff reconstruction (the crux) ----------------------------------------

describe('getDiff — reconstructed unified diff is parser-compatible', () => {
  it('emits git-style headers for add/edit/delete/rename', async () => {
    clientMock.get.mockImplementation(routeGet)

    const diff = await makeAdapter().getDiff('42')

    expect(diff).toContain('diff --git a/src/app.ts b/src/app.ts')
    // add → old side is /dev/null, new side present
    expect(diff).toContain('diff --git a/src/new.ts b/src/new.ts')
    expect(diff).toContain('--- /dev/null')
    expect(diff).toContain('+++ b/src/new.ts')
    // delete → new side is /dev/null
    expect(diff).toContain('diff --git a/src/old.ts b/src/old.ts')
    expect(diff).toContain('+++ /dev/null')
    // rename → a/<old> b/<new>
    expect(diff).toContain('diff --git a/src/a.ts b/src/b.ts')
    // real hunk header shape
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/)
  })

  it('feeds filterDiff (lockfile stripped) and scanTodos (TODO at correct line)', async () => {
    clientMock.get.mockImplementation(routeGet)

    const diff = await makeAdapter().getDiff('42')

    // countChangedLines sees every +/- line across all reconstructed sections
    expect(countChangedLines(diff)).toBe(8)

    // filterDiff must recognize the `diff --git a/…` header and strip the lockfile section
    const { filtered, removedCount } = filterDiff(diff, ['package-lock.json'])
    expect(removedCount).toBe(1)
    expect(filtered).not.toContain('package-lock.json')
    expect(filtered).toContain('src/app.ts')

    // scanTodos must track the new-file line number through the reconstructed hunk header
    const todos = scanTodos(diff)
    expect(todos).toEqual([{ file: 'src/new.ts', line: 2, text: 'TODO: wire this up' }])
  })
})

describe('getCommitDiff — two-dot diff between arbitrary commits', () => {
  it('reconstructs a diff without needing PR metadata', async () => {
    clientMock.get.mockImplementation(routeGet)

    const diff = await makeAdapter().getCommitDiff('BASE', 'HEAD')

    expect(diff).toContain('diff --git a/src/app.ts b/src/app.ts')
    expect(countChangedLines(diff)).toBe(8)
  })
})

// --- File content ----------------------------------------------------------

describe('getFileContent / getRepoFileContent', () => {
  it('requests the item at a commit version and returns raw text', async () => {
    clientMock.get.mockResolvedValue({ data: 'file body' })

    const out = await makeAdapter().getFileContent('src/x.ts', 'SHA')

    expect(out).toBe('file body')
    const [, config] = clientMock.get.mock.calls[0]
    expect(config.params).toMatchObject({
      path: '/src/x.ts',
      'versionDescriptor.version': 'SHA',
      'versionDescriptor.versionType': 'commit',
    })
  })

  it('getRepoFileContent hits the default branch (no version descriptor) and returns null on 404', async () => {
    clientMock.get.mockResolvedValueOnce({ data: 'instructions' })
    const found = await makeAdapter().getRepoFileContent('.agent-review-instructions.md')
    expect(found).toBe('instructions')
    const [, config] = clientMock.get.mock.calls[0]
    expect(config.params).toEqual({ path: '/.agent-review-instructions.md' })

    clientMock.get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } })
    const missing = await makeAdapter().getRepoFileContent('nope.md')
    expect(missing).toBeNull()
  })
})

// --- Agent review detection via thread listing -----------------------------

describe('getPreviousReviewComments — footer-based detection over threads', () => {
  it('returns only comments carrying the real agent footer, keyed by threadId:commentId', async () => {
    clientMock.get.mockResolvedValue({
      data: {
        value: [
          { id: 10, comments: [comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot')] },
          { id: 11, comments: [comment(1, 'Reviewed by me, LGTM', '2026-07-01T11:00:00Z')] },
        ],
      },
    })

    const reviews = await makeAdapter().getPreviousReviewComments('42')

    expect(reviews.map(r => r.id)).toEqual(['10:1'])
  })
})

// --- Reply walking (no self-reply loops) -----------------------------------

describe('getRepliesToReviewComments — same-thread replies, composite IDs', () => {
  const base = [
    comment(1, REVIEW_BODY, '2026-07-01T10:00:00Z', 'Review Bot'),
    comment(2, 'Why is this HIGH severity?', '2026-07-01T11:00:00Z', 'Dev One', 1),
    comment(3, AGENT_REPLY_BODY, '2026-07-01T12:00:00Z', 'Review Bot', 1),
  ]
  const threadData = (comments: any[]) => ({ data: { value: [{ id: 10, comments }] } })

  it('never returns the agent own reply as unanswered', async () => {
    clientMock.get.mockResolvedValue(threadData(base))

    const { replies, agentReplyCount } = await makeAdapter().getRepliesToReviewComments('42', ['10:1'])

    expect(agentReplyCount).toBe(1)
    expect(replies).toEqual([])
  })

  it('returns only human replies newer than the latest agent reply', async () => {
    clientMock.get.mockResolvedValue(threadData([...base, comment(4, 'One more question', '2026-07-01T13:00:00Z', 'Dev One', 1)]))

    const { replies } = await makeAdapter().getRepliesToReviewComments('42', ['10:1'])

    expect(replies.map(r => r.id)).toEqual(['10:4'])
  })

  it('returns unanswered human replies when the agent has not replied yet', async () => {
    clientMock.get.mockResolvedValue(threadData([base[0], base[1]]))

    const { replies, agentReplyCount } = await makeAdapter().getRepliesToReviewComments('42', ['10:1'])

    expect(agentReplyCount).toBe(0)
    expect(replies.map(r => r.id)).toEqual(['10:2'])
  })

  it('includeAnswered returns the full discussion with agent replies labeled', async () => {
    clientMock.get.mockResolvedValue(threadData(base))

    const { replies } = await makeAdapter().getRepliesToReviewComments('42', ['10:1'], true)

    expect(replies.map(r => r.author)).toEqual(['Dev One', 'Agent (prior reply)'])
  })
})

// --- Posting ---------------------------------------------------------------

describe('postComment / postReply request shapes', () => {
  it('postComment opens a new thread', async () => {
    clientMock.post.mockResolvedValue({ data: {} })

    await makeAdapter().postComment('42', 'hello world')

    const [url, body] = clientMock.post.mock.calls[0]
    expect(url).toContain('/pullRequests/42/threads')
    expect(body).toEqual({ comments: [{ parentCommentId: 0, content: 'hello world', commentType: 1 }], status: 1 })
  })

  it('postReply splits the composite id into thread + parent comment', async () => {
    clientMock.post.mockResolvedValue({ data: {} })

    await makeAdapter().postReply('42', '10:5', 'the answer')

    const [url, body] = clientMock.post.mock.calls[0]
    expect(url).toContain('/pullRequests/42/threads/10/comments')
    expect(body).toEqual({ content: 'the answer', parentCommentId: 5, commentType: 1 })
  })
})
