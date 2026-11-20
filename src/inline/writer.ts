import type { InlineCapableAdapter, VCSAdapter, MarkedThread } from '../vcs/adapter.js'
import { isTrusted } from './identity.js'
import type { IdentityResult } from './identity.js'
import { isInlineMarked, buildRegistry, type Registry } from './registry.js'
import { parseAnswerMarker, parseNoteMarker } from './markers.js'
import { addCommit, canonical, splitState, withState } from './state.js'
import { answerBody, noteBody, targetOf } from './replies.js'
import type { PlannedRoot } from './plan.js'
import type { InlineOutcome, SummaryState, ThreadEntry } from './types.js'

type OkIdentity = Extract<IdentityResult, { status: 'api' | 'setting_only' }>
type Selection = Registry['summary']

export type WriterAdapter = Pick<InlineCapableAdapter, 'listMarkedThreads' | 'postInlineComment' | 'postTopLevelComment' | 'postThreadComment' | 'editComment'>
  & Pick<VCSAdapter, 'getPullRequestInfo'>

export interface PlannedAnswer { target: string; rootId: string; through: string; text: string }
export interface PlannedNote { target: string; rootId: string; max: number }
export interface PostedRoot { root: PlannedRoot; commentId: string; url: string }
export interface RootFailure { root: PlannedRoot; reason: 'post_failed' | 'post_uncertain' }

export interface RootsResult { posted: PostedRoot[]; failed: RootFailure[]; cancelled: PlannedRoot[]; entries: ThreadEntry[] }

export interface WriteInput {
  adapter: WriterAdapter
  prId: string
  head: string
  identity: OkIdentity
  dryRun: boolean
  forced: boolean
  mode: 'review' | 'replies'
  summary: Selection
  nextN: number
  entries: readonly ThreadEntry[]
  roots: readonly PlannedRoot[]
  rootText: (r: PlannedRoot) => string
  answers: readonly PlannedAnswer[]
  notes: readonly PlannedNote[]
  coveredByOpen?: (root: PlannedRoot, openIds: ReadonlySet<string>) => boolean
  buildSummary?: (r: RootsResult, state: SummaryState) => string
  markHeadChecked: () => void
}

export interface WriteResult extends RootsResult {
  outcome: InlineOutcome
  answers: { posted: number; failed: number; uncertain: number; skipped: number; summaryPosted: number }
  notesPosted: number
  summary: 'created' | 'edited' | 'not_written'
  headRecorded: boolean
  newState?: SummaryState
  headMovedAt?: string
  reconciled: number
}

export class InlineWriteError extends Error {
  constructor(message: string, readonly result: WriteResult) {
    super(message)
    this.name = 'InlineWriteError'
  }
}

const statusOf = (err: unknown): number | undefined => (err as { response?: { status?: number } } | null)?.response?.status
// A timeout, 5xx or reset may have been applied, so only a clear 4xx counts as a refusal.
const refused = (err: unknown): boolean => { const s = statusOf(err); return s !== undefined && s >= 400 && s < 500 }
const msg = (err: unknown): string => { try { return String((err as Error)?.message ?? err) } catch { return 'unknown error' } }

type Listed = { ok: true; threads: MarkedThread[]; reg: Registry } | { ok: false; outcome: InlineOutcome }

export async function writeInline(input: WriteInput): Promise<WriteResult> {
  const { adapter, prId, identity } = input
  const head12 = input.head.slice(0, 12)
  const res: WriteResult = {
    outcome: 'written', posted: [], failed: [], cancelled: [], entries: [...input.entries],
    answers: { posted: 0, failed: 0, uncertain: 0, skipped: 0, summaryPosted: 0 }, notesPosted: 0, summary: 'not_written', headRecorded: false, reconciled: 0,
  }
  const loaded = input.summary.kind === 'found' && input.summary.check === 'valid' && input.summary.state ? input.summary.state : { n: 0, commits: [] as string[] }
  const trusted = (authorIds: readonly string[]): boolean => isTrusted(identity.ids, authorIds)
  const known = new Set(input.entries.map(e => e.id))
  const takenIds = new Set(known)
  let touched = false
  let uncertain = false
  let invalidated = false
  let headInSummary = false
  let expectedBody = input.summary.kind === 'found' ? input.summary.comment.body : ''

  const stop = (outcome: InlineOutcome): WriteResult => { res.outcome = outcome; return res }
  let headCheckFailed = false
  const moved = (): InlineOutcome => (headCheckFailed ? 'head_check_failed' : touched ? 'head_moved_partial' : 'head_moved_skip')

  if (input.dryRun) return dryRun(input, res, loaded, head12)

  async function headMoved(): Promise<boolean> {
    try {
      const now = (await adapter.getPullRequestInfo(prId)).sourceCommit.slice(0, 12)
      if (now === head12) return false
      res.headMovedAt = now
    } catch (err: unknown) {
      console.warn(`  Head check failed (${msg(err)}) - no further writes`)
      headCheckFailed = true
    }
    return true
  }

  // One re-list per group; a root nobody here knows, or a changed summary, means another run is writing.
  async function relist(): Promise<Listed> {
    let threads: MarkedThread[]
    try {
      threads = await adapter.listMarkedThreads(prId, isInlineMarked)
    } catch (err: unknown) {
      console.warn(`  Re-list failed (${msg(err)}) - no further writes`)
      // With nothing written the run must fail like a legacy error, not pass as a completed review.
      if (!touched) throw new InlineWriteError(`Re-list failed before any write (${msg(err)})`, { ...res, outcome: 'write_failed' })
      uncertain = true
      return { ok: false, outcome: 'write_uncertain' }
    }
    const reg = buildRegistry(threads, identity)
    if (reg.status === 'identity_mismatch') return { ok: false, outcome: 'identity_mismatch' }
    if (reg.entries.some(e => !known.has(e.id))) return { ok: false, outcome: 'concurrent_run' }
    const s = reg.summary
    const same = input.summary.kind === 'none'
      ? s.kind === 'none'
      : s.kind === 'found' && s.comment.id === input.summary.comment.id && canonical(s.comment.body) === canonical(expectedBody)
    if (!same) return { ok: false, outcome: 'concurrent_run' }
    res.entries = reg.entries
    return { ok: true, threads, reg }
  }

  if (input.mode === 'review' && input.forced && input.summary.kind === 'found' && input.summary.check === 'valid' && loaded.commits.includes(head12)) {
    if (await headMoved()) return stop(moved())
    const comment = input.summary.comment
    const split = splitState(comment.body)
    if (!trusted(comment.authorIds) || !split) return stop('identity_mismatch')
    const body = withState(split.above, { n: loaded.n, commits: loaded.commits.filter(c => c !== head12) }, identity.agentId)
    try {
      await adapter.editComment(prId, comment.id, body)
    } catch (err: unknown) {
      console.warn(`  Forced-run checkpoint edit failed (${msg(err)}) - nothing written`)
      return stop('force_invalidate_failed')
    }
    touched = true
    invalidated = true
    expectedBody = body
  }

  if (input.roots.length > 0) {
    if (await headMoved()) return stop(moved())
    const listed = await relist()
    if (!listed.ok) return stop(listed.outcome)
    // A thread reopened since load already carries the finding, so a planned re-raise over it would duplicate.
    const open = new Set(listed.reg.entries.filter(e => !e.resolved).map(e => e.id))
    const plan = input.roots.filter(r => {
      // Any reopened thread can carry the finding, not only the one it was raised over, so the engine's open-match rule decides.
      if ((r.was && open.has(r.was)) || input.coveredByOpen?.(r, open)) { res.cancelled.push(r); return false }
      return true
    })
    for (const root of plan) {
      if (await headMoved()) return stop(moved())
      if (takenIds.has(root.id)) return stop('concurrent_run')
      try {
        const posted = await adapter.postInlineComment(prId, { path: root.path, line: root.line }, input.rootText(root))
        touched = true
        if (!trusted(posted.authorIds)) return stop('identity_mismatch')
        takenIds.add(root.id)
        known.add(root.id)
        res.posted.push({ root, commentId: posted.id, url: posted.url })
      } catch (err: unknown) {
        if (refused(err)) { res.failed.push({ root, reason: 'post_failed' }); console.warn(`  Root ${root.id} refused (${msg(err)})`); continue }
        // The POST may have been applied, so it is never resent in this run; the next listing settles it.
        touched = true
        uncertain = true
        takenIds.add(root.id)
        known.add(root.id)
        res.failed.push({ root, reason: 'post_uncertain' })
        console.warn(`  Root ${root.id} outcome unknown (${msg(err)}) - not resent`)
      }
    }
  }

  if (input.answers.length > 0 || input.notes.length > 0) {
    if (await headMoved()) return stop(moved())
    const listed = await relist()
    if (!listed.ok) return stop(listed.outcome)
    // A push can land during the re-list, so the head is re-checked right before the group's first write.
    if (await headMoved()) return stop(moved())
    const summaryId = listed.reg.summary.kind === 'found' ? listed.reg.summary.comment.id : undefined
    const byTarget = new Map<string, MarkedThread>()
    for (const t of listed.threads) {
      const target = targetOf(t, summaryId)
      // A pasted root marker by anyone else must not shadow the agent's own thread.
      if (target && trusted(t.root.authorIds)) byTarget.set(target, t)
    }
    const uncertainTargets = new Set<string>()
    const post = async (t: MarkedThread, body: string, target: string): Promise<'ok' | 'refused' | 'uncertain' | 'identity_mismatch'> => {
      try {
        const posted = await adapter.postThreadComment(prId, t.root.id, body)
        touched = true
        return trusted(posted.authorIds) ? 'ok' : 'identity_mismatch'
      } catch (err: unknown) {
        console.warn(`  Reply on ${target} ${refused(err) ? 'refused' : 'outcome unknown, not resent'} (${msg(err)})`)
        if (refused(err)) return 'refused'
        touched = true
        uncertain = true
        uncertainTargets.add(target)
        return 'uncertain'
      }
    }
    const owns = (t: MarkedThread, target: string): { covered: number; noted: boolean } => {
      let covered = -1
      let noted = false
      for (const c of t.comments) {
        if (!trusted(c.authorIds)) continue
        const a = parseAnswerMarker(c.body)
        if (a && a.target === target && Number.isFinite(Number(a.through))) covered = Math.max(covered, Number(a.through))
        const n = parseNoteMarker(c.body)
        if (n && n.target === target) noted = true
      }
      return { covered, noted }
    }

    for (const a of input.answers) {
      const t = byTarget.get(a.target)
      // The question must sit in the thread the answer goes to, and that thread must still be the planned root and open.
      if (!t || t.root.id !== a.rootId || t.resolved || !t.comments.some(c => c.id === a.through && !trusted(c.authorIds)) || owns(t, a.target).covered >= Number(a.through) || uncertainTargets.has(a.target)) {
        res.answers.skipped++
        continue
      }
      const r = await post(t, answerBody(a.target, a.through, a.text), a.target)
      if (r === 'identity_mismatch') return stop(r)
      if (r === 'ok') { res.answers.posted++; if (a.target === 'summary') res.answers.summaryPosted++ }
      else if (r === 'refused') res.answers.failed++
    }
    for (const n of input.notes) {
      const t = byTarget.get(n.target)
      if (!t || t.root.id !== n.rootId || t.resolved || owns(t, n.target).noted || uncertainTargets.has(n.target)) continue
      const r = await post(t, noteBody(n.target, n.max), n.target)
      if (r === 'identity_mismatch') return stop(r)
      if (r === 'ok') res.notesPosted++
    }
    res.answers.uncertain = uncertainTargets.size
  }

  if (input.mode === 'review' && input.buildSummary) {
    if (await headMoved()) return stop(moved())
    const listed = await relist()
    if (!listed.ok) return stop(listed.outcome)
    if (await headMoved()) return stop(moved())
    const present = new Set(listed.reg.entries.map(e => e.id))
    const settled = res.failed.filter(f => f.reason === 'post_uncertain' && present.has(f.root.id))
    res.failed = res.failed.filter(f => !settled.includes(f))
    res.reconciled = settled.length

    const base = invalidated ? loaded.commits.filter(c => c !== head12) : loaded.commits
    const recordHead = !uncertain
    const stateFor = (withHead: boolean): SummaryState => ({ n: input.nextN, commits: withHead ? addCommit({ n: input.nextN, commits: base }, head12).commits : base })
    const bodyFor = (withHead: boolean): string => input.buildSummary!(res, stateFor(withHead))
    headInSummary = recordHead
    const written = await writeSummary(bodyFor, listed.reg.summary, recordHead)
    if (written === 'identity_mismatch') return stop('identity_mismatch')
    if (written === 'concurrent_run') return stop('concurrent_run')
    if (written === 'head_moved') return stop(moved())
    res.newState = stateFor(headInSummary)
    if (written === 'uncertain') uncertain = true
    else if (headInSummary) { res.headRecorded = true; input.markHeadChecked() }
  }

  res.outcome = uncertain ? 'write_uncertain' : input.mode === 'review' ? 'written' : 'replies_only'
  return res

  async function writeSummary(bodyFor: (withHead: boolean) => string, current: Selection, withHead: boolean): Promise<'ok' | 'uncertain' | 'identity_mismatch' | 'concurrent_run' | 'head_moved'> {
    const fail = (why: string): never => { throw new InlineWriteError(why, { ...res, outcome: uncertain ? 'write_uncertain' : 'write_failed' }) }
    const create = async (): Promise<'ok' | 'uncertain' | 'identity_mismatch'> => {
      let posted: Awaited<ReturnType<WriterAdapter['postTopLevelComment']>>
      try {
        // A create whose response is lost may still have landed, so it never carries the head; the head goes in by edit once the create is acknowledged.
        posted = await adapter.postTopLevelComment(prId, bodyFor(false))
      } catch (err: unknown) {
        if (refused(err)) return fail(`Summary create refused (${msg(err)})`)
        touched = true
        headInSummary = false
        console.warn(`  Summary create outcome unknown (${msg(err)}) - not resent`)
        return 'uncertain'
      }
      touched = true
      if (!trusted(posted.authorIds)) return 'identity_mismatch'
      res.summary = 'created'
      if (!withHead) return 'ok'
      try {
        await adapter.editComment(prId, posted.id, bodyFor(true))
        return 'ok'
      } catch (err: unknown) {
        headInSummary = false
        console.warn(`  Head checkpoint edit ${refused(err) ? 'refused' : 'outcome unknown'} (${msg(err)}) - head not recorded`)
        return refused(err) ? 'ok' : 'uncertain'
      }
    }
    if (current.kind === 'none') return create()
    if (!trusted(current.comment.authorIds)) return 'identity_mismatch'
    try {
      await adapter.editComment(prId, current.comment.id, bodyFor(withHead))
      touched = true
      res.summary = 'edited'
      return 'ok'
    } catch (err: unknown) {
      const status = statusOf(err)
      if (status === 403) return fail('Summary edit refused (403): the agent needs edit permission on its own comments')
      if (status === 404) {
        let threads: MarkedThread[]
        try { threads = await adapter.listMarkedThreads(prId, isInlineMarked) } catch (e: unknown) { return fail(`Summary edit returned 404 and the re-list failed (${msg(e)})`) }
        const reg = buildRegistry(threads, identity)
        if (reg.status === 'identity_mismatch') return 'identity_mismatch'
        if (reg.summary.kind === 'none') {
          // A push can land during the recovery re-list, and a created summary must not describe a stale head.
          if (await headMoved()) return 'head_moved'
          return create()
        }
        return fail('Summary edit returned 404 but the summary still exists')
      }
      if (refused(err)) return fail(`Summary edit refused (${msg(err)})`)
      touched = true
      console.warn(`  Summary edit outcome unknown (${msg(err)}) - not resent`)
      return 'uncertain'
    }
  }
}

function dryRun(input: WriteInput, res: WriteResult, loaded: SummaryState, head12: string): WriteResult {
  console.log('\n=== DRY RUN - Inline writes (not posted) ===\n')
  for (const r of input.roots) console.log(`--- root ${r.id} at ${r.path}:${r.line}\n${input.rootText(r)}\n`)
  for (const a of input.answers) console.log(`--- answer on ${a.target}\n${answerBody(a.target, a.through, a.text)}\n`)
  for (const n of input.notes) console.log(`--- note on ${n.target}\n${noteBody(n.target, n.max)}\n`)
  if (input.mode === 'review' && input.buildSummary) {
    const synthetic: RootsResult = { posted: input.roots.map(root => ({ root, commentId: 'dry-run', url: '(dry run)' })), failed: [], cancelled: [], entries: res.entries }
    const state: SummaryState = { n: input.nextN, commits: addCommit({ n: input.nextN, commits: loaded.commits }, head12).commits }
    console.log(`--- summary\n${input.buildSummary(synthetic, state)}\n`)
  }
  console.log('=== End of inline writes ===\n')
  res.outcome = 'dry_run'
  return res
}
