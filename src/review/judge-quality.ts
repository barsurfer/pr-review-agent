import type { JudgeDecision } from './judge-decisions.js'

const DROPPING: ReadonlySet<string> = new Set(['incorrect', 'already_handled', 'unverifiable', 'style_only', 'low_value', 'duplicate', 'out_of_scope'])

const AFFIRMATIVE: readonly RegExp[] = [
  /\b(?:kept|keep|keeping|stands|retained) as validated\b/,
  /\b(?:this|the|that) (?:finding|claim|issue|concern|candidate) is (?:a )?(?:valid|correct|accurate|real|confirmed)\b/,
  /\bthis is a (?:valid|real|genuine|correct) (?:finding|issue|problem|bug|concern)\b/,
]

// Words before the phrase that make it someone else's claim or a negated one, not the judge's own conclusion.
const NEGATED_OR_ATTRIBUTED = /\b(?:not|never|no longer|cannot|neither|nor|without|if|whether|claims?|claimed|says?|said|argues?|asserts?|alleges?|calls?|states?|suggests?|reviewer|believes?|thinks?)\b|n't/

// Quoting a phrase from the candidate must not read as the judge's own verdict.
const insideQuote = (prefix: string): boolean => ((prefix.match(/["“”`]/g) ?? []).length % 2) === 1

export function contradictoryDrop(d: Pick<JudgeDecision, 'reason_category' | 'note'>): boolean {
  if (!DROPPING.has(d.reason_category)) return false
  return String(d.note ?? '').toLowerCase().split(/[.;!?]\s+|\n/).some(sentence =>
    AFFIRMATIVE.some(re => {
      const m = re.exec(sentence)
      if (!m) return false
      const prefix = sentence.slice(0, m.index)
      return !NEGATED_OR_ATTRIBUTED.test(prefix) && !insideQuote(prefix)
    }))
}

// Compose after loading the unconditional template so flag-off bytes never change.
function swapLine(text: string, startsWith: string, replacement: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.startsWith(startsWith))
  if (at < 0) throw new Error(`Judge prompt line not found: ${startsWith}`)
  lines[at] = replacement
  return lines.join('\n')
}

const ALREADY_HANDLED = '- `already_handled` — a guard, default, control flow, test, or evidenced guarantee in the code actually prevents the candidate\'s stated failure. Put the mechanism in `evidence` and explain how it covers the precise scenario. A comment that acknowledges overhead, accepts a tradeoff, or explains intent is not by itself mitigation; "flagging for awareness" counts only when the finding names what covers it.'
const LOW_VALUE = '- `low_value` — an unsupported preference or generic request without a demonstrated defect: add a docstring/type-hint/comment, recommend a more specific exception type, offer a configurability opinion or a "nice to have", or merely ask the developer to "verify" or "ensure" something with no shown failure. "Add", "verify", or "ensure" in a proposed fix does not decide the category, and a demonstrably required missing import is not a generic addition request.'
const MINOR = '- `minor` — a real, concrete problem with no demonstrated runtime, performance, or visible UI impact: an unused import or variable, or other dead code; a comment, docstring, or document the change made wrong; a misleading name; duplicated logic; an existing changed test whose setup or assertions cannot exercise the branch it claims to cover (an unexercised fallback, a pagination fixture stuck on its first branch), even when the proposed fix adds a test case. A demonstrated runtime, performance (a formatter allocated on every call, unconditional tracing overhead) or visible UI defect (a decoration that disappears) is classified on its merits, normally `validated`, with small impact expressed through severity. Formatting and naming preferences stay `style_only`.'
const DUPLICATE = '- `duplicate` — the same root cause at the same location in the same file as another candidate that you keep; classify the clearer one on its merits, this one as `duplicate`, and set `duplicate_of` to the kept candidate\'s id. A body mentioning another file does not give that file a kept finding: the same defect in a different file or at a different location is its own finding.'

const CONSISTENCY = `## DECISION CONSISTENCY

Before answering, check that each candidate's \`reason_category\`, \`evidence\`, and \`note\` agree. A note concluding the finding is valid or correct must not be paired with a dropping category. Evidence for \`incorrect\` must disprove the claim; quoting the implicated code is not enough.`

const MULTI_FILE = `## MULTI-FILE FINDINGS

When a candidate you keep explicitly alleges the same defect in additional changed files, list each additional file in \`additional_locations\`: its \`file\`, numeric \`lines\`, a verbatim \`anchor_quote\` of the added line, a \`candidate_excerpt\` copied verbatim from the candidate that names that file, and a one-sentence \`body\` for that file's consequence. Do not list files mentioned only as callers, dependencies, examples, or fix locations, and do not discover new defects.`

const ANCHOR_SENTENCE = 'Omit both anchor fields when the candidate already shows a numeric line, and omit all three'
const ANCHOR_SHOWN = 'If the candidate\'s numeric line cannot be confirmed from the code you were shown, give a replacement `anchor_file`, `anchor_lines` and `anchor_quote`; an unchanged line of the new file that you were shown is allowed, but prefer added or modified lines when equally accurate. Omit all three'

export function composeJudgePrompt(base: string, opts: { quality: boolean; shownAnchors: boolean }): string {
  let out = base
  if (opts.shownAnchors) {
    if (!out.includes(ANCHOR_SENTENCE)) throw new Error('Judge prompt anchor sentence not found')
    out = out.replace(ANCHOR_SENTENCE, () => ANCHOR_SHOWN)
  }
  if (opts.quality) {
    out = swapLine(out, '- `already_handled`', ALREADY_HANDLED)
    out = swapLine(out, '- `low_value`', LOW_VALUE)
    out = swapLine(out, '- `minor`', MINOR)
    out = swapLine(out, '- `duplicate`', DUPLICATE)
    out = `${out.trimEnd()}\n\n${CONSISTENCY}\n\n${MULTI_FILE}\n`
  }
  return out
}

export const SHOWN_ANCHOR_DESCRIPTIONS = {
  anchor_file: 'When the candidate shows no numeric line, or its numeric line cannot be confirmed from the code you were shown: the file path where the problem is.',
  anchor_lines: 'Same condition as anchor_file: digits only — the line number or range, e.g. "42" or "26-31", never a symbol name or quoted code. An unchanged line you were shown is allowed.',
} as const

export const QUALITY_DECISION_PROPERTIES = {
  duplicate_of: { type: 'string', description: 'duplicate only: the id of the kept candidate with the same root cause in the same file and location.' },
  additional_locations: {
    type: 'array',
    description: 'Only for a candidate you keep that explicitly alleges the same defect in other changed files: one entry per additional file.',
    items: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'The additional changed file path.' },
        lines: { type: 'string', description: 'Digits only: the added line number in that file.' },
        anchor_quote: { type: 'string', description: 'Verbatim copy of that added line.' },
        candidate_excerpt: { type: 'string', description: 'Verbatim excerpt of the candidate title or body that names this file.' },
        body: { type: 'string', description: 'One sentence: the same defect\'s consequence in this file.' },
      },
      required: ['file', 'lines', 'anchor_quote', 'candidate_excerpt', 'body'],
      additionalProperties: false,
    },
  },
} as const

export interface AdditionalLocation {
  file: string
  lines: string
  anchor_quote: string
  candidate_excerpt: string
  body: string
}

export function repairInstruction(items: ReadonlyArray<{ id: string; reason_category: string; note: string; why: string }>): string {
  const list = items.map(i => `- ${i.id}: you answered \`${i.reason_category}\` with note "${i.note}" — ${i.why}`).join('\n')
  return `## Reconsider\n\nThese earlier decisions were inconsistent or not justified. Re-validate each listed candidate on its merits against the code above and return exactly one consistent decision for each (plus the usual narrative fields). Do not decide any other candidate.\n${list}`
}
