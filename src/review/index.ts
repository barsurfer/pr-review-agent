// ---------------------------------------------------------------------------
// Review orchestration — state machine only
// ---------------------------------------------------------------------------

import { config } from '../config.js'
import { contextWindowFor } from '../llm/context-window.js'
import { DeadlineAbortError, type LLMUsage } from '../llm/shared.js'
import { loadPrompt, type LoadedPrompt } from '../prompt/loader.js'
import { describeHttpError } from '../vcs/http-retry.js'
import { fetchContext } from '../context/fetcher.js'
import { runReview, runCommentResponse, runJudge, runBreadth, runLens, findingsOutputSchema, sanitizeFirstPassSites, type SiteDropReason } from './client.js'
import { buildShownSource } from './shown-anchors.js'
import { candidateId, type JudgeOptions } from './judge-decisions.js'
import { fileCoverage, prioritizeUntouched, breadthSystemPrompt, breadthBriefing, flaggedFiles, findingsInFiles, secondLookSystemPrompt, secondLookBriefing, type LensStatus } from './breadth.js'
import { activeLenses, parseLensList, lensSystemPrompt, lensBriefing } from './lenses.js'
import { splitDiffByFile } from './bundler.js'
import { normalizeFindingPath, type FirstPassSite } from './findings-output.js'
import { filterDiff, countChangedLines, parseVerdictScore, isPathExcluded, scanTodos, isContextLengthError, shownLength } from './parsers.js'
import { buildReviewFooter, buildReplyFooter, stripPreviousFooter, stripDeltaStats, stripJudgeNotes, stripJenkinsMeta, stripPreamble, isNoChange, extractCommitHash, legacyCommitHash, countFindings, markdownHasFindings, hasReplyFooter, renderReview, type ReviewFinding } from './formatter.js'
import { runBundledReview, addUsage, recordPassCall } from './bundled.js'
import { composeSuggestedFixes, COMMENT_BUDGET } from './suggested-fix.js'
import { orderPosted } from './posted-order.js'
import { buildUsageRecord, logUsageRecord, getBuildCommit, getJobUrl } from './usage.js'
import { ignoredCommentAuthor } from './trigger.js'
import { headMatches } from './checked-commit.js'
import { outsideSections, changedPrFiles, narrowDelta, readableDiff, sameHead, diffPaths } from './target-merge.js'
import { State } from './types.js'

// Supersede boundary: the latest review that isn't human-resolved (a resolved review is dismissed, so it must not bury an unanswered reply); falls back to the last review when all are resolved.
function supersedeBoundary<T extends { resolved?: boolean }>(reviews: T[]): T | undefined {
  const unresolved = reviews.filter(r => !r.resolved)
  const pool = unresolved.length > 0 ? unresolved : reviews
  return pool[pool.length - 1]
}

import type { ReviewContext, OutcomeSink, LensRun, TriggerInfo } from './types.js'
import { PrTooLargeError } from '../vcs/adapter.js'
import type { VCSAdapter, CommentReply } from '../vcs/adapter.js'

// Reply flow only answers questions put to the agent. When enabled, drop replies a dev @-directed
// solely at someone else. Fail-safe: config off, no adapter capability, or any error keeps all.
async function dropRepliesDirectedElsewhere(ctx: ReviewContext, replies: CommentReply[]): Promise<CommentReply[]> {
  if (!config.reply.skipDirectedElsewhere || !ctx.adapter.filterAddressedToAgent || replies.length === 0) return replies
  try {
    const kept = await ctx.adapter.filterAddressedToAgent(replies, new Set())
    const dropped = replies.length - kept.length
    if (dropped > 0) console.log(`  Skipped ${dropped} reply(s) @-directed at someone else`)
    return kept
  } catch (err: unknown) {
    console.warn(`  Directed-reply filter failed (${(err as Error).message}) — keeping all replies`)
    return replies
  }
}

// Nested human-to-human discussion stays reviewer context; answering it would spend the reply budget on chatter.
function questionsForAgent(replies: CommentReply[]): CommentReply[] {
  const questions = replies.filter(r => !r.contextOnly)
  if (questions.length < replies.length) console.log(`  Skipped ${replies.length - questions.length} nested reply(s) to a human that don't @-mention the agent`)
  return questions
}

// The CLI maps an empty --force to 'off', but review() is also called directly, so '' or an unknown mode must not count as forced.
const forced = (ctx: ReviewContext): boolean => ctx.force === 'clean' || ctx.force === 're-review'

// `source` itself stays unsuffixed because records and dashboards group on it.
const promptLabel = (p: LoadedPrompt): string => (p.lookupFailed ? `${p.source} (lookup failed)` : p.source)

// CI stores checked_commit from this, so only points where the head's reviewable content was really checked may set it.
function markHeadChecked(ctx: ReviewContext): void {
  if (forced(ctx) || ctx.dryRun || ctx.outcomeSink || ctx.bundleUncertain || ctx.deltaFetchFailed) return
  ctx.headChecked = true
}

// A rejection can be any value, even a prototype-less object, so describing it must never throw out of a fail-open path.
function errorText(err: unknown): string {
  try { return String((err as Error | undefined)?.message ?? err) } catch { return 'unknown error' }
}

// Null when a target merge left the PR diff unchanged; every failure keeps the full delta, so a review never depends on this check.
async function narrowTargetMergeDelta(ctx: ReviewContext, base: string, head: string, delta: string): Promise<string | null> {
  const targetCommit = ctx.prInfo!.targetCommit
  if (!config.review.targetMergeCheck || !ctx.adapter.getPrDiffAt || !targetCommit) return delta
  const base12 = base.slice(0, 12)
  let at = base
  // Pinned, since the PR diff fetched by id may be another head's; unfiltered, since the exclude filter keys on a rename's old path and could hide a PR file the delta holds.
  const pinned = async (commit: string): Promise<string> => {
    at = commit
    const diff = await ctx.adapter.getPrDiffAt!(commit, targetCommit)
    if (!/^diff --git /m.test(diff)) throw new Error('empty diff')
    return diff
  }
  try {
    const outside = outsideSections(delta, (ctx.changedFiles ?? []).map(f => f.path))
    if (outside.length === 0) return delta
    console.log(`  Delta has ${outside.length} file(s) outside the PR diff — comparing the PR diff at ${base12} with the current one...`)
    const prev = await pinned(base)
    const curr = await pinned(head)
    if (![delta, prev, curr].every(readableDiff)) {
      console.warn('  Target merge check skipped: a diff section\'s paths could not be read unambiguously — keeping the full delta')
      return delta
    }
    if (outsideSections(delta, diffPaths(curr)).length === 0) {
      console.log(`  Target merge: every delta file is in the PR diff at ${head.slice(0, 12)} — keeping the full delta`)
      return delta
    }
    if (!sameHead(delta, curr)) {
      console.warn('  Target merge check skipped: the PR diff does not end at the same file versions as the delta — keeping the full delta')
      return delta
    }
    const { changed, baseChanged } = changedPrFiles(prev, curr)
    const narrowed = narrowDelta(delta, changed)
    if (narrowed.dropped.length === 0) return delta
    if (narrowed.kept.length === 0) {
      console.log(`  Target merge: PR diff unchanged since ${base12} (${narrowed.dropped.length} delta file(s) dropped) — checking for unanswered replies...`)
      return null
    }
    console.log(`  Target merge: delta narrowed to ${narrowed.kept.length} of ${narrowed.kept.length + narrowed.dropped.length} file(s): ${narrowed.kept.join(', ')}`)
    ctx.deltaBase = base
    if (narrowed.kept.every(k => baseChanged.has(k))) ctx.mergeNarrowed = true
    return narrowed.diff
  } catch (err: unknown) {
    console.warn(`  PR diff at ${at.slice(0, 12)} unavailable (${errorText(err)}) — keeping the full delta`)
    return delta
  }
}

// Only a merge straight on top of the reviewed commit may skip the confirmation; any other commit in the push could hold new work.
async function headIsMergeOnReviewed(ctx: ReviewContext): Promise<boolean> {
  const head12 = ctx.prInfo!.sourceCommit.slice(0, 12)
  try {
    if (!ctx.adapter.getCommitParents) throw new Error('not supported')
    const parents = await ctx.adapter.getCommitParents(ctx.prInfo!.sourceCommit)
    return parents.length >= 2 && headMatches(ctx.deltaBase!, parents[0])
  } catch (err: unknown) {
    console.warn(`  Parents of ${head12} unavailable (${errorText(err)}) — posting as usual`)
    return false
  }
}

// Temporary signal: shows whether the footer-anchored hash ever differs from the old first-match reading on real PRs.
function warnOnHashDisagreement(prId: string, body: string, footerHash: string | null): void {
  const legacy = legacyCommitHash(body)
  if (legacy !== footerHash) console.warn(`  Footer commit ${footerHash} differs from legacy first match ${legacy} (PR ${prId})`)
}

// Also-affects rows exist only in findings.json, so production never asks for the field.
const hiBench = (ctx: ReviewContext): boolean => !!config.review.highImpact && !!ctx.outcomeSink

// Site rows exist only in findings.json, so production never asks for the field.
const fpSites = (ctx: ReviewContext): boolean => !!config.review.firstPassSites && !!ctx.outcomeSink

// Judge candidate ids of the first-pass findings a pass is briefed with, so a site maps back by id, never by position.
function firstPassIds(firstPass: readonly ReviewFinding[], briefed: readonly ReviewFinding[]): { tags: Map<ReviewFinding, string>; index: Map<string, number> } {
  const tags = new Map<ReviewFinding, string>()
  const index = new Map<string, number>()
  firstPass.forEach((f, i) => {
    if (!briefed.includes(f)) return
    tags.set(f, candidateId(i))
    index.set(candidateId(i), i)
  })
  return { tags, index }
}

function addFirstPassSites(ctx: ReviewContext, found: ReturnType<typeof sanitizeFirstPassSites>, via: FirstPassSite['via'], label: string): void {
  const all = ctx.firstPassSites ??= new Map()
  for (const [i, sites] of found.sites) all.set(i, [...(all.get(i) ?? []), ...sites])
  const named = [...found.sites.values()].flat()
  ;(ctx.firstPassSitesNamed ??= []).push(...named)
  const byPass = ctx.firstPassSitesDropped ??= {}
  const sum = byPass[via] ??= {}
  for (const [reason, n] of Object.entries(found.dropped) as Array<[SiteDropReason, number]>) sum[reason] = (sum[reason] ?? 0) + n
  const reasons = Object.entries(found.dropped).map(([r, n]) => `${r} ${n}`).join(', ')
  const dropped = Object.values(found.dropped).reduce((a, b) => a + b, 0)
  console.log(`  ${label} sites: ${named.length} place(s) for ${found.sites.size} first-pass finding(s), dropped ${dropped}${reasons ? ` (${reasons})` : ''}`)
}

// Benchmark-only: outside it OpenRouter extra passes are non-streaming with an unretried 600 s timeout, so a large cap could hang a review.
const extraPassMaxTokens = (ctx: ReviewContext): number => (ctx.outcomeSink && config.anthropic.extraPassMaxTokens) || config.anthropic.maxTokens

// An aborted stream's output count is a start-of-message snapshot, so only its input tokens count as spend; pass_calls shows null for the same reason.
function spentUsage<U extends { output_tokens: number; reasoning_tokens?: number }>(err: unknown, usage: U | undefined): U | undefined {
  return usage && err instanceof DeadlineAbortError ? { ...usage, output_tokens: 0, reasoning_tokens: undefined } : usage
}

const passStopAtSeconds = (): number => config.breadth.benchmarkDeadlineSeconds - config.breadth.judgeReserveSeconds

// Integer ms so limit_ms in the record is exact; undefined when no pass deadline applies (setting off, or not a benchmark run).
function passTimeLeftMs(ctx: ReviewContext): number | undefined {
  if (!config.breadth.passDeadline || !ctx.outcomeSink) return undefined
  return Math.floor(passStopAtSeconds() * 1000 - (Date.now() - ctx.startTime))
}

// A plain cleared timer rather than AbortSignal.timeout, so no timer outlives the call and fake timers can drive it.
async function withPassDeadline<T>(limitMs: number | undefined, call: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (limitMs === undefined) return call()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limitMs)
  try {
    return await call(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}


// The stage is entered only with at least one known lens, so a lens-off run never reaches it.
function stageAfterSecondLook(): State {
  if (!config.lenses.enabled) return State.JUDGE_REVIEW
  const { lenses, unknown } = parseLensList(config.lenses.list)
  if (unknown.length) console.warn(`  Ignoring unknown lens name(s): ${unknown.join(', ')}`)
  return lenses.length ? State.LENS_REVIEW : State.JUDGE_REVIEW
}

import type { UsageRecord } from './usage.js'
export type { UsageRecord } from './usage.js'

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

async function transition(state: State, ctx: ReviewContext): Promise<State> {
  switch (state) {

    case State.CHECK_TRIGGER: {
      if (!ctx.trigger) return State.FETCH_PR_INFO
      const { event, commentAuthor, kind } = ctx.trigger
      const ignoreList = config.trigger.ignoreCommentAuthors
      console.log(`Trigger: ${event || 'unknown event'}${commentAuthor ? ` by ${commentAuthor}` : ''}${kind ? ` (event kind: ${kind})` : ''}`)
      if (commentAuthor && !event && !kind && ignoreList.length) console.warn('  Comment author given without an event - IGNORE_COMMENT_AUTHORS not applied (every PR event carries an actor)')
      if (!ignoredCommentAuthor(ctx.trigger, ignoreList)) return State.FETCH_PR_INFO
      if (forced(ctx)) {
        console.log(`  ${commentAuthor} matches IGNORE_COMMENT_AUTHORS - running anyway (--force)`)
        return State.FETCH_PR_INFO
      }
      ctx.action = 'SKIP'
      ctx.skipReason = `${event || 'comment event'} by "${commentAuthor}" matches IGNORE_COMMENT_AUTHORS`
      return State.SKIP
    }

    case State.FETCH_PR_INFO: {
      console.log('Fetching PR info...')
      ctx.prInfo = await ctx.adapter.getPullRequestInfo(ctx.prId)
      console.log(`  "${ctx.prInfo.title}" (${ctx.prInfo.sourceBranch} → ${ctx.prInfo.targetBranch})`)
      return State.CHECK_BRANCHES
    }

    case State.CHECK_BRANCHES: {
      const src = ctx.prInfo!.sourceBranch
      const tgt = ctx.prInfo!.targetBranch
      const matchesPattern = (branch: string, patterns: string[]) =>
        patterns.some(p => p.includes('*')
          ? new RegExp('^' + p.replace(/\*/g, '.*') + '$').test(branch)
          : p === branch)

      if (config.skipSourceBranches.length > 0 && matchesPattern(src, config.skipSourceBranches)) {
        ctx.action = 'SKIP'
        ctx.skipReason = `source branch "${src}" matches SKIP_SOURCE_BRANCHES`
        return State.SKIP
      }
      if (config.skipTargetBranches.length > 0 && matchesPattern(tgt, config.skipTargetBranches)) {
        if (config.onlyTargetBranches.length > 0 && matchesPattern(tgt, config.onlyTargetBranches)) {
          console.warn(`  "${tgt}" is in both SKIP_TARGET_BRANCHES and ONLY_TARGET_BRANCHES - the skip list wins; set SKIP_TARGET_BRANCHES= to review it`)
        }
        ctx.action = 'SKIP'
        ctx.skipReason = `target branch "${tgt}" matches SKIP_TARGET_BRANCHES`
        return State.SKIP
      }
      if (config.onlyTargetBranches.length > 0 && !matchesPattern(tgt, config.onlyTargetBranches)) {
        ctx.action = 'SKIP'
        ctx.skipReason = `target branch "${tgt}" is not in ONLY_TARGET_BRANCHES (${config.onlyTargetBranches.join(',')})`
        return State.SKIP
      }
      return State.FETCH_DIFF
    }

    case State.FETCH_DIFF: {
      console.log('Fetching diff...')
      try {
        ctx.diff = await ctx.adapter.getDiff(ctx.prId)
      } catch (err: unknown) {
        // A PR too large to fetch completely is a deterministic SKIP (no Claude call), not an ERROR that reddens CI.
        if (err instanceof PrTooLargeError) {
          ctx.action = 'SKIP'
          ctx.skipReason = err.message
          return State.SKIP
        }
        throw err
      }

      console.log('Fetching changed files...')
      ctx.changedFiles = await ctx.adapter.getChangedFiles(ctx.prId)
      ctx.lineCount = countChangedLines(ctx.diff)

      const { filtered, removedCount } = filterDiff(ctx.diff, config.diffExcludePatterns)
      ctx.filteredDiff = filtered
      if (removedCount > 0) {
        console.log(`  Filtered ${removedCount} file(s) from diff (${config.diffExcludePatterns.join(', ')})`)
      }

      // Thresholds apply to reviewable content only — excluded files don't count
      ctx.reviewableLineCount = countChangedLines(filtered)
      ctx.reviewableFileCount = ctx.changedFiles.filter(f => !isPathExcluded(f.path, config.diffExcludePatterns)).length

      console.log(`  ${ctx.changedFiles.length} changed file(s), ${ctx.reviewableFileCount} reviewable`)
      console.log(`  ${ctx.lineCount} changed line(s), ${ctx.reviewableLineCount} reviewable`)

      if (ctx.reviewableLineCount === 0) {
        ctx.action = 'SKIP'
        ctx.skipReason = 'no reviewable changes after exclusions'
        return State.SKIP
      }
      return State.CHECK_THRESHOLDS
    }

    case State.CHECK_THRESHOLDS: {
      const { minChangedFiles, maxChangedFiles, minChangedLines, maxChangedLines } = config.thresholds
      const fileCount = ctx.reviewableFileCount!
      const lineCount = ctx.reviewableLineCount!

      if (minChangedFiles > 0 && fileCount < minChangedFiles) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${fileCount} reviewable file(s), minimum is ${minChangedFiles}`
        return State.SKIP
      }
      // With bundling on, size is governed by the input budget and MAX_BUNDLES, not these caps.
      const bundling = config.review.bundledReview
      if (!bundling && maxChangedFiles > 0 && fileCount > maxChangedFiles) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${fileCount} reviewable file(s), maximum is ${maxChangedFiles}`
        return State.SKIP
      }
      if (minChangedLines > 0 && lineCount < minChangedLines) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${lineCount} reviewable line(s), minimum is ${minChangedLines}`
        return State.SKIP
      }
      if (!bundling && maxChangedLines > 0 && lineCount > maxChangedLines) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${lineCount} reviewable line(s), maximum is ${maxChangedLines}`
        return State.SKIP
      }
      return State.CHECK_PREVIOUS_REVIEWS
    }

    case State.CHECK_PREVIOUS_REVIEWS: {
      if (ctx.force === 'clean') {
        console.log('Skipping previous review check (--force clean)')
        ctx.previousReviews = []
        ctx.reviewNumber = 1
        return State.LOAD_PROMPT
      }
      console.log('Checking for previous reviews...')
      ctx.previousReviews = await ctx.adapter.getPreviousReviewComments(ctx.prId)

      if (ctx.previousReviews.length > 0) {
        console.log(`  Found ${ctx.previousReviews.length} previous review(s) — will produce delta review`)

        const lastReview = ctx.previousReviews[ctx.previousReviews.length - 1]
        const commitHash = extractCommitHash(lastReview.body)
        warnOnHashDisagreement(ctx.prId, lastReview.body, commitHash)

        if (ctx.force === 're-review') {
          console.log('  Bypassing dedup check (--force re-review) — will re-review with full context')
        } else {
          if (commitHash && commitHash === ctx.prInfo!.sourceCommit.slice(0, 12)) {
            console.log(`  Source commit ${ctx.prInfo!.sourceCommit.slice(0, 12)} already reviewed — checking for unanswered replies...`)
            markHeadChecked(ctx)
            ctx.reviewNumber = ctx.previousReviews.length
            return State.CHECK_REPLIES
          }

          if (ctx.checkedCommit) {
            const head12 = ctx.prInfo!.sourceCommit.slice(0, 12)
            if (headMatches(ctx.checkedCommit, ctx.prInfo!.sourceCommit)) {
              console.log(`  Source commit ${head12} already checked by an earlier run (checked commit) — checking for unanswered replies...`)
              ctx.dedupHit = 'checked_commit'
              markHeadChecked(ctx)
              ctx.reviewNumber = ctx.previousReviews.length
              return State.CHECK_REPLIES
            }
            console.log(`  Checked commit ${ctx.checkedCommit.slice(0, 12)} is not the current head ${head12} — ignoring it`)
          }

          // Delta diff check: fetch only the changes since the last reviewed commit
          if (commitHash) {
            console.log(`  Fetching delta diff (${commitHash}..${ctx.prInfo!.sourceCommit.slice(0, 12)})...`)
            try {
              const deltaDiff = await ctx.adapter.getCommitDiff(commitHash, ctx.prInfo!.sourceCommit)
              const { filtered, removedCount } = filterDiff(deltaDiff, config.diffExcludePatterns)
              const deltaLines = countChangedLines(filtered)
              console.log(`  Delta: ${countChangedLines(deltaDiff)} lines total, ${removedCount} file(s) filtered, ${deltaLines} lines remain`)
              if (deltaLines === 0) {
                console.log('  No reviewable changes in delta — checking for unanswered replies...')
                markHeadChecked(ctx)
                ctx.reviewNumber = ctx.previousReviews!.length
                return State.CHECK_REPLIES
              }
              const delta = await narrowTargetMergeDelta(ctx, commitHash, ctx.prInfo!.sourceCommit, filtered)
              if (delta === null) {
                ctx.dedupHit = 'target_merge'
                markHeadChecked(ctx)
                ctx.reviewNumber = ctx.previousReviews!.length
                return State.CHECK_REPLIES
              }
              ctx.deltaDiff = delta   // feed the exact changes-since-last-review to the reviewer
            } catch (err: unknown) {
              console.log(`  Delta diff fetch failed (${(err as Error).message}) — falling back to full PR diff`)
              // The fallback review was told to report only new findings but cannot see what is new.
              ctx.deltaFetchFailed = true
            }
          }
        }

        const reviewIds = ctx.previousReviews.map(r => r.id)
        const { replies: discussion } = await ctx.adapter.getRepliesToReviewComments(ctx.prId, reviewIds, true)
        if (discussion.length > 0) {
          ctx.replies = discussion
          console.log(`  Found ${discussion.length} discussion comment(s) (dev replies + agent replies) — will include in review context`)
        }
      } else {
        console.log('  No previous reviews — first review for this PR')
      }

      ctx.reviewNumber = (ctx.previousReviews?.length ?? 0) + 1
      return State.LOAD_PROMPT
    }

    case State.CHECK_REPLIES: {
      const reviewIds = ctx.previousReviews!.map(r => r.id)
      const { replies, agentReplyCount } = await ctx.adapter.getRepliesToReviewComments(ctx.prId, reviewIds)

      // A new review supersedes the prior thread; resolved reviews don't count as the boundary.
      const latestReviewDate = supersedeBoundary(ctx.previousReviews!)!.createdOn
      ctx.replies = replies.filter(r => r.createdOn > latestReviewDate)
      if (ctx.replies.length < replies.length) {
        console.log(`  Filtered ${replies.length - ctx.replies.length} reply(s) older than latest review (${latestReviewDate})`)
      }

      // Before the reply-limit check: all-directed-elsewhere becomes the normal "no unanswered questions" skip.
      ctx.replies = await dropRepliesDirectedElsewhere(ctx, questionsForAgent(ctx.replies))

      if (ctx.replies.length > 0) {
        if (config.reply.maxComments > 0 && agentReplyCount >= config.reply.maxComments) {
          console.log(`  Found ${ctx.replies.length} unanswered reply(s), but agent already posted ${agentReplyCount}/${config.reply.maxComments} replies — skipping`)
          ctx.action = 'DEDUP_SKIP'
          ctx.skipReason = `reply limit reached (${agentReplyCount}/${config.reply.maxComments})`
          return State.SKIP
        }
        console.log(`  Found ${ctx.replies.length} unanswered reply(s) — responding... (${agentReplyCount}/${config.reply.maxComments || '∞'} replies used)`)
        return State.RESPOND_TO_REPLIES
      }

      // Preserve a NO_CHANGE set upstream (a re-review fell through to here); only label the pure
      // dedup path, where no action was set yet.
      if (ctx.action !== 'NO_CHANGE') {
        ctx.action = 'DEDUP_SKIP'
        ctx.skipReason = ctx.dedupHit === 'checked_commit' ? 'head already checked by an earlier run and no unanswered questions'
          : ctx.dedupHit === 'target_merge' ? 'target branch merged in; PR diff unchanged since the last review and no unanswered questions'
          : 'no new commits and no unanswered questions'
      }
      return State.SKIP
    }

    case State.RESPOND_TO_REPLIES: {
      const lastReview = ctx.previousReviews![ctx.previousReviews!.length - 1]
      const replyModel = config.reply.model || config.anthropic.model
      const result = await runCommentResponse(
        config.llmApiKey,
        replyModel,
        config.anthropic.maxRetries,
        ctx.filteredDiff!,
        lastReview.body,
        ctx.replies!
      )
      addUsage(ctx, result.usage)

      const replyBody = result.text.trimEnd() + buildReplyFooter(config.agentIdentity, replyModel, getJobUrl())

      if (ctx.dryRun) {
        console.log('\n=== DRY RUN — Reply output (not posted) ===\n')
        console.log(replyBody)
        console.log('\n=== End of reply ===\n')
      } else {
        const targetParentId = ctx.replies![ctx.replies!.length - 1].parentId
        await ctx.adapter.postReply(ctx.prId, targetParentId, replyBody)
        console.log('Done. Reply posted to PR.\n')
      }
      ctx.action = 'REPLY'
      ctx.skipReason = undefined   // a reply isn't a skip; drop any NO_CHANGE reason set upstream
      return State.DONE
    }

    case State.LOAD_PROMPT: {
      console.log('Loading prompt...')
      ctx.prompt = await loadPrompt(ctx.adapter, ctx.prInfo!, ctx.promptPath, ctx.changedFiles, ctx.diff)
      console.log(`  Prompt source: ${promptLabel(ctx.prompt)}`)
      return State.FETCH_CONTEXT
    }

    case State.FETCH_CONTEXT: {
      console.log('Fetching file context...')
      ctx.fileContexts = await fetchContext(
        ctx.adapter,
        ctx.changedFiles!,
        ctx.prInfo!.sourceCommit,
        ctx.diff!,
        config.context.maxFiles,
        config.context.maxFileLines
      )
      console.log(`  Fetched full content for ${ctx.fileContexts.length} file(s)`)
      return State.ESTIMATE_TOKENS
    }

    case State.ESTIMATE_TOKENS: {
      const tok = (chars: number) => Math.ceil(chars / 4)
      // Per-section sizes (~chars/4) so an over-budget run shows WHERE the tokens went —
      // a huge diff vs many file contexts vs a long review/reply history — not just a total.
      const shown = (s: string) => shownLength(s, config.review.lineNumbers)
      const sizes = () => {
        const files = ctx.fileContexts!.reduce((sum, f) => sum + shown(f.content), 0)
        const reviews = (ctx.previousReviews ?? []).reduce((sum, r) => sum + r.body.length, 0)
        const replies = (ctx.replies ?? []).reduce((sum, r) => sum + r.body.length, 0)
        const prompt = ctx.prompt!.content.length
        const diff = shown(ctx.filteredDiff!)
        const delta = shown(ctx.deltaDiff ?? '')
        return {
          total: tok(prompt + diff + delta + files + reviews + replies),
          prompt: tok(prompt), diff: tok(diff), delta: tok(delta),
          files: tok(files), filesN: ctx.fileContexts!.length,
          reviews: tok(reviews), reviewsN: (ctx.previousReviews ?? []).length,
          replies: tok(replies), repliesN: (ctx.replies ?? []).length,
        }
      }
      const fmt = (s: ReturnType<typeof sizes>) =>
        `prompt ${s.prompt.toLocaleString()} | diff ${s.diff.toLocaleString()} | delta ${s.delta.toLocaleString()} | files ${s.files.toLocaleString()} (${s.filesN}) | prev_reviews ${s.reviews.toLocaleString()} (${s.reviewsN}) | replies ${s.replies.toLocaleString()} (${s.repliesN})`

      let s = sizes()
      // Input budget: MAX_INPUT_TOKENS and the context window (minus output reserve), whichever is smaller, so a big diff degrades/skips instead of hitting a 400.
      // The diff goes to both reviewer and judge, so cap by the smaller window.
      const reviewerWindow = contextWindowFor(config.anthropic.model, true)
      const ctxWindow = config.judge.model ? Math.min(reviewerWindow, contextWindowFor(config.judge.model)) : reviewerWindow
      const ctxCap = ctxWindow > 0 ? ctxWindow - config.anthropic.maxTokens : 0
      const limits = [config.anthropic.maxInputTokens, ctxCap].filter(n => n > 0)
      const max = limits.length ? Math.min(...limits) : 0
      console.log(`  Estimated input: ~${s.total.toLocaleString()} tokens  [${fmt(s)}]`)

      // A delta larger than the full PR diff means the branch merged its target in (commit-to-commit delta captured the merge) — drop it and review the bounded full diff.
      if (ctx.deltaDiff && s.delta > s.diff) {
        console.warn(`  Delta (${s.delta.toLocaleString()} tok) exceeds full PR diff (${s.diff.toLocaleString()} tok) — likely a merged target branch; dropping delta, reviewing full diff`)
        ctx.deltaDiff = ''
        // A full-diff review saw more than the narrowed files, so it must never be silenced as a quiet merge.
        ctx.mergeNarrowed = undefined
        ctx.deltaBase = undefined
        s = sizes()
        console.log(`  Re-estimated input: ~${s.total.toLocaleString()} tokens (full diff, no delta)  [${fmt(s)}]`)
      }

      // Degrade before skipping: file contexts are the largest optional payload —
      // drop them and review diff-only rather than skip a large PR entirely.
      if (max > 0 && s.total > max && ctx.fileContexts!.length > 0) {
        console.warn(`  Over input budget (${max.toLocaleString()}) — file contexts are ${s.files.toLocaleString()} tokens across ${s.filesN} file(s); dropping them, reviewing diff-only`)
        ctx.fileContexts = []
        ctx.degraded = true
        s = sizes()
        console.log(`  Re-estimated input: ~${s.total.toLocaleString()} tokens (diff-only)  [${fmt(s)}]`)
      }

      ctx.estimatedInputTokens = s.total

      if (max > 0 && s.total > max && config.review.bundledReview) {
        console.log('  Still over budget — switching to bundled review')
        ctx.inputBudget = max
        return State.BUNDLED_REVIEW
      }

      if (max > 0 && s.total > max) {
        ctx.action = 'SKIP'
        ctx.skipReason = `Estimated input ~${s.total.toLocaleString()} tokens exceeds the input budget (${max.toLocaleString()}; min of MAX_INPUT_TOKENS and model context) even without file context — ${fmt(s)}`
        return State.SKIP
      }
      return State.CALL_MODEL
    }

    case State.CALL_MODEL: {
      // Runtime prompt add-ons (opt-in) — appended without touching the base template
      let content = ctx.prompt!.content
      if (config.review.maxFindings > 0) {
        content += `\n\n## FINDINGS LIMIT\nReport at most ${config.review.maxFindings} findings, prioritized by severity and impact. If more exist, include only the most important and omit the rest.`
      }
      if (config.review.splitCheck) {
        content += `\n\n## SPLIT CHECK\nIf this PR spans multiple independent themes that could each be a separate, independently-reviewable PR, populate the \`can_be_split\` array — one entry per theme. If the PR is cohesive, leave it empty.`
      }
      const reviewPrompt = { ...ctx.prompt!, content }
      const recommend = config.lenses.recommend && ctx.reviewNumber === 1
      const recommendTail: [boolean?] = recommend ? [true] : []

      const call = () => runReview(
        config.llmApiKey,
        config.anthropic.model,
        config.anthropic.maxRetries,
        config.anthropic.maxTokens,
        config.review.effort,
        ctx.prInfo!,
        ctx.filteredDiff!,
        ctx.fileContexts!,
        reviewPrompt,
        ctx.previousReviews ?? [],
        ctx.replies ?? [],
        ctx.deltaDiff ?? '',
        config.review.lineNumbers,
        ...recommendTail,
      )
      // Backstop for an under-counted estimate: on a context-length rejection, drop file contexts
      // and retry diff-only; if the diff alone won't fit, skip rather than let the API error.
      const result = await (async () => {
        for (;;) {
          try {
            const answer = await call()
            recordPassCall(ctx, 'review', config.anthropic.maxTokens, undefined, answer.usage)
            return answer
          } catch (err: unknown) {
            // Every attempt is logged, so a truncated or context-rejected first try still shows in pass_calls.
            recordPassCall(ctx, 'review', config.anthropic.maxTokens, undefined, (err as { usage?: LLMUsage }).usage, err)
            if (!isContextLengthError(err)) throw err
            if (ctx.fileContexts!.length === 0) return null
            console.warn('  Prompt exceeded the model context — dropping file contexts, retrying diff-only')
            ctx.fileContexts = []
            ctx.degraded = true
          }
        }
      })()
      if (!result) {
        ctx.action = 'SKIP'
        ctx.skipReason = 'Diff exceeds the model context window'
        return State.SKIP
      }
      ctx.reviewText = result.text
      ctx.reviewObject = result.review
      if (recommend) {
        const recs = result.lensRecommendations ?? null
        ctx.lensRecommendations = recs
        console.log(`  Lens recommendations: ${recs ? recs.map(r => `${r.lens} (${r.reason})`).join(', ') || 'none' : 'unavailable'}`)
      }
      addUsage(ctx, result.usage)
      return State.CHECK_NO_CHANGE
    }

    case State.CHECK_NO_CHANGE: {
      if (isNoChange(ctx.reviewText!)) {
        // NO_CHANGE is a re-review signal; on a first review it's a reviewer malfunction — error
        // (CI retries) rather than silently skip a never-reviewed PR as "no changes since last".
        if ((ctx.previousReviews?.length ?? 0) === 0) {
          throw new Error('Reviewer returned NO_CHANGE on a first review — refusing to silently skip')
        }
        console.log('  Reviewer: NO_CHANGE')
        ctx.action = 'NO_CHANGE'
        ctx.skipReason = 'No changes since last review'
        // renderReview yields NO_CHANGE for any truthy no_change and drops findings, so only a coherent structured verdict counts.
        if (ctx.reviewObject ? ctx.reviewObject.no_change === true && ctx.reviewObject.findings?.length === 0 : ctx.reviewText === 'NO_CHANGE') markHeadChecked(ctx)
        // No code change, but a developer may have replied since the last review — answer them
        // rather than skip, so a reply on a PR with only trivial new commits isn't dropped.
        return State.CHECK_REPLIES
      }
      return State.BREADTH_REVIEW
    }

    case State.BREADTH_REVIEW: {
      // Breadth findings are only ever posted after judging, so without a judge the call would be paid for and lost.
      if (!config.breadth.enabled) { ctx.breadthStatus = 'disabled'; return State.SECOND_LOOK }
      if (!config.judge.model) { ctx.breadthStatus = 'skipped_no_judge'; return State.SECOND_LOOK }
      if (ctx.reviewNumber > 1) { ctx.breadthStatus = 'skipped_rereview'; return State.SECOND_LOOK }

      const firstPass = ctx.reviewObject?.findings ?? []
      const coverage = fileCoverage(ctx.filteredDiff!, firstPass)
      ctx.untouchedFiles = coverage.untouched
      if (coverage.reviewable.length < config.breadth.minFiles) { ctx.breadthStatus = 'skipped_small'; return State.SECOND_LOOK }
      if (coverage.untouched.length < config.breadth.minUntouched) { ctx.breadthStatus = 'skipped_few_untouched'; return State.SECOND_LOOK }
      const remaining = config.review.maxFindings > 0 ? config.review.maxFindings - firstPass.length : 0
      if (config.review.maxFindings > 0 && remaining <= 0) { ctx.breadthStatus = 'skipped_limit'; return State.SECOND_LOOK }

      // Resolved here, after benchmark labels were applied, so RB_CONFIG_JUDGE_MODEL also picks the breadth model.
      const model = config.breadth.model || config.judge.model
      const effort = config.breadth.effort || (config.breadth.model ? '' : config.judge.effort)
      const fp = fpSites(ctx)
      const ids = fp ? firstPassIds(firstPass, firstPass) : undefined
      const system = breadthSystemPrompt(ctx.prompt!.content, remaining, config.judge.shownAnchors, fp)
      ctx.breadthPlan = config.breadth.priorityTargets ? prioritizeUntouched(coverage.untouched, ctx.filteredDiff!, firstPass) : undefined
      const briefing = ids ? breadthBriefing(firstPass, coverage.untouched, ctx.breadthPlan, ids.tags) : breadthBriefing(firstPass, coverage.untouched, ctx.breadthPlan)
      const estimate = ctx.estimatedInputTokens + Math.ceil((system.length - ctx.prompt!.content.length + briefing.length) / 4)
      // A 0 limit means "disabled", as in ESTIMATE_TOKENS; without this filter MAX_INPUT_TOKENS=0 would skip every breadth pass.
      const limits = [config.anthropic.maxInputTokens, contextWindowFor(model) - extraPassMaxTokens(ctx)].filter(n => n > 0)
      const budget = limits.length ? Math.min(...limits) : Infinity
      if (estimate > budget) {
        ctx.breadthStatus = 'skipped_budget'
        console.log(`  Breadth review skipped: ~${estimate.toLocaleString()} tokens exceeds the ${model} budget (${budget.toLocaleString()})`)
        return State.SECOND_LOOK
      }
      // The benchmark entrypoint kills the agent at the deadline and a killed run scores nothing, so breadth must leave the judge the second half.
      const elapsedSeconds = (Date.now() - ctx.startTime) / 1000
      if (ctx.outcomeSink && elapsedSeconds > config.breadth.benchmarkDeadlineSeconds / 2) {
        ctx.breadthStatus = 'skipped_time'
        console.log(`  Breadth review skipped: ${Math.round(elapsedSeconds)}s elapsed, over half the ${config.breadth.benchmarkDeadlineSeconds}s benchmark deadline`)
        return State.SECOND_LOOK
      }
      const limitMs = passTimeLeftMs(ctx)
      if (limitMs !== undefined && limitMs <= 0) {
        ctx.breadthStatus = 'skipped_time'
        console.log(`  Breadth review skipped: no time left before the ${passStopAtSeconds()}s pass deadline`)
        return State.SECOND_LOOK
      }

      ctx.breadthModel = model
      if (config.judge.shownAnchors) ctx.shownBreadth = buildShownSource(ctx.filteredDiff!, ctx.fileContexts ?? [])
      console.log(`  Breadth review: ${coverage.untouched.length} untouched of ${coverage.reviewable.length} reviewable file(s)`)
      const breadthSchema: [string?, Record<string, unknown>?] = hiBench(ctx) || fp ? ['breadth', findingsOutputSchema({ alsoAffects: hiBench(ctx), firstPassSites: fp })] : []
      try {
        const result = await withPassDeadline(limitMs, signal => {
          const tail: [string?, Record<string, unknown>?, AbortSignal?] = signal ? ['breadth', breadthSchema[1], signal] : breadthSchema
          return runBreadth(
            config.llmApiKey, model, config.judge.maxRetries, extraPassMaxTokens(ctx), effort,
            ctx.prInfo!, ctx.filteredDiff!, ctx.fileContexts ?? [], system, briefing, config.review.lineNumbers, ...tail,
          )
        })
        ctx.breadthFindings = result.findings
        ctx.breadthPromptHash = result.promptHash
        ctx.breadthUsage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, cost_usd: result.usage.cost_usd }
        addUsage(ctx, result.usage)
        if (ids) addFirstPassSites(ctx, sanitizeFirstPassSites(result.firstPassSites, ids.index, 'breadth'), 'breadth', 'Breadth')
        ctx.breadthStatus = 'succeeded'
        console.log(`  Breadth review: ${coverage.untouched.length} untouched file(s) → ${result.findings.length} finding(s)`)
        // Last in the try, so a throw above is recorded once by the catch, never twice.
        recordPassCall(ctx, 'breadth', extraPassMaxTokens(ctx), limitMs, result.usage)
      } catch (err: unknown) {
        // A truncated response carries its usage; count it so the record shows what the failed call cost.
        const e = err as Error & { usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cost_usd?: number; reasoning_tokens?: number } }
        const used = spentUsage(err, e.usage)
        if (used) {
          ctx.breadthUsage = { input_tokens: used.input_tokens, output_tokens: used.output_tokens, cost_usd: used.cost_usd }
          addUsage(ctx, used)
        }
        recordPassCall(ctx, 'breadth', extraPassMaxTokens(ctx), limitMs, e.usage, err)
        if (err instanceof DeadlineAbortError) {
          ctx.breadthStatus = 'aborted_time'
          console.warn(`  Breadth review stopped at the ${passStopAtSeconds()}s pass deadline (${Math.round((Date.now() - ctx.startTime) / 1000)}s elapsed) — continuing with first-pass findings only`)
        } else {
          ctx.breadthStatus = 'failed'
          console.warn(`  Breadth review FAILED (${isContextLengthError(err) ? 'context length' : e.message}) — continuing with first-pass findings only`)
        }
      }
      return State.SECOND_LOOK
    }

    case State.SECOND_LOOK: {
      const next = stageAfterSecondLook()
      // Second-look candidates are only ever posted after judging (same as breadth); a re-review targets the delta, not a full re-read.
      if (!config.review.secondLook) { ctx.secondLookStatus = 'disabled'; return next }
      if (!config.judge.model) { ctx.secondLookStatus = 'skipped_no_judge'; return next }
      if (ctx.reviewNumber > 1) { ctx.secondLookStatus = 'skipped_rereview'; return next }

      const firstPass = ctx.reviewObject?.findings ?? []
      const breadth = ctx.breadthFindings ?? []
      const flagged = flaggedFiles(ctx.filteredDiff!, config.review.secondLookBreadthTargets ? [...firstPass, ...breadth] : firstPass)
      if (flagged.length === 0) { ctx.secondLookStatus = 'skipped_no_findings'; return next }

      const remaining = config.review.maxFindings > 0 ? config.review.maxFindings - firstPass.length - breadth.length : 0
      if (config.review.maxFindings > 0 && remaining <= 0) { ctx.secondLookStatus = 'skipped_limit'; return next }

      const sections = splitDiffByFile(ctx.filteredDiff!)
      const restrictedDiff = flagged.map(p => sections.get(p) ?? '').join('')
      const flaggedSet = new Set(flagged)
      const contexts = (ctx.fileContexts ?? []).filter(c => flaggedSet.has(normalizeFindingPath(c.path, flagged)))
      const known = findingsInFiles([...firstPass, ...breadth], flagged)

      const model = config.anthropic.model
      const hi = !!config.review.highImpact
      const fp = fpSites(ctx)
      const ids = fp ? firstPassIds(firstPass, known) : undefined
      const system = secondLookSystemPrompt(ctx.prompt!.content, remaining, config.judge.shownAnchors, hi, fp)
      const briefing = ids ? secondLookBriefing(known, ids.tags) : secondLookBriefing(known)
      // Estimate on the restricted inputs, not the full diff, so a large PR with few flagged files isn't needlessly skipped.
      // shownLength on the numbered payloads (diff + file contexts) so the guard counts the line-number gutter, as ESTIMATE_TOKENS does.
      const shownSL = (s: string) => shownLength(s, config.review.lineNumbers)
      const estimate = Math.ceil((system.length + shownSL(restrictedDiff) + briefing.length + contexts.reduce((n, c) => n + shownSL(c.content), 0)) / 4)
      const limits = [config.anthropic.maxInputTokens, contextWindowFor(model) - extraPassMaxTokens(ctx)].filter(n => n > 0)
      const budget = limits.length ? Math.min(...limits) : Infinity
      if (estimate > budget) {
        ctx.secondLookStatus = 'skipped_budget'
        console.log(`  Second-look skipped: ~${estimate.toLocaleString()} tokens exceeds the ${model} budget (${budget.toLocaleString()})`)
        return next
      }
      // Same deadline guard as breadth: a killed benchmark run scores nothing, so leave the judge the second half.
      const elapsedSeconds = (Date.now() - ctx.startTime) / 1000
      if (ctx.outcomeSink && elapsedSeconds > config.breadth.benchmarkDeadlineSeconds / 2) {
        ctx.secondLookStatus = 'skipped_time'
        console.log(`  Second-look skipped: ${Math.round(elapsedSeconds)}s elapsed, over half the ${config.breadth.benchmarkDeadlineSeconds}s benchmark deadline`)
        return next
      }
      const limitMs = passTimeLeftMs(ctx)
      if (limitMs !== undefined && limitMs <= 0) {
        ctx.secondLookStatus = 'skipped_time'
        console.log(`  Second-look skipped: no time left before the ${passStopAtSeconds()}s pass deadline`)
        return next
      }

      if (config.judge.shownAnchors) ctx.shownSecondLook = buildShownSource(restrictedDiff, contexts)
      console.log(`  Second-look: re-reading ${flagged.length} flagged file(s), excluding ${known.length} known finding(s)`)
      const secondLookSchema: [Record<string, unknown>?] = hi || fp ? [findingsOutputSchema({ alsoAffects: hiBench(ctx), scenario: hi, firstPassSites: fp })] : []
      try {
        const result = await withPassDeadline(limitMs, signal => {
          const tail: [Record<string, unknown>?, AbortSignal?] = signal ? [secondLookSchema[0], signal] : secondLookSchema
          return runBreadth(
            config.llmApiKey, model, config.anthropic.maxRetries, extraPassMaxTokens(ctx), config.review.effort,
            ctx.prInfo!, restrictedDiff, contexts, system, briefing, config.review.lineNumbers, 'second-look', ...tail,
          )
        })
        ctx.secondLookFindings = result.findings
        ctx.secondLookPromptHash = result.promptHash
        ctx.secondLookUsage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, cost_usd: result.usage.cost_usd }
        addUsage(ctx, result.usage)
        if (ids) addFirstPassSites(ctx, sanitizeFirstPassSites(result.firstPassSites, ids.index, 'second_look'), 'second_look', 'Second-look')
        ctx.secondLookStatus = 'succeeded'
        console.log(`  Second-look: ${flagged.length} flagged file(s) → ${result.findings.length} additional finding(s)`)
        recordPassCall(ctx, 'second_look', extraPassMaxTokens(ctx), limitMs, result.usage)
      } catch (err: unknown) {
        const e = err as Error & { usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cost_usd?: number; reasoning_tokens?: number } }
        const used = spentUsage(err, e.usage)
        if (used) {
          ctx.secondLookUsage = { input_tokens: used.input_tokens, output_tokens: used.output_tokens, cost_usd: used.cost_usd }
          addUsage(ctx, used)
        }
        recordPassCall(ctx, 'second_look', extraPassMaxTokens(ctx), limitMs, e.usage, err)
        if (err instanceof DeadlineAbortError) {
          ctx.secondLookStatus = 'aborted_time'
          console.warn(`  Second-look stopped at the ${passStopAtSeconds()}s pass deadline (${Math.round((Date.now() - ctx.startTime) / 1000)}s elapsed) — continuing with first-pass and breadth findings only`)
        } else {
          ctx.secondLookStatus = 'failed'
          console.warn(`  Second-look FAILED (${isContextLengthError(err) ? 'context length' : e.message}) — continuing with first-pass and breadth findings only`)
        }
      }
      return next
    }

    case State.LENS_REVIEW: {
      // Same stage skips as second-look: lens candidates only post after judging, and a re-review targets the delta.
      const lenses = activeLenses(config.lenses)
      const model = config.lenses.model || config.anthropic.model
      const runs: LensRun[] = []
      ctx.lensRuns = runs
      const stageSkip: LensStatus | undefined = !config.judge.model ? 'skipped_no_judge' : ctx.reviewNumber > 1 ? 'skipped_rereview' : undefined
      if (stageSkip) {
        for (const lens of lenses) runs.push({ name: lens.name, status: stageSkip, model, findings: [] })
        return State.JUDGE_REVIEW
      }

      const effort = config.lenses.model ? '' : config.review.effort
      const earlier = [...(ctx.reviewObject?.findings ?? []), ...(ctx.breadthFindings ?? []), ...(ctx.secondLookFindings ?? [])]
      const limits = [config.anthropic.maxInputTokens, contextWindowFor(model) - extraPassMaxTokens(ctx)].filter(n => n > 0)
      const budget = limits.length ? Math.min(...limits) : Infinity
      let halt: LensStatus | undefined
      for (const lens of lenses) {
        const run: LensRun = { name: lens.name, status: 'failed', model, findings: [] }
        runs.push(run)
        if (halt) { run.status = halt; continue }

        const known = [...earlier, ...runs.flatMap(r => r.findings)]
        const remaining = config.review.maxFindings > 0 ? config.review.maxFindings - known.length : 0
        if (config.review.maxFindings > 0 && remaining <= 0) { run.status = halt = 'skipped_limit'; continue }

        const system = lensSystemPrompt(ctx.prompt!.content, lens, remaining, config.judge.shownAnchors)
        const briefing = lensBriefing(known)
        const estimate = ctx.estimatedInputTokens + Math.ceil((system.length - ctx.prompt!.content.length + briefing.length) / 4)
        if (estimate > budget) {
          run.status = 'skipped_budget'
          console.log(`  Lens ${lens.name} skipped: ~${estimate.toLocaleString()} tokens exceeds the ${model} budget (${budget.toLocaleString()})`)
          continue
        }
        // Re-checked per lens: each is a reviewer-sized call, and a killed benchmark run scores nothing.
        const elapsedSeconds = (Date.now() - ctx.startTime) / 1000
        if (ctx.outcomeSink && elapsedSeconds > config.breadth.benchmarkDeadlineSeconds / 2) {
          run.status = halt = 'skipped_time'
          console.log(`  Lens review stopped at ${lens.name}: ${Math.round(elapsedSeconds)}s elapsed, over half the ${config.breadth.benchmarkDeadlineSeconds}s benchmark deadline`)
          continue
        }
        const limitMs = passTimeLeftMs(ctx)
        if (limitMs !== undefined && limitMs <= 0) {
          run.status = halt = 'skipped_time'
          console.log(`  Lens review stopped at ${lens.name}: no time left before the ${passStopAtSeconds()}s pass deadline`)
          continue
        }

        if (config.judge.shownAnchors && !ctx.shownLens) ctx.shownLens = buildShownSource(ctx.filteredDiff!, ctx.fileContexts ?? [])
        console.log(`  Lens ${lens.name}: full-PR pass, excluding ${known.length} known finding(s)`)
        const extras = { alsoAffects: hiBench(ctx), scenario: !!config.review.highImpact && !!lens.scenarioTag }
        const lensSchema: [Record<string, unknown>?] = extras.alsoAffects || extras.scenario ? [findingsOutputSchema(extras)] : []
        try {
          const result = await withPassDeadline(limitMs, signal => {
            const tail: [Record<string, unknown>?, AbortSignal?] = signal ? [lensSchema[0], signal] : lensSchema
            return runLens(
              config.llmApiKey, model, config.anthropic.maxRetries, extraPassMaxTokens(ctx), effort,
              ctx.prInfo!, ctx.filteredDiff!, ctx.fileContexts ?? [], system, briefing, config.review.lineNumbers, `lens:${lens.name}`, ...tail,
            )
          })
          run.findings = result.findings
          run.promptHash = result.promptHash
          run.usage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, cost_usd: result.usage.cost_usd }
          addUsage(ctx, result.usage)
          run.status = 'succeeded'
          console.log(`  Lens ${lens.name}: ${result.findings.length} finding(s)`)
          recordPassCall(ctx, `lens:${lens.name}`, extraPassMaxTokens(ctx), limitMs, result.usage)
        } catch (err: unknown) {
          const e = err as Error & { usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cost_usd?: number; reasoning_tokens?: number } }
          const used = spentUsage(err, e.usage)
          if (used) {
            run.usage = { input_tokens: used.input_tokens, output_tokens: used.output_tokens, cost_usd: used.cost_usd }
            addUsage(ctx, used)
          }
          recordPassCall(ctx, `lens:${lens.name}`, extraPassMaxTokens(ctx), limitMs, e.usage, err)
          if (err instanceof DeadlineAbortError) {
            run.status = 'aborted_time'
            halt = 'skipped_time'
            console.warn(`  Lens ${lens.name} stopped at the ${passStopAtSeconds()}s pass deadline (${Math.round((Date.now() - ctx.startTime) / 1000)}s elapsed) — continuing without its findings`)
          } else {
            console.warn(`  Lens ${lens.name} FAILED (${isContextLengthError(err) ? 'context length' : e.message}) — continuing without its findings`)
          }
        }
      }
      return State.JUDGE_REVIEW
    }

    case State.JUDGE_REVIEW: {
      const reviewFindings = ctx.reviewObject ? countFindings(ctx.reviewObject) : { high: 0, medium: 0, low: 0 }
      console.log(`  Reviewer findings: ${reviewFindings.high}H / ${reviewFindings.medium}M / ${reviewFindings.low}L`)
      const noFindings = reviewFindings.high === 0 && reviewFindings.medium === 0 && reviewFindings.low === 0

      // 0-finding re-review: an unanswered dev reply is answered in-thread (reply priority); else suppress noise, or post one confirmation when a finding was resolved or is still open. --force re-review bypasses this and always posts.
      if (noFindings && ctx.reviewNumber > 1 && ctx.force !== 're-review') {
        const lastReview = supersedeBoundary(ctx.previousReviews ?? [])
        // Agent replies carry a footer; an unanswered dev reply is one without, newer than our last review and last agent reply.
        const replies = ctx.replies ?? []
        const lastAgentReplyAt = replies.filter(r => hasReplyFooter(r.body))
          .reduce((max, r) => (r.createdOn > max ? r.createdOn : max), '')
        const unanswered = await dropRepliesDirectedElsewhere(ctx, questionsForAgent(replies.filter(r =>
          !hasReplyFooter(r.body) && !!lastReview && r.createdOn > lastReview.createdOn && r.createdOn > lastAgentReplyAt)))

        const priorHadFindings = !!lastReview && markdownHasFindings(lastReview.body)
        const stillOpen = (ctx.reviewObject?.delta_stats?.still_open ?? 0) > 0
        const cleanPrior = !priorHadFindings && !stillOpen
        // A fix made while resolving the conflict still owes its confirmation, so only an explicit resolved count of 0 may stay quiet.
        const mergeQuiet = async () => !cleanPrior && ctx.mergeNarrowed === true && ctx.reviewObject?.delta_stats?.resolved === 0 && await headIsMergeOnReviewed(ctx)
        if (unanswered.length > 0) {
          const agentReplies = replies.filter(r => hasReplyFooter(r.body)).length
          if (config.reply.maxComments > 0 && agentReplies >= config.reply.maxComments) {
            console.log(`  Unanswered dev reply, but reply limit reached (${agentReplies}/${config.reply.maxComments}) — skipping`)
            ctx.action = 'DEDUP_SKIP'
            ctx.skipReason = `reply limit reached (${agentReplies}/${config.reply.maxComments})`
            markHeadChecked(ctx)
            return State.SKIP
          }
          ctx.replies = unanswered
          console.log('  Re-review found nothing new, but a developer reply is unanswered — answering it in-thread')
          // A non-quiet re-review still owes the confirmation post on the next event, so only a quiet one counts as checked.
          if (cleanPrior || await mergeQuiet()) markHeadChecked(ctx)
          return State.RESPOND_TO_REPLIES
        }

        if (cleanPrior) {
          console.log('  Re-review: no findings, prior clean, nothing open, no discussion — nothing to post, skipping')
          ctx.action = 'NO_NEW_FINDINGS'
          ctx.skipReason = 'Re-review found no new findings (prior review already clean)'
          markHeadChecked(ctx)
          return State.SKIP
        }
        if (await mergeQuiet()) {
          console.log('  Re-review after a target merge: no new findings — not posting a confirmation')
          ctx.action = 'NO_NEW_FINDINGS'
          ctx.skipReason = 'Re-review after a target-branch merge found no new findings'
          markHeadChecked(ctx)
          return State.SKIP
        }
        console.log(`  Re-review with no new findings — posting (${stillOpen ? 'findings still open' : 'prior review had findings'})`)
      }

      if (!config.judge.model) {
        ctx.judgeStatus = 'disabled'
        return State.POST_REVIEW
      }

      // The re-review gate above stays on reviewer findings; the judge runs whenever there is anything to validate.
      const breadth = ctx.breadthFindings ?? []
      const secondLook = ctx.secondLookFindings ?? []
      const lens = (ctx.lensRuns ?? []).flatMap(r => r.findings)
      if (noFindings && breadth.length === 0 && secondLook.length === 0 && lens.length === 0) {
        ctx.judgeStatus = 'skipped_no_findings'
        console.log('  Skipping judge — no findings to validate')
        return State.POST_REVIEW
      }

      const firstPass = ctx.reviewObject?.findings ?? []
      // Order is load-bearing: the boundary arg (firstPass.length) keeps review as trusted-anchor, breadth+second_look+lens changed-line-only.
      ctx.judgeCandidates = [
        ...firstPass.map(f => ({ ...f, origin: 'review' as const })),
        ...breadth.map(f => ({ ...f, origin: 'breadth' as const })),
        ...secondLook.map(f => ({ ...f, origin: 'second_look' as const })),
        ...(ctx.lensRuns ?? []).flatMap(r => r.findings.map(f => ({ ...f, origin: `lens:${r.name}` as const }))),
      ]
      const extra = breadth.length > 0 || secondLook.length > 0 || lens.length > 0
      const judgeInput = extra ? { ...ctx.reviewObject!, findings: [...firstPass, ...breadth, ...secondLook, ...lens] } : ctx.reviewObject!

      ctx.reviewTextBeforeJudge = ctx.reviewText
      const suggestedFixes = !!config.judge.suggestedFixes
      const counterparts = !!ctx.outcomeSink && config.benchmarkCounterpartRows
      const alsoAffects = hiBench(ctx)
      const sites = ctx.firstPassSites?.size ? ctx.firstPassSites : undefined
      const judgeOptions: JudgeOptions | undefined = config.judge.quality || config.judge.shownAnchors || config.judge.proposals || suggestedFixes || counterparts || alsoAffects || sites
        ? {
            quality: config.judge.quality,
            proposals: config.judge.proposals,
            shownAnchors: config.judge.shownAnchors
              ? {
                  judge: buildShownSource(ctx.filteredDiff!, config.judge.fileContext ? ctx.fileContexts ?? [] : []), breadth: ctx.shownBreadth, secondLook: ctx.shownSecondLook, secondLookFrom: firstPass.length + breadth.length,
                  ...(lens.length ? { lens: ctx.shownLens, lensFrom: firstPass.length + breadth.length + secondLook.length } : {}),
                }
              : undefined,
            ...(suggestedFixes ? { proposals: true, codeProposals: true } : {}),
            ...(counterparts ? { counterparts: true } : {}),
            ...(alsoAffects ? { alsoAffects: true } : {}),
            ...(sites ? { firstPassSites: sites } : {}),
          }
        : undefined
      const judgeTail: [JudgeOptions?] = judgeOptions ? [judgeOptions] : []
      try {
        const result = await runJudge(
          config.llmApiKey,
          config.judge.model,
          config.judge.maxRetries,
          config.anthropic.maxTokens,
          config.judge.effort,
          ctx.filteredDiff!,
          judgeInput,
          config.judge.fileContext ? ctx.fileContexts ?? [] : [],
          config.judge.policy,
          config.review.lineNumbers,
          extra ? firstPass.length : undefined,
          ...judgeTail,
        )
        ctx.reviewText = result.text
        ctx.judgeScores = result.scores
        ctx.judgePromptHash = result.promptHash
        ctx.judgeDecisions = result.decisions
        ctx.judgeAnomalies = result.anomalies
        ctx.judgedFindings = result.kept
        if (result.render) ctx.renderJudged = result.render
        if (result.proposalsDropped) ctx.proposalsDropped = result.proposalsDropped
        if (result.notes) {
          console.log(`  Judge notes (not posted): ${result.notes}`)
        }
        const a = result.anomalies
        if (a && (a.unknown_ids || a.undecided || a.duplicate_ids || a.drop_without_evidence)) {
          console.warn(`  Judge anomalies: unknown_ids ${a.unknown_ids}, undecided ${a.undecided}, duplicate_ids ${a.duplicate_ids}, drop_without_evidence ${a.drop_without_evidence}`)
        }
        if (result.scores?.length) {
          console.log(`  Judge finding scores: ${result.scores.map(s => `${s.severity} ${s.score}/10`).join(', ')}`)
        }
        ctx.judgeUsage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens, cost_usd: result.usage.cost_usd }
        addUsage(ctx, result.usage)
        ctx.judgeStatus = 'succeeded'
        recordPassCall(ctx, 'judge', config.anthropic.maxTokens, undefined, result.usage)
      } catch (err: unknown) {
        ctx.judgeStatus = 'failed'
        recordPassCall(ctx, 'judge', config.anthropic.maxTokens, undefined, (err as { usage?: LLMUsage }).usage, err)
        // Benchmark keeps the unjudged reviewer findings; normal mode throws so CI retries, unless the reviewer was clean and the judge ran only for breadth — then the clean review posts as it would without breadth.
        if (!ctx.outcomeSink && !noFindings) throw err
        console.warn(`  Judge failed (${(err as Error).message}) — proceeding with unjudged reviewer findings`)
      }

      return State.POST_REVIEW
    }

    case State.BUNDLED_REVIEW: {
      const outcome = await runBundledReview(ctx, ctx.inputBudget!)
      if (!outcome.ok) {
        ctx.action = 'SKIP'
        ctx.skipReason = `Bundled review not possible: ${outcome.reason}`
        return State.SKIP
      }
      if (isNoChange(ctx.reviewText!)) return State.CHECK_NO_CHANGE

      // Same quiet-re-review rule as JUDGE_REVIEW: nothing found and prior review was clean means nothing worth posting.
      const merged = ctx.reviewObject!
      if (merged.findings.length === 0 && ctx.reviewNumber > 1 && ctx.force !== 're-review') {
        const lastReview = supersedeBoundary(ctx.previousReviews ?? [])
        const priorHadFindings = !!lastReview && markdownHasFindings(lastReview.body)
        if (!priorHadFindings && (merged.delta_stats?.still_open ?? 0) === 0) {
          ctx.action = 'NO_NEW_FINDINGS'
          ctx.skipReason = 'Re-review found no new findings (prior review already clean)'
          markHeadChecked(ctx)
          return State.SKIP
        }
      }
      return State.POST_REVIEW
    }

    case State.POST_REVIEW: {
      // The sink takes the structured review instead of a posted comment, so cleanup, cut guard and footer don't apply.
      if (ctx.outcomeSink) {
        const sunk = await ctx.outcomeSink({
          review: ctx.reviewObject!, reviewText: ctx.reviewText!, judged: ctx.judgeUsage !== undefined, judgeScores: ctx.judgeScores, judgedFindings: ctx.judgedFindings, breadthFindings: ctx.breadthFindings, secondLookFindings: ctx.secondLookFindings,
          ...(ctx.lensRuns ? { lensFindings: ctx.lensRuns.flatMap(r => r.findings) } : {}),
        })
        if (sunk && sunk.counterpartRows !== undefined) ctx.counterpartRows = sunk.counterpartRows
        if (sunk && sunk.alsoAffectsRows !== undefined) ctx.alsoAffectsRows = sunk.alsoAffectsRows
        if (sunk && sunk.alsoAffects) ctx.alsoAffectsLog = sunk.alsoAffects
        if (sunk && sunk.firstPassSiteRows !== undefined) ctx.firstPassSiteRows = sunk.firstPassSiteRows
        if (sunk && sunk.firstPassSites) ctx.firstPassSitesLog = sunk.firstPassSites
        ctx.action = 'REVIEW'
        return State.DONE
      }

      const judgeNotes = ctx.reviewText!.match(/<!--\s*JUDGE_NOTES:([\s\S]*?)-->/)
      if (judgeNotes) {
        console.log(`  Judge notes (stripped from comment): ${judgeNotes[1].trim()}`)
      }

      // Apply cleanup in stages and log what each removes, so we can confirm cleanup
      // never over-eats (a large cut from anything but preamble is a red flag)
      const raw = ctx.reviewText!
      const s1 = stripPreviousFooter(raw)
      const s2 = stripDeltaStats(s1)
      const s3 = stripJudgeNotes(s2)
      const s4 = stripPreamble(s3)
      const cleaned = stripJenkinsMeta(s4)
      const cuts = [
        ['footer', raw.length - s1.length],
        ['delta-stats', s1.length - s2.length],
        ['judge-notes', s2.length - s3.length],
        ['preamble', s3.length - s4.length],
        ['jenkins', s4.length - cleaned.length],
      ].filter(([, n]) => (n as number) > 0).map(([name, n]) => `${name} -${n}`)
      if (cuts.length) {
        console.log(`  Cleanup removed ${raw.length - cleaned.length} chars (${raw.length} → ${cleaned.length}): ${cuts.join(', ')}`)
      }
      if (!cleaned.trim() || isNoChange(cleaned)) {
        console.log('  Review text empty or NO_CHANGE after cleanup — skipping post')
        ctx.action = 'NO_CHANGE'
        ctx.skipReason = 'Review text empty or NO_CHANGE after cleanup'
        return State.SKIP
      }

      // Cut guard: a complete review ends with its final mandatory section. The judge
      // path ends with "Merge Confidence"; the reviewer-only path ends with "Unresolved
      // Questions". A truncated model response (valid JSON envelope, cut string value)
      // slips past the max_tokens guard — this catches it so we never post a half-review.
      const judged = ctx.judgeUsage !== undefined
      const tailOk = judged
        ? parseVerdictScore(cleaned) !== null
        : /^#{1,4}\s*Unresolved Questions\b/im.test(cleaned)
      if (!tailOk) {
        throw new Error(`Review appears truncated — missing ${judged ? 'Merge Confidence' : 'Unresolved Questions'} section; refusing to post a partial review`)
      }

      // Deterministic TODO/FIXME/HACK scan of added lines — reliably catches breadcrumbs
      const todos = config.review.todoScan ? scanTodos(ctx.filteredDiff!) : []
      let todoSection = ''
      if (todos.length > 0) {
        console.log(`  Found ${todos.length} TODO/FIXME/HACK marker(s) in added lines`)
        todoSection = '\n\n### TODOs Introduced\n' + todos.map(t => `- \`${t.file}:${t.line}\` — ${t.text}`).join('\n')
      }

      const commitShort = ctx.prInfo!.sourceCommit.slice(0, 12)
      const footer = buildReviewFooter(config.agentIdentity, config.anthropic.model, promptLabel(ctx.prompt!), ctx.reviewNumber, commitShort, getBuildCommit(), getJobUrl())
      // Only the posted comment is severity-ordered; a judged bundle has no render closure and its merge already sorts by severity.
      const judgedRender = ctx.renderJudged
      const reviewObject = ctx.reviewObject
      const posted = judgedRender
        ? orderPosted(cleaned, ctx.judgedFindings ?? [], order => judgedRender(new Map(), order))
        : !judged && reviewObject ? orderPosted(cleaned, reviewObject.findings, order => renderReview(reviewObject, { order })) : { text: cleaned }
      let body = posted.text
      // After every guard and parser has read the plain text, so no reviewText consumer ever sees a block.
      if (config.judge.suggestedFixes && judgedRender) {
        const composed = composeSuggestedFixes(ctx.judgedFindings ?? [], s => judgedRender(s, posted.order), body, COMMENT_BUDGET - todoSection.length - footer.length, (s, fixFree) => judgedRender(s, posted.order, fixFree))
        body = composed.text
        const dropped = ctx.proposalsDropped
        ctx.suggestedFixes = dropped ? { ...composed.stats, dropped } : composed.stats
        const { rendered, rejected, skipped } = composed.stats
        console.log(`  Suggested fixes: ${rendered} rendered, ${rejected} rejected${dropped ? `, ${dropped} dropped by the sanitizer` : ''}${skipped ? `, all skipped (${skipped})` : ''}`)
      }
      const comment = body + todoSection + footer

      if (ctx.dryRun) {
        console.log('\n=== DRY RUN — Review output (not posted) ===\n')
        console.log(comment)
        console.log('\n=== End of review ===\n')
      } else {
        // Pre-post dedup: re-fetch reviews to catch concurrent runs that posted while we were working
        if (ctx.force === 'off') {
          const freshReviews = await ctx.adapter.getPreviousReviewComments(ctx.prId)
          const alreadyReviewed = freshReviews.some(r => {
            const footerHash = extractCommitHash(r.body)
            warnOnHashDisagreement(ctx.prId, r.body, footerHash)
            return footerHash === commitShort
          })
          if (alreadyReviewed) {
            console.log(`  Commit ${commitShort} already reviewed by another run — skipping post`)
            ctx.action = 'DEDUP_SKIP'
            ctx.skipReason = 'Another agent run already reviewed this commit (race condition avoided)'
            // Nothing is posted, so the record must not report composed blocks as rendered.
            ctx.suggestedFixes = undefined
            markHeadChecked(ctx)
            return State.SKIP
          }
        }
        console.log('Posting review comment...')
        await ctx.adapter.postComment(ctx.prId, comment)
        markHeadChecked(ctx)
        console.log('Done. Review posted to PR.\n')
      }
      ctx.action = ctx.reviewNumber > 1 ? 'RE_REVIEW' : 'REVIEW'
      return State.DONE
    }

    case State.SKIP: {
      console.log(`\nSkipping: ${ctx.skipReason}`)
      return State.DONE
    }

    default:
      return State.DONE
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function review(adapter: VCSAdapter, prId: string, dryRun = false, promptPath?: string, force: 'off' | 'clean' | 're-review' = 'off', logUsage = false, repoSlug = '', outcomeSink?: OutcomeSink, trigger?: TriggerInfo, checkedCommit?: string): Promise<UsageRecord | null> {
  console.log(`\nStarting review for PR #${prId}`)

  const startTime = Date.now()
  const ctx: ReviewContext = {
    adapter, prId, dryRun, promptPath, force, logUsage, repoSlug, outcomeSink, trigger, checkedCommit, startTime,
    usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 0,
    action: 'ERROR',
    reviewNumber: 0,
  }

  let error: { type: string; message: string; status: number | null } | null = null

  try {
    let state = State.CHECK_TRIGGER
    while (state !== State.DONE) {
      state = await transition(state, ctx)
    }
  } catch (err: unknown) {
    ctx.action = 'ERROR'
    const e = err as Error & { status?: number; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cost_usd?: number; reasoning_tokens?: number } }
    // A truncated response carries its usage — fold it in so the record shows the real token spend
    // (often large: that is why it truncated) instead of zeros.
    if (e.usage) {
      addUsage(ctx, e.usage)
    }
    const where = describeHttpError(err)
    error = {
      type: e.constructor.name,
      message: where ? `${e.message} [${where}]` : e.message,
      status: e.status ?? null,
    }
  }

  const record = buildUsageRecord(ctx, Date.now() - startTime, error)
  console.log(`\n=== Usage ===\n${JSON.stringify(record, null, 2)}`)

  if (logUsage) {
    logUsageRecord(record)
  }

  if (error) throw new Error(error.message)

  return record
}
