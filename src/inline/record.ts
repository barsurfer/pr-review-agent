import type { ReviewContext } from '../review/types.js'
import type { InlineRecord } from './types.js'

// The inactive form is derived from the context, never from an engine object, because none exists then.
export function inlineRecord(ctx: ReviewContext): InlineRecord {
  if (ctx.inline) return ctx.inline.record()
  return { active: false, reason: ctx.outcomeSink ? 'benchmark' : 'unsupported_vcs' }
}
