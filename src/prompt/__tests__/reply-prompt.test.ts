import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
const getReplyPrompt = (): string => readFileSync(new URL('../reply-prompt.txt', import.meta.url), 'utf-8')

const frozen = readFileSync(new URL('../../__tests__/__fixtures__/identity-v0061/reply-prompt-v0061.txt', import.meta.url), 'utf-8').replace(/\r\n/g, '\n')
const now = getReplyPrompt().replace(/\r\n/g, '\n')
const section = (text: string, from: string, to?: string): string => {
  const start = text.indexOf(from)
  const end = to ? text.indexOf(to, start) : text.length
  return text.slice(start, end)
}

describe('reply prompt', () => {
  it('has the eight dispute bullets', () => {
    const block = section(now, 'When a developer disputes or questions a finding:', 'Format rules:')
    const bullets = block.split('\n').filter(l => l.startsWith('- '))
    expect(bullets).toHaveLength(8)
    expect(bullets[0]).toContain('A concrete fact names a specific place')
    expect(bullets[1]).toContain('A stated intent')
    expect(bullets[2]).toContain('A dismissal, a vague objection')
    expect(bullets[3]).toContain('Do not accept a claim the diff contradicts')
    expect(bullets[4]).toContain('without stating it')
    expect(bullets[5]).toContain('only the developer can know')
    expect(bullets[6]).toContain('Otherwise do not ask questions back')
    expect(bullets[7]).toContain('a later commit fixed it')
  })

  it('drops the old open-ended-question rule and the old intent-as-fact rule', () => {
    expect(now).not.toContain('Do not ask open-ended questions back.')
    expect(now).not.toContain('A stated intent or requirement is also a fact')
  })

  it('keeps SCOPE LOCK and the Format rules byte-equal to v0.0.61', () => {
    expect(section(now, 'SCOPE LOCK:', 'Your job:')).toBe(section(frozen, 'SCOPE LOCK:', 'Your job:'))
    expect(section(now, 'Format rules:')).toBe(section(frozen, 'Format rules:'))
  })

  it('is LF only', () => {
    expect(getReplyPrompt()).not.toContain('\r')
  })
})

describe('reply prompt concision and dismissal wording', () => {
  it('adds the concise bullet right after the short-and-direct bullet', () => {
    const job = section(now, 'Your job:', 'When a developer disputes')
    const bullets = job.split('\n').filter(l => l.startsWith('- '))
    const at = bullets.findIndex(l => l.startsWith('- Keep answers short and direct'))
    expect(bullets[at + 1]).toBe('- Be concise: at most three short sentences. State facts (the line, the condition, what happens), not explanations, and do not repeat what an earlier answer in this thread already said. No filler, hedges or softeners.')
  })

  it('uses the corrected disagreement phrase in a single dismissal bullet', () => {
    expect(now).toContain('Write "You may see it differently, but I disagree", restate the evidence in one sentence, and keep the finding.')
    expect(now).not.toContain('Say that they may see it differently')
    expect(now).toContain('"it\'s handled elsewhere" without naming where')
    expect(now.split('\n').filter(l => l.includes('"nonsense"'))).toHaveLength(1)
  })
})
