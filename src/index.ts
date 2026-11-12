const [major] = process.versions.node.split('.').map(Number)
if (major < 22) {
  console.error(`Node.js 22+ required. Current: ${process.version}`)
  process.exit(1)
}

import { Command } from 'commander'
import { config, parseBranchList, validateBitbucketConfig, validateAzureConfig, validateGitHubConfig } from './config.js'
import { BitbucketAdapter } from './vcs/bitbucket.js'
import { AzureDevOpsAdapter } from './vcs/azure.js'
import { GitHubAdapter } from './vcs/github.js'
import { review } from './review/index.js'
import { resolveTrigger } from './review/trigger.js'
import { resolveCheckedCommit } from './review/checked-commit.js'
import { validateLocalPrompt, loadPrompt } from './prompt/loader.js'
import { runBenchmark } from './benchmark.js'
import type { VCSAdapter } from './vcs/adapter.js'

const program = new Command()

program
  .name('pr-review-agent')
  .description('Automated PR code review powered by Claude')
  .option('--pr-id <id>', 'Pull request ID')
  .option('--workspace <workspace>', 'VCS workspace / org (overrides BITBUCKET_WORKSPACE)')
  .option('--repo-slug <slug>', 'Repository slug')
  .option('--vcs <provider>', 'VCS provider: bitbucket | azure (WIP) | github (overrides VCS_PROVIDER); gitlab is not implemented and exits 1')
  .option('--dry-run', 'Print the review to stdout without posting to the PR')
  .option('--force [mode]', 'Force review: "clean" (no prior context) or "re-review" (keep context, bypass dedup)')
  .option('--log-usage [bool]', 'Log usage data to results.jsonl (default: true)', (v: string) => v !== 'false', true)
  .option('--prompt <path>', 'Path to a local prompt file (overrides repo .agent-review-instructions.md)')
  .option('--validate-prompt', 'Validate prompt and exit (local via --prompt, or repo via --pr-id)')
  .option('--model <id>', 'Claude model ID (overrides CLAUDE_MODEL)')
  .option('--judge-model <id>', 'Judge model ID (overrides JUDGING_MODEL)')
  .option('--reply-model <id>', 'Model ID for developer replies (overrides REPLY_MODEL; empty = reviewer model)')
  .option('--min-changed-files <n>', 'Skip review if fewer files changed (overrides MIN_CHANGED_FILES)')
  .option('--max-changed-files <n>', 'Skip review if more files changed (overrides MAX_CHANGED_FILES)')
  .option('--min-changed-lines <n>', 'Skip review if fewer lines changed (overrides MIN_CHANGED_LINES)')
  .option('--max-changed-lines <n>', 'Skip review if more lines changed (overrides MAX_CHANGED_LINES)')
  .option('--skip-source-branches <list>', 'Comma list of source-branch globs to skip (overrides SKIP_SOURCE_BRANCHES); an empty value (--skip-source-branches=) disables the check')
  .option('--skip-target-branches <list>', 'Comma list of target-branch globs to skip (overrides SKIP_TARGET_BRANCHES); an empty value (--skip-target-branches=) disables the check')
  .option('--only-target-branches <list>', 'Comma list of target-branch globs to review, skipping all others (overrides ONLY_TARGET_BRANCHES); an empty value (--only-target-branches=) disables the check')
  .option('--max-input-tokens <n>', 'Max estimated input tokens before degrade/skip (overrides MAX_INPUT_TOKENS)')
  .option('--max-output-tokens <n>', 'Max output tokens for reviewer + judge (overrides MAX_OUTPUT_TOKENS)')
  .option('--effort <level>', 'Reviewer thinking effort: low|medium|high|xhigh|max (overrides REVIEW_EFFORT; ignored by models without effort)')
  .option('--judge-effort <level>', 'Judge thinking effort (overrides JUDGE_EFFORT)')
  .option('--skip-directed-replies', 'Skip replying to dev comments @-directed at someone else (Bitbucket only; overrides SKIP_DIRECTED_REPLIES)')
  .option('--second-look', 'Second reviewer pass over already-flagged files to lift recall (overrides ENABLE_SECOND_LOOK; requires a judge)')
  .option('--lenses <list>', 'Concern-specific reviewer passes, e.g. reliability+security (overrides ENABLE_LENSES/LENSES; requires a judge)')
  .option('--lens-recommendation', 'Log which lenses the first-pass reviewer recommends for this PR; never gates a lens (overrides ENABLE_LENS_RECOMMENDATION)')
  .option('--proposals', 'Add a concise fix proposal to each kept finding in results.jsonl anchored_findings (overrides ENABLE_JUDGE_PROPOSALS; requires a judge)')
  .option('--suggested-fixes', 'Post a code fix block under each kept finding that has one; implies code-only proposals (overrides ENABLE_SUGGESTED_FIXES; requires a judge)')
  .option('--event <name>', 'What started this run, e.g. pullrequest:comment_created (overrides TRIGGER_EVENT); logged, and enables IGNORE_COMMENT_AUTHORS on comment events')
  .option('--comment-author <id>', 'Account id of the event actor, e.g. the Bitbucket actor uuid (overrides TRIGGER_COMMENT_AUTHOR)')
  .option('--event-kind <kind>', 'comment | other: whether the --event is a comment event, whatever its name (overrides TRIGGER_EVENT_KIND)')
  .option('--checked-commit <hash>', 'Head an earlier run reported as checked_commit for this PR; a run on that same head skips the re-review (overrides LAST_CHECKED_COMMIT)')
  .option('--benchmark', 'ReviewBench mode: read the PR from RB_* env + mounted files, write findings JSON to RB_OUT instead of posting; always exits 0')
  .parse(process.argv)

const opts = program.opts<{
  prId?: string
  workspace?: string
  repoSlug?: string
  vcs?: string
  model?: string
  judgeModel?: string
  replyModel?: string
  dryRun?: boolean
  force?: string | boolean
  logUsage?: boolean
  prompt?: string
  validatePrompt?: boolean
  minChangedFiles?: string
  maxChangedFiles?: string
  minChangedLines?: string
  maxChangedLines?: string
  skipSourceBranches?: string
  skipTargetBranches?: string
  onlyTargetBranches?: string
  maxInputTokens?: string
  maxOutputTokens?: string
  effort?: string
  judgeEffort?: string
  skipDirectedReplies?: boolean
  secondLook?: boolean
  lenses?: string
  lensRecommendation?: boolean
  proposals?: boolean
  suggestedFixes?: boolean
  event?: string
  commentAuthor?: string
  eventKind?: string
  checkedCommit?: string
  benchmark?: boolean
}>()

async function main(): Promise<void> {
  // Applied before the benchmark dispatch, which returns early.
  if (opts.proposals) config.judge.proposals = true
  if (opts.suggestedFixes) config.judge.suggestedFixes = true
  if (opts.benchmark) {
    await runBenchmark()
    return
  }

  // --validate-prompt: parse prompt and exit (no review)
  if (opts.validatePrompt) {
    if (opts.prompt) {
      // Local file — no VCS needed
      validateLocalPrompt(opts.prompt)
      return
    }
    // Remote — need adapter + PR info to locate repo prompt
    if (!opts.prId) {
      console.error('Error: --validate-prompt requires --prompt <path> or --pr-id <id>')
      process.exit(1)
    }
  }

  if (!opts.prId) {
    console.error('Error: --pr-id is required')
    process.exit(1)
  }

  const provider = (opts.vcs ?? config.vcsProvider) as 'bitbucket' | 'github' | 'gitlab' | 'azure'
  // Make the resolved provider authoritative so usage logging (vcs, run_id) matches the
  // adapter actually used when --vcs overrides VCS_PROVIDER.
  config.vcsProvider = provider

  let adapter: VCSAdapter

  if (provider === 'bitbucket') {
    // Allow CLI flags to override env vars for one-off runs
    if (opts.workspace) config.bitbucket.workspace = opts.workspace
    validateBitbucketConfig()

    const bb = new BitbucketAdapter(
      config.bitbucket.baseUrl,
      config.bitbucket.workspace,
      config.bitbucket.username,
      config.bitbucket.token
    )

    if (!opts.repoSlug) {
      console.error('Error: --repo-slug is required for Bitbucket')
      process.exit(1)
    }
    bb.setRepoSlug(opts.repoSlug)
    adapter = bb
  } else if (provider === 'azure') {
    // Azure DevOps — experimental / WIP. --workspace aliases AZURE_ORG for one-off runs.
    if (opts.workspace) config.azure.org = opts.workspace
    validateAzureConfig()

    const az = new AzureDevOpsAdapter(
      config.azure.baseUrl,
      config.azure.org,
      config.azure.project,
      config.azure.pat,
      config.azure.accessToken
    )

    if (!opts.repoSlug) {
      console.error('Error: --repo-slug is required for Azure DevOps')
      process.exit(1)
    }
    az.setRepoSlug(opts.repoSlug)
    adapter = az
  } else if (provider === 'github') {
    if (opts.workspace) config.github.owner = opts.workspace
    validateGitHubConfig()

    const gh = new GitHubAdapter(config.github.baseUrl, config.github.owner, config.github.token)

    if (!opts.repoSlug) {
      console.error('Error: --repo-slug is required for GitHub')
      process.exit(1)
    }
    gh.setRepoSlug(opts.repoSlug)
    adapter = gh
  } else if (provider === 'gitlab') {
    // The GitLab adapter is a stub whose every call throws, so a run could only end in ERROR.
    console.error('Error: VCS provider gitlab is not implemented yet - use bitbucket, github or azure')
    process.exit(1)
  } else {
    console.error(`Unknown VCS provider: ${provider}`)
    process.exit(1)
  }

  // Remote prompt validation — adapter is set up, fetch PR info and load prompt
  if (opts.validatePrompt) {
    const prInfo = await adapter.getPullRequestInfo(opts.prId!)
    const changedFiles = await adapter.getChangedFiles(opts.prId!)
    const diff = await adapter.getDiff(opts.prId!)   // import-based stack overlays need the diff, as in a real run
    const result = await loadPrompt(adapter, prInfo, undefined, changedFiles, diff)
    console.log(`\nFilled prompt length: ${result.content.length} chars (~${Math.ceil(result.content.length / 4).toLocaleString()} tokens)`)
    return
  }

  // CLI flags override env var models
  if (opts.model) config.anthropic.model = opts.model
  if (opts.judgeModel) config.judge.model = opts.judgeModel
  if (opts.replyModel) config.reply.model = opts.replyModel

  // CLI flags override env var thresholds
  if (opts.minChangedFiles) config.thresholds.minChangedFiles = parseInt(opts.minChangedFiles, 10)
  if (opts.maxChangedFiles) config.thresholds.maxChangedFiles = parseInt(opts.maxChangedFiles, 10)
  if (opts.minChangedLines) config.thresholds.minChangedLines = parseInt(opts.minChangedLines, 10)
  if (opts.maxChangedLines) config.thresholds.maxChangedLines = parseInt(opts.maxChangedLines, 10)

  // Compared with undefined, not truthiness: an empty value is how one repo disables a list, e.g. the default main,master target skip.
  if (opts.skipSourceBranches !== undefined) config.skipSourceBranches = parseBranchList(opts.skipSourceBranches)
  if (opts.skipTargetBranches !== undefined) config.skipTargetBranches = parseBranchList(opts.skipTargetBranches)
  if (opts.onlyTargetBranches !== undefined) config.onlyTargetBranches = parseBranchList(opts.onlyTargetBranches)

  // CLI flags override env var token limits
  if (opts.maxInputTokens) config.anthropic.maxInputTokens = parseInt(opts.maxInputTokens, 10)
  if (opts.maxOutputTokens) config.anthropic.maxTokens = parseInt(opts.maxOutputTokens, 10)

  // CLI flags override env var effort
  if (opts.effort) config.review.effort = opts.effort
  if (opts.judgeEffort) config.judge.effort = opts.judgeEffort
  if (opts.skipDirectedReplies) config.reply.skipDirectedElsewhere = true
  if (opts.secondLook) config.review.secondLook = true
  if (opts.lenses) { config.lenses.enabled = true; config.lenses.list = opts.lenses }
  if (opts.lensRecommendation) config.lenses.recommend = true
  const fixOutput = config.judge.suggestedFixes ? 'suggested fixes' : 'proposals'
  if ((config.judge.proposals || config.judge.suggestedFixes) && !config.judge.model) console.warn(`Warning: ${fixOutput} requested but the judge is disabled (JUDGING_MODEL empty) - no ${fixOutput} will be produced.`)
  if (opts.repoSlug) config.repoSlug = opts.repoSlug
  const trigger = resolveTrigger(opts, { ...config.trigger, eventKind: config.triggerEventKind })
  if (!trigger && config.trigger.ignoreCommentAuthors.length) console.warn('Warning: IGNORE_COMMENT_AUTHORS is set but no --event/--comment-author (TRIGGER_EVENT/TRIGGER_COMMENT_AUTHOR) was given - the ignore list is inactive.')
  const checkedCommit = resolveCheckedCommit(opts.checkedCommit, config.lastCheckedCommit)

  // A bare --force means re-review; an empty value (how CI passes an unset parameter) must run exactly like an absent flag, pre-post race check included.
  const forceMode = opts.force === true ? 're-review' : typeof opts.force === 'string' && opts.force.trim() ? opts.force as 'clean' | 're-review' : 'off'
  await review(adapter, opts.prId!, opts.dryRun ?? false, opts.prompt, forceMode, opts.logUsage ?? true, opts.repoSlug ?? '', undefined, trigger, checkedCommit)
}

main().catch((err: unknown) => {
  console.error('Fatal error:', (err as Error).message)
  process.exit(1)
})
