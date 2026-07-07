// ---------------------------------------------------------------------------
// Comment & footer formatting — string builders, no I/O
// ---------------------------------------------------------------------------

/** Build the footer appended to review comments. When a CI job URL is available, the
 *  "Review #N" label links to the build that posted the comment (Bitbucket renders HTML
 *  comments as visible text, so a markdown link is the clean way to carry the job link). */
export function buildReviewFooter(
  identity: string,
  model: string,
  promptSource: string,
  reviewNumber: number,
  commitShort: string,
  buildCommit: string,
  jobUrl?: string
): string {
  const review = jobUrl ? `[Review #${reviewNumber}](${jobUrl})` : `Review #${reviewNumber}`
  return `\n\n---\n*Reviewed by ${identity} (${model}) | Prompt: ${promptSource} | ${review} | Commit: ${commitShort} | Build: ${buildCommit}*`
}

/** Build the footer appended to reply comments. Links "Reply by …" to the CI job when available. */
export function buildReplyFooter(identity: string, model: string, jobUrl?: string): string {
  const label = `Reply by ${identity} (${model})`
  return jobUrl ? `\n\n---\n*[${label}](${jobUrl})*` : `\n\n---\n*${label}*`
}

/** Remove a previous review footer so it isn't duplicated on re-reviews. */
export function stripPreviousFooter(text: string): string {
  return text.replace(/\n---\n\*Reviewed by .*?\*\s*/g, '').trimEnd()
}

/** Strip internal DELTA_STATS HTML comment before posting. */
export function stripDeltaStats(text: string): string {
  return text.replace(/\n*<!--\s*DELTA_STATS:.*?-->\s*/g, '').trimEnd()
}

/** Strip the judge's validation notes — its sanctioned outlet for drop rationale,
 *  never meant to reach the PR. */
export function stripJudgeNotes(text: string): string {
  return text.replace(/\n*<!--\s*JUDGE_NOTES:[\s\S]*?-->\s*/g, '').trimEnd()
}

/** Strip any Jenkins metadata comment the model may have echoed from a prior review —
 *  the current run appends its own. */
export function stripJenkinsMeta(text: string): string {
  return text.replace(/\n*<!--\s*jenkins:[\s\S]*?-->\s*/gi, '').trimEnd()
}

/** Check whether Claude returned the NO_CHANGE stop word — exact, or as a standalone
 *  line when the model prepends a summary despite the prompt instruction. */
export function isNoChange(text: string): boolean {
  return /^[ \t]*NO_CHANGE[ \t]*$/m.test(text)
}

/** Drop leaked model reasoning before the first "Summary" heading — reviewer and judge
 *  are both instructed to start there, but models sometimes think out loud first. */
export function stripPreamble(text: string): string {
  const match = text.match(/^#{1,4}[ \t]*Summary\b/im)
  if (!match || !match.index) return text
  return text.slice(match.index)
}

/** Extract the short commit hash from a review comment footer. */
export function extractCommitHash(body: string): string | null {
  const match = body.match(/Commit: ([a-f0-9]+)/)
  return match ? match[1] : null
}

/** Detect the agent's exact review footer line — a casual "Reviewed by" mention
 *  in a human comment must not match. The Build segment is optional so footers
 *  posted before it existed keep matching (dedup must survive the format change). */
export function hasReviewFooter(body: string): boolean {
  return /^\*Reviewed by .+ \(.+\) \| Prompt: .+ \| (?:Review #\d+|\[Review #\d+\]\([^)]+\)) \| Commit: [0-9a-f]+( \| Build: [\w.-]+)?\*$/m.test(body)
}

/** Detect the agent's exact reply footer line (plain or CI-linked). */
export function hasReplyFooter(body: string): boolean {
  return /^\*(?:Reply by .+ \(.+\)|\[Reply by .+ \(.+\)\]\([^)]+\))\*$/m.test(body)
}
