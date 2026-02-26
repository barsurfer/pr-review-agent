import { appendFileSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { config } from './config.js'
import { loadPrompt } from './prompt/loader.js'
import { fetchContext } from './context/fetcher.js'
import { runReview, runCommentResponse } from './claude/client.js'
import type { ClaudeUsage } from './claude/client.js'
import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply } from './vcs/adapter.js'
import type { LoadedPrompt } from './prompt/loader.js'
import type { FileContext } from './context/fetcher.js'

export interface UsageRecord {
  run_id: string
  timestamp: string
  agent_version: string
  vcs: string
  workspace: string
  repo_slug: string
  pr_id: string
  source_commit: string
  target_branch: string
  review_number: number
  action: string
  skip_reason: string | null
  model: string
  tokens: { input: number; output: number; cache_read: number; cache_write: number }
  cost_usd: number
  duration_ms: number
  dry_run: boolean
  force: boolean
  prompt_source: string
  error: { type: string; message: string; status: number | null } | null
}

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
  readonly force: boolean
  readonly logUsage: boolean
  readonly repoSlug: string

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
  usage: { input_tokens: number; output_tokens: number }

  // Tracking
  action: string
  reviewNumber: number
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
// Version & cost helpers
// ---------------------------------------------------------------------------

function getAgentVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version
  } catch {
    // @ts-ignore — injected at bundle time by esbuild
    if (typeof __AGENT_VERSION__ !== 'undefined') return __AGENT_VERSION__ as string
    return 'unknown'
  }
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
}

function estimateCost(tokens: { input: number; output: number }, model: string): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING['claude-sonnet-4-6']
  const cost = (tokens.input / 1_000_000) * p.input + (tokens.output / 1_000_000) * p.output
  return Math.round(cost * 10000) / 10000 // 4 decimal places
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

    // ── Previous review detection ──────────────────────────────────────
    case State.CHECK_PREVIOUS_REVIEWS: {
      if (ctx.force) {
        console.log('Skipping previous review check (--force)')
        ctx.previousReviews = []
        ctx.reviewNumber = 1
        return State.LOAD_PROMPT
      }
      console.log('Checking for previous reviews...')
      ctx.previousReviews = await ctx.adapter.getPreviousReviewComments(ctx.prId)

      if (ctx.previousReviews.length > 0) {
        console.log(`  Found ${ctx.previousReviews.length} previous review(s) — will produce delta review`)

        // Same commit? → check for unanswered replies instead of re-reviewing
        const lastReview = ctx.previousReviews[ctx.previousReviews.length - 1]
        const commitMatch = lastReview.body.match(/Commit: ([a-f0-9]+)/)
        if (commitMatch && commitMatch[1] === ctx.prInfo!.sourceCommit.slice(0, 12)) {
          console.log(`  Source commit ${ctx.prInfo!.sourceCommit.slice(0, 12)} already reviewed — checking for unanswered replies...`)
          ctx.reviewNumber = ctx.previousReviews.length
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

      ctx.reviewNumber = (ctx.previousReviews?.length ?? 0) + 1
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

      ctx.action = 'DEDUP_SKIP'
      ctx.skipReason = 'no new commits and no unanswered questions'
      return State.SKIP
    }

    // ── Generate and post reply ────────────────────────────────────────
    case State.RESPOND_TO_REPLIES: {
      const lastReview = ctx.previousReviews![ctx.previousReviews!.length - 1]
      const result = await runCommentResponse(
        config.anthropic.apiKey,
        config.anthropic.model,
        ctx.filteredDiff!,
        lastReview.body,
        ctx.replies!
      )
      ctx.usage.input_tokens += result.usage.input_tokens
      ctx.usage.output_tokens += result.usage.output_tokens
      const responseText = result.text
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
      ctx.action = 'REPLY'
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
      const result = await runReview(
        config.anthropic.apiKey,
        config.anthropic.model,
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

    // ── NO_CHANGE stop word ────────────────────────────────────────────
    case State.CHECK_NO_CHANGE: {
      if (ctx.reviewText!.trim() === 'NO_CHANGE') {
        ctx.action = 'NO_CHANGE'
        ctx.skipReason = 'No changes since last review'
        return State.SKIP
      }
      return State.POST_REVIEW
    }

    // ── Build comment and post ─────────────────────────────────────────
    case State.POST_REVIEW: {
      const cleaned = ctx.reviewText!.replace(/\n---\n\*Reviewed by .*?\*\s*/g, '').trimEnd()
      const commitShort = ctx.prInfo!.sourceCommit.slice(0, 12)
      const footer = `\n\n---\n*Reviewed by ${config.agentIdentity} (${config.anthropic.model}) | Prompt: ${ctx.prompt!.source} | Review #${ctx.reviewNumber} | Commit: ${commitShort}*`
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
      ctx.action = 'REVIEW'
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

export async function review(adapter: VCSAdapter, prId: string, dryRun = false, promptPath?: string, force = false, logUsage = false, repoSlug = ''): Promise<UsageRecord | null> {
  console.log(`\nStarting review for PR #${prId}`)

  const startTime = Date.now()
  const ctx: ReviewContext = {
    adapter, prId, dryRun, promptPath, force, logUsage, repoSlug,
    usage: { input_tokens: 0, output_tokens: 0 },
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

  const durationMs = Date.now() - startTime
  const commitShort = ctx.prInfo?.sourceCommit?.slice(0, 12) ?? 'unknown'

  const record: UsageRecord = {
    run_id: `${config.vcsProvider}-${repoSlug}-${prId}-${commitShort}`,
    timestamp: new Date().toISOString(),
    agent_version: getAgentVersion(),
    vcs: config.vcsProvider,
    workspace: config.bitbucket.workspace,
    repo_slug: repoSlug,
    pr_id: prId,
    source_commit: ctx.prInfo?.sourceCommit ?? 'unknown',
    target_branch: ctx.prInfo?.targetBranch ?? 'unknown',
    review_number: ctx.reviewNumber,
    action: ctx.action,
    skip_reason: ctx.skipReason ?? null,
    model: config.anthropic.model,
    tokens: {
      input: ctx.usage.input_tokens,
      output: ctx.usage.output_tokens,
      cache_read: 0,
      cache_write: 0,
    },
    cost_usd: estimateCost({ input: ctx.usage.input_tokens, output: ctx.usage.output_tokens }, config.anthropic.model),
    duration_ms: durationMs,
    dry_run: dryRun,
    force,
    prompt_source: ctx.prompt?.source ?? 'none',
    error,
  }

  console.log(`\n=== Usage ===\n${JSON.stringify(record, null, 2)}`)

  if (logUsage) {
    appendFileSync('results.jsonl', JSON.stringify(record) + '\n')
    console.log('Usage appended to results.jsonl')
  }

  if (error) throw new Error(error.message)

  return record
}
