// Python-Markdown 3.x fenced_code FENCED_BLOCK_RE and its replace loop: Bitbucket Cloud documents this renderer, which closes a fence only on the exact opener at column 0.
const FENCED_BLOCK = /^(~{3,}|`{3,})[ ]*(?:(\{[^\n]*\})|(\.?([\w#.+-]*)[ ]*)?(?:hl_lines=("|')(.*?)\5[ ]*)?)\n([\s\S]*?)(?<=\n)\1[ ]*$/m

export interface PmBlock { opener: string; code: string }

export function pmBlocks(text: string): { blocks: PmBlock[]; rest: string } {
  const blocks: PmBlock[] = []
  let rest = text
  for (;;) {
    const m = FENCED_BLOCK.exec(rest)
    if (!m) break
    blocks.push({ opener: m[0].slice(0, m[0].indexOf('\n')), code: m[7].replace(/\n$/, '') })
    rest = rest.slice(0, m.index) + `\u0002PH${blocks.length}\u0003` + rest.slice(m.index + m[0].length)
  }
  return { blocks, rest }
}
