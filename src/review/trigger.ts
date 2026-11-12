import type { TriggerInfo } from './types.js'

// Bitbucket sends an actor with every PR event (the pusher on pullrequest:updated), so only a comment event proves the author commented.
export function isCommentEvent(event: string): boolean {
  return /comment/i.test(event)
}

// Webhook JSONPath yields {uuid}, while people paste ids bare or in another case.
export function normalizeAuthorId(id: string): string {
  return id.trim().replace(/^\{(.*)\}$/, '$1').trim().toLowerCase()
}

// CI passes unset parameters as empty strings, so an empty CLI value falls back to the env value.
export function resolveTrigger(cli: { event?: string; commentAuthor?: string }, env: TriggerInfo): TriggerInfo | undefined {
  const event = cli.event?.trim() || env.event
  const commentAuthor = cli.commentAuthor?.trim() || env.commentAuthor
  return event || commentAuthor ? { event, commentAuthor } : undefined
}

export function ignoredCommentAuthor(trigger: TriggerInfo, ignoreList: readonly string[]): string | null {
  const author = normalizeAuthorId(trigger.commentAuthor)
  if (!author || !isCommentEvent(trigger.event)) return null
  return ignoreList.find(entry => normalizeAuthorId(entry) === author) ?? null
}
