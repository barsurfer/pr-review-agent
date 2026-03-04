// ---------------------------------------------------------------------------
// Comment & footer formatting — string builders, no I/O
// ---------------------------------------------------------------------------

/** Build the footer appended to review comments. */
export function buildReviewFooter(
  identity: string,
  model: string,
  promptSource: string,
  reviewNumber: number,
  commitShort: string
): string {
  return `\n\n---\n*Reviewed by ${identity} (${model}) | Prompt: ${promptSource} | Review #${reviewNumber} | Commit: ${commitShort}*`
}

/** Build the footer appended to reply comments. */
export function buildReplyFooter(identity: string, model: string): string {
  return `\n\n---\n*Reply by ${identity} (${model})*`
}

/** Remove a previous review footer so it isn't duplicated on re-reviews. */
export function stripPreviousFooter(text: string): string {
  return text.replace(/\n---\n\*Reviewed by .*?\*\s*/g, '').trimEnd()
}

/** Strip internal DELTA_STATS HTML comment before posting. */
export function stripDeltaStats(text: string): string {
  return text.replace(/\n*<!--\s*DELTA_STATS:.*?-->\s*/g, '').trimEnd()
}

/** Check whether Claude returned the NO_CHANGE stop word. */
export function isNoChange(text: string): boolean {
  return text.trim() === 'NO_CHANGE'
}

/** Extract the short commit hash from a review comment footer. */
export function extractCommitHash(body: string): string | null {
  const match = body.match(/Commit: ([a-f0-9]+)/)
  return match ? match[1] : null
}
