import type { ContentFilterError } from '../llm/shared.js'
import type { ContentFilterRecord, ReviewContext } from './types.js'

// Fixed line the previous-review detection keys on, so a notice is never mistaken for a review.
export const CONTENT_FILTER_MARKER = '*Review not completed: content filter*'

export const CONTENT_FILTER_NOTICE_TEXT = `**Automated review not completed**

The review model's safety filters declined to process this pull request, so no review was produced. This usually happens when a change includes code that resembles security-sensitive behaviour, for example collecting credentials from browser storage or replaying authentication headers.

Please take a look at those areas and consider a different approach, such as authenticating through the API layer or test fixtures. The next push will be reviewed again.`

export const CONTENT_FILTER_NOTICE = `${CONTENT_FILTER_NOTICE_TEXT}\n\n${CONTENT_FILTER_MARKER}`

export const CONTENT_FILTER_SKIP_REASON = "The model's safety filters declined the review; a notice was posted"

export const PARTIAL_FILTER_LINE = "Some files were not reviewed because the model's safety filters declined them."

export const REPLY_DECLINED_TEXT = "I can't answer this one: the review model's safety filters declined it."

export const NOTICE_HISTORY_TEXT = 'review not completed (content filter)'

const NOTICE_START = '**Automated review not completed**'

// A model can echo the marker line, so a legacy notice must also start with the heading and carry the marker directly above the review footer.
export function isContentFilterNotice(body: string): boolean {
  const text = body.replace(/\r\n/g, '\n')
  return text.startsWith(`${NOTICE_START}\n`) && text.includes(`\n${CONTENT_FILTER_MARKER}\n\n---\n*Reviewed by `)
}

// The inline summary carries the marker as its first line under the header; narrative text can never contain it.
export function isNoticeSummary(body: string): boolean {
  const lines = body.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() !== '')
  return lines[1]?.trimEnd() === CONTENT_FILTER_MARKER
}

export function filterRecord(stage: string, err: ContentFilterError, bundle?: number): ContentFilterRecord {
  return {
    stage, signal: err.signal,
    ...(err.nativeFinishReason ? { native_finish_reason: err.nativeFinishReason } : {}),
    ...(err.category ? { category: err.category } : {}),
    ...(err.reasons?.length ? { reasons: err.reasons } : {}),
    ...(err.httpStatus !== undefined ? { http_status: err.httpStatus } : {}),
    ...(bundle !== undefined ? { bundle } : {}),
  }
}

export function noteContentFilter(ctx: ReviewContext, stage: string, err: ContentFilterError, bundle?: number): void {
  ;(ctx.contentFilters ??= []).push(filterRecord(stage, err, bundle))
  console.warn(`  Content filter on ${stage}${bundle !== undefined ? ` (bundle ${bundle})` : ''}: ${err.signal}${err.category ? ` / ${err.category}` : ''}${err.reasons?.length ? ` [${err.reasons.join(', ')}]` : ''}`)
}
