import { sumAttempts, ContentFilterError, type LLMUsage } from '../llm/shared.js'
import type { MarkedThread } from '../vcs/adapter.js'
import { isTrusted } from './identity.js'
import { parseRootMarker } from './markers.js'
import { decide, selectBatch, targetOf, threadView, type ThreadView } from './replies.js'
import type { CodeSince } from './match.js'
import { runFindingReplies, runSummaryReplies, type CallArgs } from './replies-call.js'
import type { PlannedAnswer, PlannedNote } from './writer.js'
import { REPLY_DECLINED_TEXT } from '../review/content-filter.js'

// One call covers the whole batch, so the refusal cannot be pinned on a thread; each declined thread is answered once and the rest move on.
const declineAnswer = (v: ThreadView): PlannedAnswer => ({ target: v.target, rootId: v.rootId, through: v.pending.reduce((a, q) => (q.seq > a.seq ? q : a)).id, text: REPLY_DECLINED_TEXT })

export interface ReplyPlanInput {
  threads: readonly MarkedThread[]
  who: { ids: readonly string[]; names: readonly string[] }
  summaryRootId?: string
  maxFinding: number
  maxSummary: number
  skipDirected?: boolean
  status?: (v: ThreadView) => Promise<CodeSince>
  call: CallArgs
}

export interface ReplyPlan {
  answers: PlannedAnswer[]
  notes: PlannedNote[]
  threads: number
  deferredCap: number
  summaryAnswered: boolean
  usage?: LLMUsage
  callFailed: boolean
  error?: Error
  declined: ContentFilterError[]
}

const usageOf = (err: unknown): LLMUsage | undefined => (err as { usage?: LLMUsage } | null)?.usage

// A reply failure must not lose a finished review, so a failed call leaves its questions pending for a later run.
export async function planReplies(input: ReplyPlanInput): Promise<ReplyPlan> {
  const plan: ReplyPlan = { answers: [], notes: [], threads: 0, deferredCap: 0, summaryAnswered: false, callFailed: false, declined: [] }
  const views: ThreadView[] = []
  const open = new Set<string>()
  for (const t of input.threads) {
    const target = targetOf(t, input.summaryRootId)
    if (!target) continue
    // A marker-shaped root by anyone else is not our finding, so its thread is never answered.
    if (target !== 'summary' && !isTrusted(input.who.ids, t.root.authorIds)) continue
    if (target !== 'summary' && !parseRootMarker(t.root.body)) continue
    const view = threadView(t, target, input.who, input.skipDirected)
    views.push(view)
    if (!t.resolved) open.add(target)
  }

  const answerable: ThreadView[] = []
  let summaryView: ThreadView | undefined
  for (const v of views) {
    if (!open.has(v.target)) continue
    const isSummary = v.target === 'summary'
    const decision = isSummary ? decide(v, input.maxSummary) : decide(v, input.maxFinding)
    if (decision === 'note') plan.notes.push({ target: v.target, rootId: v.rootId, max: isSummary ? input.maxSummary : input.maxFinding })
    if (decision !== 'answer') continue
    if (isSummary) summaryView = v
    else answerable.push(v)
  }

  const { batch, deferred } = selectBatch(answerable)
  plan.deferredCap = deferred
  plan.threads = batch.length + (summaryView ? 1 : 0)
  const usages: LLMUsage[] = []

  if (input.status) {
    for (const v of batch) v.status = await input.status(v).catch((): CodeSince => 'unknown')
  }

  if (batch.length > 0) {
    try {
      const r = await runFindingReplies({ ...input.call, threads: batch })
      usages.push(r.usage)
      plan.answers.push(...r.answers)
    } catch (err: unknown) {
      const u = usageOf(err)
      if (u) usages.push(u)
      // A refusal repeats for the same question, so it is answered with a decline instead of staying pending and being re-sent.
      if (err instanceof ContentFilterError) {
        plan.declined.push(err)
        if (batch.length === 1) {
          plan.answers.push(declineAnswer(batch[0]))
          console.warn('  Finding reply declined by the content filter - posting a decline answer')
        } else {
          console.warn('  Finding replies declined by the content filter - asking each thread once on its own')
          // Each thread gets one smaller request of its own; this runs at most once per run because the batch call does.
          for (const v of batch) {
            try {
              const r = await runFindingReplies({ ...input.call, threads: [v] })
              usages.push(r.usage)
              plan.answers.push(...r.answers)
            } catch (splitErr: unknown) {
              const su = usageOf(splitErr)
              if (su) usages.push(su)
              if (splitErr instanceof ContentFilterError) {
                plan.declined.push(splitErr)
                plan.answers.push(declineAnswer(v))
              } else {
                plan.callFailed = true
                plan.error ??= splitErr instanceof Error ? splitErr : new Error(String(splitErr))
                console.warn(`  Finding reply for ${v.target} failed (${(splitErr as Error)?.message}) - the question stays pending`)
              }
            }
          }
        }
      } else {
        plan.callFailed = true
        plan.error = err instanceof Error ? err : new Error(String(err))
        console.warn(`  Finding replies failed (${(err as Error)?.message}) - the questions stay pending`)
      }
    }
  }
  if (summaryView) {
    try {
      const r = await runSummaryReplies({ ...input.call, view: summaryView })
      usages.push(r.usage)
      if (r.answer) { plan.answers.push(r.answer); plan.summaryAnswered = true }
    } catch (err: unknown) {
      const u = usageOf(err)
      if (u) usages.push(u)
      if (err instanceof ContentFilterError) {
        plan.declined.push(err)
        plan.answers.push(declineAnswer(summaryView))
        console.warn('  Summary reply declined by the content filter - posting a decline answer')
      } else {
        plan.callFailed = true
        plan.error ??= err instanceof Error ? err : new Error(String(err))
        console.warn(`  Summary reply failed (${(err as Error)?.message}) - the question stays pending`)
      }
    }
  }
  if (usages.length > 0) plan.usage = sumAttempts(...usages)
  return plan
}
