import { renderFinding, type RenderedFinding } from './formatter.js'

const RANK = new Map<string, number>([['HIGH', 0], ['MEDIUM', 1], ['LOW', 2]])

// A label the renderers never emit keeps its slot instead of being guessed into a level.
export function severityPermutation(findings: readonly RenderedFinding[]): number[] {
  const known = findings.flatMap((f, i) => (RANK.has(f.severity) ? [i] : []))
  const sorted = [...known].sort((a, b) => RANK.get(findings[a].severity)! - RANK.get(findings[b].severity)! || a - b)
  let next = 0
  return findings.map((f, i) => (RANK.has(f.severity) ? sorted[next++] : i))
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/

// CommonMark and Python-Markdown pair fences alike only when each opens with a bare language tag and closes on the identical fence line, nothing fence-shaped between.
export function fencesSelfContained(text: string): boolean {
  let open: string | undefined
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = FENCE.exec(line)
    if (!m) continue
    if (open === undefined) {
      if (!/^ *[\w#.+-]* *$/.test(m[3])) return false
      open = m[1] + m[2]
    } else if (line.startsWith(open) && /^ *$/.test(line.slice(open.length))) {
      open = undefined
    } else {
      return false
    }
  }
  return open === undefined
}

// Moving a finding is safe only if no fence can pair across findings, so the text before them and each finding must keep its fences to itself.
export function orderPosted(plain: string, findings: readonly RenderedFinding[], render: (order?: readonly number[]) => string): { text: string; order?: readonly number[] } {
  const order = severityPermutation(findings)
  if (order.every((from, to) => from === to)) return { text: plain }
  const chunks = findings.map(f => renderFinding(f))
  const block = chunks.join('\n\n')
  const at = plain.indexOf(block)
  const head = plain.slice(0, at)
  if (at < 0 || !fencesSelfContained(head) || !chunks.every(fencesSelfContained)) return { text: plain }
  const text = render(order)
  // Proof that the re-render is the cleaned text with only the findings permuted, so a cleanup edit anywhere leaves the text as is.
  if (text !== head + order.map(i => chunks[i]).join('\n\n') + plain.slice(at + block.length)) return { text: plain }
  return { text, order }
}
