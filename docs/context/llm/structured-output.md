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

`createProvider(apiKey)` selects the impl by `LLM_PROVIDER` (`anthropic` default, or `openrouter`; anything else throws). `provider.ts` is the stable facade (factory + re-exports); each impl lives in its own file (`anthropic-provider.ts`, `openrouter-provider.ts`) over the shared contracts in `shared.ts`, so a new backend is a new class and file — not a re-plumb across the codebase. Both `complete` and `completeStructured` throw a `TruncatedResponseError` on a cut-off (`max_tokens` / `finish_reason: length`) — it carries the response usage, so the record keeps real token counts (not zeros); `completeStructured` also throws on invalid JSON or missing required keys, so a truncated or malformed object is never returned.

Usage currency is `LLMUsage` (defined in `shared.ts`, re-exported by `provider.ts`; formerly `ClaudeUsage`): token counts plus an optional `cost_usd`. `cost_usd` is set only by OpenRouter; when absent (Anthropic) the usage record falls back to the static pricing-table estimate, so the Anthropic record is unchanged.

| Impl | Selected by | Transport | Notes |
|------|-------------|-----------|-------|
| `AnthropicProvider` | `LLM_PROVIDER=anthropic` (default) | `@anthropic-ai/sdk`, streamed | Structured output via `output_config.format`; effort rides `output_config.effort` with a one-shot retry without it on a 400 |
| `OpenRouterProvider` | `LLM_PROVIDER=openrouter` | axios → OpenAI-compatible `POST {OPENROUTER_BASE_URL}/chat/completions`, non-streaming | See below |

**Why:** isolate each provider behind one seam and make structured output and the backend an implementation detail. Prompts stay Claude-tuned — portability to other models is a separate per-model effort.

### OpenRouter specifics

- **Structured output:** `response_format` json_schema with `strict: false` (our reviewer/judge schemas don't meet OpenAI strict mode's all-keys-required rule), guarded by `JSON.parse` + `missingRequired(object, schema, true)` — the `deep` pass validates the root keys **and** one level of array-item required keys (`findings[].severity`, `decisions[].candidate_id`), so a strict:false model that drops a nested field fails loud instead of silently skewing `review_findings`/`computed_score`. Fields nested deeper than one array level stay best-effort; gate model choice on `supported_parameters`.
- **Per-model reliability:** structured-output fidelity depends on the routed model, not the transport. OpenRouter forwards `response_format` only to models that support it; others ignore it and the parse guard fails loud. Gate model choice on OpenRouter's `supported_parameters`.
- **Errors:** normalized inside the provider to the Anthropic-recognized `{status, message}` shape (including an HTTP 200 body carrying an `error`). A 400 context overflow is surfaced with a message the existing `isContextLengthError` regex matches, so the degrade-to-diff-only backstop works with no shared-code change.
- **Retries:** hand-rolled — 429/5xx and connection errors, honoring `Retry-After`, with backoff. Timeouts are **not** retried (a non-streaming timeout may have already billed upstream).
- **Cost:** requests send `usage: { include: true }`; the returned USD cost lands in `cost_usd` and is logged instead of a wrong-model pricing-table estimate. A BYOK key reports `usage.cost` as 0, so the real `cost_details.upstream_inference_cost` is used instead.
- **Attribution:** sends `HTTP-Referer` (`OPENROUTER_REFERER`, default the repo URL) and `X-OpenRouter-Title` (`OPENROUTER_TITLE`, default `pr-review-agent`) so runs appear on the OpenRouter dashboard/rankings. `HTTP-Referer` must be non-empty or usage is unattributed; set either env empty to opt out. Also tags each request with `user` = the reviewed repo slug (`config.repoSlug`, from `--repo-slug`) for per-repo segmentation — OpenRouter documents `user` for abuse-prevention, so it may not surface in analytics.
- **Dropped:** `effort` is ignored (no portable equivalent).
- **Context window:** the window table is keyed by Claude model ids, so a non-Claude slug falls back to 200K; set `MODEL_CONTEXT_TOKENS` to the routed model's real window.
- **Models:** `CLAUDE_MODEL` / `JUDGING_MODEL` take OpenRouter slugs (`anthropic/claude-sonnet-5`, `openai/gpt-…`). Reviewer and judge pass their own slug to the same provider, so one run can mix vendors (e.g. Claude reviewer, OpenAI judge). Selection is global per run: native Anthropic and OpenRouter can't be mixed — route both through OpenRouter.
- **ReviewBench** defaults to Anthropic; there is no benchmark-mode guard, so an OpenRouter run stays reachable by env.

---

## Structured Reviewer Output

The reviewer returns a typed object (`REVIEW_OUTPUT_SCHEMA` in `src/review/client.ts`), not markdown:
`summary`, `findings[{severity, title, file?, lines?, body, type?}]` (`type` = one of `ISSUE_TYPES` in `src/review/formatter.ts` — analytics-only, nothing keys off it), `behavioral_diff[]`, `production_risk[]`, `unresolved_questions[]`, plus optional `can_be_split[]` (SPLIT CHECK add-on), `delta_stats{resolved, still_open, new_findings}` (re-reviews), and `no_change` (delta stop signal). The extra passes share one findings-only core, `runLens(…, systemPrompt, briefing, lineNumbers, label)`: the reviewer payload without prior reviews or discussion + a briefing in, `findings[]` only out (`BREADTH_OUTPUT_SCHEMA`, reusing the reviewer's finding item schema), plus `promptHash` (sha256-12 of the system prompt). `runBreadth` is a thin wrapper that only defaults the log label to `breadth`, so breadth requests are unchanged; second-look calls it with label `second-look`, and each lens calls `runLens` with `lens:<name>`. Their findings go to the judge, never into `reviewObject`.

`lens_recommendations` is a schema variant only: `reviewOutputSchema(lensRecommendation)` returns the `REVIEW_OUTPUT_SCHEMA` constant itself when off, otherwise a cached clone with one required `lens_recommendations[{lens, reason}]` (`lens` enum = `LENS_REGISTRY` keys; the field description lists each lens with its `when` trigger phrase and asks for an empty array on small, cosmetic or unrelated changes), so the system prompt and prompt hash never change. `runReview` requests it only via its trailing `lensRecommendation` arg (`ENABLE_LENS_RECOMMENDATION`, first single-pass review), strips it before `renderReview`, and returns it as `lensRecommendations` after `sanitizeLensRecommendations` (known names only, first per lens wins, `reason` whitespace-collapsed, trimmed and capped at `LENS_REASON_CAP` 200; `null` when the field is missing or not an array, `[]` when none was recommended), so `reviewObject`, the judge input, findings output and the posted comment never carry it. That request also sets `LLMOptions.tolerateMissing: ['lens_recommendations']`, which makes `missingRequired` skip that root key and its item check in both providers while the schema stays strict, because a log-only field must never fail the review (OpenRouter's deep check would otherwise throw on an omitted field or a dropped `reason`); with the flag off the options object is unchanged. Log-only: nothing gates a lens on it yet.

`renderReview(obj)` (`src/review/formatter.ts`) builds the posted markdown from those fields. Because the code owns the rendering, the model cannot leak preamble, tone, or a footer into the review. `no_change: true` renders the `NO_CHANGE` sentinel (reuses the existing `isNoChange` path). Merge Confidence is NOT rendered here — the judge adds it.

**Why:** prompt-only suppression of leaks proved unreliable in production; typed fields make the output shape guaranteed and the metrics exact.

---

## Structured Judge Output

The judge (`JUDGE_OUTPUT_SCHEMA`) rules on reviewer candidates by id and writes the narrative. It never writes the posted markdown:
- `decisions[{candidate_id, reason_category, evidence, note, score, rewritten_body?, question?, anchor_file?, anchor_lines?, anchor_quote?, proposal?}]` — one per candidate; `reason_category` is one of `REASON_CATEGORIES` (`src/review/judge-decisions.ts`); `anchor_quote` is a verbatim diff line used for deterministic anchoring
- `summary`, `behavioral_diff[]`, `production_risk[]`, `unresolved_questions[]`, `merge_confidence` (0–100)
- `proposal?` is a schema variant only: `judgeOutputSchema(quality, shownAnchors, proposals)` returns the shared `JUDGE_OUTPUT_SCHEMA` when all three are off, otherwise a cached clone (key `quality:shownAnchors:proposals`) with `PROPOSAL_DECISION_PROPERTIES` merged in, never `required`. `sanitizeProposal` rejects non-string or blank input and omits (never truncates) anything over `PROPOSAL_CAP` (500) chars or over `PROPOSAL_MAX_LINES` (7) non-blank lines (split on `\r\n`, `\r`, `\n`); there is no fence parsing; it is stashed per decision and emitted only on KEPT candidates, so `KeptFinding.proposal?`, `ReportFinding.proposal?`, `AppliedDecision.proposal?` and `anchored_findings[].proposal?` are absent unless `ENABLE_JUDGE_PROPOSALS` is on and the judge supplied one. Per-file expansion rows never carry one.

`applyJudgeDecisions` applies the policy table (see [prompt/judge.md](../prompt/judge.md)), and `renderJudgedReview` builds the posted comment. Kept findings resolve an anchor via `locateInDiff` in order: the reviewer's `file:line` when strictly numeric (`anchorSource: 'reviewer'`, **ungated** — never dropped, since the reviewer sees full files and may cite context/out-of-diff lines; a breadth candidate's line must be on a changed line), else the judge's `anchor_file`/`anchor_lines` validated to a changed line (`'judge'`), else a single verbatim `anchor_quote` located in the diff (`'diff'`); a finding that resolves to none keeps only its file, and the benchmark places it on that file's first added line (`'file'`, see [vcs/adapter.md](../vcs/adapter.md)) or drops it with a `Parse check` warning when the file is missing, deleted, or not in the diff. The benchmark reads them directly (`ReviewOutcome.judgedFindings` → `keptToReportFindings`) instead of re-parsing prose. Only the bundled path still uses the prose merge (`mergeJudgedFindingsWithStats`), fed by the same rendered markdown.

**Why:** the judge used to write the comment as prose, so kept findings had to be fuzzy-matched back to reviewer anchors, and drop reasons existed only as a console note. Typed decisions make every drop attributable and logged.

---

## Metrics From the Object

`ctx.reviewObject` (reviewer) and `ctx.judgeScores` / `ctx.judgeDecisions` / `ctx.judgeAnomalies` / `ctx.judgedFindings` (judge) are carried on `ReviewContext`. Reviewer-side metrics read the typed object — `review_findings` via `countFindings(reviewObject)`, `delta`/`touch_rate` via `reviewObject.delta_stats` (no more `<!-- DELTA_STATS -->` markdown comment). Judge-side `findings`/`verdict_score` are still regex over the judged markdown, which is now app-rendered and so exact. `parseFindings`/`parseVerdictScore`/`parseDeltaStats` remain the judged-text parsers plus defensive helpers. The record also carries `anchored_findings[]` — one compact `{anchor, severity, type, description, proposal?, quality_action?}` row per kept finding that resolved to a real line (`isAnchored`); `proposal?` only under `ENABLE_JUDGE_PROPOSALS` with a judge-supplied fix, `quality_action?` only under `ENABLE_JUDGE_QUALITY`. With lenses active (`ENABLE_LENSES` + ≥1 known name in `LENSES`), it also carries `lens_runs[]` — one `{name, status, model, prompt_hash, tokens, cost_usd, findings}` row per listed lens (`findings` is a count; `cost_usd` is the provider's actual, else the pricing-table estimate at the lens model, and is included in the top-level `cost_usd`), or `null` when `LENS_REVIEW` wasn't reached; with lenses off the key is absent, not null, so a lens-off record serializes as before. With `ENABLE_LENS_RECOMMENDATION` on it also carries `lens_recommendations[]` (`{lens, reason}` from the reviewer's object, `[]` for none, `null` when not requested or not answered); off, the key is absent.
