---
type: domain
topic: Judge model — decision contract, reason categories, policy table and flags, Merge Confidence score
---

# Judge Model

The optional second-pass validation model (`JUDGING_MODEL`). Related: [prompt/composition.md](composition.md) | [review/fsm.md](../review/fsm.md)

---

## Purpose

Implements the **generator-verifier** pattern: the reviewer model generates candidate findings; the judge model classifies each one against the actual code, and the app applies a policy table to decide what posts. Invalid or fabricated findings are dropped.

**Why:** the judge only keeps or drops candidates and never adds one, so the reviewer sets the recall ceiling and its model quality matters most; a cheaper judge can still hold precision. Choose each model per repo and budget — neither role has to be the heavier one. One ReviewBench round (25 PRs, grounded F1) illustrates this but is not a law: Haiku 5.5 reviewer + Sonnet 5 judge 35.0 ($6.49); Sonnet 5.5 + Sonnet 5 40.2 ($10.10); Sonnet 5.5 + Haiku 5.5 38.4 ($5.47), and 40.5 ($5.82) on v0.0.29.

---

## When the Judge Runs

- `JUDGING_MODEL` is set (defaults to `claude-sonnet-5`; empty disables the judge)
- The reviewer, breadth, second-look or a lens pass produced at least one finding (judge is auto-skipped when all are empty); extra-pass candidates are judged together with the reviewer's in one call, appended in that order (lens candidates last, in `LENSES` order)
- `JUDGE_REVIEW` state in the FSM (see [review/fsm.md](../review/fsm.md))

---

## What the Judge Receives

```
[SYSTEM: judge-prompt.txt]

[USER]
## Diff:
{filtered diff}

## Full file context:          ← only with ENABLE_JUDGE_FILE_CONTEXT=true
{the reviewer's file contexts}

## Review to Validate:
{reviewer output, breadth/second-look/lens findings appended, each finding tagged [c0], [c1], …}
```

By default the judge sees only the diff, while the reviewer also saw full files. That means it can't confirm a claim that rests on unchanged code; such candidates land in `unverifiable`. With `ENABLE_LINE_NUMBERS` (default on) the diff and file context carry the same line-number gutter the reviewer sees (see [fetching/strategy.md](../fetching/strategy.md)).

When `ENABLE_NITPICKS` is on (see [composition.md](composition.md)), the reviewer emits more real-but-low-impact candidates (dead code, stale docs/comments, misleading names, duplication, vacuous tests); these classify as `minor`, so they post only under `ENABLE_JUDGE_KEEP_MINOR`.

---

## Decision Contract: the judge classifies, the app decides

The judge returns one decision per candidate id, each with a `reason_category`. `applyJudgeDecisions` (`src/review/judge-decisions.ts`) maps each category to an action through a fixed policy table. Severity changes are derived from the category, never taken from the model, so a decision can't inflate severity.

| `reason_category` | Prompt rule it encodes | Default action | With a flag on |
|---|---|---|---|
| `validated` | diff shows the problem | keep | — |
| `unconfirmed_high` | HIGH without confirmed crash/data loss/breach/outage | downgrade → MEDIUM | — |
| `chained_hypothetical` | needs 3+ chained hypotheticals | downgrade → LOW | — |
| `incorrect` | the code contradicts the claim (guard, default, try-catch present) | drop | — |
| `already_handled` | the finding's own reasoning says it's mitigated ("for awareness") | drop | — |
| `unverifiable` | no concrete line shows the problem | drop | `ENABLE_JUDGE_KEEP_UNVERIFIED` → keep, score ≤ 5 |
| `style_only` | formatting / style / naming preference | drop | — |
| `low_value` | pure asks: add a docstring/type-hint/import, configurability opinions, "verify/ensure X" | drop | — |
| `minor` | real problem with no runtime impact: unused imports/variables or dead code, stale docs/comments, misleading names, duplication, weak tests in the diff | drop | `ENABLE_JUDGE_KEEP_MINOR` → keep as LOW |
| `duplicate` | same root cause **and** same location; the same defect elsewhere is a separate finding | drop | — |
| `out_of_scope` | not code this diff adds or modifies | drop | — |
| `framework_uncertainty` | rests on framework/library internals | move to Unresolved Questions (the judge's `question`) | `ENABLE_JUDGE_KEEP_UNVERIFIED` → keep, score ≤ 5 |

**Why policy is app-side:** the judge's output doesn't depend on the flags, so one judged run can be re-scored offline under any `keepMinor`/`keepUnverified` combination from the logged decisions (the provider request never depends on them). Toggling `ENABLE_JUDGE_QUALITY` changes the prompt and needs fresh judging; replay of its duplicate validity depends on the retained targets, and expansion logs hold only `{file, accepted}` for retained parents, so exact reconstruction from logs alone is not promised. Paid runs are scarce, so this replaces ablation runs. With all flags off the app's actions follow the pre-contract rules, but two prompt-level changes are not inert. `minor` is a new category that is dropped by default (stale docs/comments, dead code, duplicated logic, vacuous tests; the old prompt left these to the judge's discretion), so LOW recall can fall until `ENABLE_JUDGE_KEEP_MINOR` is on. `duplicate` now means the same root cause at the same location; the same defect at two places is two findings.

**Edge handling (precision-safe):**
- Unknown or hallucinated id → ignored and counted.
- No decision for a candidate → dropped and counted (`undecided`).
- Several decisions for one id → any drop wins.
- A category outside the enum → treated as `unverifiable`.
- `incorrect` / `already_handled` with empty `evidence` → reclassified `unverifiable` (still dropped by default) and counted (`drop_without_evidence`).
- `rewritten_body` over 600 chars → the reviewer's body is used (even when it is empty).
- Anchors (`locateInDiff`, first that resolves wins): (1) the reviewer's `file:line` when `lines` is strictly numeric (`42`, `26-31`, `L10-L12`; a symbol that merely contains a digit like `Phase 4` is not a line) — **ungated / `anchor_source: reviewer`**, never diff-validated, since the reviewer sees full files and may cite context/out-of-diff lines (a breadth, second-look or lens candidate's line counts only on a changed line, else it falls through); (2) else the judge's `anchor_file`/`anchor_lines` (numeric), accepted only when the line is a changed line in the diff → `anchor_source: judge`; (3) else a single verbatim `anchor_quote` (≥12 chars, after stripping a copied line-number gutter or leading `+`) located in the diff → `anchor_source: diff`. With none, the finding still posts without a usable line but keeps its file (the reviewer's, else a changed file the judge named); the single-pass benchmark places it on that file's first added line (see [vcs/adapter.md](../vcs/adapter.md)) and drops it from `findings.json` with a `Parse check` warning only when the file is missing, deleted, or not in the diff. Only the judge/quote channels are proven against the diff; the reviewer anchor is additive-only so nothing that anchors today is lost.

---

## Judge Output

- **Structured output:** `decisions[{candidate_id, reason_category, evidence, note, score, rewritten_body?, question?, anchor_file?, anchor_lines?, anchor_quote?, proposal?}]`, plus `summary`, `behavioral_diff[]`, `production_risk[]`, `unresolved_questions[]`, `merge_confidence`. `anchor_quote` is a verbatim diff line for deterministic anchoring. Schema: [llm/structured-output.md](../llm/structured-output.md).
- **The app renders the posted comment** (`renderJudgedReview`): kept findings with the reviewer's `file:line` (the judge's anchor when the reviewer's is not numeric) and `rewritten_body ?? reviewer body` — in kept (candidate) order in `ctx.reviewText`, and re-rendered HIGH → MEDIUM → LOW through the `render` closure in the posted comment only (see [review/fsm.md](../review/fsm.md#posted-severity-order)) — then the reviewer's `Can Be Split` section when present (carried through so `ENABLE_SPLIT_CHECK` works with the judge on; the judge never rules on it), then `### Merge Confidence: X%` and the disclaimer line, byte-compatible with what the judge used to write. Validation reasoning lives only in `note` and `evidence`, so nothing leaks into the post; `stripPreamble()`/`stripJudgeNotes()` stay as defense-in-depth.
- **Logged to `results.jsonl`, never posted:**
  - `review_candidates[]` (stored once, with ids and `origin` `review`/`breadth`/`second_look`/`lens:<name>`, e.g. `lens:security`) and `judge_decisions[]` (joined by `candidate_id`; effective category, `reclassified_from`, action, original and final severity, score, evidence, note, and the resolved `anchor_source`/`anchor_file`/`anchor_lines` on **every decided candidate** — dropped included — so an offline re-score under a different policy can place what it would keep);
  - `judge_anomalies`, and `judge_policy` (only when the judge ran);
  - `finding_scores` / `min_finding_score`, now a projection of kept decisions;
  - `anchored_findings[]` — one compact `{anchor, severity, type, description, proposal?, quality_action?}` row per kept finding that resolved to a real line (`proposal` only under `ENABLE_JUDGE_PROPOSALS` or `ENABLE_SUGGESTED_FIXES`, `quality_action` only under `ENABLE_JUDGE_QUALITY`).
- **Bundled review** runs the same contract per bundle and re-parses each bundle's rendered markdown. Its decisions are not persisted (ids would need per-bundle namespacing).

**Merge Confidence is NOT arithmetic.** The judge considers:
- Number and severity of findings
- Code scope and criticality
- Unresolved questions
- Critical path impact

The `computed_score` field in `results.jsonl` provides a separate arithmetic score (`100 − HIGHs×12 − MEDIUMs×4`) from parsed findings, regardless of whether a judge was used. The two scores are independently useful.

---

## Recall levers (all default off, label-driven for A/B)

- `ENABLE_JUDGE_QUALITY` / `RB_CONFIG_J_QUALITY` — one gate, three behaviors, one judge invocation and no repair status. (1) Narrow evidence classification: a `## LOW_VALUE EVIDENCE CHECK` prompt section lets the judge answer `validated` instead of `low_value` only when the candidate states a failing scenario and a concrete runtime/performance/UI failure in code this diff changes, and the shown code demonstrates the mechanism; the base `already_handled`/`low_value`/`minor` definitions are untouched, and `policyAction` is unchanged (a returned `low_value` still drops). (2) Stricter duplicate justification: `duplicate` must name a kept, different, same-file candidate in `duplicate_of`; an invalid duplicate (target unknown, self, dropped, different file, non-overlapping range; checked against the final kept set) becomes `unverifiable` and follows `keepUnverified` plus the score cap (`invalid_duplicate`). (3) Guarded per-file expansion: a kept parent expands into one extra row per additional changed file only when the candidate text itself names it (verbatim `candidate_excerpt`) and the quote resolves to a single added line in that file (`expansions` on the decision). Schema adds optional `duplicate_of` and `additional_locations`. The bundled caller gets the same gate.
  - **Final dedup pass (app-side, quality-only):** after kept findings are built and before scores/markdown, `dedupKept` collapses a mechanical double-count (per-file expansion plus duplicate rescue emitting the same issue). It is post-processing in `applyJudgeDecisions`; the judge prompt, schema and model call are unchanged by it. Two rows are the same issue only when they share a normalized file and overlapping numeric line ranges AND either (a) their normalized bodies are equal and titles overlap, or (b) explicit provenance: a rescued invalid-duplicate whose `duplicate_of` is the parent of the other row's expansion. Never a shared line alone or title overlap alone. Survivor precedence: validated > evidenced > higher score > primary row over expansion row > candidate order.
  - **`quality_action` markers** (absent when quality is off): `'expansion'` on per-file expansion rows, `'dup_rescue'` on a rescued invalid-duplicate that is kept, `'dedup_suppressed'` (+ `retained_candidate_id`) on the decision of a suppressed primary loser. A suppressed expansion row instead sets `suppressed_by` on its parent's `expansions` log entry. Surfaces in `judge_decisions[]` and `anchored_findings[].quality_action`, so each mechanism is attributable offline.
- `ENABLE_JUDGE_SHOWN_CONTEXT_ANCHORS` / `RB_CONFIG_J_SHOWN_ANCHOR` — a numeric anchor is also valid when every line of the range was shown (new-side diff context or supplied full-file lines) to the pass that produced the candidate (breadth, second-look, lens — every lens shares one shown source, the full filtered diff + all reviewer file contexts; reviewer anchors stay ungated) or, for judge replacement anchors, to the judge. Unique verbatim quotes also resolve against shown lines. `anchor_basis` (`added_line` | `shown_context` | `fallback`) is logged on the decision. Location validity is separate from the PR-introduced-defect requirement; breadth/second-look lens wording and every `LENSES` overlay gain the shown-line allowance. Not applied in bundled review.
- `ENABLE_JUDGE_PROPOSALS` / `--proposals` / `RB_CONFIG_J_PROPOSAL` — an output lever, not a recall lever (it is not in `recall_levers`; the changed `judge_prompt_hash` attributes it). Appends a `## PROPOSAL` prompt section and an optional `proposal` decision field: a standalone, imperative, code-level fix (at most 2 sentences plus one fenced snippet of 4 lines, the prompt asks for this; the app enforces only `PROPOSAL_CAP` 500 chars and `PROPOSAL_MAX_LINES` 7 non-blank lines, omitting anything over either, never truncating), distinct from `body`/`rewritten_body` which carry problem, why and flag-level fix in the posted comment. It appears only in JSON outputs (`anchored_findings[].proposal` in `results.jsonl`, `findings.json` under `--benchmark`), never in the posted markdown. Bundled review gets none (it re-parses rendered markdown). Needs a judge; with `JUDGING_MODEL` empty it warns and does nothing. It changes the judge prompt and schema, so decisions may shift slightly: judge fresh, do not replay. Rescore caveat: a proposal is logged only for candidates KEPT BY THE APPLIED POLICY, so an offline rescore that flips a dropped candidate to kept has no proposal for it. Pair with `ENABLE_JUDGE_FILE_CONTEXT` for fixes that need unshown code.

## Suggested fixes in the posted review (`ENABLE_SUGGESTED_FIXES`)

`ENABLE_SUGGESTED_FIXES` / `--suggested-fixes` (default off) posts the proposal under each kept finding as code. It is an output option, not a recall lever: no ReviewBench label and not in `recall_levers`, but the `--benchmark` settings line echoes it as `sfx=0/1`, because it changes the judge prompt there too.

- **Contract.** The flag turns proposals on by itself (`judgeOptions` gains `{ proposals: true, codeProposals: true }`; with `ENABLE_JUDGE_PROPOSALS` also on, the code contract wins). The judge gets a code-only `## PROPOSAL` section instead of the prose one: only the corrected code for the lines that change, as they read after the fix, no prose, fences, diff markers or line numbers, original indentation, at most 5 lines and under ~400 characters, omitted when the fix is not a small local edit. The schema variant uses the matching `proposal` description (cache key suffix `:code`). It changes the prompt and `judge_prompt_hash`, so judge fresh, do not replay.
- **Sanitizer.** `sanitizeCodeProposal` (code mode only; `sanitizeProposal` is untouched): omit raw input over 2,000 chars (4 × `PROPOSAL_CAP`, before the fence-unwrap regex, which backtracks on a long unclosed backtick run), CRLF/CR → LF, unwrap one outer ``` or ~~~ fence, drop leading and trailing blank lines, remove the common leading whitespace of the non-blank lines (whitespace-only lines become empty, as `textwrap.dedent` does), then omit anything over `PROPOSAL_CAP` (500) chars or over 7 lines **in total** (blank lines count, so padding cannot slip past the caps). Under the flag `anchored_findings[].proposal` and `findings.json` carry this dedented code.
- **Rendered form.** At `POST_REVIEW`, after cleanup, the NO_CHANGE guard, the cut guard and the posted severity order, each kept finding with a usable proposal gets, right after its body (wherever the order moved it) and at column 0:

  ~~~~text
  **Suggested fix:**

  ```suggested-fix-v1
  <code>
  ```
  ~~~~

  preceded by one blank line. The fence is backticks, longer than any backtick run in the code and than any line-leading backtick run in the review (Python-Markdown, which Bitbucket documents, closes a fence only on the exact opener, so a stray opener in the review can never pair with the block's own fences; a stray opener and a later closer in the review can still wrap the block, which the post-render check below catches). One form on every platform. The info string is not displayed, so there is no syntax highlighting.
- **Rejected or skipped.** A proposal holding a fence line, a line that trimmed matches the review- or reply-footer pattern, U+2028, U+2029 or a control character other than `\n` and `\t` (the footer parsers' `/m` regexes start a line after U+2028/U+2029 and CR, so a footer could hide behind one), or over `PROPOSAL_CAP` (re-checked so the strip bound never rests on the sanitizer alone) is `rejected` (a reply that copies the block must not pass as an agent comment). All blocks are skipped when the judge text was changed by cleanup (`cleanup`), the review has an unclosed fence under CommonMark rules, loose or 3-space-strict, or a block does not stand alone after rendering (`unbalanced`: stripping the rendered text must give back the block-free text, CR-normalised, and the Python-Markdown block scan `pmBlocks` must find exactly the rendered blocks with exactly their code, so a model fence opened in one finding and closed in a later one cannot wrap a block), a block would need a fence over 32 backticks (`fence`), or the comment with blocks would exceed 32,000 characters minus the TODO section and footer (`size`; the review then posts exactly as without the flag). The severity order moves findings only when every finding keeps its fences to itself (`fencesSelfContained`), which already implies the post-render check passes; the check is what guards a review that is not reordered. No blocks without a judge, on a judge failure, on the bundled path (no proposals requested there) or under `--benchmark` (the sink returns before rendering).
- **Never parsed.** Blocks are spliced only into the posted comment, never into `ctx.reviewText`, so the cut guard, metrics (`findings`, `verdict_score`), bundled parsing and every `reviewText` parser are unchanged. The next run reads the posted body only through `extractCommitHash` (the last footer line wins), `hasReviewFooter`/`hasReplyFooter` and `markdownHasFindings` (a block sits under a real finding).
- **Marker and versioning.** The info string `suggested-fix-v1` is the marker. Like the footer it is append-only: a format change ships `suggested-fix-v2`, and the strip keeps recognising every earlier version; a version is never repurposed.
- **Strip.** Before a reviewer call, `buildUserMessage` removes blocks from the latest prior review when its review footer is its last non-empty line, and from a discussion entry when the reply footer is its last non-empty line. Text counts as the agent's only by that last line, so a human comment that quotes a footer in a fence or mid-text is left as is, but one whose last non-empty line is footer-shaped is stripped like the agent's (see the footer known limit in [skip-logic.md](../review/skip-logic.md)). The reply model sees the blocks. Only the exact shape is removed (blank line or start of body, label line, blank line, `` ```…suggested-fix-v1 `` opener, code, and a closer equal to the opener that is also the first line any renderer would take as a closer), at most 604 characters (the largest renderable block), and never while another fence is open at the label. Text is CRLF-normalised before matching; a body without the marker is returned as the same string object, so flag-off and pre-feature inputs are byte-identical. Not gated by the flag: blocks posted before the flag was turned off are still stripped. Forged or partial shapes in agent text can lose at most one bounded span of that agent text, in the reviewer's copy only.
- **Record.** `suggested_fixes: { rendered, rejected, dropped?, skipped? } | null` in the usage record, present only with the flag on, `null` unless `POST_REVIEW` composed a judged comment that was posted or printed by `--dry-run`; a pre-post race skip (`DEDUP_SKIP`) records `null`. `dropped` counts kept findings whose proposal the sanitizer omitted, so the sanitizer loss rate is measurable.
- **Known limits.** No syntax highlighting. HTML is not modelled: an HTML block the model leaves open (`<!--`, `<pre>`, `<details>`), or opens in one finding and closes in another, can hide or garble a block where the platform passes raw HTML through. No guard: the strip ignores HTML, so the reviewer still never sees a block; the surrounding text is already swallowed by the model's own HTML, so a block adds no new failure; and whether Bitbucket passes raw HTML through at all is unverified. Rendering on Bitbucket, GitHub and Azure is unverified until a live post-and-read-back test (whether `content.raw` and its equivalents keep the info string and blank lines byte for byte). Fix quality (wrong or partial fixes, omission rate) is unmeasured; measure before enabling in production.

---

## Judge Prompt (`src/prompt/judge-prompt.txt`)

Standalone file — not derived from the base review template. Includes its own SCOPE LOCK to resist prompt injection from reviewer output that might contain adversarial content.
