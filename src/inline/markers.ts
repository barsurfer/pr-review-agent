import { REVIEW_FOOTER_SOURCE, REPLY_FOOTER_SOURCE } from '../review/formatter.js'

export const SUMMARY_HEADER_LINE = '### Review summary'
export const SUMMARY_HEADER_TAG = '*inline-summary v1 | maintained by the review agent*'
export const SUMMARY_HEADER = `${SUMMARY_HEADER_LINE}\n${SUMMARY_HEADER_TAG}`

const ID = 'F[1-9][0-9]{0,5}'
export const ROOT_RE = new RegExp(String.raw`^\*Finding (${ID}) \| opened at ([0-9a-f]{12})\*$`)
export const ANSWER_RE = new RegExp(String.raw`^\*Answer on (${ID}|summary) \| through ([A-Za-z0-9:_-]{1,64})\*$`)
export const NOTE_RE = new RegExp(String.raw`^\*Replies paused on (${ID}|summary)\*$`)
export const STATE_RE = /^\*inline-state v1 \| n=([1-9][0-9]{0,5}) \| commits=((?:[0-9a-f]{12}(?:,[0-9a-f]{12}){0,999})?) \| sig=([0-9a-f]{16})\*$/

export const buildRootMarker = (id: string, c12: string): string => `*Finding ${id} | opened at ${c12}*`
export const buildAnswerMarker = (target: string, through: string): string => `*Answer on ${target} | through ${through}*`
export const buildNoteMarker = (target: string): string => `*Replies paused on ${target}*`
export const buildStateLine = (n: number, commits: readonly string[], sig: string): string => `*inline-state v1 | n=${n} | commits=${commits.join(',')} | sig=${sig}*`

// Leading whitespace is kept on purpose: an indented or quoted marker must not match.
export function lastNonEmptyLine(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim() !== '') return lines[i].trimEnd()
  return ''
}

export function parseRootMarker(body: string): { id: string; openedAt: string } | null {
  const m = ROOT_RE.exec(lastNonEmptyLine(body))
  return m ? { id: m[1], openedAt: m[2] } : null
}

export function parseAnswerMarker(body: string): { target: string; through: string } | null {
  const m = ANSWER_RE.exec(lastNonEmptyLine(body))
  return m ? { target: m[1], through: m[2] } : null
}

export function parseNoteMarker(body: string): { target: string } | null {
  const m = NOTE_RE.exec(lastNonEmptyLine(body))
  return m ? { target: m[1] } : null
}

export function parseStateLine(line: string): { n: number; commits: string[]; sig: string } | null {
  const m = STATE_RE.exec(line)
  return m ? { n: Number(m[1]), commits: m[2] ? m[2].split(',') : [], sig: m[3] } : null
}

const GENERATED_LINE: RegExp[] = [
  new RegExp(REVIEW_FOOTER_SOURCE), new RegExp(REPLY_FOOTER_SOURCE), ROOT_RE, ANSWER_RE, NOTE_RE, STATE_RE,
]

// Model text must never forge a footer or marker line, so each one is dropped and counted.
export function stripGeneratedFooters(text: string): { text: string; removed: number } {
  let removed = 0
  const kept = text.replace(/\r\n/g, '\n').split('\n').filter(line => {
    const t = line.trimEnd()
    if (GENERATED_LINE.some(re => re.test(t))) { removed++; return false }
    return true
  })
  return { text: kept.join('\n').trimEnd(), removed }
}
