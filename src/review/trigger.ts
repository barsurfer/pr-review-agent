import type { TriggerInfo, EventKind } from './types.js'
import { cliOrEnv } from './cli-value.js'

// Comment events whose names lack the word: GitLab's note hook (object_kind / X-Gitlab-Event) and a submitted GitHub review.
const UNNAMED_COMMENT_EVENTS = /^(note|note hook|pull_request_review)$/i

// Bitbucket sends an actor with every PR event (the pusher on pullrequest:updated), so only a comment event proves the author commented.
export function isCommentEvent(event: string): boolean {
  return /comment/i.test(event) || UNNAMED_COMMENT_EVENTS.test(event)
}

// An explicit kind lets CI classify events a relay renamed or a provider names without "comment".
export function isCommentTrigger(trigger: TriggerInfo): boolean {
  return trigger.kind ? trigger.kind === 'comment' : isCommentEvent(trigger.event)
}

// Webhook JSONPath yields {uuid}, while people paste ids bare or in another case.
export function normalizeAuthorId(id: string): string {
  return id.trim().replace(/^\{(.*)\}$/, '$1').trim().toLowerCase()
}

function resolveEventKind(cli: string | undefined, env: string): EventKind | undefined {
  const value = cliOrEnv(cli, env).trim().toLowerCase()
  if (!value) return undefined
  if (value === 'comment' || value === 'other') return value
  console.warn(`Warning: ignoring the event kind "${value.slice(0, 64)}" (--event-kind/TRIGGER_EVENT_KIND) - expected comment or other`)
  return undefined
}

export function resolveTrigger(
  cli: { event?: string; commentAuthor?: string; eventKind?: string },
  env: { event: string; commentAuthor: string; eventKind?: string },
): TriggerInfo | undefined {
  const event = cliOrEnv(cli.event, env.event)
  const commentAuthor = cliOrEnv(cli.commentAuthor, env.commentAuthor)
  const kind = resolveEventKind(cli.eventKind, env.eventKind ?? '')
  if (!event && !commentAuthor) return undefined
  return kind ? { event, commentAuthor, kind } : { event, commentAuthor }
}

export function ignoredCommentAuthor(trigger: TriggerInfo, ignoreList: readonly string[]): string | null {
  const author = normalizeAuthorId(trigger.commentAuthor)
  if (!author || !isCommentTrigger(trigger)) return null
  return ignoreList.find(entry => normalizeAuthorId(entry) === author) ?? null
}
