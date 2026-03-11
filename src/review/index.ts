// ---------------------------------------------------------------------------
// Review orchestration — state machine only
// ---------------------------------------------------------------------------

import { config } from '../config.js'
import { loadPrompt } from '../prompt/loader.js'
import { fetchContext } from '../context/fetcher.js'
import { runReview, runCommentResponse, runJudge } from '../claude/client.js'
import { filterDiff, countChangedLines, parseFindings } from './parsers.js'
import { buildReviewFooter, buildReplyFooter, stripPreviousFooter, stripDeltaStats, isNoChange, extractCommitHash } from './formatter.js'
import { buildUsageRecord, logUsageRecord } from './usage.js'
import { State } from './types.js'
import type { ReviewContext } from './types.js'
import type { VCSAdapter } from '../vcs/adapter.js'

export type { UsageRecord } from './usage.js'

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

async function transition(state: State, ctx: ReviewContext): Promise<State> {
  switch (state) {

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
        ctx.action = 'SKIP'
        ctx.skipReason = `target branch "${tgt}" matches SKIP_TARGET_BRANCHES`
        return State.SKIP
      }
      return State.FETCH_DIFF
    }

    case State.FETCH_DIFF: {
      console.log('Fetching diff...')
      ctx.diff = await ctx.adapter.getDiff(ctx.prId)

      console.log('Fetching changed files...')
      ctx.changedFiles = await ctx.adapter.getChangedFiles(ctx.prId)
      ctx.lineCount = countChangedLines(ctx.diff)

      const { filtered, removedCount } = filterDiff(ctx.diff, config.diffExcludePatterns)
      ctx.filteredDiff = filtered
      if (removedCount > 0) {
        console.log(`  Filtered ${removedCount} file(s) from diff (${config.diffExcludePatterns.join(', ')})`)
      }

      console.log(`  ${ctx.changedFiles.length} changed file(s)`)
      console.log(`  ${ctx.lineCount} changed line(s)`)
      return State.CHECK_THRESHOLDS
    }

    case State.CHECK_THRESHOLDS: {
      const { minChangedFiles, maxChangedFiles, minChangedLines, maxChangedLines } = config.thresholds
      const fileCount = ctx.changedFiles!.length
      const lineCount = ctx.lineCount!

      if (minChangedFiles > 0 && fileCount < minChangedFiles) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${fileCount} changed file(s), minimum is ${minChangedFiles}`
        return State.SKIP
      }
      if (maxChangedFiles > 0 && fileCount > maxChangedFiles) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${fileCount} changed file(s), maximum is ${maxChangedFiles}`
        return State.SKIP
      }
      if (minChangedLines > 0 && lineCount < minChangedLines) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${lineCount} changed line(s), minimum is ${minChangedLines}`
        return State.SKIP
      }
      if (maxChangedLines > 0 && lineCount > maxChangedLines) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${lineCount} changed line(s), maximum is ${maxChangedLines}`
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

        if (ctx.force === 're-review') {
          console.log('  Bypassing dedup check (--force re-review) — will re-review with full context')
        } else {
          if (commitHash && commitHash === ctx.prInfo!.sourceCommit.slice(0, 12)) {
            console.log(`  Source commit ${ctx.prInfo!.sourceCommit.slice(0, 12)} already reviewed — checking for unanswered replies...`)
            ctx.reviewNumber = ctx.previousReviews.length
            return State.CHECK_REPLIES
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
                ctx.action = 'NO_CHANGE'
                ctx.skipReason = 'New commits contain only excluded files (e.g. tests, lock files) — no reviewable changes'
                return State.SKIP
              }
            } catch (err: unknown) {
              console.log(`  Delta diff fetch failed (${(err as Error).message}) — falling back to full PR diff`)
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
      ctx.replies = replies

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

      ctx.action = 'DEDUP_SKIP'
      ctx.skipReason = 'no new commits and no unanswered questions'
      return State.SKIP
    }

    case State.RESPOND_TO_REPLIES: {
      const lastReview = ctx.previousReviews![ctx.previousReviews!.length - 1]
      const result = await runCommentResponse(
        config.anthropic.apiKey,
        config.anthropic.model,
        config.anthropic.maxRetries,
        ctx.filteredDiff!,
        lastReview.body,
        ctx.replies!
      )
      ctx.usage.input_tokens += result.usage.input_tokens
      ctx.usage.output_tokens += result.usage.output_tokens

      const replyBody = result.text.trimEnd() + buildReplyFooter(config.agentIdentity, config.anthropic.model)

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
      return State.DONE
    }

    case State.LOAD_PROMPT: {
      console.log('Loading prompt...')
      ctx.prompt = await loadPrompt(ctx.adapter, ctx.prInfo!, ctx.promptPath)
      console.log(`  Prompt source: ${ctx.prompt.source}`)
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
      const promptChars = ctx.prompt!.content.length
      const diffChars = ctx.filteredDiff!.length
      const contextChars = ctx.fileContexts!.reduce((sum, f) => sum + f.content.length, 0)
      const reviewChars = (ctx.previousReviews ?? []).reduce((sum, r) => sum + r.body.length, 0)
      const replyChars = (ctx.replies ?? []).reduce((sum, r) => sum + r.body.length, 0)
      const totalChars = promptChars + diffChars + contextChars + reviewChars + replyChars
      const estimatedTokens = Math.ceil(totalChars / 4)

      ctx.estimatedInputTokens = estimatedTokens
      console.log(`  Estimated input: ~${estimatedTokens.toLocaleString()} tokens (${totalChars.toLocaleString()} chars)`)

      const max = config.anthropic.maxInputTokens
      if (max > 0 && estimatedTokens > max) {
        ctx.action = 'SKIP'
        ctx.skipReason = `Estimated input ~${estimatedTokens.toLocaleString()} tokens exceeds MAX_INPUT_TOKENS (${max.toLocaleString()})`
        return State.SKIP
      }
      return State.CALL_CLAUDE
    }

    case State.CALL_CLAUDE: {
      const result = await runReview(
        config.anthropic.apiKey,
        config.anthropic.model,
        config.anthropic.maxRetries,
        ctx.prInfo!,
        ctx.filteredDiff!,
        ctx.fileContexts!,
        ctx.prompt!,
        ctx.previousReviews ?? [],
        ctx.replies ?? []
      )
      ctx.reviewText = result.text
      ctx.usage.input_tokens += result.usage.input_tokens
      ctx.usage.output_tokens += result.usage.output_tokens
      return State.CHECK_NO_CHANGE
    }

    case State.CHECK_NO_CHANGE: {
      if (isNoChange(ctx.reviewText!)) {
        console.log('  Reviewer: NO_CHANGE')
        ctx.action = 'NO_CHANGE'
        ctx.skipReason = 'No changes since last review'
        return State.SKIP
      }
      return State.JUDGE_REVIEW
    }

    case State.JUDGE_REVIEW: {
      const reviewFindings = parseFindings(ctx.reviewText!)
      console.log(`  Reviewer findings: ${reviewFindings.high}H / ${reviewFindings.medium}M / ${reviewFindings.low}L`)

      if (!config.judge.model) {
        return State.POST_REVIEW
      }

      if (reviewFindings.high === 0 && reviewFindings.medium === 0 && reviewFindings.low === 0) {
        console.log('  Skipping judge — no findings to validate')
        return State.POST_REVIEW
      }

      ctx.reviewTextBeforeJudge = ctx.reviewText
      const result = await runJudge(
        config.anthropic.apiKey,
        config.judge.model,
        config.judge.maxRetries,
        ctx.filteredDiff!,
        ctx.reviewText!,
      )

      ctx.reviewText = result.text
      ctx.judgeUsage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens }
      ctx.usage.input_tokens += result.usage.input_tokens
      ctx.usage.output_tokens += result.usage.output_tokens

      return State.POST_REVIEW
    }

    case State.POST_REVIEW: {
      const cleaned = stripDeltaStats(stripPreviousFooter(ctx.reviewText!))
      const commitShort = ctx.prInfo!.sourceCommit.slice(0, 12)
      const footer = buildReviewFooter(config.agentIdentity, config.anthropic.model, ctx.prompt!.source, ctx.reviewNumber, commitShort)
      const comment = cleaned + footer

      if (ctx.dryRun) {
        console.log('\n=== DRY RUN — Review output (not posted) ===\n')
        console.log(comment)
        console.log('\n=== End of review ===\n')
      } else {
        console.log('Posting review comment...')
        await ctx.adapter.postComment(ctx.prId, comment)
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

export async function review(adapter: VCSAdapter, prId: string, dryRun = false, promptPath?: string, force: 'off' | 'clean' | 're-review' = 'off', logUsage = false, repoSlug = ''): Promise<UsageRecord | null> {
  console.log(`\nStarting review for PR #${prId}`)

  const startTime = Date.now()
  const ctx: ReviewContext = {
    adapter, prId, dryRun, promptPath, force, logUsage, repoSlug,
    usage: { input_tokens: 0, output_tokens: 0 },
    estimatedInputTokens: 0,
    action: 'ERROR',
    reviewNumber: 0,
  }

  let error: { type: string; message: string; status: number | null } | null = null

  try {
    let state = State.FETCH_PR_INFO
    while (state !== State.DONE) {
      state = await transition(state, ctx)
    }
  } catch (err: unknown) {
    ctx.action = 'ERROR'
    const e = err as Error & { status?: number }
    error = {
      type: e.constructor.name,
      message: e.message,
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
