import type { TriggerInfo } from './types.js'
import { cliOrEnv } from './cli-value.js'

// Bitbucket sends an actor with every PR event (the pusher on pullrequest:updated), so only a comment event proves the author commented.
export function isCommentEvent(event: string): boolean {
  return /comment/i.test(event)
}

// Webhook JSONPath yields {uuid}, while people paste ids bare or in another case.
export function normalizeAuthorId(id: string): string {
  return id.trim().replace(/^\{(.*)\}$/, '$1').trim().toLowerCase()
}

export function resolveTrigger(cli: { event?: string; commentAuthor?: string }, env: TriggerInfo): TriggerInfo | undefined {
  const event = cliOrEnv(cli.event, env.event)
  const commentAuthor = cliOrEnv(cli.commentAuthor, env.commentAuthor)
  return event || commentAuthor ? { event, commentAuthor } : undefined
}

export function ignoredCommentAuthor(trigger: TriggerInfo, ignoreList: readonly string[]): string | null {
  const author = normalizeAuthorId(trigger.commentAuthor)
  if (!author || !isCommentEvent(trigger.event)) return null
  return ignoreList.find(entry => normalizeAuthorId(entry) === author) ?? null
}
