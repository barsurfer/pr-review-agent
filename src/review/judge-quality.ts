// Compose after loading the unconditional template so flag-off bytes never change.
function swapLine(text: string, startsWith: string, replacement: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.startsWith(startsWith))
  if (at < 0) throw new Error(`Judge prompt line not found: ${startsWith}`)
  lines[at] = replacement
  return lines.join('\n')
}

const DUPLICATE = '- `duplicate` — the same root cause at the same location in the same file as another candidate that you keep; classify the clearer one on its merits, this one as `duplicate`, and set `duplicate_of` to the kept candidate\'s id. A body mentioning another file does not give that file a kept finding: the same defect in a different file or at a different location is its own finding.'

const LOW_VALUE_EVIDENCE = `## LOW_VALUE EVIDENCE CHECK

Before assigning \`low_value\`, apply this narrow exception only when ALL of the following hold:
- The candidate itself states a specific failing input, execution path, or user interaction and a concrete runtime failure, performance cost, or visible UI failure caused by code this diff adds or modifies.
- The code you were shown demonstrates the stated scenario and its causal mechanism. Quote the specific file:line and code in \`evidence\`, and explain the scenario-to-failure connection in \`note\`.
- The claim is more than a preference, a possible optimization, or an unsupported assertion of impact. For performance claims, identify the repeated work or allocation and the execution path that incurs it; do not infer material overhead merely from an API name or invent workload or timing assumptions.

When all conditions hold and no other rejection category applies, use \`validated\` instead of \`low_value\`. The existing \`unconfirmed_high\` and \`chained_hypothetical\` rules still apply. Do not change or propose a severity; the application derives it from the candidate and category.

A bare request to "add a docstring", "consider configurable", or "verify/ensure X" does not qualify. A proposed fix containing those words does not disqualify an otherwise demonstrated failure. Do not invent a scenario or consequence to rescue a candidate. If the conditions fail, apply the existing category definitions: unsupported defect claims remain \`unverifiable\`, pure asks remain \`low_value\`, and concrete problems without runtime impact remain \`minor\`. This exception does not relax \`incorrect\`, \`already_handled\`, \`style_only\`, \`duplicate\`, or \`out_of_scope\`.`

const MULTI_FILE = `## MULTI-FILE FINDINGS

When a candidate you keep explicitly alleges the same defect in additional changed files, list each additional file in \`additional_locations\`: its \`file\`, numeric \`lines\`, a verbatim \`anchor_quote\` of the added line, a \`candidate_excerpt\` copied verbatim from the candidate that names that file, and a one-sentence \`body\` for that file's consequence. Do not list files mentioned only as callers, dependencies, examples, or fix locations, and do not discover new defects.`

const ANCHOR_SENTENCE = 'Omit both anchor fields when the candidate already shows a numeric line, and omit all three'
const ANCHOR_SHOWN = 'If the candidate\'s numeric line cannot be confirmed from the code you were shown, give a replacement `anchor_file`, `anchor_lines` and `anchor_quote`; an unchanged line of the new file that you were shown is allowed, but prefer added or modified lines when equally accurate. Omit all three'

const PROPOSAL = `## PROPOSAL

For each candidate you keep, give \`proposal\`: the specific code change that resolves it, written as an instruction to the person or agent who will make the edit ("Wrap X in try/finally and release the client in finally."). It must be standalone - understandable without the finding text - and must not repeat the problem or why it matters (that is \`body\`/\`rewritten_body\`). At most 2 sentences plus one optional fenced snippet of up to 4 lines, under ~500 characters total. If you cannot name a concrete change from the code you were shown, omit \`proposal\`; never write "consider", "verify" or "ensure". Dropped candidates get no proposal.`

const PROPOSAL_CODE = `## PROPOSAL

For each candidate you keep, give \`proposal\`: the fix, posted to the developer as a copyable plain-text block. Start with one or two short lines that say what to change and where (file, function or line). When the fix is a local edit you can write from the code you were shown, follow with the corrected code as it should read after the fix, with its original indentation, at most 5 lines. When it is not (a choice between options, a config or design change, a change across files), give only the instruction lines. Plain text only: no markdown, no fences, no diff markers, no line-number gutter. Keep each line under ~100 characters, and the whole under 7 lines and ~450 characters. Do not restate the problem or why it matters. Omit \`proposal\` only when you cannot name a concrete change; never write "consider", "verify" or "ensure".

When you give \`proposal\`, also give \`body_without_fix\`: the finding text as posted (your \`rewritten_body\`, else the candidate's body) with the fix left out - only the problem and why it matters, in at most 1–3 sentences. Keep every fact needed to understand the problem. No fix, no "should", no code snippet.

Dropped candidates get no proposal.`

export function composeJudgePrompt(base: string, opts: { quality: boolean; shownAnchors: boolean; proposals?: boolean; codeProposals?: boolean }): string {
  let out = base
  if (opts.shownAnchors) {
    if (!out.includes(ANCHOR_SENTENCE)) throw new Error('Judge prompt anchor sentence not found')
    out = out.replace(ANCHOR_SENTENCE, () => ANCHOR_SHOWN)
  }
  if (opts.quality) {
    out = swapLine(out, '- `duplicate`', DUPLICATE)
    out = `${out.trimEnd()}\n\n${LOW_VALUE_EVIDENCE}\n\n${MULTI_FILE}\n`
  }
  if (opts.proposals) out = `${out.trimEnd()}\n\n${opts.codeProposals ? PROPOSAL_CODE : PROPOSAL}\n`
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

export const PROPOSAL_DECISION_PROPERTIES = {
  proposal: { type: 'string', description: 'Only for a candidate you keep: the concrete change that fixes it, as an imperative instruction a developer or coding agent can apply without re-reading the finding. 1-2 sentences, optionally one minimal fenced snippet of at most 4 lines. Name the exact function/symbol to change. Do not restate the problem or its impact. Keep it under ~500 characters; omit when no concrete fix can be determined from the code you were shown.' },
} as const

export const PROPOSAL_CODE_DECISION_PROPERTIES = {
  proposal: { type: 'string', description: 'Only for a candidate you keep: the fix as a copyable plain-text block: one or two short lines saying what to change and where, then, for a local edit, the corrected code as it reads after the fix (at most 5 lines). Instruction lines only when the fix is not a local edit. No markdown, fences, diff markers or line numbers. Lines under ~100 characters; under 7 lines and ~450 characters in total. Omit only when no concrete change can be named.' },
  body_without_fix: { type: 'string', description: 'Only with proposal: the finding text as posted (rewritten_body, else the candidate body) with the fix left out - the problem and why it matters, 1–3 sentences. No fix, no "should", no code snippet.' },
} as const

export interface AdditionalLocation {
  file: string
  lines: string
  anchor_quote: string
  candidate_excerpt: string
  body: string
}
