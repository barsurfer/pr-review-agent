import { vi } from 'vitest'
import type { MarkedComment, MarkedThread, PostedComment, VCSAdapter } from '../../vcs/adapter.js'

export const ME = 'acc-1'
export const HEAD = 'a1b2c3d4e5f6' + '0'.repeat(28)
export const HEAD12 = HEAD.slice(0, 12)

export interface FakeComment { id: number; parentId?: number; body: string; authorIds: string[]; inline?: { path: string; line: number }; resolved?: boolean }

export interface Hooks {
  head: string
  failPost?: (n: number, kind: string) => Error | undefined
  failEdit?: (n: number) => Error | undefined
  author?: (kind: string) => string
  lateCommit?: boolean
  commitDiff?: (base: string, head: string) => string | Error
  identity?: { ids: string[]; names: string[] } | Error | null
  listError?: Error
  onCreate?: (kind: string) => void
  diff?: string
  files?: Array<{ path: string; status: string }>
}

export const httpErr = (status?: number): Error => Object.assign(new Error(status ? `HTTP ${status}` : 'socket hang up'), status ? { response: { status } } : { code: 'ECONNRESET' })

// A stateful stand-in for the Bitbucket adapter's inline surface; resolve/reopen spies exist only to prove they are never called.
export function makeFake() {
  const comments: FakeComment[] = []
  const hooks: Hooks = { head: HEAD, identity: { ids: [ME], names: ['review-bot'] } }
  const calls: string[] = []
  const counts = { post: 0, edit: 0 }
  const editBodies: string[] = []
  let nextId = 1

  const asThread = (r: FakeComment): MarkedThread => {
    const mk = (c: FakeComment): MarkedComment => ({ id: String(c.id), seq: c.id, body: c.body, author: c.authorIds[0] === ME ? 'review-bot' : 'dev', authorIds: c.authorIds, createdOn: `2026-01-01T00:00:${String(c.id).padStart(2, '0')}Z`, ...(c.parentId ? { parentId: String(c.parentId) } : {}) })
    const under = (id: number): FakeComment[] => comments.filter(c => c.parentId === id).flatMap(c => [c, ...under(c.id)])
    return { root: { ...mk(r), url: `https://x/c/${r.id}`, ...(r.inline ? { inline: r.inline } : {}) }, resolved: !!r.resolved, comments: under(r.id).map(mk).sort((a, b) => a.seq - b.seq) }
  }
  const create = (kind: string, body: string, extra: Partial<FakeComment> = {}): PostedComment => {
    counts.post++
    calls.push(kind)
    const err = hooks.failPost?.(counts.post, kind)
    const authorIds = [hooks.author?.(kind) ?? ME]
    if (err) {
      if (hooks.lateCommit) comments.push({ id: nextId++, body, authorIds: [ME], ...extra })
      throw err
    }
    const c: FakeComment = { id: nextId++, body, authorIds, ...extra }
    comments.push(c)
    hooks.onCreate?.(kind)
    return { id: String(c.id), url: `https://x/c/${c.id}`, createdOn: '', authorIds }
  }

  const resolveThread = vi.fn()
  const reopenThread = vi.fn()
  const postComment = vi.fn()
  const postReply = vi.fn()
  const adapter = {
    getPullRequestInfo: vi.fn(async () => { calls.push('head'); return { id: '7', title: 'A change', description: '', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'main', sourceCommit: hooks.head } as never }),
    getDiff: vi.fn(async () => hooks.diff ?? ''),
    getChangedFiles: vi.fn(async () => hooks.files ?? []),
    getFileContent: vi.fn(async () => ''),
    getRepoFileContent: vi.fn(async () => null),
    getPreviousReviewComments: vi.fn(async () => []),
    getRepliesToReviewComments: vi.fn(async () => ({ replies: [], agentReplyCount: 0 })),
    getAgentIdentity: vi.fn(async () => {
      if (hooks.identity instanceof Error) throw hooks.identity
      return hooks.identity ?? { ids: [], names: [] }
    }),
    listMarkedThreads: vi.fn(async (_pr: string, isMarked: (b: string) => boolean) => {
      calls.push('list')
      if (hooks.listError) throw hooks.listError
      return comments.filter(c => !c.parentId && isMarked(c.body)).map(asThread)
    }),
    getCommitDiff: vi.fn(async (base: string, head: string) => {
      calls.push('delta')
      const r = hooks.commitDiff?.(base, head) ?? ''
      if (r instanceof Error) throw r
      return r
    }),
    postInlineComment: vi.fn(async (_pr: string, anchor: { path: string; line: number }, body: string) => create('root', body, { inline: anchor })),
    postTopLevelComment: vi.fn(async (_pr: string, body: string) => create('summary', body)),
    postThreadComment: vi.fn(async (_pr: string, parent: string, body: string) => create('reply', body, { parentId: Number(parent) })),
    editComment: vi.fn(async (_pr: string, id: string, body: string) => {
      counts.edit++
      calls.push('edit')
      const err = hooks.failEdit?.(counts.edit)
      if (err) throw err
      const c = comments.find(x => x.id === Number(id))
      if (!c) throw httpErr(404)
      c.body = body
      editBodies.push(body)
    }),
    resolveThread, reopenThread, postComment, postReply,
  }
  return {
    adapter: adapter as unknown as VCSAdapter, raw: adapter, comments, hooks, calls, counts, editBodies,
    add: (c: Omit<FakeComment, 'id'>): number => { const full = { ...c, id: nextId++ }; comments.push(full); return full.id },
  }
}
export type Fake = ReturnType<typeof makeFake>
