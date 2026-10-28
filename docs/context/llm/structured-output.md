---
type: domain
topic: LLM provider seam and structured (JSON-schema) model output for reviewer and judge
---

# Structured Output & LLM Provider Seam

How the agent talks to the model, and why the reviewer and judge emit typed objects instead of free-form markdown. Related: [prompt/composition.md](../prompt/composition.md) | [prompt/judge.md](../prompt/judge.md) | [review/fsm.md](../review/fsm.md)

---

## LLM Provider Seam

All model calls go through `LLMProvider` (`src/llm/provider.ts`), never the SDK directly:
- `complete(system, user, opts)` → `{ text, usage }`
- `completeStructured<T>(system, user, schema, opts)` → `{ object: T, usage }` (JSON-schema-constrained)

`createProvider(apiKey)` selects the impl by `LLM_PROVIDER` (default and only value: `anthropic`). The Anthropic SDK lives in exactly one file, so a second provider is a new class — not a re-plumb across the codebase. Both `complete` and `completeStructured` throw a `TruncatedResponseError` on a `max_tokens` cut-off — it carries the response usage, so the record keeps real token counts (not zeros); `completeStructured` also throws on invalid JSON or missing required keys, so a truncated or malformed object is never returned. Effort rides `output_config.effort` with a one-shot retry without it on a 400.

**Why:** keep the SDK in one place and make structured output (and a future non-Anthropic backend) an implementation detail. Prompts stay Claude-tuned — provider portability is a separate per-model effort.

---

## Structured Reviewer Output

The reviewer returns a typed object (`REVIEW_OUTPUT_SCHEMA` in `src/claude/client.ts`), not markdown:
`summary`, `findings[{severity, title, file?, lines?, body, type?}]` (`type` = one of `ISSUE_TYPES` in `src/review/formatter.ts` — analytics-only, nothing keys off it), `behavioral_diff[]`, `production_risk[]`, `unresolved_questions[]`, plus optional `can_be_split[]` (SPLIT CHECK add-on), `delta_stats{resolved, still_open, new_findings}` (re-reviews), and `no_change` (delta stop signal). The breadth pass (`runBreadth`) returns `findings[]` only (`BREADTH_OUTPUT_SCHEMA`, reusing the reviewer's finding item schema); its findings go to the judge, never into `reviewObject`.

`renderReview(obj)` (`src/review/formatter.ts`) builds the posted markdown from those fields. Because the code owns the rendering, the model cannot leak preamble, tone, or a footer into the review. `no_change: true` renders the `NO_CHANGE` sentinel (reuses the existing `isNoChange` path). Merge Confidence is NOT rendered here — the judge adds it.

**Why:** prompt-only suppression of leaks proved unreliable in production; typed fields make the output shape guaranteed and the metrics exact.

---

## Structured Judge Output

The judge (`JUDGE_OUTPUT_SCHEMA`) rules on reviewer candidates by id and writes the narrative. It never writes the posted markdown:
- `decisions[{candidate_id, reason_category, evidence, note, score, rewritten_body?, question?, anchor_file?, anchor_lines?, anchor_quote?}]` — one per candidate; `reason_category` is one of `REASON_CATEGORIES` (`src/review/judge-decisions.ts`); `anchor_quote` is a verbatim diff line used for deterministic anchoring
- `summary`, `behavioral_diff[]`, `production_risk[]`, `unresolved_questions[]`, `merge_confidence` (0–100)

`applyJudgeDecisions` applies the policy table (see [prompt/judge.md](../prompt/judge.md)), and `renderJudgedReview` builds the posted comment. Kept findings resolve an anchor via `locateInDiff` in order: the reviewer's `file:line` when strictly numeric (`anchorSource: 'reviewer'`, **ungated** — never dropped, since the reviewer sees full files and may cite context/out-of-diff lines; a breadth candidate's line must be on a changed line), else the judge's `anchor_file`/`anchor_lines` validated to a changed line (`'judge'`), else a single verbatim `anchor_quote` located in the diff (`'diff'`); a finding that resolves to none keeps only its file, and the benchmark places it on that file's first added line (`'file'`, see [vcs/adapter.md](../vcs/adapter.md)) or drops it with a `Parse check` warning when the file is missing, deleted, or not in the diff. The benchmark reads them directly (`ReviewOutcome.judgedFindings` → `keptToReportFindings`) instead of re-parsing prose. Only the bundled path still uses the prose merge (`mergeJudgedFindingsWithStats`), fed by the same rendered markdown.

**Why:** the judge used to write the comment as prose, so kept findings had to be fuzzy-matched back to reviewer anchors, and drop reasons existed only as a console note. Typed decisions make every drop attributable and logged.

---

## Metrics From the Object

`ctx.reviewObject` (reviewer) and `ctx.judgeScores` / `ctx.judgeDecisions` / `ctx.judgeAnomalies` / `ctx.judgedFindings` (judge) are carried on `ReviewContext`. Reviewer-side metrics read the typed object — `review_findings` via `countFindings(reviewObject)`, `delta`/`touch_rate` via `reviewObject.delta_stats` (no more `<!-- DELTA_STATS -->` markdown comment). Judge-side `findings`/`verdict_score` are still regex over the judged markdown, which is now app-rendered and so exact. `parseFindings`/`parseVerdictScore`/`parseDeltaStats` remain the judged-text parsers plus defensive helpers. The record also carries `anchored_findings[]` — one compact `{anchor, severity, type, description}` row per kept finding that resolved to a real line (`isAnchored`).
