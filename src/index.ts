import { Command } from 'commander'
import { config, validateBitbucketConfig } from './config.js'
import { BitbucketAdapter } from './vcs/bitbucket.js'
import { GitHubAdapter } from './vcs/github.js'
import { GitLabAdapter } from './vcs/gitlab.js'
import { review } from './review.js'
import type { VCSAdapter } from './vcs/adapter.js'

const program = new Command()

program
  .name('pr-review-agent')
  .description('Automated PR code review powered by Claude')
  .requiredOption('--pr-id <id>', 'Pull request ID')
  .option('--workspace <workspace>', 'VCS workspace / org (overrides BITBUCKET_WORKSPACE)')
  .option('--repo-slug <slug>', 'Repository slug')
  .option('--vcs <provider>', 'VCS provider: bitbucket | github | gitlab (overrides VCS_PROVIDER)')
  .option('--dry-run', 'Print the review to stdout without posting to the PR')
  .option('--prompt <path>', 'Path to a local prompt file (overrides repo .agent-review-instructions.md)')
  .option('--min-changed-files <n>', 'Skip review if fewer files changed (overrides MIN_CHANGED_FILES)')
  .option('--max-changed-files <n>', 'Skip review if more files changed (overrides MAX_CHANGED_FILES)')
  .option('--min-changed-lines <n>', 'Skip review if fewer lines changed (overrides MIN_CHANGED_LINES)')
  .option('--max-changed-lines <n>', 'Skip review if more lines changed (overrides MAX_CHANGED_LINES)')
  .parse(process.argv)

const opts = program.opts<{
  prId: string
  workspace?: string
  repoSlug?: string
  vcs?: string
  dryRun?: boolean
  prompt?: string
  minChangedFiles?: string
  maxChangedFiles?: string
  minChangedLines?: string
  maxChangedLines?: string
}>()

async function main(): Promise<void> {
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

  // CLI flags override env var thresholds
  if (opts.minChangedFiles) config.thresholds.minChangedFiles = parseInt(opts.minChangedFiles, 10)
  if (opts.maxChangedFiles) config.thresholds.maxChangedFiles = parseInt(opts.maxChangedFiles, 10)
  if (opts.minChangedLines) config.thresholds.minChangedLines = parseInt(opts.minChangedLines, 10)
  if (opts.maxChangedLines) config.thresholds.maxChangedLines = parseInt(opts.maxChangedLines, 10)

  await review(adapter, opts.prId, opts.dryRun ?? false, opts.prompt)
}

main().catch((err: unknown) => {
  console.error('Fatal error:', (err as Error).message)
  process.exit(1)
})
