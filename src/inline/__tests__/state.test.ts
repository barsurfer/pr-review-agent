import { describe, it, expect } from 'vitest'
import { withState, verify, sign, addCommit, canonical, splitState, MAX_COMMITS } from '../state.js'
import { SUMMARY_HEADER } from '../markers.js'

const AGENT = 'acc-1'
const above = `${SUMMARY_HEADER}\n\n## Summary\nAll fine.`
const c = (i: number) => i.toString(16).padStart(12, '0')

describe('state signature', () => {
  it('round-trips and verifies, including empty commits', () => {
    for (const commits of [[], [c(1), c(2)]]) {
      const body = withState(above, { n: 2, commits }, AGENT)
      expect(verify(body, AGENT)).toEqual({ n: 2, commits })
    }
  })

  it('rejects a different agent id', () => {
    expect(verify(withState(above, { n: 1, commits: [] }, AGENT), 'other')).toBeNull()
  })

  it('a one-character edit anywhere, header included, is a mismatch', () => {
    const body = withState(above, { n: 1, commits: [c(1)] }, AGENT)
    for (const i of [0, 5, body.indexOf('All'), body.indexOf('inline-summary') + 3]) {
      const edited = body.slice(0, i) + (body[i] === 'x' ? 'y' : 'x') + body.slice(i + 1)
      expect(verify(edited, AGENT)).toBeNull()
    }
    expect(verify(body.replace('n=1', 'n=2'), AGENT)).toBeNull()
  })

  it('CRLF does not change the signature, and a real content edit does', () => {
    const body = withState(above, { n: 1, commits: [c(1)] }, AGENT)
    expect(verify(body.replace(/\n/g, '\r\n'), AGENT)).not.toBeNull()
    expect(sign(above, { n: 1, commits: [] }, AGENT)).toBe(sign(above.replace(/\n/g, '\r\n') + '\n\n', { n: 1, commits: [] }, AGENT))
    expect(canonical('a  \r\nb\n\n')).toBe('a\nb')
    expect(splitState(body)!.state.n).toBe(1)
  })

  it('text below the state line breaks verification', () => {
    expect(verify(withState(above, { n: 1, commits: [] }, AGENT) + '\nextra', AGENT)).toBeNull()
  })
})

describe('addCommit', () => {
  it('appends, and A then B then A keeps both with A last', () => {
    let s = addCommit({ n: 1, commits: [] }, c(1))
    s = addCommit(s, c(2))
    s = addCommit(s, c(1))
    expect(s.commits).toEqual([c(2), c(1)])
  })

  it('caps at 1,000 and the capped state still verifies', () => {
    let s = { n: 1, commits: [] as string[] }
    for (let i = 0; i < MAX_COMMITS + 5; i++) s = addCommit(s, c(i))
    expect(s.commits).toHaveLength(MAX_COMMITS)
    expect(s.commits.at(-1)).toBe(c(MAX_COMMITS + 4))
    expect(s.commits[0]).toBe(c(5))
    expect(verify(withState(above, s, AGENT), AGENT)).toEqual(s)
  })
})
