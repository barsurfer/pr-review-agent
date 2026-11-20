import type { MarkedComment, MarkedThread, CommentReply } from '../vcs/adapter.js'
import { AGENT_REPLY_AUTHOR } from '../vcs/adapter.js'
import { decideDirectedElsewhere, mentionsAgent } from '../vcs/mention-filter.js'
import { parseRootMarker, parseAnswerMarker, parseNoteMarker, buildAnswerMarker, buildNoteMarker, stripGeneratedFooters } from './markers.js'
import { isTrusted } from './identity.js'

export const MAX_BATCH_THREADS = 8

export interface Question { id: string; seq: number; author: string; body: string; createdOn: string }

export interface ThreadView {
  target: string
  rootId: string
  rootBody: string
  comments: MarkedComment[]
  questions: Question[]
  pending: Question[]
  used: number
  noted: boolean
}

export interface ReplyIdentity { ids: readonly string[]; names: readonly string[] }
export type Decision = 'answer' | 'note' | 'none'

export function targetOf(thread: MarkedThread, summaryRootId?: string): string | null {
  if (summaryRootId !== undefined && thread.root.id === summaryRootId) return 'summary'
  return parseRootMarker(thread.root.body)?.id ?? null
}

export function threadView(thread: MarkedThread, target: string, who: ReplyIdentity): ThreadView {
  const comments = [...thread.comments].sort((a, b) => a.seq - b.seq)
  const trusted = (c: MarkedComment): boolean => isTrusted(who.ids, c.authorIds)
  const byId = new Map<string, MarkedComment>([[thread.root.id, thread.root], ...comments.map((c): [string, MarkedComment] => [c.id, c])])

  // A marker for another thread's id never counts here, so a stray or copied answer cannot cover or spend this thread.
  let covered = -1
  let used = 0
  let noted = false
  for (const c of comments) {
    if (!trusted(c)) continue
    const a = parseAnswerMarker(c.body)
    if (a && a.target === target) {
      used++
      const through = Number(a.through)
      if (Number.isFinite(through)) covered = Math.max(covered, through)
    }
    const n = parseNoteMarker(c.body)
    if (n && n.target === target) noted = true
  }

  const ids = new Set(who.ids)
  const names = new Set(who.names)
  const questions: Question[] = []
  for (const c of comments) {
    if (trusted(c)) continue
    if (decideDirectedElsewhere(c.body, ids, names).drop) continue
    const parent = c.parentId ? byId.get(c.parentId) : undefined
    const toAgent = parent ? trusted(parent) : false
    if (toAgent || mentionsAgent(c.body, ids, names)) questions.push({ id: c.id, seq: c.seq, author: c.author, body: c.body, createdOn: c.createdOn })
  }
  return { target, rootId: thread.root.id, rootBody: thread.root.body, comments, questions, pending: questions.filter(q => q.seq > covered), used, noted }
}

export function decide(view: ThreadView, max: number): Decision {
  if (view.pending.length === 0) return 'none'
  if (max === 0 || view.used < max) return 'answer'
  return view.noted ? 'none' : 'note'
}

export function selectBatch(views: readonly ThreadView[], cap = MAX_BATCH_THREADS): { batch: ThreadView[]; deferred: number } {
  const ordered = views.filter(v => v.pending.length > 0).sort((a, b) => a.pending[0].seq - b.pending[0].seq)
  return { batch: ordered.slice(0, cap), deferred: Math.max(0, ordered.length - cap) }
}

export function answerBody(target: string, through: string, text: string): string {
  return `${stripGeneratedFooters(text).text}\n\n${buildAnswerMarker(target, through)}`
}

export function noteBody(target: string, max: number): string {
  const where = target === 'summary' ? 'this summary' : target
  return `Reply limit of ${max} reached on ${where}. Further questions here are not answered; new questions are answered under a later review.\n\n${buildNoteMarker(target)}`
}

const dropLastLine = (body: string): string => {
  const lines = body.replace(/\r\n/g, '\n').trimEnd().split('\n')
  lines.pop()
  return lines.join('\n').trimEnd()
}

// Roots are left out because the reviewer already receives their findings in the already-reported list.
export function contextReplies(threads: readonly MarkedThread[], who: ReplyIdentity, summaryRootId?: string): CommentReply[] {
  const out: CommentReply[] = []
  for (const t of threads) {
    const target = targetOf(t, summaryRootId)
    if (!target || !isTrusted(who.ids, t.root.authorIds)) continue
    for (const c of [...t.comments].sort((a, b) => a.seq - b.seq)) {
      const base = { id: c.id, parentId: c.parentId ?? t.root.id, createdOn: c.createdOn, ...(target !== 'summary' ? { findingId: target } : {}) }
      if (isTrusted(who.ids, c.authorIds)) {
        if (parseAnswerMarker(c.body)) out.push({ ...base, author: AGENT_REPLY_AUTHOR, body: dropLastLine(c.body) })
        continue
      }
      out.push({ ...base, author: c.author, ...(c.authorIds[0] ? { authorId: c.authorIds[0] } : {}), body: c.body })
    }
  }
  return out.sort((a, b) => a.createdOn.localeCompare(b.createdOn))
}
