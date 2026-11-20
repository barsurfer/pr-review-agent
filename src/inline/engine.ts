import { config } from '../config.js'
import type { LLMUsage } from '../llm/shared.js'
import { addUsage } from '../review/bundled.js'
import { headMatches } from '../review/checked-commit.js'
import { countFindings, isNoChange } from '../review/formatter.js'
import type { RenderedFinding } from '../review/formatter.js'
import { normalizeFindingPath, parseLineRange } from '../review/findings-output.js'
import { countChangedLines, filterDiff } from '../review/parsers.js'
import { State, type OutcomeSink, type ReviewContext } from '../review/types.js'
import { estimateAttemptsCost, estimateCost, getBuildCommit } from '../review/usage.js'
import type { AgentIdentity, MarkedThread, VCSAdapter } from '../vcs/adapter.js'
import { carryNarrative, cleanAndGuard, composeSummary, fixPart, rootBody, type Guarded } from './compose.js'
import { resolveIdentity, type IdentityResult } from './identity.js'
import { createDeltaMapper, mapEntries, matches, type DeltaMapper, type Mapped } from './match.js'
import { planRun, type PlanFinding, type RunPlan } from './plan.js'
import { buildRegistry, isInlineMarked, type Registry } from './registry.js'
import { contextReplies } from './replies.js'
import { planReplies, type ReplyPlan } from './reply-flow.js'
import { buildPrior, type PriorItems } from './reviewer-list.js'
import type { ResolvedRow, SummaryOnlyRow, ThreadRow } from './rows.js'
import { parseHistory, parseRows } from './rows.js'
import type { InlineDeps, InlineEngine, InlineOutcome, InlineRecord, Listed, SummaryState, ThreadEntry } from './types.js'
import { InlineWriteError, writeInline, type RootsResult, type WriteInput, type WriteResult } from './writer.js'

type OkIdentity = Extract<IdentityResult, { status: 'api' | 'setting_only' }>
type Capable = VCSAdapter & Required<Pick<VCSAdapter, 'listMarkedThreads' | 'postInlineComment' | 'postTopLevelComment' | 'postThreadComment' | 'editComment'>>

const isCapable = (a: VCSAdapter): a is Capable =>
  typeof a.listMarkedThreads === 'function' && typeof a.postInlineComment === 'function' && typeof a.postTopLevelComment === 'function'
  && typeof a.postThreadComment === 'function' && typeof a.editComment === 'function'

const STOPPED: readonly InlineOutcome[] = ['concurrent_run', 'head_moved_skip', 'head_moved_partial', 'identity_mismatch', 'force_invalidate_failed']

const forced = (ctx: ReviewContext): boolean => ctx.force === 'clean' || ctx.force === 're-review'

const SEVERITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
const NO_CHANGE_PLAIN = '### Summary\nNo reviewable changes since the last review; the earlier review stands.'
const QUIET_PLAIN = '### Summary\nNo new findings.'

export function selectInlineEngine(adapter: VCSAdapter, outcomeSink?: OutcomeSink): InlineEngine | undefined {
  if (!config.review.inlineReviews) return undefined
  if (outcomeSink) {
    console.log('Inline reviews are on, but this is a benchmark run - using the legacy flow')
    return undefined
  }
  if (!isCapable(adapter)) {
    console.log('Inline reviews are on, but this VCS does not support them (Bitbucket only) - using the legacy review flow')
    return undefined
  }
  return new Engine(adapter)
}

const emptyRecord = (): InlineRecord => ({
  active: true, completed: false, identity: 'unavailable', summary_check: 'missing', summary: 'not_written',
  roots: { posted: 0, failed: 0, summary_only: { low: 0, no_line: 0, out_of_hunk: 0, old_side: 0, over_cap: 0 } },
  suppressed: { open_duplicate: 0, resolved: 0, in_run_duplicate: 0 }, raised_over_resolved: 0,
  answers: { threads: 0, posted: 0, failed: 0, deferred_cap: 0, limit_notes: 0, summary: 0 },
  reply_usage: null, untrusted_markers: 0, writes_reconciled: 0, rows_collapsed: 0, footer_lines_removed: 0,
})

interface Session {
  identity: OkIdentity
  reg: Registry
  threads: MarkedThread[]
  state: SummaryState
  head: string
  head12: string
  who: { ids: string[]; names: string[] }
  summaryRootId?: string
  history: string[]
  carry: { plain?: string; summaryOnly: SummaryOnlyRow[] }
}

interface Geo { file: string; lines?: string; base: string }

interface RunSource {
  plain: string
  findings: PlanFinding[]
  carriedSummaryOnly?: readonly SummaryOnlyRow[]
  todoSection: string
  historyText: (r: RootsResult) => string
}

const lineString = (m: Mapped): string | undefined =>
  m.line === undefined ? undefined : m.end !== undefined && m.end > m.line ? `${m.line}-${m.end}` : String(m.line)

function rangeString(lines: string | undefined): string | undefined {
  const r = parseLineRange(lines)
  return r ? (r.end > r.start ? `${r.start}-${r.end}` : String(r.start)) : undefined
}

const toPlanFinding = (f: { severity: 'HIGH' | 'MEDIUM' | 'LOW'; title: string; body: string; file?: string; lines?: string; proposal?: string; bodyWithoutFix?: string }, paths: readonly string[]): PlanFinding => {
  const fix = config.judge.suggestedFixes ? fixPart(f) : undefined
  return {
    severity: f.severity, title: f.title, body: f.body,
    ...(f.file ? { file: normalizeFindingPath(f.file, paths) } : {}), ...(f.lines ? { lines: f.lines } : {}), ...(fix ? { fix } : {}),
  }
}

class Engine implements InlineEngine {
  prior?: { block: string }
  replyUsage?: LLMUsage
  private rec: InlineRecord = emptyRecord()
  private s?: Session
  private priorBase?: PriorItems
  private finished = false

  constructor(private readonly adapter: Capable) {}

  record(): InlineRecord { return this.rec }

  priorFor(files: string[]): { block: string } | undefined {
    return this.priorBase ? buildPrior(this.priorBase, files) : undefined
  }

  async step(state: State, ctx: ReviewContext, deps: InlineDeps): Promise<State> {
    if (this.finished) return deps.transition(state, ctx)
    if (!this.s && state !== State.CHECK_PREVIOUS_REVIEWS) return deps.transition(state, ctx)
    switch (state) {
      case State.CHECK_PREVIOUS_REVIEWS: return this.load(ctx, deps)
      case State.CHECK_NO_CHANGE: return this.checkNoChange(ctx, deps)
      case State.JUDGE_REVIEW: return this.judge(ctx, deps)
      case State.POST_REVIEW: return this.compose(ctx, deps, false)
      case State.SKIP: return ctx.action === 'NO_NEW_FINDINGS' ? this.compose(ctx, deps, true) : this.repliesOnly(ctx, deps, 'skip')
      case State.CHECK_REPLIES:
      case State.RESPOND_TO_REPLIES:
      case State.POST_REPLY_LIMIT_NOTE:
        return this.repliesOnly(ctx, deps, 'skip')
      default: return deps.transition(state, ctx)
    }
  }

  private halt(ctx: ReviewContext, outcome: InlineOutcome, reason: string): State {
    this.rec.outcome = outcome
    this.finished = true
    ctx.action = 'SKIP'
    ctx.skipReason = reason
    return State.SKIP
  }

  private async identify(): Promise<IdentityResult> {
    let api: AgentIdentity | null = null
    try {
      api = this.adapter.getAgentIdentity ? await this.adapter.getAgentIdentity() : null
    } catch (err: unknown) {
      console.warn(`  Agent identity lookup failed (${(err as Error)?.message})`)
    }
    return resolveIdentity(api, config.review.inlineAgentAccountId)
  }

  private async load(ctx: ReviewContext, deps: InlineDeps): Promise<State> {
    const head = ctx.prInfo!.sourceCommit
    const head12 = head.slice(0, 12)
    console.log('Loading inline review state...')
    const identity = await this.identify()
    if (identity.status === 'unavailable') return this.halt(ctx, 'identity_unavailable', 'the agent identity is unavailable (no adapter lookup and no AGENT_ACCOUNT_ID); nothing was posted')
    if (identity.status === 'identity_mismatch') return this.halt(ctx, 'identity_mismatch', identity.reason)
    this.rec.identity = identity.status === 'api' ? 'api' : 'setting'

    const threads = await this.adapter.listMarkedThreads(ctx.prId, isInlineMarked)
    const reg = buildRegistry(threads, identity)
    this.rec.untrusted_markers = reg.untrusted
    if (reg.status === 'identity_mismatch') return this.halt(ctx, 'identity_mismatch', reg.reason)

    const sel = reg.summary
    this.rec.summary_check = sel.kind === 'none' ? 'missing' : sel.check
    const valid = sel.kind === 'found' && sel.check === 'valid' && sel.state ? sel : undefined
    const state: SummaryState = valid?.state ?? { n: 0, commits: [] }
    const rows = valid ? parseRows(valid.comment.body) : undefined
    const summaryOnly: Listed[] = (rows?.summaryOnly ?? []).map(r => ({ severity: r.severity, title: r.title, gist: r.body ?? '', ...(r.file ? { file: r.file } : {}), ...(r.lines ? { lines: r.lines } : {}) }))
    this.s = {
      identity, reg, threads, state, head, head12, who: { ids: identity.ids, names: identity.names },
      ...(sel.kind === 'found' ? { summaryRootId: sel.comment.id } : {}),
      history: valid ? parseHistory(valid.comment.body) : [],
      carry: { ...(valid ? { plain: carryNarrative(valid.comment.body) ?? undefined } : {}), summaryOnly: rows?.summaryOnly ?? [] },
    }
    console.log(`  Summary ${this.rec.summary_check}, ${reg.entries.length} finding thread(s), review ${state.n} completed`)

    if (!forced(ctx) && state.commits.includes(head12)) {
      console.log(`  Head ${head12} was already reviewed - checking for unanswered questions...`)
      if (ctx.checkedCommit && headMatches(ctx.checkedCommit, head)) ctx.dedupHit = 'checked_commit'
      deps.markHeadChecked(ctx)
      this.rec.completed = true
      ctx.reviewNumber = state.n
      ctx.previousReviews = []
      return this.repliesOnly(ctx, deps, 'dedup')
    }

    let unchanged = false
    if (!forced(ctx) && state.commits.length > 0) {
      const base = state.commits[state.commits.length - 1]
      try {
        console.log(`  Fetching delta diff (${base}..${head12})...`)
        const { filtered } = filterDiff(await ctx.adapter.getCommitDiff(base, head), config.diffExcludePatterns)
        if (countChangedLines(filtered) === 0) {
          unchanged = true
        } else {
          const delta = await deps.narrowTargetMergeDelta(ctx, base, head, filtered)
          if (delta === null) { unchanged = true; ctx.dedupHit = 'target_merge' } else ctx.deltaDiff = delta
        }
      } catch (err: unknown) {
        console.log(`  Delta diff fetch failed (${(err as Error)?.message}) - reviewing the full PR diff`)
        ctx.deltaFetchFailed = true
      }
    }

    ctx.previousReviews = []
    ctx.reviewNumber = state.n + 1
    if (unchanged) {
      console.log('  No reviewable changes since the last review - refreshing the summary')
      return this.writeRun(ctx, deps, this.noChangeSource())
    }

    const discussion = contextReplies(threads, this.s.who, this.s.summaryRootId)
    if (discussion.length > 0) {
      ctx.replies = discussion
      console.log(`  Found ${discussion.length} discussion comment(s) - will include in review context`)
    }
    if (ctx.force !== 'clean') {
      this.priorBase = { n: state.n, commit: state.commits[state.commits.length - 1] ?? reg.entries[reg.entries.length - 1]?.openedAt ?? head12, entries: reg.entries, summaryOnly }
      this.prior = buildPrior(this.priorBase)
    }
    return State.LOAD_PROMPT
  }

  private async checkNoChange(ctx: ReviewContext, deps: InlineDeps): Promise<State> {
    if (!isNoChange(ctx.reviewText ?? '')) return deps.transition(State.CHECK_NO_CHANGE, ctx)
    if (this.s!.state.n === 0) throw new Error('Reviewer returned NO_CHANGE on a first review - refusing to silently skip')
    console.log('  Reviewer: NO_CHANGE')
    // Same coherence rule as legacy: a NO_CHANGE that still carries findings is not trusted as a completed check.
    const coherent = ctx.reviewObject ? ctx.reviewObject.no_change === true && ctx.reviewObject.findings?.length === 0 : ctx.reviewText === 'NO_CHANGE'
    if (!coherent) return this.repliesOnly(ctx, deps, 'incoherent', 'NO_CHANGE reported together with findings; not recorded as checked')
    return this.writeRun(ctx, deps, this.noChangeSource())
  }

  // Nothing new was reviewed, so the last verified narrative and its summary-only rows must outlive the refresh.
  private noChangeSource(): RunSource {
    const { plain, summaryOnly } = this.s!.carry
    return { plain: plain ?? NO_CHANGE_PLAIN, findings: [], carriedSummaryOnly: summaryOnly, todoSection: '', historyText: () => 'no change' }
  }

  // The legacy quiet gate runs before extra-pass candidates reach the judge, so one review number 1 call keeps it open for them.
  private async judge(ctx: ReviewContext, deps: InlineDeps): Promise<State> {
    const own = ctx.reviewObject && Array.isArray(ctx.reviewObject.findings) ? countFindings(ctx.reviewObject) : { high: 0, medium: 0, low: 0 }
    const extra = (ctx.breadthFindings?.length ?? 0) + (ctx.secondLookFindings?.length ?? 0) + (ctx.lensRuns ?? []).reduce((n, r) => n + r.findings.length, 0)
    if (own.high + own.medium + own.low > 0 || extra === 0) return deps.transition(State.JUDGE_REVIEW, ctx)
    const saved = ctx.reviewNumber
    ctx.reviewNumber = 1
    try {
      return await deps.transition(State.JUDGE_REVIEW, ctx)
    } finally {
      ctx.reviewNumber = saved
    }
  }

  private async compose(ctx: ReviewContext, deps: InlineDeps, quiet: boolean): Promise<State> {
    ctx.headChecked = undefined
    ctx.action = 'ERROR'
    ctx.skipReason = undefined
    let guard: Guarded | undefined
    try {
      guard = cleanAndGuard(ctx.reviewText ?? '', { judged: ctx.judgeUsage !== undefined, diff: ctx.filteredDiff ?? '', todoScan: config.review.todoScan })
    } catch (err: unknown) {
      // A quiet gate means nothing was found, so a malformed narrative must not block the clean summary.
      if (!quiet) throw err
    }
    if (!quiet && guard && !guard.ok) {
      console.log('  Review text empty or NO_CHANGE after cleanup - not writing a review')
      return this.repliesOnly(ctx, deps, 'incoherent', 'Review text empty or NO_CHANGE after cleanup')
    }
    const paths = (ctx.changedFiles ?? []).map(f => f.path)
    const found = quiet ? [] : (ctx.judgedFindings ?? ctx.reviewObject?.findings ?? []).map(f => toPlanFinding(f, paths))
    const n = found.length
    const carry = this.s!.carry
    return this.writeRun(ctx, deps, {
      plain: guard?.ok ? guard.cleaned : quiet ? (carry.plain ?? QUIET_PLAIN) : QUIET_PLAIN,
      findings: found,
      ...(quiet ? { carriedSummaryOnly: carry.summaryOnly } : {}),
      todoSection: guard?.ok ? guard.todoSection : '',
      historyText: r => (n === 0 ? 'no findings' : `${n} finding${n === 1 ? '' : 's'}, ${r.posted.length} new thread${r.posted.length === 1 ? '' : 's'}`),
    })
  }

  private async geoOf(e: ThreadEntry, mapper: DeltaMapper, head12: string): Promise<Geo> {
    const kept: Geo = { file: e.file || '(unknown)', ...(e.lines ? { lines: e.lines } : {}), base: e.openedAt }
    if (!e.file) return kept
    const m = await mapper.map(e.file, e.lines, e.openedAt)
    if (!m) return kept
    const lines = lineString(m)
    return { file: m.file, ...(lines ? { lines } : {}), base: head12 }
  }

  private async writeRun(ctx: ReviewContext, deps: InlineDeps, src: RunSource): Promise<State> {
    const s = this.s!
    const mapper = createDeltaMapper(base => ctx.adapter.getCommitDiff(base, s.head), s.head12)
    const mapped = await mapEntries(s.reg.entries, mapper)
    const geo = new Map<string, Geo>()
    for (const m of mapped) geo.set(m.entry.id, await this.geoOf(m.entry, mapper, s.head12))
    const plan = planRun({ findings: src.findings, entries: mapped, diff: ctx.diff ?? '', nextK: s.reg.nextK, lowThreads: config.review.inlineLowThreads })
    for (const x of plan.summaryOnly) this.rec.roots!.summary_only[x.reason]++
    this.rec.suppressed = { open_duplicate: plan.suppressed.open.length, resolved: plan.suppressed.resolved.length, in_run_duplicate: plan.suppressed.sameRun.length }

    const replies = await this.replyPlan(ctx)
    const footer = { identity: config.agentIdentity, model: config.anthropic.model, build: getBuildCommit() }
    // A thread that landed after an uncertain POST already carries the finding, so its stale summary-only row would list it twice.
    const carried = (src.carriedSummaryOnly ?? []).filter(c => !mapped.some(m => !m.entry.resolved && matches(m, c, 'open')))
    const buildSummary = (roots: RootsResult, state: SummaryState): string => {
      const { threads, resolved, summaryOnly } = this.rows(roots, plan, geo, carried)
      const composed = composeSummary({
        review: { plain: src.plain, findings: src.findings as RenderedFinding[] },
        threads, summaryOnly, resolved, history: s.history, historyText: src.historyText(roots), todoSection: src.todoSection,
        footer, head12: s.head12, state, agentId: s.identity.agentId,
      })
      this.rec.footer_lines_removed = composed.removed
      this.rec.rows_collapsed = composed.collapsed
      return composed.body
    }

    const res = await this.write(ctx, deps, {
      mode: 'review', nextN: s.state.n + 1, roots: plan.create,
      rootText: r => rootBody({ severity: r.finding.severity, title: r.finding.title, body: r.finding.fix?.body ?? r.finding.body, ...(r.finding.fix ? { fixBlock: r.finding.fix.block } : {}), id: r.id, c12: s.head12, ...(r.was ? { was: r.was } : {}) }),
      answers: replies.answers, notes: replies.notes, buildSummary,
    })
    this.rec.raised_over_resolved = res.posted.filter(p => p.root.was).length
    return this.settle(ctx, res)
  }

  private rows(roots: RootsResult, plan: RunPlan, geo: ReadonlyMap<string, Geo>, carried: readonly SummaryOnlyRow[]): { threads: ThreadRow[]; resolved: ResolvedRow[]; summaryOnly: SummaryOnlyRow[] } {
    const head12 = this.s!.head12
    const threads: ThreadRow[] = []
    const resolved: ResolvedRow[] = []
    const seen = new Set<string>()
    for (const e of roots.entries) {
      seen.add(e.id)
      if (e.resolved) { resolved.push({ kind: 'resolved', id: e.id, severity: e.severity, title: e.title }); continue }
      const g = geo.get(e.id) ?? { file: e.file || '(unknown)', ...(e.lines ? { lines: e.lines } : {}), base: e.openedAt }
      threads.push({
        kind: 'thread', severity: e.severity, title: e.title, file: g.file, ...(g.lines ? { lines: g.lines } : {}), base: g.base,
        id: e.id, ...(e.was ? { was: e.was } : {}), url: e.url, ...(plan.changedInPush.has(e.id) ? { changed: true } : {}),
      })
    }
    // A POST the listing has not caught up with yet still needs its row.
    for (const p of roots.posted) {
      if (seen.has(p.root.id)) continue
      const lines = rangeString(p.root.finding.lines) ?? String(p.root.line)
      threads.push({ kind: 'thread', severity: p.root.finding.severity, title: p.root.finding.title, file: p.root.path, lines, base: head12, id: p.root.id, ...(p.root.was ? { was: p.root.was } : {}), url: p.url })
    }
    const notThreads = [...plan.summaryOnly.map(x => x.finding), ...roots.failed.map(f => f.root.finding)]
      .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
    const summaryOnly: SummaryOnlyRow[] = notThreads.map(f => ({
      kind: 'summary_only', severity: f.severity, title: f.title, body: f.body,
      ...(f.file ? { file: f.file } : {}), ...(rangeString(f.lines) ? { lines: rangeString(f.lines) } : {}),
    }))
    return { threads, resolved, summaryOnly: [...summaryOnly, ...carried] }
  }

  private async replyPlan(ctx: ReviewContext): Promise<ReplyPlan> {
    const s = this.s!
    const model = config.reply.model || config.anthropic.model
    const plan = await planReplies({
      threads: s.threads, who: s.who, summaryRootId: s.summaryRootId,
      maxFinding: config.reply.maxFindingReplies, maxSummary: config.reply.maxComments, skipDirected: config.reply.skipDirectedElsewhere,
      call: { apiKey: config.llmApiKey, model, maxRetries: config.anthropic.maxRetries, diff: ctx.filteredDiff ?? ctx.diff ?? '' },
    })
    this.rec.answers!.threads = plan.threads
    this.rec.answers!.deferred_cap = plan.deferredCap
    if (plan.usage) {
      const u = plan.usage
      // The reply's reported cost stays out of the aggregate so a reviewer with no reported cost is still estimated; the record adds the reply once.
      this.replyUsage = { ...u, cost_usd: undefined }
      addUsage(ctx, this.replyUsage)
      this.rec.reply_usage = {
        model, input_tokens: u.input_tokens, output_tokens: u.output_tokens,
        cost_usd: u.cost_usd ?? (u.attempts ? estimateAttemptsCost(u.attempts, model) : estimateCost({ input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 }, model)),
      }
    }
    return plan
  }

  private async write(ctx: ReviewContext, deps: InlineDeps, parts: Pick<WriteInput, 'mode' | 'nextN' | 'roots' | 'rootText' | 'answers' | 'notes' | 'buildSummary'>): Promise<WriteResult> {
    const s = this.s!
    try {
      return await writeInline({
        adapter: this.adapter, prId: ctx.prId, head: s.head, identity: s.identity, dryRun: ctx.dryRun, forced: forced(ctx),
        summary: s.reg.summary, entries: s.reg.entries, markHeadChecked: () => deps.markHeadChecked(ctx), ...parts,
      })
    } catch (err: unknown) {
      if (err instanceof InlineWriteError) {
        this.noteWrite(err.result, parts.mode === 'replies')
        this.rec.outcome = err.result.outcome
        this.finished = true
      }
      throw err
    }
  }

  private noteWrite(res: WriteResult, keepCompleted = false): void {
    const r = this.rec
    r.summary = res.summary
    r.roots!.posted = res.posted.length
    r.roots!.failed = res.failed.length
    r.writes_reconciled = res.reconciled
    r.answers!.posted = res.answers.posted
    r.answers!.summary = res.answers.summaryPosted
    r.answers!.failed = res.answers.failed + res.answers.uncertain
    r.answers!.limit_notes = res.notesPosted
    if (res.headMovedAt) r.head_moved_at = res.headMovedAt
    if (!keepCompleted) r.completed = res.headRecorded
  }

  private async repliesOnly(ctx: ReviewContext, deps: InlineDeps, kind: 'dedup' | 'skip' | 'incoherent', reason?: string): Promise<State> {
    const plan = await this.replyPlan(ctx)
    let res: WriteResult | undefined
    if (plan.answers.length > 0 || plan.notes.length > 0) {
      try {
        res = await this.write(ctx, deps, { mode: 'replies', nextN: this.s!.state.n + 1, roots: [], rootText: () => '', answers: plan.answers, notes: plan.notes })
      } catch (err: unknown) {
        // Legacy never calls the reply model after a skip, so a failed attempt there must leave the legacy SKIP alone.
        if (kind === 'dedup' || !(err instanceof InlineWriteError) || err.result.outcome !== 'write_failed') throw err
      }
    }
    if (res) {
      this.noteWrite(res)
      // The head was completed by an earlier run, so a replies-only write never changes that.
      this.rec.completed = kind === 'dedup'
    }
    this.finished = true
    if (res && STOPPED.includes(res.outcome)) return this.skipFor(ctx, res.outcome, res)
    const posted = res ? res.answers.posted + res.notesPosted : 0
    // Only a dedup run fails like legacy RESPOND_TO_REPLIES; after a skip or an unrecorded review the reply attempt is a bonus.
    if (plan.callFailed && posted === 0 && kind === 'dedup') {
      this.rec.outcome = 'dedup'
      const err = plan.error ?? new Error('Reply model call failed')
      // The engine already counted this usage; review() would add it again at the reviewer price.
      Reflect.deleteProperty(err, 'usage')
      throw err
    }
    this.rec.outcome = kind === 'incoherent' ? 'incoherent_no_change' : res && res.outcome !== 'replies_only' ? res.outcome : posted > 0 ? 'replies_only' : kind === 'dedup' ? 'dedup' : 'skipped'

    if (kind === 'incoherent') { ctx.action = 'NO_CHANGE'; ctx.skipReason = reason; return State.SKIP }
    if (posted > 0 || (res?.outcome === 'dry_run' && plan.answers.length > 0)) {
      ctx.action = 'REPLY'
      ctx.skipReason = undefined
      return State.DONE
    }
    // Only the dedup path owns the DEDUP_SKIP label; any other skip keeps the reason the legacy flow gave it.
    if (kind === 'dedup') {
      ctx.action = 'DEDUP_SKIP'
      ctx.skipReason = 'head already reviewed and no unanswered questions'
    }
    return State.SKIP
  }

  private settle(ctx: ReviewContext, res: WriteResult): State {
    this.noteWrite(res)
    this.rec.outcome = res.outcome
    this.finished = true
    if (STOPPED.includes(res.outcome)) return this.skipFor(ctx, res.outcome, res)
    ctx.action = this.s!.state.n === 0 ? 'REVIEW' : 'RE_REVIEW'
    ctx.skipReason = undefined
    return State.DONE
  }

  private skipFor(ctx: ReviewContext, outcome: InlineOutcome, res: WriteResult): State {
    this.rec.outcome = outcome
    this.finished = true
    switch (outcome) {
      case 'concurrent_run':
        ctx.action = 'DEDUP_SKIP'
        ctx.skipReason = 'another run is writing to this PR; nothing more was written'
        break
      case 'head_moved_skip':
        ctx.action = 'SKIP'
        ctx.skipReason = `the PR head moved to ${res.headMovedAt ?? 'a newer commit'} before anything was written; nothing was posted`
        break
      case 'head_moved_partial':
        ctx.action = 'SKIP'
        ctx.skipReason = `the PR head moved to ${res.headMovedAt ?? 'a newer commit'} after some writes; the next run reviews the new head`
        break
      case 'identity_mismatch':
        ctx.action = 'SKIP'
        ctx.skipReason = 'a posted comment came back under a different author; no further writes'
        break
      case 'force_invalidate_failed':
        ctx.action = 'SKIP'
        ctx.skipReason = 'the forced run could not invalidate the completed head in the summary; nothing was written'
        break
      default:
        ctx.action = 'SKIP'
        ctx.skipReason = `inline write ended with ${outcome}`
    }
    return State.SKIP
  }
}
