import { createHash } from 'crypto'
import { buildStateLine, parseStateLine, lastNonEmptyLine } from './markers.js'
import type { SummaryState } from './types.js'

export const MAX_COMMITS = 1000

// CRLF, trailing spaces and trailing blank lines must not change the signature.
export function canonical(above: string): string {
  return above.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').replace(/\n+$/, '')
}

const payload = (s: SummaryState): string => `n=${s.n}|commits=${s.commits.join(',')}`

export function sign(above: string, s: SummaryState, agentId: string): string {
  return createHash('sha256').update(`${canonical(above)}\n${payload(s)}\n${agentId}`).digest('hex').slice(0, 16)
}

export function withState(above: string, s: SummaryState, agentId: string): string {
  return `${canonical(above)}\n\n${buildStateLine(s.n, s.commits, sign(above, s, agentId))}`
}

export function splitState(body: string): { above: string; state: { n: number; commits: string[]; sig: string } } | null {
  const last = lastNonEmptyLine(body)
  const state = parseStateLine(last)
  if (!state) return null
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  let i = lines.length - 1
  while (i >= 0 && lines[i].trim() === '') i--
  return { above: lines.slice(0, i).join('\n'), state }
}

export function verify(body: string, agentId: string): SummaryState | null {
  const split = splitState(body)
  if (!split) return null
  const s: SummaryState = { n: split.state.n, commits: split.state.commits }
  return sign(split.above, s, agentId) === split.state.sig ? s : null
}

// A commit seen again moves to the end, and only the newest MAX_COMMITS are kept.
export function addCommit(s: SummaryState, c12: string): SummaryState {
  const commits = [...s.commits.filter(c => c !== c12), c12]
  return { n: s.n, commits: commits.slice(-MAX_COMMITS) }
}
