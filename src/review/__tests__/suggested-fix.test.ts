import { describe, it, expect } from 'vitest'
import {
  SUGGESTED_FIX_MARKER, MAX_BLOCK_CHARS, MAX_FENCE, fixCodeContent, fenceFor, hasUnclosedFence, renderFixBlock,
  composeSuggestedFixes, stripSuggestedFixes, stripOwnSuggestedFixes,
} from '../suggested-fix.js'
import { sanitizeCodeProposal, sanitizeProposal, renderJudgedReview, PROPOSAL_CAP, type JudgeOutput } from '../judge-decisions.js'
import { renderReview, buildReviewFooter, buildReplyFooter, type ReviewObject } from '../formatter.js'
import type { KeptFinding } from '../findings-output.js'
import { pmBlocks } from './helpers/pm-fences.js'

const OUT: JudgeOutput = { decisions: [], summary: 'Adds a pool.', behavioral_diff: ['x'], production_risk: [], unresolved_questions: [], merge_confidence: 70 }
const kept = (over: Partial<KeptFinding> = {}): KeptFinding => ({ severity: 'MEDIUM', title: 'Leak', body: 'Leaks the client.', file: 'src/a.ts', lines: '2', ...over })
const renderWithFor = (rows: KeptFinding[]) => (s: ReadonlyMap<number, string>) => renderJudgedReview(rows, OUT, [], [], s)
const REVIEW_FOOTER = buildReviewFooter('bot', 'm', 'repo', 2, 'aaa111222333', '919a10b')
const REVIEW_FOOTER_LINKED = buildReviewFooter('bot', 'm', 'repo', 2, 'aaa111222333', '919a10b', 'https://ci.example/job/7')
const REPLY_FOOTER = buildReplyFooter('bot', 'm')
const REPLY_FOOTER_LINE = '*Reply by bot (m)*'
const S = (code: string, fence = '```') => renderFixBlock(code, fence)

describe('sanitizeCodeProposal', () => {
  it('rejects non-strings and blank strings', () => {
    for (const v of [undefined, null, 5, {}, '', '  \n\t\n']) expect(sanitizeCodeProposal(v)).toBeUndefined()
  })

  it('dedents absolutely indented code and keeps relative indentation exactly (Python, YAML)', () => {
    expect(sanitizeCodeProposal('        if x:\n            y()\n        else:\n            z()')).toBe('if x:\n    y()\nelse:\n    z()')
    expect(sanitizeCodeProposal('    steps:\n      - run: a\n      - run: b')).toBe('steps:\n  - run: a\n  - run: b')
  })

  it('keeps the first line aligned with the rest, where the prose sanitizer trims it out of line', () => {
    const raw = '    try {\n      x()\n    } finally {'
    expect(sanitizeCodeProposal(raw)).toBe('try {\n  x()\n} finally {')
    expect(sanitizeProposal(raw)).toBe('try {\n      x()\n    } finally {')
  })

  it('drops leading and trailing blank lines and empties whitespace-only inner lines', () => {
    expect(sanitizeCodeProposal('\n\n  a()\n     \n  b()\n\n  ')).toBe('a()\n\nb()')
  })

  it('removes only the common prefix of tabs and spaces', () => {
    expect(sanitizeCodeProposal('\t\ta()\n\t\t\tb()')).toBe('a()\n\tb()')
    expect(sanitizeCodeProposal('  \ta()\n  b()')).toBe('\ta()\nb()')
  })

  it('unwraps one outer ``` or ~~~ fence, info string and indentation included', () => {
    expect(sanitizeCodeProposal('```ts\n    a()\n    b()\n```')).toBe('a()\nb()')
    expect(sanitizeCodeProposal('  ~~~python\n  if x:\n      y()\n  ~~~\n')).toBe('if x:\n    y()')
    expect(sanitizeCodeProposal('```\na()\n````')).toBe('```\na()\n````')
  })

  it('normalises CRLF and lone CR', () => {
    expect(sanitizeCodeProposal('  a()\r\n    b()\r\n')).toBe('a()\n  b()')
    expect(sanitizeCodeProposal('  a()\r    b()')).toBe('a()\n  b()')
  })

  it('caps at PROPOSAL_CAP chars and 7 lines in total, blank lines included', () => {
    expect(sanitizeCodeProposal('x'.repeat(PROPOSAL_CAP))).toHaveLength(PROPOSAL_CAP)
    expect(sanitizeCodeProposal('x'.repeat(PROPOSAL_CAP + 1))).toBeUndefined()
    expect(sanitizeCodeProposal(Array.from({ length: 7 }, (_, i) => `l${i}()`).join('\n'))).toBeDefined()
    expect(sanitizeCodeProposal(Array.from({ length: 8 }, (_, i) => `l${i}()`).join('\n'))).toBeUndefined()
    expect(sanitizeCodeProposal('a()\n\n\n\n\n\n\nb()')).toBeUndefined()
    expect(sanitizeCodeProposal('x' + '\n'.repeat(498) + 'y')).toBeUndefined()
  })
})

describe('fixCodeContent', () => {
  it('passes plain code, inline backticks and harmless markdown through', () => {
    for (const code of ['fix()', 'const s = "```"', 'Commit: abc123\nNO_CHANGE\n- **HIGH – x**\n### Summary\n---']) expect(fixCodeContent(code)).toBe(code)
  })

  it('rejects any fence line (mixed prose and snippet)', () => {
    for (const code of ['Do it:\n```ts\nfix()\n```', 'a()\n  ~~~\nb()', '````']) expect(fixCodeContent(code)).toBeNull()
  })

  it('rejects a review- or reply-footer line, trimmed, so a copied block cannot pass as an agent comment', () => {
    for (const line of [
      '*Reviewed by bot (m) | Prompt: p | Review #1 | Commit: deadbeef0000*',
      '   *Reviewed by bot (m) | Prompt: p | [Review #1](http://x) | Commit: deadbeef0000 | Build: 1a*  ',
      REPLY_FOOTER_LINE,
      '*[Reply by bot (m)](http://ci/1)*',
    ]) expect(fixCodeContent(`a()\n${line}`)).toBeNull()
  })
})

describe('fenceFor', () => {
  it('is longer than any backtick run in the code: 0/3/5 → 3/4/6', () => {
    expect(fenceFor('fix()', '')).toBe('```')
    expect(fenceFor('s = "```"', '')).toBe('````')
    expect(fenceFor('s = "`````"', '')).toBe('``````')
  })

  it('is longer than any line-leading backtick run in the review, indented or not', () => {
    expect(fenceFor('fix()', 'x\n````\ny')).toBe('`````')
    expect(fenceFor('fix()', 'x\n  ````ts\ny')).toBe('`````')
    expect(fenceFor('fix()', 'x ```` inline')).toBe('```')
  })
})

describe('hasUnclosedFence', () => {
  it('closed, unclosed, tilde, longer closer, wrong closer', () => {
    expect(hasUnclosedFence('a\n```ts\nx\n```\nb')).toBe(false)
    expect(hasUnclosedFence('a\n```ts\nx')).toBe(true)
    expect(hasUnclosedFence('~~~\nx\n~~~')).toBe(false)
    expect(hasUnclosedFence('~~~\nx\n```')).toBe(true)
    expect(hasUnclosedFence('```\nx\n````')).toBe(false)
    expect(hasUnclosedFence('````\nx\n```')).toBe(true)
  })

  it('a backtick info string holding a backtick is not an opener', () => {
    expect(hasUnclosedFence('```inline``` text')).toBe(false)
  })

  it('counts a fence as open when only a 4-space-indented closer follows (CommonMark keeps it open)', () => {
    expect(hasUnclosedFence('```\nx\n    ```')).toBe(true)
    expect(hasUnclosedFence('```\nx\n  ```')).toBe(false)
  })
})

describe('renderFixBlock and the posted form', () => {
  it('renders the label, a blank line and a column-0 fence with the marker info string', () => {
    expect(renderFixBlock('fix()', '````')).toBe('\n\n**Suggested fix:**\n\n````suggested-fix-v1\nfix()\n````')
  })

  it('matches the spec literal: block under its finding, next finding starts a new list', () => {
    const rows = [
      kept({ severity: 'HIGH', title: 'Client leaked on query error', file: 'src/db/pool.ts', lines: '42-47', body: '`client.release()` is skipped when `query` throws, so the pool drains. Release in `finally`.', proposal: 'try {\n  return await client.query(sql, params)\n} finally {\n  client.release()\n}' }),
      kept({ title: 'Missing await on save', file: 'src/user.ts', lines: '88', body: '`repo.save(user)` is not awaited, so write errors are swallowed.' }),
    ]
    const renderWith = renderWithFor(rows)
    const { text, stats } = composeSuggestedFixes(rows, renderWith, renderWith(new Map()), 32_000)
    expect(stats).toEqual({ rendered: 1, rejected: 0 })
    expect(text).toContain([
      '- **HIGH – Client leaked on query error** (`src/db/pool.ts:42-47`)',
      '  `client.release()` is skipped when `query` throws, so the pool drains. Release in `finally`.',
      '',
      '**Suggested fix:**',
      '',
      '```suggested-fix-v1',
      'try {',
      '  return await client.query(sql, params)',
      '} finally {',
      '  client.release()',
      '}',
      '```',
      '',
      '- **MEDIUM – Missing await on save** (`src/user.ts:88`)',
      '  `repo.save(user)` is not awaited, so write errors are swallowed.',
    ].join('\n'))
  })
})

describe('Python-Markdown fence pairing', () => {
  const obj = (body: string): ReviewObject => ({
    summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [],
    findings: [{ severity: 'HIGH', title: 'x', file: 'a.ts', lines: '1', body }, { severity: 'LOW', title: 'y', file: 'a.ts', lines: '2', body: 'b2' }],
  })
  const BODIES: Record<string, string> = {
    clean: 'body',
    indentedCloser: 'see\n```ts\ncode\n  ```',
    twoWordInfo: 'see\n```ts title="a"\ncode\n```',
    longerCloser: 'see\n```\ncode\n````',
  }
  const withBlock = (body: string, fence: string) => renderReview(obj(body), { suffix: i => (i === 0 ? renderFixBlock('fix()', fence) : '') })

  for (const [name, body] of Object.entries(BODIES)) {
    it(`${name}: the block renders alone, the label outside every code block`, () => {
      const plain = renderReview(obj(body))
      expect(hasUnclosedFence(plain)).toBe(false)
      const fence = fenceFor('fix()', plain)
      const { blocks, rest } = pmBlocks(withBlock(body, fence))
      expect(blocks).toEqual([{ opener: `${fence}${SUGGESTED_FIX_MARKER}`, code: 'fix()' }])
      expect(rest).toContain('\n**Suggested fix:**\n')
    })
  }

  it('control: a plain 3-backtick fence lets the stray opener swallow the label', () => {
    const { rest } = pmBlocks(withBlock(BODIES.indentedCloser, '```'))
    expect(rest).not.toContain('**Suggested fix:**')
  })
})

describe('composeSuggestedFixes', () => {
  const rows = [
    kept({ title: 'A', proposal: 'fix()' }),
    kept({ title: 'B', proposal: 'a()\n```\nb()' }),
    kept({ title: 'C', proposal: `a()\n${REPLY_FOOTER_LINE}` }),
    kept({ title: 'D' }),
  ]
  const renderWith = renderWithFor(rows)
  const plain = renderWith(new Map())

  it('renders usable proposals under their own finding and counts the rejected ones', () => {
    const { text, stats } = composeSuggestedFixes(rows, renderWith, plain, 32_000)
    expect(stats).toEqual({ rendered: 1, rejected: 2 })
    expect(text).toBe(plain.replace('Leaks the client.\n\n- **MEDIUM – B**', `Leaks the client.${S('fix()')}\n\n- **MEDIUM – B**`))
  })

  it('no proposals: the plain text and no skip', () => {
    const none = [kept()]
    const r = composeSuggestedFixes(none, renderWithFor(none), renderWithFor(none)(new Map()), 32_000)
    expect(r).toEqual({ text: renderWithFor(none)(new Map()), stats: { rendered: 0, rejected: 0 } })
  })

  it('size: one char over the budget drops every block; at the budget they render', () => {
    const full = composeSuggestedFixes(rows, renderWith, plain, 32_000).text
    expect(composeSuggestedFixes(rows, renderWith, plain, full.length - 1)).toEqual({ text: plain, stats: { rendered: 0, rejected: 2, skipped: 'size' } })
    expect(composeSuggestedFixes(rows, renderWith, plain, full.length).text).toBe(full)
  })

  it('unbalanced: an unclosed fence in the review drops every block', () => {
    const open = [kept({ body: 'see\n```ts\ncode', proposal: 'fix()' })]
    const r = composeSuggestedFixes(open, renderWithFor(open), renderWithFor(open)(new Map()), 32_000)
    expect(r.stats).toEqual({ rendered: 0, rejected: 0, skipped: 'unbalanced' })
  })

  it('fence: a proposal that needs a fence over MAX_FENCE drops every block', () => {
    const long = [kept({ proposal: 'fix()' }), kept({ title: 'E', proposal: `s = "${'`'.repeat(MAX_FENCE)}"` })]
    const r = composeSuggestedFixes(long, renderWithFor(long), renderWithFor(long)(new Map()), 32_000)
    expect(r.stats).toEqual({ rendered: 0, rejected: 0, skipped: 'fence' })
  })

  it('cleanup: text that differs from the judge render drops every block', () => {
    const cleaned = plain.replace('### Summary', '### Summary ')
    expect(composeSuggestedFixes(rows, renderWith, cleaned, 32_000)).toEqual({ text: cleaned, stats: { rendered: 0, rejected: 2, skipped: 'cleanup' } })
  })
})

describe('stripSuggestedFixes', () => {
  const rows = [kept({ title: 'A', proposal: 'fix()' }), kept({ title: 'B', proposal: '  if x:\n      y()' }), kept({ title: 'C', proposal: 'z()' })]
  const renderWith = renderWithFor(rows)
  const plain = renderWith(new Map())
  const posted = composeSuggestedFixes(rows, renderWith, plain, 32_000).text

  it('round trip: stripping the rendered review returns the plain review byte for byte (several blocks)', () => {
    expect(posted.split(SUGGESTED_FIX_MARKER)).toHaveLength(4)
    expect(stripSuggestedFixes(posted)).toBe(plain)
    expect(stripSuggestedFixes(posted + REVIEW_FOOTER)).toBe(plain + REVIEW_FOOTER)
  })

  it('consumes a forged label and marker inside the code together with the real block', () => {
    const code = 'a()\n**Suggested fix:**\n\n```suggested-fix-v1\nb()\n```'
    const body = `x${S(code, fenceFor(code, 'x'))}\n\ny`
    expect(stripSuggestedFixes(body)).toBe('x\n\ny')
  })

  it('CRLF on read-back: matches and returns LF text', () => {
    expect(stripSuggestedFixes((posted + REVIEW_FOOTER).replace(/\n/g, '\r\n'))).toBe(plain + REVIEW_FOOTER)
  })

  it('a block at the very start of the body is removed', () => {
    expect(stripSuggestedFixes(S('x()').slice(2) + '\n\nThat compiles.' + REPLY_FOOTER)).toBe('\n\nThat compiles.' + REPLY_FOOTER)
  })

  it('the largest renderable block (500-char code, 32-backtick fence) strips; one char more does not', () => {
    const code = `x = "${'`'.repeat(MAX_FENCE - 1)}"` + 'y'.repeat(PROPOSAL_CAP - MAX_FENCE - 5)
    expect(code).toHaveLength(PROPOSAL_CAP)
    const fence = fenceFor(code, 'p')
    expect(fence).toHaveLength(MAX_FENCE)
    expect(S(code, fence)).toHaveLength(MAX_BLOCK_CHARS)
    expect(stripSuggestedFixes(`p${S(code, fence)}`)).toBe('p')
    const over = `p${S(code + 'y', fence)}`
    expect(stripSuggestedFixes(over)).toBe(over)
  })

  it('leaves partial and malformed shapes untouched', () => {
    for (const body of [
      'a\n\n**Suggested fix:**\n\n```ts\nfix() // suggested-fix-v1\n```',
      'a\n\n```suggested-fix-v1\nfix()\n```',
      'a\n\n**Suggested fix:**\n\n```suggested-fix-v1\nfix()',
      'a\n**Suggested fix:**\n\n```suggested-fix-v1\nfix()\n```',
      'a\n\n**Suggested fix:**\n```suggested-fix-v1\nfix()\n```',
      'a\n\n**Suggested fix:**\n\n```suggested-fix-v1 extra\nfix()\n```',
      'a\n\n**Suggested fix:**\n\n```suggested-fix-v1\nfix()\n````\n```',
      'a\n\n**Suggested fix:**\n\n```suggested-fix-v1\nfix()\n  ```\n```',
    ]) expect(stripSuggestedFixes(body)).toBe(body)
  })

  it('never strips inside another open fence: the tilde-fence example comes back unchanged', () => {
    const body = 'Intro\n~~~text\n\n**Suggested fix:**\n\n```suggested-fix-v1\nbad()\n~~~\n\nOther example:\n```\ngood()\n```'
    expect(stripSuggestedFixes(body)).toBe(body)
    expect(stripOwnSuggestedFixes(body + REPLY_FOOTER, 'reply')).toBe(body + REPLY_FOOTER)
  })

  it('never strips after a closer CommonMark ignores (4-space indent), nor inside a backtick fence', () => {
    for (const body of [
      `\`\`\`\nfoo\n    \`\`\`${S('x()', '````')}`,
      `\`\`\`${S('x()', '````')}\n\`\`\``,
    ]) expect(stripSuggestedFixes(body)).toBe(body)
  })

  it('keeps every fence outside the removed block, so nothing is left dangling', () => {
    const fences = (s: string) => s.split('\n').filter(l => /^[ \t]*(`{3,}|~{3,})/.test(l))
    const before = 'Before:\n```ts\na()\n```'
    const after = '\n\nAfter:\n~~~\nb()\n~~~'
    const stripped = stripSuggestedFixes(before + S('fix()', '````') + after)
    expect(stripped).toBe(before + after)
    expect(fences(stripped)).toEqual(fences(before + after))
    expect(hasUnclosedFence(stripped)).toBe(false)
  })

  it('an oversize match is refused', () => {
    const body = `a${S('x'.repeat(MAX_BLOCK_CHARS))}`
    expect(stripSuggestedFixes(body)).toBe(body)
  })
})

describe('stripOwnSuggestedFixes (authorship by last-line footer)', () => {
  it('strips an agent review and an agent reply whose footer is the last non-empty line', () => {
    expect(stripOwnSuggestedFixes(`R${S('x()')}${REVIEW_FOOTER}\n\n`, 'review')).toBe(`R${REVIEW_FOOTER}\n\n`)
    expect(stripOwnSuggestedFixes(`R${S('x()')}${REVIEW_FOOTER_LINKED}`, 'review')).toBe(`R${REVIEW_FOOTER_LINKED}`)
    expect(stripOwnSuggestedFixes(`Answer.${S('x()')}${REPLY_FOOTER}`, 'reply')).toBe(`Answer.${REPLY_FOOTER}`)
    expect(stripOwnSuggestedFixes(`Answer.${S('x()')}${buildReplyFooter('bot', 'm', 'http://ci/1')}`, 'reply')).toBe(`Answer.${buildReplyFooter('bot', 'm', 'http://ci/1')}`)
  })

  it('a human reply quoting an agent reply footer inside a fence after a block is untouched', () => {
    const human = 'Please retain this workaround:' + S('await rollback()') + '\n\n```text\n' + REPLY_FOOTER_LINE + '\n```'
    expect(stripOwnSuggestedFixes(human, 'reply')).toBe(human)
  })

  it('a human reply without any footer is untouched, including a truncated copy before a later fence', () => {
    const copy = 'Your fix:\n\n**Suggested fix:**\n\n```suggested-fix-v1\nfoo()\n\nIt does not compile. I did this instead:\n```ts\nbar()\n```\nThanks'
    expect(stripOwnSuggestedFixes(copy, 'reply')).toBe(copy)
    expect(stripOwnSuggestedFixes(`Thanks${S('x()')}`, 'reply')).toBe(`Thanks${S('x()')}`)
  })

  it('the same truncated copy in agent text loses at most one bounded span, up to the next equal bare fence', () => {
    const copy = 'Your fix:\n\n**Suggested fix:**\n\n```suggested-fix-v1\nfoo()\n\nIt does not compile. I did this instead:\n```ts\nbar()\n```\nThanks'
    expect(stripOwnSuggestedFixes(copy + REPLY_FOOTER, 'reply')).toBe('Your fix:\nThanks' + REPLY_FOOTER)
  })

  it('the footer kind must match: a review footer does not mark a reply, nor a reply footer a review', () => {
    const asReply = `R${S('x()')}${REVIEW_FOOTER}`
    const asReview = `R${S('x()')}${REPLY_FOOTER}`
    expect(stripOwnSuggestedFixes(asReply, 'reply')).toBe(asReply)
    expect(stripOwnSuggestedFixes(asReview, 'review')).toBe(asReview)
  })

  it('a footer that is not the last line does not count', () => {
    const tail = `R${S('x()')}${REVIEW_FOOTER}\n<!-- jenkins: job -->`
    expect(stripOwnSuggestedFixes(tail, 'review')).toBe(tail)
  })
})

describe('strip is the identity on bodies without the marker (same string object)', () => {
  const rv = (findings: ReviewObject['findings']): ReviewObject => ({ summary: 'ok', findings, behavioral_diff: ['b'], production_risk: [], unresolved_questions: ['q?'] })
  const f = (body: string): ReviewObject['findings'][number] => ({ severity: 'MEDIUM', title: 't', file: 'a.ts', lines: '1', body })
  const CLEAN_PRIOR = '### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.'
  const FLAGGED_PRIOR = '### Summary\nOne issue.\n\n### Findings\n- **MEDIUM – Prior issue** (`a.ts:1`)\n  desc\n\n### Unresolved Questions\nNone.'
  const legacyFooter = '\n\n---\n*Reviewed by test-bot (claude-haiku-4-5-20251001) | Prompt: repo | Review #1 | Commit: aabbcc112233*'
  const judged = renderJudgedReview([kept({ body: 'Uses **Suggested fix:** wording\n```ts\nx()\n```' })], OUT)
  const reviews = [
    CLEAN_PRIOR + legacyFooter, FLAGGED_PRIOR + legacyFooter,
    renderReview(rv([f('see\n```ts\nfix()\n```'), f('unclosed\n```ts\nx')])) + REVIEW_FOOTER,
    judged + REVIEW_FOOTER, judged + '\n\n### TODOs Introduced\n- `a.ts:1` — TODO x' + REVIEW_FOOTER_LINKED,
    judged + REVIEW_FOOTER + '\n<!-- jenkins: job -->',
    (judged + REVIEW_FOOTER).replace(/\n/g, '\r\n'),
    'NO_CHANGE', '',
  ]
  const replies = [
    'Fixed in d4f2b43e.', 'Confirmed.' + REPLY_FOOTER, 'Confirmed.' + buildReplyFooter('bot', 'm', 'http://ci/1'),
    'Quoting you:\n```\n' + REPLY_FOOTER_LINE + '\n```', '**Suggested fix:**\n\n```ts\nx()\n```', 'Why?\r\n\r\n> **Suggested fix:**', '   \n',
  ]

  it('returns the very same object for every review and reply body, whatever the footer kind', () => {
    for (const b of [...reviews, ...replies]) {
      expect(stripSuggestedFixes(b)).toBe(b)
      expect(stripOwnSuggestedFixes(b, 'review')).toBe(b)
      expect(stripOwnSuggestedFixes(b, 'reply')).toBe(b)
    }
  })

  it('a marker-bearing body with nothing to strip also comes back as the same object, CRLF included', () => {
    const b = 'Note:\r\n```suggested-fix-v1\r\nx\r\n```' + REPLY_FOOTER.replace(/\n/g, '\r\n')
    expect(stripOwnSuggestedFixes(b, 'reply')).toBe(b)
  })
})
