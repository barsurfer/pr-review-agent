import { REVIEW_FOOTER_SOURCE, REPLY_FOOTER_SOURCE } from './formatter.js'
import { PROPOSAL_CAP, type RenderJudged } from './judge-decisions.js'
import type { KeptFinding } from './findings-output.js'

// Append-only like the footer: a format change ships suggested-fix-v2 and the strip keeps recognising every earlier version.
export const SUGGESTED_FIX_MARKER = 'suggested-fix-v1'
export const SUGGESTED_FIX_LABEL = '**Suggested fix:**'
export const COMMENT_BUDGET = 32_000
export const MAX_FENCE = 32
export const MAX_BLOCK_CHARS = `\n\n${SUGGESTED_FIX_LABEL}\n\n`.length + MAX_FENCE + SUGGESTED_FIX_MARKER.length + 1 + PROPOSAL_CAP + 1 + MAX_FENCE

export interface SuggestedFixStats {
  rendered: number
  rejected: number
  skipped?: 'cleanup' | 'unbalanced' | 'fence' | 'size'
}

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/
const BLOCK_OPENER = new RegExp(`^(\`{3,})${SUGGESTED_FIX_MARKER}$`)

// A fence line would mix prose and snippet, and a footer-shaped line copied into a reply would make it pass as an agent review.
export function fixCodeContent(proposal: string): string | null {
  const review = new RegExp(REVIEW_FOOTER_SOURCE)
  const reply = new RegExp(REPLY_FOOTER_SOURCE)
  for (const line of proposal.split('\n')) {
    if (FENCE_LINE.test(line)) return null
    const t = line.trim()
    if (review.test(t) || reply.test(t)) return null
  }
  return proposal
}

export const longestRun = (s: string): number => (s.match(/`+/g) ?? []).reduce((n, r) => Math.max(n, r.length), 0)

export const longestLeadingRun = (s: string): number => [...s.matchAll(/^[ \t]*(`+)/gm)].reduce((n, m) => Math.max(n, m[1].length), 0)

// Python-Markdown closes only on the exact opener fence, so a fence longer than every line-leading run in the review can never pair with a stray opener there.
export function fenceFor(code: string, plain: string): string {
  return '`'.repeat(Math.max(3, longestRun(code) + 1, longestLeadingRun(plain) + 1))
}

export function renderFixBlock(code: string, fence: string): string {
  return `\n\n${SUGGESTED_FIX_LABEL}\n\n${fence}${SUGGESTED_FIX_MARKER}\n${code}\n${fence}`
}

interface Fence { ch: string; len: number }
const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/
const indentOk = (ws: string, strict: boolean): boolean => !strict || /^ {0,3}$/.test(ws)

function stepFence(open: Fence | null, line: string, strict: boolean): Fence | null {
  if (open) {
    const c = FENCE_CLOSE.exec(line)
    return c && c[2][0] === open.ch && c[2].length >= open.len && indentOk(c[1], strict) ? null : open
  }
  const o = FENCE_OPEN.exec(line)
  if (!o || !indentOk(o[1], strict) || (o[2][0] === '`' && o[3].includes('`'))) return null
  return { ch: o[2][0], len: o[2].length }
}

// Open under either CommonMark reading (3-space indent limit, or any indent) counts: list nesting decides which one applies, and guessing wrong would swallow the block.
export function hasUnclosedFence(text: string): boolean {
  let loose: Fence | null = null
  let strict: Fence | null = null
  for (const line of text.split(/\r\n|\r|\n/)) {
    loose = stepFence(loose, line, false)
    strict = stepFence(strict, line, true)
  }
  return !!(loose || strict)
}

export function composeSuggestedFixes(kept: readonly KeptFinding[], renderWith: RenderJudged, plain: string, budget: number): { text: string; stats: SuggestedFixStats } {
  const fixes: Array<[number, string]> = []
  let rejected = 0
  kept.forEach((k, i) => {
    if (!k.proposal) return
    const code = fixCodeContent(k.proposal)
    if (code === null) rejected++
    else fixes.push([i, code])
  })
  const skip = (skipped: SuggestedFixStats['skipped']) => ({ text: plain, stats: { rendered: 0, rejected, skipped } })
  if (!fixes.length) return { text: plain, stats: { rendered: 0, rejected } }
  // Blocks are spliced into the judge's render, so any cleanup edit to that text would be silently undone.
  if (renderWith(new Map()) !== plain) return skip('cleanup')
  if (hasUnclosedFence(plain)) return skip('unbalanced')
  const suffixes = new Map<number, string>()
  for (const [i, code] of fixes) {
    const fence = fenceFor(code, plain)
    if (fence.length > MAX_FENCE) return skip('fence')
    suffixes.set(i, renderFixBlock(code, fence))
  }
  const text = renderWith(suffixes)
  if (text.length > budget) return skip('size')
  return { text, stats: { rendered: suffixes.size, rejected } }
}

// The first line that could close the opener under any reading must be the exact fence, so every renderer agrees where the block ends.
function blockClose(lines: readonly string[], starts: readonly number[], i: number, limit: number): number {
  if (lines[i + 1] !== '') return -1
  const open = BLOCK_OPENER.exec(lines[i + 2] ?? '')
  if (!open) return -1
  const fence = open[1]
  for (let j = i + 3; j < lines.length && starts[j] <= limit; j++) {
    const c = /^[ \t]*(`{3,})[ \t]*$/.exec(lines[j])
    if (c && c[1].length >= fence.length) return lines[j] === fence ? j : -1
  }
  return -1
}

// Removes only exact, bounded blocks outside every open fence, so a removal can neither eat surrounding text nor unbalance a fence around it.
export function stripSuggestedFixes(body: string): string {
  if (!body.includes(SUGGESTED_FIX_MARKER)) return body
  const text = body.replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const starts: number[] = []
  let offset = 0
  for (const l of lines) { starts.push(offset); offset += l.length + 1 }

  const cuts: Array<[number, number]> = []
  let loose: Fence | null = null
  let strict: Fence | null = null
  for (let i = 0; i < lines.length; i++) {
    if (!loose && !strict && lines[i] === SUGGESTED_FIX_LABEL && (i === 0 || lines[i - 1] === '')) {
      const from = Math.max(0, starts[i] - 2)
      const close = blockClose(lines, starts, i, from + MAX_BLOCK_CHARS)
      const to = close >= 0 ? starts[close] + lines[close].length : -1
      if (close >= 0 && to - from <= MAX_BLOCK_CHARS) {
        cuts.push([from, to])
        i = close
        continue
      }
    }
    loose = stepFence(loose, lines[i], false)
    strict = stepFence(strict, lines[i], true)
  }
  if (!cuts.length) return body
  let out = ''
  let at = 0
  for (const [from, to] of cuts) { out += text.slice(at, from); at = to }
  return out + text.slice(at)
}

// A footer counts only as the last line, so one a human quotes in a fence or mid-text does not mark the comment as the agent's.
export function stripOwnSuggestedFixes(body: string, footer: 'review' | 'reply'): string {
  if (!body.includes(SUGGESTED_FIX_MARKER)) return body
  const lines = body.replace(/\r\n?/g, '\n').trimEnd().split('\n')
  const last = lines[lines.length - 1].trimEnd()
  return new RegExp(footer === 'review' ? REVIEW_FOOTER_SOURCE : REPLY_FOOTER_SOURCE).test(last) ? stripSuggestedFixes(body) : body
}
