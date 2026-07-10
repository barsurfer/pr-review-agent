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

`createProvider(apiKey)` selects the impl by `LLM_PROVIDER` (default and only value: `anthropic`). The Anthropic SDK lives in exactly one file, so a second provider is a new class — not a re-plumb across the codebase. `completeStructured` throws on invalid JSON and on a `max_tokens` cut-off, so a truncated object is never returned.

**Why:** keep the SDK in one place and make structured output (and a future non-Anthropic backend) an implementation detail. Prompts stay Claude-tuned — provider portability is a separate per-model effort.

---

## Structured Reviewer Output

The reviewer returns a typed object (`REVIEW_OUTPUT_SCHEMA` in `src/claude/client.ts`), not markdown:
`summary`, `findings[{severity, title, file?, lines?, body}]`, `behavioral_diff[]`, `production_risk[]`, `unresolved_questions[]`, plus optional `can_be_split[]` (SPLIT CHECK add-on), `delta_stats{resolved, still_open, new_findings}` (re-reviews), and `no_change` (delta stop signal).

`renderReview(obj)` (`src/review/formatter.ts`) builds the posted markdown from those fields. Because the code owns the rendering, the model cannot leak preamble, tone, or a footer into the review. `no_change: true` renders the `NO_CHANGE` sentinel (reuses the existing `isNoChange` path). Merge Confidence is NOT rendered here — the judge adds it.

**Why:** prompt-only suppression of leaks proved unreliable (PR 8722); typed fields make the output shape guaranteed and the metrics exact.

---

## Structured Judge Output

The judge (`JUDGE_OUTPUT_SCHEMA`) returns three fields:
- `review_markdown` — the posted comment; the judge still writes this as prose, including `### Merge Confidence: X%`
- `judge_notes` — drop/downgrade rationale; logged, never posted
- `finding_scores[{title, severity, score}]` — per-finding 0–10 confidence, scored independently of severity; logged to `results.jsonl` as `finding_scores` + `min_finding_score`, never posted

The judge is **not** yet fully structured (it emits `review_markdown` prose), so the final `findings` counts and `verdict_score` are still parsed from that markdown. Making the judge emit structured findings — and rendering the scores in the review — is a deferred step (the "visible / structured-judge" path).

---

## Metrics From the Object

`ctx.reviewObject` (reviewer) and `ctx.judgeScores` (judge) are carried on `ReviewContext`. Reviewer-side metrics read the typed object — `review_findings` via `countFindings(reviewObject)`, `delta`/`touch_rate` via `reviewObject.delta_stats` (no more `<!-- DELTA_STATS -->` markdown comment). Judge-side `findings`/`verdict_score` stay regex over the judged markdown (see above). `parseFindings`/`parseVerdictScore`/`parseDeltaStats` remain the judged-text parsers plus defensive helpers.
