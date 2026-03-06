const [major] = process.versions.node.split('.').map(Number)
if (major < 20) {
  console.error(`Node.js 20+ required. Current: ${process.version}`)
  process.exit(1)
}

import { Command } from 'commander'
import { config, validateBitbucketConfig } from './config.js'
import { BitbucketAdapter } from './vcs/bitbucket.js'
import { GitHubAdapter } from './vcs/github.js'
import { GitLabAdapter } from './vcs/gitlab.js'
import { review } from './review/index.js'
import { validateLocalPrompt, loadPrompt } from './prompt/loader.js'
import type { VCSAdapter } from './vcs/adapter.js'

const program = new Command()

program
  .name('pr-review-agent')
  .description('Automated PR code review powered by Claude')
  .option('--pr-id <id>', 'Pull request ID')
  .option('--workspace <workspace>', 'VCS workspace / org (overrides BITBUCKET_WORKSPACE)')
  .option('--repo-slug <slug>', 'Repository slug')
  .option('--vcs <provider>', 'VCS provider: bitbucket | github | gitlab (overrides VCS_PROVIDER)')
  .option('--dry-run', 'Print the review to stdout without posting to the PR')
  .option('--force', 'Ignore previous reviews and produce a fresh review')
  .option('--log-usage [bool]', 'Log usage data to results.jsonl (default: true)', (v: string) => v !== 'false', true)
  .option('--prompt <path>', 'Path to a local prompt file (overrides repo .agent-review-instructions.md)')
  .option('--validate-prompt', 'Validate prompt and exit (local via --prompt, or repo via --pr-id)')
  .option('--model <id>', 'Claude model ID (overrides CLAUDE_MODEL)')
  .option('--judge-model <id>', 'Judge model ID (overrides JUDGING_MODEL)')
  .option('--min-changed-files <n>', 'Skip review if fewer files changed (overrides MIN_CHANGED_FILES)')
  .option('--max-changed-files <n>', 'Skip review if more files changed (overrides MAX_CHANGED_FILES)')
  .option('--min-changed-lines <n>', 'Skip review if fewer lines changed (overrides MIN_CHANGED_LINES)')
  .option('--max-changed-lines <n>', 'Skip review if more lines changed (overrides MAX_CHANGED_LINES)')
  .parse(process.argv)

const opts = program.opts<{
  prId?: string
  workspace?: string
  repoSlug?: string
  vcs?: string
  model?: string
  judgeModel?: string
  dryRun?: boolean
  force?: boolean
  logUsage?: boolean
  prompt?: string
  validatePrompt?: boolean
  minChangedFiles?: string
  maxChangedFiles?: string
  minChangedLines?: string
  maxChangedLines?: string
}>()

async function main(): Promise<void> {
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

  const provider = (opts.vcs ?? config.vcsProvider) as 'bitbucket' | 'github' | 'gitlab'

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
  } else if (provider === 'github') {
    adapter = new GitHubAdapter()
  } else if (provider === 'gitlab') {
    adapter = new GitLabAdapter()
  } else {
    console.error(`Unknown VCS provider: ${provider}`)
    process.exit(1)
  }

  // Remote prompt validation — adapter is set up, fetch PR info and load prompt
  if (opts.validatePrompt) {
    const prInfo = await adapter.getPullRequestInfo(opts.prId!)
    const result = await loadPrompt(adapter, prInfo)
    console.log(`\nFilled prompt length: ${result.content.length} chars (~${Math.ceil(result.content.length / 4).toLocaleString()} tokens)`)
    return
  }

  // CLI flags override env var models
  if (opts.model) config.anthropic.model = opts.model
  if (opts.judgeModel) config.judge.model = opts.judgeModel

  // CLI flags override env var thresholds
  if (opts.minChangedFiles) config.thresholds.minChangedFiles = parseInt(opts.minChangedFiles, 10)
  if (opts.maxChangedFiles) config.thresholds.maxChangedFiles = parseInt(opts.maxChangedFiles, 10)
  if (opts.minChangedLines) config.thresholds.minChangedLines = parseInt(opts.minChangedLines, 10)
  if (opts.maxChangedLines) config.thresholds.maxChangedLines = parseInt(opts.maxChangedLines, 10)

  await review(adapter, opts.prId!, opts.dryRun ?? false, opts.prompt, opts.force ?? false, opts.logUsage ?? true, opts.repoSlug ?? '')
}

main().catch((err: unknown) => {
  console.error('Fatal error:', (err as Error).message)
  process.exit(1)
})
