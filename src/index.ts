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
  .parse(process.argv)

const opts = program.opts<{
  prId: string
  workspace?: string
  repoSlug?: string
  vcs?: string
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

  await review(adapter, opts.prId)
}

main().catch((err: unknown) => {
  console.error('Fatal error:', (err as Error).message)
  process.exit(1)
})
