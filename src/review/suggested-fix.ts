import { REVIEW_FOOTER_SOURCE, REPLY_FOOTER_SOURCE, isNoChange, stripPreviousFooter, stripDeltaStats, stripJudgeNotes, stripJenkinsMeta } from './formatter.js'
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
  dropped?: number
  fix_free?: number
  skipped?: 'cleanup' | 'unbalanced' | 'fence' | 'size'
}

export type RenderFixFree = (suffixes: ReadonlyMap<number, string>, fixFree: ReadonlySet<number>) => string

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/
const BLOCK_OPENER = new RegExp(`^(\`{3,})${SUGGESTED_FIX_MARKER}$`)
// The footer parsers' /m regexes also start a line after CR, U+2028 and U+2029, so a footer-shaped line could hide behind one; no fix needs other controls.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/

// A fence line would mix prose and snippet, and a footer-shaped line copied into a reply would make it pass as an agent review.
export function fixCodeContent(proposal: string): string | null {
  if (UNSAFE_CHARS.test(proposal)) return null
  const review = new RegExp(REVIEW_FOOTER_SOURCE)
  const reply = new RegExp(REPLY_FOOTER_SOURCE)
  for (const line of proposal.split('\n')) {
    if (FENCE_LINE.test(line)) return null
    const t = line.trim()
    if (review.test(t) || reply.test(t)) return null
  }
  return proposal
}

// Spliced in after cleanup, so text that cleanup would have changed or skipped is refused; without fence lines it cannot pair with a fence elsewhere.
export function fixFreeContent(text: string): string | null {
  if (fixCodeContent(text) === null || isNoChange(text)) return null
  return stripJenkinsMeta(stripJudgeNotes(stripDeltaStats(stripPreviousFooter(text)))) === text ? text : null
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

// Python-Markdown 3.x fenced_code FENCED_BLOCK_RE split into its opener and closer lines: Bitbucket Cloud documents this renderer, which closes a fence only on the exact opener at column 0.
const PM_OPENER = /^(~{3,}|`{3,})[ ]*(?:(\{[^\n]*\})|(\.?([\w#.+-]*)[ ]*)?(?:hl_lines=("|')([\s\S]*?)\5[ ]*)?)$/
const PM_CLOSER = /^(~{3,}|`{3,})[ ]*$/

export interface PmBlock { opener: string; code: string }

// The regex's lazy search pairs an opener with the first exact closer after it and leaves an unpaired opener as text; one pass does the same without its quadratic rescans.
export function pmBlocks(text: string): { blocks: PmBlock[]; rest: string } {
  // Python-Markdown normalises CR first, and only \n ends its lines, not U+2028/U+2029 as in a JS /m regex.
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const closers = new Map<string, number[]>()
  lines.forEach((line, n) => {
    const fence = PM_CLOSER.exec(line)?.[1]
    if (!fence) return
    const at = closers.get(fence)
    if (at) at.push(n)
    else closers.set(fence, [n])
  })
  const next = new Map<string, number>()
  const firstCloserAfter = (fence: string, i: number): number | undefined => {
    const at = closers.get(fence) ?? []
    let p = next.get(fence) ?? 0
    while (p < at.length && at[p] <= i) p++
    next.set(fence, p)
    return at[p]
  }
  const blocks: PmBlock[] = []
  const rest: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const fence = PM_OPENER.exec(lines[i])?.[1]
    const close = fence === undefined ? undefined : firstCloserAfter(fence, i)
    if (close === undefined) {
      rest.push(lines[i])
      continue
    }
    blocks.push({ opener: lines[i], code: lines.slice(i + 1, close).join('\n') })
    rest.push(`\u0002PH${blocks.length}\u0003`)
    i = close
  }
  return { blocks, rest: rest.join('\n') }
}

// A model fence pair around a block turns it into code text that the strip then leaves in, so each block must strip out and render alone; render order may be permuted, hence sorted.
function blocksStandAlone(text: string, plain: string, codes: readonly string[]): boolean {
  if (stripSuggestedFixes(text) !== plain.replace(/\r\n?/g, '\n')) return false
  const own = pmBlocks(text).blocks.filter(b => b.opener.endsWith(SUGGESTED_FIX_MARKER)).map(b => b.code).sort()
  const want = [...codes].sort()
  return own.length === want.length && own.every((c, n) => c === want[n])
}

type Skip = NonNullable<SuggestedFixStats['skipped']>

// `base` is the block-free text the blocks go into: every check is made against it, so the strip must give it back exactly.
function placeBlocks(fixes: ReadonlyArray<[number, string]>, base: string, render: (suffixes: ReadonlyMap<number, string>) => string, budget: number): { text: string } | { skipped: Skip } {
  const suffixes = new Map<number, string>()
  for (const [i, code] of fixes) {
    const fence = fenceFor(code, base)
    if (fence.length > MAX_FENCE) return { skipped: 'fence' }
    suffixes.set(i, renderFixBlock(code, fence))
  }
  const text = render(suffixes)
  if (text.length > budget) return { skipped: 'size' }
  if (!blocksStandAlone(text, base, fixes.map(([, code]) => code))) return { skipped: 'unbalanced' }
  return { text }
}

export function composeSuggestedFixes(kept: readonly KeptFinding[], renderWith: RenderJudged, plain: string, budget: number, renderFixFree?: RenderFixFree): { text: string; stats: SuggestedFixStats } {
  const fixes: Array<[number, string]> = []
  let rejected = 0
  kept.forEach((k, i) => {
    if (!k.proposal) return
    // The strip's MAX_BLOCK_CHARS bound holds only for code within the cap, so it is not left to the sanitizer alone.
    const code = k.proposal.length <= PROPOSAL_CAP ? fixCodeContent(k.proposal) : null
    if (code === null) rejected++
    else fixes.push([i, code])
  })
  const skip = (skipped: SuggestedFixStats['skipped']) => ({ text: plain, stats: { rendered: 0, rejected, skipped } })
  if (!fixes.length) return { text: plain, stats: { rendered: 0, rejected } }
  // Blocks are spliced into the judge's render, so any cleanup edit to that text would be silently undone.
  if (renderWith(new Map()) !== plain) return skip('cleanup')
  if (hasUnclosedFence(plain)) return skip('unbalanced')
  // Only findings that get a block may drop their fix sentence; the identity render proves the closure is the cleaned text's.
  const fixFree = new Set(fixes.filter(([i]) => kept[i].bodyWithoutFix && fixFreeContent(kept[i].bodyWithoutFix!) !== null).map(([i]) => i))
  if (renderFixFree && fixFree.size && renderFixFree(new Map(), new Set()) === plain) {
    const base = renderFixFree(new Map(), fixFree)
    const placed = hasUnclosedFence(base) ? null : placeBlocks(fixes, base, s => renderFixFree(s, fixFree), budget)
    if (placed && 'text' in placed) return { text: placed.text, stats: { rendered: fixes.length, rejected, fix_free: fixFree.size } }
  }
  // A fix-free text that breaks a check falls back to the normal texts, so the blocks still post as they would without it.
  const placed = placeBlocks(fixes, plain, renderWith, budget)
  return 'text' in placed ? { text: placed.text, stats: { rendered: fixes.length, rejected } } : skip(placed.skipped)
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
