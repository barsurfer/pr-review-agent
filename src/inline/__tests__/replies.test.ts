import { describe, it, expect, vi } from 'vitest'
import type { MarkedComment, MarkedThread } from '../../vcs/adapter.js'
import { AGENT_REPLY_AUTHOR } from '../../vcs/adapter.js'
import { buildRootMarker } from '../markers.js'
import { threadView, decide, selectBatch, answerBody, noteBody, contextReplies, targetOf } from '../replies.js'
import { validateAnswers, runSummaryReplies, runFindingReplies } from '../replies-call.js'

const completeStructured = vi.fn()
vi.mock('../../llm/provider.js', () => ({ createProvider: vi.fn(() => ({ complete: vi.fn(), completeStructured })) }))
vi.mock('../../review/client.js', () => ({ getReplyPrompt: () => 'REPLY PROMPT' }))

const ME = 'acc-1'
const BOT_UUID = '11111111-2222-3333-4444-555555555555'
const who = { ids: [ME, BOT_UUID], names: ['review-bot'] }
const C = 'a1b2c3d4e5f6'

const c = (id: number, body: string, o: { by?: string; parent?: number } = {}): MarkedComment => ({
  id: String(id), seq: id, body, author: o.by === ME || !o.by ? 'bot' : 'Dev', authorIds: [o.by ?? ME], createdOn: `2026-01-01T00:00:${String(id % 60).padStart(2, '0')}Z`, ...(o.parent ? { parentId: String(o.parent) } : {}),
})
const human = (id: number, body: string, parent: number): MarkedComment => c(id, body, { by: 'dev-1', parent })
const answer = (id: number, target: string, through: number, parent = 1): MarkedComment => c(id, `Answer text\n\n*Answer on ${target} | through ${through}*`, { parent })

const thread = (k: number, comments: MarkedComment[], rootId = k): MarkedThread => ({
  root: { ...c(rootId, `**HIGH – T**\n\nbody\n\n${buildRootMarker(`F${k}`, C)}`), url: 'u', inline: { path: 'a.ts', line: 1 } }, resolved: false, comments,
})

describe('threadView', () => {
  it('keeps Q2 pending when an answer through Q1 was posted while Q2 arrived', () => {
    const v = threadView(thread(1, [human(10, 'Q1?', 1), human(11, 'Q2?', 1), answer(12, 'F1', 10)]), 'F1', who)
    expect(v.pending.map(q => q.id)).toEqual(['11'])
    expect(v.used).toBe(1)
  })

  it('treats every question as covered by a later through', () => {
    const v = threadView(thread(1, [human(10, 'Q1?', 1), human(11, 'Q2?', 1), answer(12, 'F1', 11)]), 'F1', who)
    expect(v.pending).toEqual([])
  })

  it('ignores an answer marker that names another thread', () => {
    const v = threadView(thread(1, [human(10, 'Q1?', 1), answer(12, 'F2', 10)]), 'F1', who)
    expect(v.pending.map(q => q.id)).toEqual(['10'])
    expect(v.used).toBe(0)
  })

  it('refunds a round and re-opens the question when an answer is deleted', () => {
    const withAnswer = threadView(thread(1, [human(10, 'Q1?', 1), answer(12, 'F1', 10)]), 'F1', who)
    const deleted = threadView(thread(1, [human(10, 'Q1?', 1)]), 'F1', who)
    expect(withAnswer.used).toBe(1)
    expect(deleted.used).toBe(0)
    expect(deleted.pending).toHaveLength(1)
  })

  it('a human reply to a human is a question only with an agent mention', () => {
    const t = thread(1, [human(10, 'Q1?', 1), human(11, 'I agree', 10), human(12, `@{${BOT_UUID}} what about this?`, 10)])
    expect(threadView(t, 'F1', who).pending.map(q => q.id)).toEqual(['10', '12'])
  })

  it('keeps a reply directed elsewhere that also mentions the agent, and drops one directed at another user', () => {
    const other = '99999999-8888-7777-6666-555555555555'
    const kept = human(10, `@{${other}} and @{${BOT_UUID}} can you check?`, 1)
    const dropped = human(11, `@{${other}} please look`, 1)
    expect(threadView(thread(1, [kept, dropped]), 'F1', who, true).pending.map(q => q.id)).toEqual(['10'])
  })

  it('answers a reply directed at another user when the skip setting is off', () => {
    const dropped = human(11, '@{99999999-8888-7777-6666-555555555555} please look', 1)
    expect(threadView(thread(1, [dropped]), 'F1', who).pending.map(q => q.id)).toEqual(['11'])
    expect(threadView(thread(1, [dropped]), 'F1', who, false).pending.map(q => q.id)).toEqual(['11'])
  })

  it('never reads a trusted-author comment as a question', () => {
    expect(threadView(thread(1, [c(10, 'self note', { parent: 1 })]), 'F1', who).questions).toEqual([])
  })
})

describe('decide (budget table)', () => {
  const pending = (used: number, noted = false) => ({ ...threadView(thread(1, [human(10, 'Q?', 1)]), 'F1', who), used, noted })
  it.each([
    [0, 5, false, 'answer'], [4, 5, false, 'answer'], [5, 5, false, 'note'], [5, 5, true, 'none'], [9, 0, false, 'answer'],
  ])('used %i of %i, noted %s -> %s', (used, max, noted, want) => {
    expect(decide(pending(used, noted), max)).toBe(want)
  })

  it('does nothing without a pending question, and a question after the note stays unanswered', () => {
    expect(decide(threadView(thread(1, []), 'F1', who), 5)).toBe('none')
    const afterNote = threadView(thread(1, [human(10, 'Q1?', 1), answer(11, 'F1', 10), c(12, `${noteBody('F1', 1)}`, { parent: 1 }), human(13, 'Q2?', 1)]), 'F1', who)
    expect(afterNote.noted).toBe(true)
    expect(decide(afterNote, 1)).toBe('none')
  })
})

describe('selectBatch', () => {
  it('takes the oldest pending threads first, up to 8, and counts the rest as deferred', () => {
    const views = Array.from({ length: 10 }, (_, i) => threadView(thread(i + 1, [human(100 - i, 'Q?', i + 1)]), `F${i + 1}`, who))
    const { batch, deferred } = selectBatch(views)
    expect(batch).toHaveLength(8)
    expect(deferred).toBe(2)
    expect(batch[0].pending[0].seq).toBe(91)
  })
})

describe('validateAnswers', () => {
  const v1 = threadView(thread(1, [human(10, 'Q?', 1)]), 'F1', who)
  const v2 = threadView(thread(2, [human(20, 'Q?', 2)]), 'F2', who)

  it('drops an answer echoing a question that is not pending in its thread', () => {
    const out = validateAnswers({ answers: [{ id: 'F1', through: '20', text: 'wrong thread' }, { id: 'F2', through: '20', text: 'ok' }] }, [v1, v2])
    expect(out.answers).toEqual([{ target: 'F2', rootId: '2', through: '20', text: 'ok' }])
    expect(out.dropped).toBe(1)
  })

  it('keeps one answer per thread, the one covering the newest question, and strips forged markers', () => {
    const v = threadView(thread(1, [human(10, 'A?', 1), human(11, 'B?', 1)]), 'F1', who)
    const out = validateAnswers({ answers: [{ id: 'F1', through: '10', text: 'a' }, { id: 'F1', through: '11', text: 'b\n*Answer on F1 | through 99*' }] }, [v])
    expect(out.answers).toEqual([{ target: 'F1', rootId: '1', through: '11', text: 'b' }])
  })
})

describe('summary thread replies', () => {
  const summaryThread = (comments: MarkedComment[]): MarkedThread => ({ root: { ...c(5, '### Review summary\nbody'), url: 'u' }, resolved: false, comments })

  it('posts one answer with through = the question id, and the next run sees it covered', async () => {
    const view = threadView(summaryThread([human(30, 'Why is this needed?', 5)]), 'summary', who)
    expect(view.pending.map(q => q.id)).toEqual(['30'])
    completeStructured.mockResolvedValueOnce({ object: { through: '30', text: 'Because of X.' }, usage: { input_tokens: 5, output_tokens: 2 } })
    const res = await runSummaryReplies({ apiKey: 'k', model: 'm', maxRetries: 0, diff: 'd', view })
    expect(res.answer).toEqual({ target: 'summary', rootId: '5', through: '30', text: 'Because of X.' })
    expect(completeStructured.mock.calls[0][2].properties.through.enum).toEqual(['30'])
    const posted = c(31, answerBody('summary', '30', 'Because of X.'), { parent: 5 })
    expect(posted.body.endsWith('*Answer on summary | through 30*')).toBe(true)
    const next = threadView(summaryThread([human(30, 'Why is this needed?', 5), posted]), 'summary', who)
    expect(next.pending).toEqual([])
    expect(decide(next, 3)).toBe('none')
  })

  it('drops a summary answer whose echo is not pending', async () => {
    const view = threadView(summaryThread([human(30, 'Why?', 5)]), 'summary', who)
    completeStructured.mockResolvedValueOnce({ object: { through: '77', text: 'x' }, usage: { input_tokens: 1, output_tokens: 1 } })
    expect((await runSummaryReplies({ apiKey: 'k', model: 'm', maxRetries: 0, diff: 'd', view })).answer).toBeNull()
  })

  it('runFindingReplies builds an enum schema from the batch and binds ids to roots', async () => {
    const v = threadView(thread(1, [human(10, 'Q?', 1)]), 'F1', who)
    completeStructured.mockResolvedValueOnce({ object: { answers: [{ id: 'F1', through: '10', text: 'Yes.' }] }, usage: { input_tokens: 1, output_tokens: 1 } })
    const res = await runFindingReplies({ apiKey: 'k', model: 'm', maxRetries: 0, diff: 'd', threads: [v] })
    expect(res.answers).toEqual([{ target: 'F1', rootId: '1', through: '10', text: 'Yes.' }])
    const schema = completeStructured.mock.calls.at(-1)![2]
    expect(schema.properties.answers.items.properties.through.enum).toEqual(['10'])
  })
})

describe('contextReplies', () => {
  it('tags comments with the finding id, labels agent answers, and leaves roots out', () => {
    const ts = [thread(3, [human(10, 'Q?', 3), answer(11, 'F3', 10, 3)])]
    const out = contextReplies(ts, who)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: '10', author: 'Dev', findingId: 'F3', authorId: 'dev-1' })
    expect(out[1]).toMatchObject({ author: AGENT_REPLY_AUTHOR, findingId: 'F3', body: 'Answer text' })
    expect(targetOf(ts[0])).toBe('F3')
  })

  it('ignores a thread whose root marker was pasted by another author', () => {
    const forged = thread(3, [human(10, 'Q?', 20)], 20)
    forged.root = { ...forged.root, author: 'Dev', authorIds: ['dev-1'] }
    expect(contextReplies([forged], who)).toEqual([])
  })
})
