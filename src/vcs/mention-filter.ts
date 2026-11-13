// Pure drop-rule for "@-directed at someone else" replies. Over-drop-averse: a wrongly dropped
// reply is a silently unanswered question, so keep on any doubt (see docs/context/review/replies.md).

// Captures the inner id of @{…}, tolerating Atlassian's @{{uuid}} double-brace echo.
const MENTION_TOKEN = /@\{+([^{}]+)\}+/g
const LEADING_MENTION = /^@\{+([^{}]+)\}+/

// Mention ids seen in real Bitbucket payloads: legacy 24-hex, NNN:uuid, or a bare uuid. Anything
// else (e.g. @{vm.name} data-binding) is not an id and never counts as an address.
const ID_SHAPES = [/^[0-9a-f]{24}$/, /^\d+:[0-9a-f-]{36}$/, /^[0-9a-f-]{36}$/]

function isIdShaped(token: string): boolean {
  return ID_SHAPES.some(re => re.test(token))
}

// Templates like @{vm.name} live in code; strip fenced + inline code so they can't read as a lead address.
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
}

export interface DropDecision {
  drop: boolean
  matchedToken?: string   // the leading mention that triggered the drop, for per-drop logging
}

// The agent is addressed anywhere, by id or name, even mid-sentence or after another mention.
export function mentionsAgent(body: string, agentIds: ReadonlySet<string>, agentNames: ReadonlySet<string>): boolean {
  for (const m of body.matchAll(MENTION_TOKEN)) {
    if (isIdShaped(m[1]) && agentIds.has(m[1])) return true
  }
  // A picker-less plain-text @agentname the tokenizer can't see.
  const lower = body.toLowerCase()
  for (const name of agentNames) {
    if (name && mentionsName(lower, '@' + name)) return true
  }
  return false
}

// Word boundaries on both sides: a short agent name like "dev" is not found inside "@devon" or the email "alice@dev.co".
function mentionsName(lower: string, needle: string): boolean {
  const wordChar = /[\p{L}\p{N}_-]/u
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
    const before = at > 0 ? lower[at - 1] : undefined
    const next = lower[at + needle.length]
    if ((before === undefined || !wordChar.test(before)) && (next === undefined || !wordChar.test(next))) return true
  }
  return false
}

export function decideDirectedElsewhere(
  body: string,
  agentIds: ReadonlySet<string>,
  agentNames: ReadonlySet<string>,
): DropDecision {
  if (agentIds.size === 0) return { drop: false }
  const lead = stripCode(body).trim().match(LEADING_MENTION)
  if (!lead || !isIdShaped(lead[1])) return { drop: false }
  if (mentionsAgent(body, agentIds, agentNames)) return { drop: false }
  return { drop: true, matchedToken: lead[1] }
}
