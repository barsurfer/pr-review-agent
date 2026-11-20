import { createProvider, type LLMUsage } from '../llm/provider.js'
import { getReplyPrompt } from '../review/client.js'
import { stripGeneratedFooters } from './markers.js'
import type { ThreadView } from './replies.js'

const REPLY_MAX_TOKENS = 8000

export interface ValidAnswer { target: string; rootId: string; through: string; text: string }
export interface CallArgs { apiKey: string; model: string; maxRetries: number; diff: string }

const OVERLAY = `

INLINE THREAD REPLIES: each thread below is one finding you posted as an inline comment (or the review summary). Answer only the questions listed as pending, in the thread they belong to.
- Return structured JSON only. For each thread answer once, and set "through" to the id of the newest pending question that answer covers.
- Name the question you answer in the first sentence. Do not write footers, signatures, or marker lines.`

const quote = (s: string): string => s.replace(/\r\n/g, '\n').split('\n').map(l => `> ${l}`).join('\n')

function threadBlock(v: ThreadView): string {
  const rootText = v.rootBody.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(0, -1).join('\n')
  const lines = [`## Thread ${v.target} (root comment ${v.rootId})`, `Original comment:\n${quote(rootText)}`, 'Discussion:']
  for (const c of v.comments) lines.push(`**${c.author}** (comment ${c.id}, ${c.createdOn}):\n${quote(c.body)}`)
  lines.push(`Pending question ids: ${v.pending.map(q => q.id).join(', ')}`)
  return lines.join('\n')
}

const clean = (text: unknown): string => (typeof text === 'string' ? stripGeneratedFooters(text).text.trim() : '')

// An echo outside the thread's pending ids cannot be bound to a question, so the answer is dropped rather than guessed.
export function validateAnswers(raw: unknown, threads: readonly ThreadView[]): { answers: ValidAnswer[]; dropped: number } {
  const list = Array.isArray((raw as { answers?: unknown })?.answers) ? (raw as { answers: unknown[] }).answers : []
  const byTarget = new Map(threads.map(t => [t.target, t]))
  const best = new Map<string, ValidAnswer & { seq: number }>()
  let dropped = 0
  for (const item of list) {
    const a = item as { id?: unknown; through?: unknown; text?: unknown }
    const view = typeof a.id === 'string' ? byTarget.get(a.id) : undefined
    const q = view?.pending.find(p => p.id === a.through)
    const text = clean(a.text)
    if (!view || !q || !text) { dropped++; continue }
    const prev = best.get(view.target)
    if (prev) { dropped++; if (prev.seq >= q.seq) continue }
    best.set(view.target, { target: view.target, rootId: view.rootId, through: q.id, text, seq: q.seq })
  }
  return { answers: [...best.values()].map(({ seq: _s, ...a }) => a), dropped }
}

export async function runFindingReplies(args: CallArgs & { threads: readonly ThreadView[] }): Promise<{ answers: ValidAnswer[]; dropped: number; usage: LLMUsage }> {
  const targets = args.threads.map(t => t.target)
  const pendingIds = [...new Set(args.threads.flatMap(t => t.pending.map(q => q.id)))]
  const schema = {
    type: 'object',
    properties: {
      answers: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string', enum: targets }, through: { type: 'string', enum: pendingIds }, text: { type: 'string' } },
          required: ['id', 'through', 'text'],
          additionalProperties: false,
        },
      },
    },
    required: ['answers'],
    additionalProperties: false,
  }
  const user = [`## Diff:\n\`\`\`diff\n${args.diff}\n\`\`\``, ...args.threads.map(threadBlock)].join('\n\n')
  const { object, usage } = await createProvider(args.apiKey).completeStructured<unknown>(
    getReplyPrompt() + OVERLAY, user, schema, { model: args.model, maxTokens: REPLY_MAX_TOKENS, maxRetries: args.maxRetries },
  )
  return { ...validateAnswers(object, args.threads), usage }
}

// The summary thread has its own wrapper so the legacy runCommentResponse stays as it is.
export async function runSummaryReplies(args: CallArgs & { view: ThreadView }): Promise<{ answer: ValidAnswer | null; dropped: number; usage: LLMUsage }> {
  const pendingIds = args.view.pending.map(q => q.id)
  const schema = {
    type: 'object',
    properties: { through: { type: 'string', enum: pendingIds }, text: { type: 'string' } },
    required: ['through', 'text'],
    additionalProperties: false,
  }
  const user = [`## Diff:\n\`\`\`diff\n${args.diff}\n\`\`\``, threadBlock(args.view)].join('\n\n')
  const { object, usage } = await createProvider(args.apiKey).completeStructured<{ through?: unknown; text?: unknown }>(
    getReplyPrompt() + OVERLAY, user, schema, { model: args.model, maxTokens: REPLY_MAX_TOKENS, maxRetries: args.maxRetries },
  )
  const { answers, dropped } = validateAnswers({ answers: [{ id: args.view.target, through: object?.through, text: object?.text }] }, [args.view])
  return { answer: answers[0] ?? null, dropped, usage }
}
