import { LENS_REGISTRY, type SectionDef } from './lenses.js'

export interface SectionRow { text: string; body?: string }

export interface SectionBlock { lens: string; heading: string; legend: string; order: number; rows: SectionRow[]; more: number }

export interface RenderOpts { bodies?: boolean; maxRows?: number; count?: boolean }

const headingWord = (b: Pick<SectionBlock, 'heading'>): string => b.heading.replace(/^#+\s*/, '')

const MORE_RE = /^- and (\d+) more .+ items$/
const COUNT_RE = /^- (\d+) .+ items; list omitted to fit the size limit$/

export function renderBlock(b: SectionBlock, o: RenderOpts = {}): string {
  const head = `${b.heading}\n${b.legend}`
  if (o.count) return `${head}\n\n- ${b.rows.length + b.more} ${headingWord(b)} items; list omitted to fit the size limit`
  const shown = b.rows.slice(0, o.maxRows ?? Infinity)
  const hidden = b.rows.length - shown.length + b.more
  const lines = shown.map(r => (o.bodies === false || !r.body ? r.text : `${r.text}\n  ${r.body}`))
  if (hidden > 0) lines.push(`- and ${hidden} more ${headingWord(b)} items`)
  return `${head}\n\n${lines.join('\n')}`
}

export const renderBlocks = (blocks: readonly SectionBlock[], o: RenderOpts = {}): string =>
  blocks.filter(b => b.rows.length + b.more > 0).map(b => renderBlock(b, o)).join('\n\n')

export const sectionDefs = (): Array<{ lens: string; def: SectionDef }> =>
  Object.values(LENS_REGISTRY).map(l => ({ lens: l.name, def: l.section }))

interface Scanned { block: SectionBlock; from: number; to: number }

// Heading plus its exact legend is the recognition key, so a narrative line that merely looks like a heading is never taken for a block.
function scan(lines: readonly string[]): Scanned[] {
  const defs = sectionDefs()
  const out: Scanned[] = []
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]*(`{3,}|~{3,})/.test(lines[i])) { fenced = !fenced; continue }
    if (fenced) continue
    const t = lines[i].trimEnd()
    const hit = defs.find(d => d.def.heading === t)
    if (!hit) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    if (j >= lines.length || lines[j].trimEnd() !== hit.def.legend) continue
    const rows: SectionRow[] = []
    let more = 0
    let end = j + 1
    for (let k = j + 1; k < lines.length; k++) {
      const line = lines[k].trimEnd()
      if (line.trim() === '') continue
      if (/^- /.test(line)) {
        const m = MORE_RE.exec(line) ?? COUNT_RE.exec(line)
        if (m) more += Number(m[1])
        else rows.push({ text: line })
      } else if (/^[ \t]+\S/.test(line) && rows.length) {
        const last = rows[rows.length - 1]
        last.body = last.body ? `${last.body} ${line.trim()}` : line.trim()
      } else break
      end = k + 1
    }
    out.push({ block: { lens: hit.lens, heading: hit.def.heading, legend: hit.def.legend, order: hit.def.order, rows, more }, from: i, to: end })
    i = end - 1
  }
  return out
}

const split = (body: string): string[] => body.replace(/\r\n/g, '\n').split('\n')

export const parseSectionBlocks = (body: string): SectionBlock[] => scan(split(body)).map(s => s.block)

// Line indexes belonging to recognized blocks, so a carried narrative can leave them out and the run regenerates its own.
export function sectionLineRanges(body: string): Array<[number, number]> {
  return scan(split(body)).map(s => [s.from, s.to])
}

const FOOTER_LINE = /^\*Reviewed by .+\*$/

// Only an agent review (its footer is the last line) is stripped, and a body with no block comes back as the same string.
export function stripOwnSections(body: string): string {
  const lines = split(body)
  const last = [...lines].reverse().find(l => l.trim() !== '')
  if (!last || !FOOTER_LINE.test(last.trimEnd())) return body
  const found = scan(lines)
  if (!found.length) return body
  const drop = new Set<number>()
  for (const s of found) {
    let to = s.to
    while (to < lines.length && lines[to].trim() === '') to++
    for (let i = s.from; i < to; i++) drop.add(i)
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n')
}
