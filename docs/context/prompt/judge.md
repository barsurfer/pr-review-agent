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
- The reviewer or the breadth pass produced at least one finding (judge is auto-skipped when both are empty); breadth candidates are judged together with the reviewer's in one call
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
{reviewer output, breadth findings appended, each finding tagged [c0], [c1], …}
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

**Why policy is app-side:** the judge's output doesn't depend on the flags, so one judged run can be re-scored offline under any flag combination from the logged decisions. Paid runs are scarce, so this replaces ablation runs. With all flags off the app's actions follow the pre-contract rules, but two prompt-level changes are not inert. `minor` is a new category that is dropped by default (stale docs/comments, dead code, duplicated logic, vacuous tests; the old prompt left these to the judge's discretion), so LOW recall can fall until `ENABLE_JUDGE_KEEP_MINOR` is on. `duplicate` now means the same root cause at the same location; the same defect at two places is two findings.

**Edge handling (precision-safe):**
- Unknown or hallucinated id → ignored and counted.
- No decision for a candidate → dropped and counted (`undecided`).
- Several decisions for one id → any drop wins.
- A category outside the enum → treated as `unverifiable`.
- `incorrect` / `already_handled` with empty `evidence` → reclassified `unverifiable` (still dropped by default) and counted (`drop_without_evidence`).
- `rewritten_body` over 600 chars → the reviewer's body is used (even when it is empty).
- Anchors (`locateInDiff`, first that resolves wins): (1) the reviewer's `file:line` when `lines` is strictly numeric (`42`, `26-31`, `L10-L12`; a symbol that merely contains a digit like `Phase 4` is not a line) — **ungated / `anchor_source: reviewer`**, never diff-validated, since the reviewer sees full files and may cite context/out-of-diff lines (a breadth candidate's line counts only on a changed line, else it falls through); (2) else the judge's `anchor_file`/`anchor_lines` (numeric), accepted only when the line is a changed line in the diff → `anchor_source: judge`; (3) else a single verbatim `anchor_quote` (≥12 chars, after stripping a copied line-number gutter or leading `+`) located in the diff → `anchor_source: diff`. With none, the finding still posts without a usable line but keeps its file (the reviewer's, else a changed file the judge named); the single-pass benchmark places it on that file's first added line (see [vcs/adapter.md](../vcs/adapter.md)) and drops it from `findings.json` with a `Parse check` warning only when the file is missing, deleted, or not in the diff. Only the judge/quote channels are proven against the diff; the reviewer anchor is additive-only so nothing that anchors today is lost.

---

## Judge Output

- **Structured output:** `decisions[{candidate_id, reason_category, evidence, note, score, rewritten_body?, question?, anchor_file?, anchor_lines?, anchor_quote?}]`, plus `summary`, `behavioral_diff[]`, `production_risk[]`, `unresolved_questions[]`, `merge_confidence`. `anchor_quote` is a verbatim diff line for deterministic anchoring. Schema: [llm/structured-output.md](../llm/structured-output.md).
- **The app renders the posted comment** (`renderJudgedReview`): kept findings with the reviewer's `file:line` (the judge's anchor when the reviewer's is not numeric) and `rewritten_body ?? reviewer body`, then the reviewer's `Can Be Split` section when present (carried through so `ENABLE_SPLIT_CHECK` works with the judge on; the judge never rules on it), then `### Merge Confidence: X%` and the disclaimer line, byte-compatible with what the judge used to write. Validation reasoning lives only in `note` and `evidence`, so nothing leaks into the post; `stripPreamble()`/`stripJudgeNotes()` stay as defense-in-depth.
- **Logged to `results.jsonl`, never posted:**
  - `review_candidates[]` (stored once, with ids and `origin` `review`/`breadth`) and `judge_decisions[]` (joined by `candidate_id`; effective category, `reclassified_from`, action, original and final severity, score, evidence, note, and the resolved `anchor_source`/`anchor_file`/`anchor_lines` on **every decided candidate** — dropped included — so an offline re-score under a different policy can place what it would keep);
  - `judge_anomalies`, and `judge_policy` (only when the judge ran);
  - `finding_scores` / `min_finding_score`, now a projection of kept decisions;
  - `anchored_findings[]` — one compact `{anchor, severity, type, description}` row per kept finding that resolved to a real line.
- **Bundled review** runs the same contract per bundle and re-parses each bundle's rendered markdown. Its decisions are not persisted (ids would need per-bundle namespacing).

**Merge Confidence is NOT arithmetic.** The judge considers:
- Number and severity of findings
- Code scope and criticality
- Unresolved questions
- Critical path impact

The `computed_score` field in `results.jsonl` provides a separate arithmetic score (`100 − HIGHs×12 − MEDIUMs×4`) from parsed findings, regardless of whether a judge was used. The two scores are independently useful.

---

## Judge Prompt (`src/prompt/judge-prompt.txt`)

Standalone file — not derived from the base review template. Includes its own SCOPE LOCK to resist prompt injection from reviewer output that might contain adversarial content.
