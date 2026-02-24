import { config } from './config.js'
import { loadPrompt } from './prompt/loader.js'
import { fetchContext } from './context/fetcher.js'
import { runReview, runCommentResponse } from './claude/client.js'
import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply } from './vcs/adapter.js'
import type { LoadedPrompt } from './prompt/loader.js'
import type { FileContext } from './context/fetcher.js'

// ---------------------------------------------------------------------------
// State enum — every node in the review flow
// ---------------------------------------------------------------------------

enum State {
  FETCH_PR_INFO,
  FETCH_DIFF,
  CHECK_THRESHOLDS,
  CHECK_PREVIOUS_REVIEWS,
  CHECK_REPLIES,
  RESPOND_TO_REPLIES,
  LOAD_PROMPT,
  FETCH_CONTEXT,
  CALL_CLAUDE,
  CHECK_NO_CHANGE,
  POST_REVIEW,
  SKIP,
  DONE,
}

// ---------------------------------------------------------------------------
// Context — accumulated data shared across states
// ---------------------------------------------------------------------------

interface ReviewContext {
  // Immutable inputs
  readonly adapter: VCSAdapter
  readonly prId: string
  readonly dryRun: boolean
  readonly promptPath?: string

  // Populated progressively
  prInfo?: PRInfo
  diff?: string
  filteredDiff?: string
  changedFiles?: ChangedFile[]
  lineCount?: number
  previousReviews?: ReviewComment[]
  replies?: CommentReply[]
  prompt?: LoadedPrompt
  fileContexts?: FileContext[]
  reviewText?: string
  skipReason?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIFF_EXCLUDED_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.lock$/,
]

/** Strip diff sections for files that add noise without review value (lock files, etc.). */
function filterDiff(diff: string): string {
  const sections = diff.split(/(?=^diff --git )/m)
  const kept = sections.filter(section => {
    const match = section.match(/^diff --git a\/(.+?) b\//)
    if (!match) return true
    return !DIFF_EXCLUDED_PATTERNS.some(p => p.test(match[1]))
  })
  const filtered = kept.join('')
  const removedCount = sections.length - kept.length
  if (removedCount > 0) {
    console.log(`  Filtered ${removedCount} lock file(s) from diff`)
  }
  return filtered
}

/** Count added/removed lines in a unified diff (excludes --- and +++ headers). */
function countChangedLines(diff: string): number {
  let count = 0
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))) {
      count++
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Transition — pure decision logic per state
// ---------------------------------------------------------------------------

async function transition(state: State, ctx: ReviewContext): Promise<State> {
  switch (state) {

    // ── Fetch PR metadata ──────────────────────────────────────────────
    case State.FETCH_PR_INFO: {
      console.log('Fetching PR info...')
      ctx.prInfo = await ctx.adapter.getPullRequestInfo(ctx.prId)
      console.log(`  "${ctx.prInfo.title}" (${ctx.prInfo.sourceBranch} → ${ctx.prInfo.targetBranch})`)
      return State.FETCH_DIFF
    }

    // ── Fetch diff & changed files ─────────────────────────────────────
    case State.FETCH_DIFF: {
      console.log('Fetching diff...')
      ctx.diff = await ctx.adapter.getDiff(ctx.prId)

      console.log('Fetching changed files...')
      ctx.changedFiles = await ctx.adapter.getChangedFiles(ctx.prId)
      ctx.lineCount = countChangedLines(ctx.diff)
      ctx.filteredDiff = filterDiff(ctx.diff)
      console.log(`  ${ctx.changedFiles.length} changed file(s)`)
      console.log(`  ${ctx.lineCount} changed line(s)`)
      return State.CHECK_THRESHOLDS
    }

    // ── PR size gate ───────────────────────────────────────────────────
    case State.CHECK_THRESHOLDS: {
      const { minChangedFiles, maxChangedFiles, minChangedLines, maxChangedLines } = config.thresholds
      const fileCount = ctx.changedFiles!.length
      const lineCount = ctx.lineCount!

      if (minChangedFiles > 0 && fileCount < minChangedFiles) {
        ctx.skipReason = `PR has ${fileCount} changed file(s), minimum is ${minChangedFiles}`
        return State.SKIP
      }
      if (maxChangedFiles > 0 && fileCount > maxChangedFiles) {
        ctx.skipReason = `PR has ${fileCount} changed file(s), maximum is ${maxChangedFiles}`
        return State.SKIP
      }
      if (minChangedLines > 0 && lineCount < minChangedLines) {
        ctx.skipReason = `PR has ${lineCount} changed line(s), minimum is ${minChangedLines}`
        return State.SKIP
      }
      if (maxChangedLines > 0 && lineCount > maxChangedLines) {
        ctx.skipReason = `PR has ${lineCount} changed line(s), maximum is ${maxChangedLines}`
        return State.SKIP
      }
      return State.CHECK_PREVIOUS_REVIEWS
    }

    // ── Previous review detection ──────────────────────────────────────
    case State.CHECK_PREVIOUS_REVIEWS: {
      console.log('Checking for previous reviews...')
      ctx.previousReviews = await ctx.adapter.getPreviousReviewComments(ctx.prId)

      if (ctx.previousReviews.length > 0) {
        console.log(`  Found ${ctx.previousReviews.length} previous review(s) — will produce delta review`)

        // Same commit? → check for unanswered replies instead of re-reviewing
        const lastReview = ctx.previousReviews[ctx.previousReviews.length - 1]
        const commitMatch = lastReview.body.match(/Commit: ([a-f0-9]+)/)
        if (commitMatch && commitMatch[1] === ctx.prInfo!.sourceCommit.slice(0, 12)) {
          console.log(`  Source commit ${ctx.prInfo!.sourceCommit.slice(0, 12)} already reviewed — checking for unanswered replies...`)
          return State.CHECK_REPLIES
        }

        // New commit — fetch developer discussion for delta review context
        const reviewIds = ctx.previousReviews.map(r => r.id)
        const discussion = await ctx.adapter.getRepliesToReviewComments(ctx.prId, reviewIds, true)
        if (discussion.length > 0) {
          ctx.replies = discussion
          console.log(`  Found ${discussion.length} developer reply comment(s) — will include in review context`)
        }
      } else {
        console.log('  No previous reviews — first review for this PR')
      }

      return State.LOAD_PROMPT
    }

    // ── Fetch unanswered developer replies ─────────────────────────────
    case State.CHECK_REPLIES: {
      const reviewIds = ctx.previousReviews!.map(r => r.id)
      ctx.replies = await ctx.adapter.getRepliesToReviewComments(ctx.prId, reviewIds)

      if (ctx.replies.length > 0) {
        console.log(`  Found ${ctx.replies.length} unanswered reply comment(s) — responding...`)
        return State.RESPOND_TO_REPLIES
      }

      ctx.skipReason = 'no new commits and no unanswered questions'
      return State.SKIP
    }

    // ── Generate and post reply ────────────────────────────────────────
    case State.RESPOND_TO_REPLIES: {
      const lastReview = ctx.previousReviews![ctx.previousReviews!.length - 1]
      const responseText = await runCommentResponse(
        config.anthropic.apiKey,
        config.anthropic.model,
        ctx.filteredDiff!,
        lastReview.body,
        ctx.replies!
      )
      const replyFooter = `\n\n---\n*Reply by ${config.agentIdentity} (${config.anthropic.model})*`
      const replyBody = responseText.trimEnd() + replyFooter

      if (ctx.dryRun) {
        console.log('\n=== DRY RUN — Reply output (not posted) ===\n')
        console.log(replyBody)
        console.log('\n=== End of reply ===\n')
      } else {
        const targetParentId = ctx.replies![ctx.replies!.length - 1].parentId
        await ctx.adapter.postReply(ctx.prId, targetParentId, replyBody)
        console.log('Done. Reply posted to PR.\n')
      }
      return State.DONE
    }

    // ── Load system prompt ─────────────────────────────────────────────
    case State.LOAD_PROMPT: {
      console.log('Loading prompt...')
      ctx.prompt = await loadPrompt(ctx.adapter, ctx.prInfo!, ctx.promptPath)
      console.log(`  Prompt source: ${ctx.prompt.source}`)
      return State.FETCH_CONTEXT
    }

    // ── Fetch full file context ────────────────────────────────────────
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
      return State.CALL_CLAUDE
    }

    // ── Call Claude for review ─────────────────────────────────────────
    case State.CALL_CLAUDE: {
      ctx.reviewText = await runReview(
        config.anthropic.apiKey,
        config.anthropic.model,
        ctx.prInfo!,
        ctx.filteredDiff!,
        ctx.fileContexts!,
        ctx.prompt!,
        ctx.previousReviews ?? [],
        ctx.replies ?? []
      )
      return State.CHECK_NO_CHANGE
    }

    // ── NO_CHANGE stop word ────────────────────────────────────────────
    case State.CHECK_NO_CHANGE: {
      if (ctx.reviewText!.trim() === 'NO_CHANGE') {
        ctx.skipReason = 'No changes since last review'
        return State.SKIP
      }
      return State.POST_REVIEW
    }

    // ── Build comment and post ─────────────────────────────────────────
    case State.POST_REVIEW: {
      const cleaned = ctx.reviewText!.replace(/\n---\n\*Reviewed by .*?\*\s*/g, '').trimEnd()
      const reviewNumber = (ctx.previousReviews?.length ?? 0) + 1
      const commitShort = ctx.prInfo!.sourceCommit.slice(0, 12)
      const footer = `\n\n---\n*Reviewed by ${config.agentIdentity} (${config.anthropic.model}) | Prompt: ${ctx.prompt!.source} | Review #${reviewNumber} | Commit: ${commitShort}*`
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
      return State.DONE
    }

    // ── Terminal: skip ─────────────────────────────────────────────────
    case State.SKIP: {
      console.log(`\nSkipping: ${ctx.skipReason}`)
      return State.DONE
    }

    default:
      return State.DONE
  }
}

// ---------------------------------------------------------------------------
// Public API — unchanged signature
// ---------------------------------------------------------------------------

export async function review(adapter: VCSAdapter, prId: string, dryRun = false, promptPath?: string): Promise<void> {
  console.log(`\nStarting review for PR #${prId}`)

  const ctx: ReviewContext = { adapter, prId, dryRun, promptPath }
  let state = State.FETCH_PR_INFO

  while (state !== State.DONE) {
    state = await transition(state, ctx)
  }
}
