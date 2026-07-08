// ---------------------------------------------------------------------------
// Review orchestration — state machine only
// ---------------------------------------------------------------------------

import { config } from '../config.js'
import { loadPrompt } from '../prompt/loader.js'
import { fetchContext } from '../context/fetcher.js'
import { runReview, runCommentResponse, runJudge } from '../claude/client.js'
import { filterDiff, countChangedLines, parseFindings, parseVerdictScore, isPathExcluded, scanTodos } from './parsers.js'
import { buildReviewFooter, buildReplyFooter, stripPreviousFooter, stripDeltaStats, stripJudgeNotes, stripJenkinsMeta, stripPreamble, isNoChange, extractCommitHash } from './formatter.js'
import { buildUsageRecord, logUsageRecord, getBuildCommit, getJobUrl } from './usage.js'
import { State } from './types.js'
import type { ReviewContext } from './types.js'
import type { VCSAdapter } from '../vcs/adapter.js'

import type { UsageRecord } from './usage.js'
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
      if (maxChangedFiles > 0 && fileCount > maxChangedFiles) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${fileCount} reviewable file(s), maximum is ${maxChangedFiles}`
        return State.SKIP
      }
      if (minChangedLines > 0 && lineCount < minChangedLines) {
        ctx.action = 'SKIP'
        ctx.skipReason = `PR has ${lineCount} reviewable line(s), minimum is ${minChangedLines}`
        return State.SKIP
      }
      if (maxChangedLines > 0 && lineCount > maxChangedLines) {
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
                console.log('  No reviewable changes in delta — checking for unanswered replies...')
                ctx.reviewNumber = ctx.previousReviews!.length
                return State.CHECK_REPLIES
              }
              ctx.deltaDiff = filtered   // feed the exact changes-since-last-review to the reviewer
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

      // Filter out human replies that are older than the latest review —
      // a new review supersedes the previous conversation thread
      const latestReviewDate = ctx.previousReviews![ctx.previousReviews!.length - 1].createdOn
      ctx.replies = replies.filter(r => r.createdOn > latestReviewDate)
      if (ctx.replies.length < replies.length) {
        console.log(`  Filtered ${replies.length - ctx.replies.length} reply(s) older than latest review (${latestReviewDate})`)
      }

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
      ctx.usage.cache_read += result.usage.cache_read_input_tokens ?? 0
      ctx.usage.cache_write += result.usage.cache_creation_input_tokens ?? 0

      const replyBody = result.text.trimEnd() + buildReplyFooter(config.agentIdentity, config.anthropic.model, getJobUrl())

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
      ctx.prompt = await loadPrompt(ctx.adapter, ctx.prInfo!, ctx.promptPath, ctx.changedFiles)
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
      // Runtime prompt add-ons (opt-in) — appended without touching the base template
      let content = ctx.prompt!.content
      if (config.review.maxFindings > 0) {
        content += `\n\n## FINDINGS LIMIT\nReport at most ${config.review.maxFindings} findings, prioritized by severity and impact. If more exist, include only the most important and omit the rest.`
      }
      if (config.review.splitCheck) {
        content += `\n\n## SPLIT CHECK\nIf this PR spans multiple independent themes that could each be a separate, independently-reviewable PR, add a "### Can Be Split" section listing them (one line each). If the PR is cohesive, omit the section entirely.`
      }
      const reviewPrompt = { ...ctx.prompt!, content }

      const result = await runReview(
        config.anthropic.apiKey,
        config.anthropic.model,
        config.anthropic.maxRetries,
        ctx.prInfo!,
        ctx.filteredDiff!,
        ctx.fileContexts!,
        reviewPrompt,
        ctx.previousReviews ?? [],
        ctx.replies ?? [],
        ctx.deltaDiff ?? ''
      )
      ctx.reviewText = result.text
      ctx.usage.input_tokens += result.usage.input_tokens
      ctx.usage.output_tokens += result.usage.output_tokens
      ctx.usage.cache_read += result.usage.cache_read_input_tokens ?? 0
      ctx.usage.cache_write += result.usage.cache_creation_input_tokens ?? 0
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
      if (result.notes) {
        console.log(`  Judge notes (not posted): ${result.notes}`)
      }
      ctx.judgeUsage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens }
      ctx.usage.input_tokens += result.usage.input_tokens
      ctx.usage.output_tokens += result.usage.output_tokens
      ctx.usage.cache_read += result.usage.cache_read_input_tokens ?? 0
      ctx.usage.cache_write += result.usage.cache_creation_input_tokens ?? 0

      return State.POST_REVIEW
    }

    case State.POST_REVIEW: {
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
      const footer = buildReviewFooter(config.agentIdentity, config.anthropic.model, ctx.prompt!.source, ctx.reviewNumber, commitShort, getBuildCommit(), getJobUrl())
      const comment = cleaned + todoSection + footer

      if (ctx.dryRun) {
        console.log('\n=== DRY RUN — Review output (not posted) ===\n')
        console.log(comment)
        console.log('\n=== End of review ===\n')
      } else {
        // Pre-post dedup: re-fetch reviews to catch concurrent runs that posted while we were working
        if (ctx.force === 'off') {
          const freshReviews = await ctx.adapter.getPreviousReviewComments(ctx.prId)
          const alreadyReviewed = freshReviews.some(r => extractCommitHash(r.body) === commitShort)
          if (alreadyReviewed) {
            console.log(`  Commit ${commitShort} already reviewed by another run — skipping post`)
            ctx.action = 'DEDUP_SKIP'
            ctx.skipReason = 'Another agent run already reviewed this commit (race condition avoided)'
            return State.SKIP
          }
        }
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
    usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 },
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
