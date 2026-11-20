import { describe, it, expect, vi } from 'vitest'
import type { MarkedThread, MarkedComment, PostedComment } from '../../vcs/adapter.js'
import { resolveIdentity } from '../identity.js'
import type { IdentityResult } from '../identity.js'
import { buildRegistry, isInlineMarked } from '../registry.js'
import { writeInline, InlineWriteError, type WriteInput, type WriterAdapter, type PlannedAnswer, type RootsResult } from '../writer.js'
import { rootBody } from '../compose.js'
import { withState, verify } from '../state.js'
import { SUMMARY_HEADER, buildAnswerMarker } from '../markers.js'
import { planRun, type PlannedRoot } from '../plan.js'
import { threadView } from '../replies.js'
import type { MappedEntry } from '../match.js'

const ME = 'acc-1'
const OTHER = 'acc-9'
const HEAD = 'a1b2c3d4e5f6' + '0'.repeat(28)
const A = 'aaaaaaaaaaaa'
const identity = resolveIdentity({ ids: [ME], names: ['bot'] }, '') as Extract<IdentityResult, { status: 'api' }>

interface FakeComment { id: number; parentId?: number; body: string; authorIds: string[]; inline?: { path: string; line: number }; resolved?: boolean }
interface Hooks { head: string; failPost?: (n: number, kind: string) => Error | undefined; failEdit?: (n: number) => Error | undefined; author?: (kind: string) => string; lateCommit?: boolean }

function makeFake() {
  const comments: FakeComment[] = []
  const hooks: Hooks = { head: HEAD }
  const calls: string[] = []
  const counts = { post: 0, edit: 0 }
  let nextId = 1
  const asThread = (r: FakeComment): MarkedThread => {
    const mk = (c: FakeComment): MarkedComment => ({ id: String(c.id), seq: c.id, body: c.body, author: 'x', authorIds: c.authorIds, createdOn: '', ...(c.parentId ? { parentId: String(c.parentId) } : {}) })
    const under = (id: number): FakeComment[] => comments.filter(c => c.parentId === id).flatMap(c => [c, ...under(c.id)])
    return {
      root: { ...mk(r), url: `u${r.id}`, ...(r.inline ? { inline: r.inline } : {}) }, resolved: !!r.resolved,
      comments: under(r.id).map(mk).sort((a, b) => a.seq - b.seq),
    }
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
    return { id: String(c.id), url: `u${c.id}`, createdOn: '', authorIds }
  }
  const adapter: WriterAdapter = {
    getPullRequestInfo: async () => { calls.push('head'); return { sourceCommit: hooks.head } as never },
    listMarkedThreads: async (_pr, isMarked) => { calls.push('list'); return comments.filter(c => !c.parentId && isMarked(c.body)).map(asThread) },
    postInlineComment: async (_pr, anchor, body) => create('root', body, { inline: anchor }),
    postTopLevelComment: async (_pr, body) => create('summary', body),
    postThreadComment: async (_pr, parent, body) => create('reply', body, { parentId: Number(parent) }),
    editComment: async (_pr, id, body) => {
      counts.edit++
      calls.push('edit')
      const err = hooks.failEdit?.(counts.edit)
      if (err) throw err
      const c = comments.find(x => x.id === Number(id))
      if (!c) throw Object.assign(new Error('not found'), { response: { status: 404 } })
      c.body = body
    },
  }
  return { adapter, comments, hooks, calls, counts, add: (c: Omit<FakeComment, 'id'>) => { const full = { ...c, id: nextId++ }; comments.push(full); return full.id } }
}
type Fake = ReturnType<typeof makeFake>

const httpErr = (status?: number): Error => Object.assign(new Error(status ? `HTTP ${status}` : 'socket hang up'), status ? { response: { status } } : { code: 'ECONNRESET' })

const summaryBody = (state: { n: number; commits: string[] }, text = 'old'): string => withState(`${SUMMARY_HEADER}\n\n${text}`, state, ME)
const rootText = (r: PlannedRoot): string => rootBody({ severity: r.finding.severity, title: r.finding.title, body: r.finding.body, id: r.id, c12: HEAD.slice(0, 12), ...(r.was ? { was: r.was } : {}) })
const planned = (k: number, extra: Partial<PlannedRoot> = {}): PlannedRoot => ({ id: `F${k}`, finding: { severity: 'HIGH', title: `Finding ${k} title`, body: `body ${k}` }, path: 'src/a.ts', line: k, ...extra })

function inputFor(fake: Fake, over: Partial<WriteInput> = {}): WriteInput & { headChecked: () => number } {
  const threads = fake.comments.filter(c => !c.parentId && isInlineMarked(c.body))
  const reg = buildRegistry(threads.map(r => ({ root: { id: String(r.id), seq: r.id, body: r.body, author: 'x', authorIds: r.authorIds, createdOn: '', url: '', ...(r.inline ? { inline: r.inline } : {}) }, resolved: !!r.resolved, comments: [] })), identity)
  if (reg.status !== 'ok') throw new Error('load failed')
  const markHeadChecked = vi.fn()
  return {
    adapter: fake.adapter, prId: '7', head: HEAD, identity, dryRun: false, forced: false, mode: 'review',
    summary: reg.summary, nextN: (reg.summary.kind === 'found' && reg.summary.state ? reg.summary.state.n : 0) + 1, entries: reg.entries,
    roots: [], rootText, answers: [], notes: [],
    buildSummary: (r: RootsResult, state) => summaryBody(state, `posted=${r.posted.map(p => p.root.id).join(',')} failed=${r.failed.map(f => `${f.root.id}:${f.reason}`).join(',')}`),
    markHeadChecked, headChecked: () => markHeadChecked.mock.calls.length, ...over,
  }
}

const summaryOf = (fake: Fake): FakeComment | undefined => fake.comments.find(c => !c.parentId && c.body.startsWith(SUMMARY_HEADER))
const creates = (fake: Fake): string[] => fake.calls.filter(c => ['root', 'summary', 'reply'].includes(c))

describe('writeInline: order and basics', () => {
  it('writes roots, then answers, then the summary, and records the head', async () => {
    const fake = makeFake()
    const rootId = fake.add({ body: rootBody({ severity: 'HIGH', title: 'Old', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 1 } })
    const q = fake.add({ parentId: rootId, body: 'why?', authorIds: ['dev'] })
    fake.add({ body: summaryBody({ n: 1, commits: [A] }), authorIds: [ME] })
    const input = inputFor(fake, { roots: [planned(2), planned(3)], answers: [{ target: 'F1', rootId: String(rootId), through: String(q), text: 'Because.' }] })
    const res = await writeInline(input)
    expect(res.outcome).toBe('written')
    expect(creates(fake)).toEqual(['root', 'root', 'reply'])
    expect(fake.counts.edit).toBe(1)
    expect(fake.calls.indexOf('edit')).toBeGreaterThan(fake.calls.lastIndexOf('reply'))
    expect(res.summary).toBe('edited')
    expect(verify(summaryOf(fake)!.body, ME)).toEqual({ n: 2, commits: [A, HEAD.slice(0, 12)] })
    expect(res.headRecorded).toBe(true)
    expect(input.headChecked()).toBe(1)
  })

  it('never calls anything that resolves or reopens a thread', async () => {
    const fake = makeFake()
    const seen: string[] = []
    const spy = new Proxy(fake.adapter, { get: (t, p) => { seen.push(String(p)); return Reflect.get(t, p) } })
    await writeInline(inputFor(fake, { adapter: spy, roots: [planned(1)] }))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter(n => /resolve|reopen/i.test(n))).toEqual([])
    expect(new Set(seen)).toEqual(new Set(['getPullRequestInfo', 'listMarkedThreads', 'postInlineComment', 'postTopLevelComment']))
  })

  it('creates the summary when none exists, and a dry run touches nothing', async () => {
    const fake = makeFake()
    const res = await writeInline(inputFor(fake, { roots: [planned(1)] }))
    expect(res.summary).toBe('created')
    const dry = makeFake()
    const out = await writeInline(inputFor(dry, { dryRun: true, roots: [planned(1)] }))
    expect(out.outcome).toBe('dry_run')
    expect(dry.calls).toEqual([])
  })

  it('a reply-only run posts answers with no state edit and no head record', async () => {
    const fake = makeFake()
    const rootId = fake.add({ body: rootBody({ severity: 'HIGH', title: 'Old', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 1 } })
    const q = fake.add({ parentId: rootId, body: 'why?', authorIds: ['dev'] })
    fake.add({ body: summaryBody({ n: 1, commits: [HEAD.slice(0, 12)] }), authorIds: [ME] })
    const input = inputFor(fake, { mode: 'replies', buildSummary: undefined, answers: [{ target: 'F1', rootId: String(rootId), through: String(q), text: 'Because.' }] })
    const res = await writeInline(input)
    expect(res.outcome).toBe('replies_only')
    expect(fake.counts.edit).toBe(0)
    expect(res.answers.posted).toBe(1)
    expect(input.headChecked()).toBe(0)
  })
})

describe('writeInline: head checks', () => {
  it('writes nothing when the head moved before the first write', async () => {
    const fake = makeFake()
    fake.hooks.head = 'b'.repeat(40)
    const res = await writeInline(inputFor(fake, { roots: [planned(1)] }))
    expect(res.outcome).toBe('head_moved_skip')
    expect(creates(fake)).toEqual([])
    expect(fake.counts.edit).toBe(0)
    expect(res.headMovedAt).toBe('bbbbbbbbbbbb')
  })

  it('stops between roots when the head moves after the first one', async () => {
    const fake = makeFake()
    fake.hooks.failPost = () => undefined
    const orig = fake.adapter.postInlineComment
    fake.adapter.postInlineComment = async (...a) => { const r = await orig(...a); fake.hooks.head = 'c'.repeat(40); return r }
    const res = await writeInline(inputFor(fake, { roots: [planned(1), planned(2)] }))
    expect(res.outcome).toBe('head_moved_partial')
    expect(res.posted.map(p => p.root.id)).toEqual(['F1'])
    expect(summaryOf(fake)).toBeUndefined()
    expect(res.headRecorded).toBe(false)
  })
})

describe('writeInline: concurrency', () => {
  it('barrier: a root another run posted after this snapshot stops the group, with zero writes', async () => {
    const fake = makeFake()
    const input = inputFor(fake, { roots: [planned(1)] })
    fake.add({ body: rootBody({ severity: 'HIGH', title: 'Finding 1 title', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 1 } })
    const res = await writeInline(input)
    expect(res.outcome).toBe('concurrent_run')
    expect(creates(fake)).toEqual([])
  })

  it('never creates a second summary while one exists', async () => {
    const fake = makeFake()
    const input = inputFor(fake)
    fake.add({ body: summaryBody({ n: 1, commits: [A] }), authorIds: [ME] })
    const res = await writeInline(input)
    expect(res.outcome).toBe('concurrent_run')
    expect(fake.calls).not.toContain('summary')
    expect(fake.comments.filter(c => c.body.startsWith(SUMMARY_HEADER))).toHaveLength(1)
  })

  it('does not edit a summary the agent does not own', async () => {
    const fake = makeFake()
    const foreign = fake.add({ body: summaryBody({ n: 1, commits: [A] }), authorIds: [OTHER] })
    const input = inputFor(fake)
    input.summary = { kind: 'found', comment: { id: String(foreign), seq: foreign, body: fake.comments[0].body, author: 'x', authorIds: [OTHER], createdOn: '', url: '' }, check: 'valid', state: { n: 1, commits: [A] }, extras: 0 }
    const res = await writeInline(input)
    expect(fake.counts.edit).toBe(0)
    expect(res.outcome).not.toBe('written')
    expect(fake.comments[0].body).toBe(summaryBody({ n: 1, commits: [A] }))
  })

  it('a thread reopened since load cancels a planned re-raise over it', async () => {
    const fake = makeFake()
    const id = fake.add({ body: rootBody({ severity: 'MEDIUM', title: 'Finding 1 title', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 1 }, resolved: true })
    const input = inputFor(fake, { roots: [planned(2, { was: 'F1' })] })
    expect(input.entries.find(e => e.id === 'F1')?.resolved).toBe(true)
    fake.comments.find(c => c.id === id)!.resolved = false
    const res = await writeInline(input)
    expect(creates(fake)).toEqual(['summary'])
    expect(res.cancelled.map(r => r.id)).toEqual(['F2'])
    expect(res.posted).toEqual([])
  })

  it('the id check refuses a planned id that already exists or repeats', async () => {
    const fake = makeFake()
    fake.add({ body: rootBody({ severity: 'HIGH', title: 'Other', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/b.ts', line: 1 } })
    const dup = await writeInline(inputFor(fake, { roots: [planned(1)] }))
    expect(dup.outcome).toBe('concurrent_run')
    expect(creates(fake)).toEqual([])

    const twice = makeFake()
    const res = await writeInline(inputFor(twice, { roots: [planned(1), planned(1, { line: 9 })] }))
    expect(res.outcome).toBe('concurrent_run')
    expect(creates(twice)).toEqual(['root'])
  })
})

describe('writeInline: identity on every create', () => {
  it.each([['root'], ['summary']])('a %s created under another author stops all writes', async kind => {
    const fake = makeFake()
    fake.hooks.author = k => (k === kind ? OTHER : ME)
    const res = await writeInline(inputFor(fake, { roots: [planned(1), planned(2)] }))
    expect(res.outcome).toBe('identity_mismatch')
    expect(creates(fake).filter(c => c === kind)).toHaveLength(1)
    if (kind === 'root') expect(creates(fake)).toEqual(['root'])
  })

  it('an answer on a reply-only run is checked too', async () => {
    const fake = makeFake()
    const rootId = fake.add({ body: rootBody({ severity: 'HIGH', title: 'Old', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 1 } })
    const q1 = fake.add({ parentId: rootId, body: 'why?', authorIds: ['dev'] })
    const rootId2 = fake.add({ body: rootBody({ severity: 'HIGH', title: 'Old2', body: 'x', id: 'F2', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 2 } })
    const q2 = fake.add({ parentId: rootId2, body: 'why?', authorIds: ['dev'] })
    fake.hooks.author = () => OTHER
    const res = await writeInline(inputFor(fake, { mode: 'replies', buildSummary: undefined, answers: [
      { target: 'F1', rootId: String(rootId), through: String(q1), text: 'a' }, { target: 'F2', rootId: String(rootId2), through: String(q2), text: 'b' },
    ] }))
    expect(res.outcome).toBe('identity_mismatch')
    expect(creates(fake)).toEqual(['reply'])
  })
})

describe('writeInline: answers stay in their own thread', () => {
  it('drops an answer whose question belongs to another thread, or whose root differs', async () => {
    const fake = makeFake()
    const r1 = fake.add({ body: rootBody({ severity: 'HIGH', title: 'One', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 1 } })
    const r2 = fake.add({ body: rootBody({ severity: 'HIGH', title: 'Two', body: 'x', id: 'F2', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 2 } })
    const q2 = fake.add({ parentId: r2, body: 'question for two', authorIds: ['dev'] })
    const answers: PlannedAnswer[] = [
      { target: 'F1', rootId: String(r1), through: String(q2), text: 'wrong thread' },
      { target: 'F2', rootId: String(r1), through: String(q2), text: 'wrong root' },
    ]
    const res = await writeInline(inputFor(fake, { mode: 'replies', buildSummary: undefined, answers }))
    expect(creates(fake)).toEqual([])
    expect(res.answers.skipped).toBe(2)
  })

  it('a pasted root marker by another author neither blocks the real thread nor receives a write', async () => {
    const fake = makeFake()
    const real = fake.add({ body: rootBody({ severity: 'HIGH', title: 'One', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 1 } })
    const q = fake.add({ parentId: real, body: 'why?', authorIds: ['dev'] })
    const forged = fake.add({ body: rootBody({ severity: 'HIGH', title: 'One', body: 'x', id: 'F1', c12: A }), authorIds: [OTHER], inline: { path: 'src/a.ts', line: 1 } })
    const res = await writeInline(inputFor(fake, { mode: 'replies', buildSummary: undefined, answers: [{ target: 'F1', rootId: String(real), through: String(q), text: 'Because.' }] }))
    expect(res.answers.posted).toBe(1)
    expect(fake.comments.filter(c => c.parentId === real && c.authorIds[0] === ME)).toHaveLength(1)
    expect(fake.comments.filter(c => c.parentId === forged)).toHaveLength(0)
  })

  it('skips an answer that an earlier or concurrent run already covered, and a resolved thread', async () => {
    const fake = makeFake()
    const r1 = fake.add({ body: rootBody({ severity: 'HIGH', title: 'One', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 1 } })
    const q = fake.add({ parentId: r1, body: 'q', authorIds: ['dev'] })
    fake.add({ parentId: r1, body: `ok\n\n${buildAnswerMarker('F1', String(q))}`, authorIds: [ME] })
    const r2 = fake.add({ body: rootBody({ severity: 'HIGH', title: 'Two', body: 'x', id: 'F2', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 2 }, resolved: true })
    const q2 = fake.add({ parentId: r2, body: 'q', authorIds: ['dev'] })
    const res = await writeInline(inputFor(fake, { mode: 'replies', buildSummary: undefined, answers: [
      { target: 'F1', rootId: String(r1), through: String(q), text: 'again' }, { target: 'F2', rootId: String(r2), through: String(q2), text: 'frozen' },
    ] }))
    expect(creates(fake)).toEqual([])
    expect(res.answers.skipped).toBe(2)
  })
})

describe('writeInline: uncertain creates', () => {
  const entryFor = (id: string, title: string, line: number): MappedEntry => ({
    entry: { id, k: Number(id.slice(1)), severity: 'HIGH', title, gist: '', file: 'src/a.ts', lines: String(line), openedAt: A, rootId: '1', url: 'u', resolved: false, humanComments: 0 },
    loc: { file: 'src/a.ts', line, g: 0, mapped: true }, changed: false,
  })
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n'

  it('a root that times out and commits late is an open thread next run, with nothing re-posted', async () => {
    const fake = makeFake()
    fake.hooks.failPost = (_n, kind) => (kind === 'root' ? httpErr() : undefined)
    fake.hooks.lateCommit = true
    const res = await writeInline(inputFor(fake, { roots: [planned(1, { line: 2 })] }))
    expect(res.outcome).toBe('write_uncertain')
    expect(fake.calls.filter(c => c === 'root')).toHaveLength(1)
    const next = inputFor(fake)
    expect(next.entries.map(e => e.id)).toEqual(['F1'])
    const plan = planRun({ findings: [{ severity: 'HIGH', title: 'Finding 1 title', body: 'b', file: 'src/a.ts', lines: '2' }], entries: [entryFor('F1', 'Finding 1 title', 2)], diff, nextK: 2, lowThreads: false })
    expect(plan.create).toEqual([])
    expect(plan.suppressed.open).toHaveLength(1)
  })

  it('a root that times out and never commits is posted once next run', async () => {
    const fake = makeFake()
    fake.hooks.failPost = (_n, kind) => (kind === 'root' ? httpErr(503) : undefined)
    const res = await writeInline(inputFor(fake, { roots: [planned(1, { line: 2 })] }))
    expect(res.outcome).toBe('write_uncertain')
    expect(res.failed).toEqual([expect.objectContaining({ reason: 'post_uncertain' })])
    const next = inputFor(fake)
    expect(next.entries).toEqual([])
    const plan = planRun({ findings: [{ severity: 'HIGH', title: 'Finding 1 title', body: 'b', file: 'src/a.ts', lines: '2' }], entries: [], diff, nextK: next.nextN, lowThreads: false })
    expect(plan.create).toHaveLength(1)
    fake.hooks.failPost = undefined
    const again = await writeInline(inputFor(fake, { roots: plan.create }))
    expect(again.posted).toHaveLength(1)
    expect(fake.calls.filter(c => c === 'root')).toHaveLength(2)
  })

  it('after an uncertain root nothing is resent, the head is not recorded, and other roots and the summary still go out', async () => {
    const fake = makeFake()
    fake.hooks.failPost = (_n, kind) => (kind === 'root' && fake.calls.filter(c => c === 'root').length === 1 ? httpErr() : undefined)
    const input = inputFor(fake, { roots: [planned(1), planned(2)] })
    const res = await writeInline(input)
    expect(fake.calls.filter(c => c === 'root')).toHaveLength(2)
    expect(res.posted.map(p => p.root.id)).toEqual(['F2'])
    expect(res.summary).toBe('created')
    expect(res.headRecorded).toBe(false)
    expect(input.headChecked()).toBe(0)
    expect(verify(summaryOf(fake)!.body, ME)?.commits).toEqual([])
    expect(summaryOf(fake)!.body).toContain('F1:post_uncertain')
  })

  it('a 429 that withRetry gave up on is a refusal and is not resent', async () => {
    const fake = makeFake()
    fake.hooks.failPost = (_n, kind) => (kind === 'root' ? httpErr(429) : undefined)
    const res = await writeInline(inputFor(fake, { roots: [planned(1)] }))
    expect(fake.calls.filter(c => c === 'root')).toHaveLength(1)
    expect(res.failed[0].reason).toBe('post_failed')
    expect(res.outcome).toBe('written')
    expect(res.headRecorded).toBe(true)
  })

  it('an answer that commits late covers its question, and one that never commits is answered once next run', async () => {
    for (const late of [true, false]) {
      const fake = makeFake()
      const r1 = fake.add({ body: rootBody({ severity: 'HIGH', title: 'One', body: 'x', id: 'F1', c12: A }), authorIds: [ME], inline: { path: 'src/a.ts', line: 1 } })
      const q = fake.add({ parentId: r1, body: 'q', authorIds: ['dev'] })
      fake.add({ body: summaryBody({ n: 1, commits: [HEAD.slice(0, 12)] }), authorIds: [ME] })
      const answers = [{ target: 'F1', rootId: String(r1), through: String(q), text: 'Because.' }]
      fake.hooks.failPost = () => httpErr()
      fake.hooks.lateCommit = late
      const res = await writeInline(inputFor(fake, { mode: 'replies', buildSummary: undefined, answers }))
      expect(res.outcome).toBe('write_uncertain')
      expect(fake.calls.filter(c => c === 'reply')).toHaveLength(1)
      const thread = (): MarkedThread => {
        const root = fake.comments.find(c => c.id === r1)!
        return {
          root: { id: String(root.id), seq: root.id, body: root.body, author: 'x', authorIds: root.authorIds, createdOn: '', url: '' }, resolved: false,
          comments: fake.comments.filter(c => c.parentId === r1).map(c => ({ id: String(c.id), seq: c.id, parentId: String(r1), body: c.body, author: 'x', authorIds: c.authorIds, createdOn: '' })),
        }
      }
      const view = threadView(thread(), 'F1', { ids: [ME], names: [] })
      expect(view.pending.length).toBe(late ? 0 : 1)
      expect(view.used).toBe(late ? 1 : 0)
    }
  })
})

describe('writeInline: summary writes', () => {
  const withSummary = (fake: Fake, commits: string[]): number => fake.add({ body: summaryBody({ n: 1, commits }), authorIds: [ME] })

  it('a 403 on the summary edit fails the run, twice, and adds no comments', async () => {
    const fake = makeFake()
    withSummary(fake, [A])
    fake.hooks.failEdit = () => httpErr(403)
    const before = fake.comments.length
    for (let i = 0; i < 2; i++) await expect(writeInline(inputFor(fake))).rejects.toBeInstanceOf(InlineWriteError)
    expect(fake.comments).toHaveLength(before)
  })

  it('a 404 with the summary gone posts a new one; with it still present the run fails', async () => {
    const fake = makeFake()
    const id = withSummary(fake, [A])
    const input = inputFor(fake)
    const build = input.buildSummary!
    input.buildSummary = (r, s) => { fake.comments.splice(fake.comments.findIndex(c => c.id === id), 1); return build(r, s) }
    const res = await writeInline(input)
    expect(res.summary).toBe('created')
    expect(fake.comments.filter(c => c.body.startsWith(SUMMARY_HEADER))).toHaveLength(1)

    const stays = makeFake()
    withSummary(stays, [A])
    stays.hooks.failEdit = () => httpErr(404)
    await expect(writeInline(inputFor(stays))).rejects.toThrow(/still exists/)
    expect(stays.calls).not.toContain('summary')
  })

  it('records the head in commits and calls markHeadChecked even when the bundle was uncertain', async () => {
    const fake = makeFake()
    const ctx: { bundleUncertain: boolean; headChecked?: boolean } = { bundleUncertain: true }
    const legacyMark = (): void => { if (ctx.bundleUncertain) return; ctx.headChecked = true }
    const markHeadChecked = vi.fn(legacyMark)
    const res = await writeInline(inputFor(fake, { markHeadChecked }))
    expect(res.newState?.commits).toEqual([HEAD.slice(0, 12)])
    expect(markHeadChecked).toHaveBeenCalledTimes(1)
    expect(ctx.headChecked).toBeUndefined()
  })

  it('an uncertain summary edit leaves the head unrecorded without resending', async () => {
    const fake = makeFake()
    withSummary(fake, [A])
    fake.hooks.failEdit = () => httpErr(502)
    const input = inputFor(fake)
    const res = await writeInline(input)
    expect(res.outcome).toBe('write_uncertain')
    expect(fake.counts.edit).toBe(1)
    expect(input.headChecked()).toBe(0)
  })
})

describe('writeInline: forced runs', () => {
  const head12 = HEAD.slice(0, 12)

  it('invalidates the head first and adds it back at the successful end', async () => {
    const fake = makeFake()
    fake.add({ body: summaryBody({ n: 1, commits: [A, head12] }), authorIds: [ME] })
    const bodies: string[] = []
    const origEdit = fake.adapter.editComment
    fake.adapter.editComment = async (p, id, body) => { bodies.push(body); return origEdit(p, id, body) }
    const res = await writeInline(inputFor(fake, { forced: true, roots: [planned(1)] }))
    expect(res.outcome).toBe('written')
    expect(verify(bodies[0], ME)).toEqual({ n: 1, commits: [A] })
    expect(fake.calls.indexOf('edit')).toBeLessThan(fake.calls.indexOf('root'))
    expect(verify(bodies[1], ME)).toEqual({ n: 2, commits: [A, head12] })
  })

  it('a failed invalidation writes nothing', async () => {
    const fake = makeFake()
    fake.add({ body: summaryBody({ n: 1, commits: [head12] }), authorIds: [ME] })
    fake.hooks.failEdit = () => httpErr(403)
    const res = await writeInline(inputFor(fake, { forced: true, roots: [planned(1)] }))
    expect(res.outcome).toBe('force_invalidate_failed')
    expect(creates(fake)).toEqual([])
  })

  it('an uncertain root plus a failed summary leaves the head out of commits', async () => {
    const fake = makeFake()
    fake.add({ body: summaryBody({ n: 1, commits: [head12] }), authorIds: [ME] })
    fake.hooks.failPost = (_n, kind) => (kind === 'root' ? httpErr() : undefined)
    fake.hooks.failEdit = n => (n === 2 ? httpErr(403) : undefined)
    await expect(writeInline(inputFor(fake, { forced: true, roots: [planned(1)] }))).rejects.toBeInstanceOf(InlineWriteError)
    expect(verify(summaryOf(fake)!.body, ME)?.commits).toEqual([])
  })
})
