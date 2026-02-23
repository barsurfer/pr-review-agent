import { config } from './config.js'
import { loadPrompt } from './prompt/loader.js'
import { fetchContext } from './context/fetcher.js'
import { runReview, runCommentResponse } from './claude/client.js'
import type { VCSAdapter } from './vcs/adapter.js'

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

export async function review(adapter: VCSAdapter, prId: string, dryRun = false, promptPath?: string): Promise<void> {
  console.log(`\nStarting review for PR #${prId}`)

  // 1. Fetch PR metadata
  console.log('Fetching PR info...')
  const prInfo = await adapter.getPullRequestInfo(prId)
  console.log(`  "${prInfo.title}" (${prInfo.sourceBranch} → ${prInfo.targetBranch})`)

  // 2. Fetch diff
  console.log('Fetching diff...')
  const diff = await adapter.getDiff(prId)

  // 3. Fetch changed file list
  console.log('Fetching changed files...')
  const changedFiles = await adapter.getChangedFiles(prId)
  console.log(`  ${changedFiles.length} changed file(s)`)

  // 3a. Check PR size thresholds
  const { minChangedFiles, maxChangedFiles, minChangedLines, maxChangedLines } = config.thresholds
  const fileCount = changedFiles.length
  const lineCount = countChangedLines(diff)
  console.log(`  ${lineCount} changed line(s)`)

  if (minChangedFiles > 0 && fileCount < minChangedFiles) {
    console.log(`\nSkipping: PR has ${fileCount} changed file(s), minimum is ${minChangedFiles}`)
    return
  }
  if (maxChangedFiles > 0 && fileCount > maxChangedFiles) {
    console.log(`\nSkipping: PR has ${fileCount} changed file(s), maximum is ${maxChangedFiles}`)
    return
  }
  if (minChangedLines > 0 && lineCount < minChangedLines) {
    console.log(`\nSkipping: PR has ${lineCount} changed line(s), minimum is ${minChangedLines}`)
    return
  }
  if (maxChangedLines > 0 && lineCount > maxChangedLines) {
    console.log(`\nSkipping: PR has ${lineCount} changed line(s), maximum is ${maxChangedLines}`)
    return
  }

  // 4. Check for previous review comments
  console.log('Checking for previous reviews...')
  const previousReviews = await adapter.getPreviousReviewComments(prId)
  if (previousReviews.length > 0) {
    console.log(`  Found ${previousReviews.length} previous review(s) — will produce delta review`)

    // 4a. If source commit hasn't changed, check for unanswered reply comments
    const lastReview = previousReviews[previousReviews.length - 1]
    const commitMatch = lastReview.body.match(/Commit: ([a-f0-9]+)/)
    if (commitMatch && commitMatch[1] === prInfo.sourceCommit.slice(0, 12)) {
      console.log(`  Source commit ${prInfo.sourceCommit.slice(0, 12)} already reviewed — checking for unanswered replies...`)
      const reviewIds = previousReviews.map(r => r.id)
      const replies = await adapter.getRepliesToReviewComments(prId, reviewIds)
      if (replies.length > 0) {
        console.log(`  Found ${replies.length} unanswered reply comment(s) — responding...`)
        const responseText = await runCommentResponse(
          config.anthropic.apiKey,
          config.anthropic.model,
          diff,
          lastReview.body,
          replies
        )
        const replyFooter = `\n\n---\n*Reply by Claude (${config.anthropic.model})*`
        const replyBody = responseText.trimEnd() + replyFooter
        if (dryRun) {
          console.log('\n=== DRY RUN — Reply output (not posted) ===\n')
          console.log(replyBody)
          console.log('\n=== End of reply ===\n')
        } else {
          // Reply to the most recent review comment that has unanswered replies
          const targetParentId = replies[replies.length - 1].parentId
          await adapter.postReply(prId, targetParentId, replyBody)
          console.log('Done. Reply posted to PR.\n')
        }
      } else {
        console.log('\nSkipping: no new commits and no unanswered questions.')
      }
      return
    }
  } else {
    console.log('  No previous reviews — first review for this PR')
  }

  // 5. Load system prompt
  console.log('Loading prompt...')
  const prompt = await loadPrompt(adapter, promptPath)
  console.log(`  Prompt source: ${prompt.source}`)

  // 6. Fetch full file context
  console.log('Fetching file context...')
  const fileContexts = await fetchContext(
    adapter,
    changedFiles,
    prInfo.sourceCommit,
    diff,
    config.context.maxFiles,
    config.context.maxFileLines
  )
  console.log(`  Fetched full content for ${fileContexts.length} file(s)`)

  // 7. Call Claude
  const reviewText = await runReview(
    config.anthropic.apiKey,
    config.anthropic.model,
    prInfo,
    diff,
    fileContexts,
    prompt,
    previousReviews
  )

  // 8. Check for NO_CHANGE stop word — skip posting if nothing new
  if (reviewText.trim() === 'NO_CHANGE') {
    console.log('\nNo changes since last review — skipping comment.')
    return
  }

  // 9. Strip any hallucinated footer from Claude's output, then append the real one
  const cleaned = reviewText.replace(/\n---\n\*Reviewed by Claude.*?\*\s*/g, '').trimEnd()
  const reviewNumber = previousReviews.length + 1
  const commitShort = prInfo.sourceCommit.slice(0, 12)
  const footer = `\n\n---\n*Reviewed by Claude (${config.anthropic.model}) | Prompt: ${prompt.source} | Review #${reviewNumber} | Commit: ${commitShort}*`
  const comment = cleaned + footer

  if (dryRun) {
    console.log('\n=== DRY RUN — Review output (not posted) ===\n')
    console.log(comment)
    console.log('\n=== End of review ===\n')
  } else {
    console.log('Posting review comment...')
    await adapter.postComment(prId, comment)
    console.log('Done. Review posted to PR.\n')
  }
}
