# Environment Variables Reference

All variables across all phases. Only Phase 1 vars are required to start.

## Security Rule

**All API keys and tokens must be supplied via environment variables. Never hardcode
credentials in source code or commit them to version control.**

- Locally: use a `.env` file (`.env` is in `.gitignore`)
- In Jenkins: use masked credentials (`withCredentials` block) — see [phases/phase-2-jenkins.md](../phases/phase-2-jenkins.md)
- Never pass secrets as CLI arguments (they appear in process lists and logs)

---

## Phase 1 — Core (Required)

| Variable | Example | Description |
|----------|---------|-------------|
| `VCS_PROVIDER` | `bitbucket` | Which VCS adapter to use. `bitbucket` is production; `azure` and `github` are experimental (see below); `gitlab` is not implemented: from 0.0.46 selecting it (or `--vcs gitlab`) exits 1 at startup with one error line. |
| `BITBUCKET_BASE_URL` | `https://api.bitbucket.org/2.0` | Bitbucket Cloud API base URL (Server/DC is not supported — different v1 API) |
| `BITBUCKET_WORKSPACE` | `my-workspace` | Bitbucket workspace slug |
| `BITBUCKET_USERNAME` | `you@company.com` | Your Atlassian account email (used for HTTP Basic Auth) |
| `BITBUCKET_TOKEN` | `ATATT3x...` | Atlassian API token with Bitbucket scopes (replaces deprecated app passwords) |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Anthropic API key (billed separately from Claude.ai subscriptions) |
| `ANTHROPIC_WORKSPACE_ID` | *(unset)* | Sent as the `anthropic-workspace-id` header. Required when the key isn't workspace-scoped — a user-scoped key (`sk-ant-usr-…`) 400s without it (*"not scoped to a workspace"*). Leave unset for a workspace-scoped key. |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude model ID for reviews: proposes the candidate findings that `JUDGING_MODEL` filters (generator-verifier pattern). With `LLM_PROVIDER=openrouter` this takes an OpenRouter slug (e.g. `anthropic/claude-sonnet-5`, `openai/gpt-…`) |
| `RB_MODEL_BASE_URL` | `https://api.anthropic.com` | Anthropic SDK base URL (set by ReviewBench; a trailing `/v1` is stripped). Unset keeps the SDK default (`ANTHROPIC_BASE_URL` or api.anthropic.com). The other `RB_*` vars only apply under `--benchmark`; see [reviewbench/README.md](../../reviewbench/README.md). |
| `LLM_PROVIDER` | `anthropic` | Model backend behind the reviewer/judge: `anthropic` (native SDK) or `openrouter` (OpenAI-compatible gateway via axios). Selected through the `LLMProvider` seam (`src/llm/provider.ts`). Default: `anthropic` |
| `OPENROUTER_API_KEY` | *(unset)* | OpenRouter key, used when `LLM_PROVIDER=openrouter`; if unset it falls back to the `ANTHROPIC_API_KEY` slot (warned), so a bench/CI slot that only exposes that name works; ignored otherwise |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base URL (`/chat/completions` is appended) |
| `OPENROUTER_REFERER` | `https://github.com/barsurfer/pr-review-agent` | Sent as `HTTP-Referer` — **required** for the run to appear in the OpenRouter dashboard/rankings; set empty to opt out of attribution |
| `OPENROUTER_TITLE` | `pr-review-agent` | Sent as `X-OpenRouter-Title` — the app's display name in OpenRouter analytics; set empty to omit |
| `REPO_SLUG` | *(unset)* | Sent as OpenRouter's `user` field for per-repo segmentation. `--repo-slug` overrides it, so it only matters for runs without that flag (e.g. `--benchmark`) |
| `MAX_RETRIES` | `3` | Max retries on 429/5xx errors (SDK built-in exponential backoff). Default: `3` |
| `MAX_INPUT_TOKENS` | `250000` | If estimated input exceeds this, first drop file contexts and review diff-only; skip only if the diff alone still exceeds it (0 = disabled). `ESTIMATE_TOKENS` logs a per-section breakdown (prompt / diff / delta / file-contexts / prev-reviews / replies) so you can see what drove the size |
| `MAX_OUTPUT_TOKENS` | `32000` | Output-token cap for reviewer + judge (raised from 16k because the Claude 5 family thinks by default and thinking counts against this). Requests stream, so large caps don't hit the HTTP timeout. **Effort coupling:** thinking counts against this cap, so `REVIEW_EFFORT`/`JUDGE_EFFORT` at `xhigh`/`max` can exceed 32k on a non-trivial PR and truncate the response (the run errors rather than posting a cut-off review) — raise to ~`64000` when using high effort. Default/`high` effort fits 32k. |
| `MODEL_CONTEXT_TOKENS` | *(derived)* | Context-window override for the input budgets. The main budget is `min(MAX_INPUT_TOKENS, window − MAX_OUTPUT_TOKENS)` with the window the smaller of the reviewer's and the judge's (both see the diff); breadth, second-look and lens budgets use their own model's window. Unset (`0`) derives each window from the model id: 200K for 4.5-generation (Haiku 4.5), 1M for 4.6+/5.x (incl. Haiku 5.5); OpenRouter Claude slugs resolve as their bare id (`anthropic/claude-sonnet-5.5[:variant]` → `claude-sonnet-5-5`, 1M), as do dated ids. A model the table doesn't map (a non-Claude slug such as `openai/…`, or a version-first one such as `anthropic/claude-3.7-sonnet`) gets, under `LLM_PROVIDER=openrouter`, the smaller of `context_length` and `top_provider.context_length` from OpenRouter's public model list (`GET {OPENROUTER_BASE_URL}/models`: one request per CLI run, 5 s timeout, made only when such a model is configured, never under `--benchmark` or the Anthropic provider, logged as one `Context window from the OpenRouter model list: …` line); a model the list lacks, or a failed lookup, keeps 200K with one startup warning naming the model and this variable. **Rule:** set, it replaces the reviewer's window (whatever the model, as before) and stands in for any other model (judge, breadth, second-look, lens) that the table doesn't map, ahead of the model-list lookup, which is then skipped; a model the table maps keeps its window, so a mapped 200K judge (Haiku 4.5) still caps the budget. For an all-unmapped setup, set it to the smallest real window among those models. |
| `ENABLE_BUNDLED_REVIEW` | `false` | When a PR is still over the input budget after dropping file contexts, split it into per-directory bundles (≤85% of budget each), review each with the normal reviewer + judge, then merge and dedupe — instead of skipping. Off by default; every bundle is a reviewer + judge call, so a huge PR is real spend |
| `MAX_BUNDLES` | `8` | Cap on bundles one over-budget PR may split into (0 = unlimited); the review skips if the plan needs more |
| `MAX_CONTEXT_FILES` | `20` | Max number of files to fetch full content for |
| `MAX_FILE_LINES` | `500` | Files over this line count get diff-only (no full content) |
| `MIN_CHANGED_FILES` | `0` | Skip review if PR has fewer reviewable files (0 = disabled) |
| `MAX_CHANGED_FILES` | `200` | Skip review if PR has more reviewable files (0 = disabled). Default: `200` |
| `MIN_CHANGED_LINES` | `0` | Skip review if PR has fewer reviewable lines (0 = disabled) |
| `MAX_CHANGED_LINES` | `3000` | Skip review if PR has more reviewable lines (0 = disabled). Default: `3000` |
| `SKIP_SOURCE_BRANCHES` | `main,master,release/*` | Comma-separated branch patterns. Skip review if PR source branch matches. Default: `main,master,release/*,hotfix/*`. CLI: `--skip-source-branches=<list>` (empty value = off) |
| `SKIP_TARGET_BRANCHES` | `main,master` | Comma-separated branch patterns. Skip review if PR target branch matches. Default: `main,master`. An explicitly empty value disables the default, so don't pass it as an always-on job parameter shared by every repo. CLI: `--skip-target-branches=<list>` (per repo; `--skip-target-branches=` = off) |
| `ONLY_TARGET_BRANCHES` | `develop,release/*` | Comma-separated branch patterns, same `*` wildcard. When set, skip review if PR target branch matches **none** of them (e.g. stacked PRs until retargeted). Checked after both skip lists, which win on overlap (a target in both `SKIP_TARGET_BRANCHES` and this list logs one warning). Default: empty (off). CLI: `--only-target-branches=<list>`. Main-only recipe: `SKIP_TARGET_BRANCHES=` + `ONLY_TARGET_BRANCHES=main` + `SKIP_SOURCE_BRANCHES=main,master`, or per repo `--skip-target-branches= --only-target-branches=main --skip-source-branches=main,master`. See [review/skip-logic.md §3](../context/review/skip-logic.md) |
| `TRIGGER_EVENT` | `pullrequest:comment_created` | What started the run: Bitbucket `X-Event-Key`, GitHub `${{ github.event_name }}`, Azure `ms.vss-code.git-pullrequest-comment-event`, the comment service hook's event, which the sample reply pipeline passes as a literal (per provider in [review/skip-logic.md §9](../context/review/skip-logic.md)). Logged and recorded as `trigger.event`; only a comment event is checked against `IGNORE_COMMENT_AUTHORS`. Default: empty. CLI: `--event` |
| `TRIGGER_COMMENT_AUTHOR` | `{a1b2c3…}` | Account id of the event **actor** — Bitbucket `$.actor.uuid` (or `account_id`), GitHub `sender.login` / `sender.id`, Azure `resource.comment.author.id` — never the PR author, never the display name. Logged and recorded as `trigger.comment_author`. Default: empty. CLI: `--comment-author` |
| `TRIGGER_EVENT_KIND` | `comment` | From 0.0.46. `comment` or `other`: whether this event is a comment event, overriding the name rule (a name containing `comment`, or exactly `note`, `Note Hook` or `pull_request_review`). Case-insensitive; any other value logs one warning and is ignored. Recorded as `trigger.event_kind` only when given. Set it per event, not job-wide, unless the job receives only comment events: `comment` on a job that also runs on pushes makes a listed author's push skippable. Default: empty (name rule). CLI: `--event-kind` |
| `IGNORE_COMMENT_AUTHORS` | `{bot-uuid}` | Comma-separated actor ids. A comment event by a listed actor skips before any VCS or model call (exit 0, `action: SKIP`); push/created/updated events are never comment events by name, so they are never skipped, whatever the actor. Matching is exact after trim, `{}` strip and lowercase. `--force` overrides it. Default: empty (off). **Caveat:** an ignored event never catches up a push that a skip-if-locked CI lock dropped, so that head stays unreviewed until the next non-ignored event — list an actor only when CI queues push events (Bitbucket `pullrequest:updated`), prefer bots that never comment in response to a push, and don't list the agent's own id under a dropping lock. On GitHub Actions filter commenters in the job `if:` instead. See [review/skip-logic.md §7](../context/review/skip-logic.md) |
| `LAST_CHECKED_COMMIT` | `0123456789ab…` | The `checked_commit` an earlier run reported for this PR (from that run's `results.jsonl` record). When the head equals it (12–64 hex, so SHA-256 heads work too; prefix match, case-insensitive), a re-review on that head goes to `CHECK_REPLIES` like a footer match instead of re-paying the review. Malformed → one warning, treated as unset. Default: empty (off). CLI: `--checked-commit`. **Rollout:** an older bundle exits 1 on the unknown `--checked-commit` flag, so CI should pass this env var instead. See [review/skip-logic.md §8](../context/review/skip-logic.md) |
| `USAGE_RECORD_FILE` | `/tmp/pr-review-record.json` | From 0.0.46. A path that receives only this run's usage record, overwritten on every run, so any CI can read "this run's record" without matching on `JOB_NAME` / `BUILD_NUMBER`. Written next to the `results.jsonl` append, so not with `--log-usage false`; a failed write logs one warning and changes nothing else. Delete the file before the run: a run that fails before writing leaves the previous one. Default: empty (off). No CLI flag. See [usage-logging.md](usage-logging.md#finding-this-runs-record) |
| `DIFF_EXCLUDE_PATTERNS` | `*.lock,*.json,*.spec.ts` | Comma-separated file patterns to strip from diff before sending to Claude. Default: `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml,*.json,*.spec.ts` |
| `JUDGING_MODEL` | `claude-sonnet-5` | Judge model for finding validation — **on by default**. Set empty to disable the judge pass. With `LLM_PROVIDER=openrouter` this takes an OpenRouter slug and may be a different vendor than the reviewer. |
| `REVIEW_EFFORT` | *(unset)* | Reviewer thinking effort: `low`\|`medium`\|`high`\|`xhigh`\|`max`. Unset = model default (a strong model like Opus 4.8 at its adaptive default needs no effort flag). Only the 5-family / Opus-4.6+ / Sonnet-5 support it; models that don't (e.g. Haiku 4.5) are retried without it. `xhigh`/`max` need a larger `MAX_OUTPUT_TOKENS` (~64k) — thinking counts against the output cap and otherwise truncates the review. Applies under both providers: Anthropic sends `output_config.effort`; OpenRouter sends `reasoning: { effort }`, which it maps to the same `output_config.effort` on Claude 4.6+, and a value it rejects with a 400 naming `reasoning` is retried without it. Up to 0.0.47 OpenRouter runs dropped the effort silently, so from the next release an OpenRouter run that sets it reasons more: more output tokens, higher cost, slower. On OpenRouter a budget-based model (Claude ≤4.5) gets a thinking budget of `MAX_OUTPUT_TOKENS` × 0.2/0.5/0.8/0.95 for `low`/`medium`/`high`/`xhigh`·`max` instead of the Anthropic path's retry without effort. See [structured-output.md](../context/llm/structured-output.md#openrouter-specifics). |
| `JUDGE_EFFORT` | *(unset)* | Judge thinking effort — same scale, providers and fallback behavior as `REVIEW_EFFORT`. |
| `ENABLE_JUDGE_KEEP_MINOR` | `false` | Post candidates the judge classifies `minor` (real problem, no runtime impact: stale docs/comments, misleading names, duplication, weak tests in the diff) as LOW instead of dropping them. More LOW comments. See [prompt/judge.md](../context/prompt/judge.md). |
| `ENABLE_JUDGE_KEEP_UNVERIFIED` | `false` | Post candidates the judge classifies `unverifiable` or `framework_uncertainty` (score capped at 5) instead of dropping / moving them to Unresolved Questions. |
| `ENABLE_JUDGE_KEEP_TEST_GAPS` | `false` | Post a candidate the judge classifies `low_value` as LOW when its title or body names a test gap (`isTestGap`: explicit phrases alone, generic ones such as "does not cover" only with a testing word) and its resolved anchor is placeable (`isAnchored`: a positive line); other `low_value` candidates still drop. No prompt or model-call change. Logs `policy_override: 'test_gap'` on the decision and `keep_test_gaps: true` in `judge_policy`. About 0.4 more LOW comments per PR on the replay data. ReviewBench label `J_TGAP`. CLI: `--keep-test-gaps`. See [prompt/judge.md](../context/prompt/judge.md). |
| `ENABLE_JUDGE_PROPOSALS` | `false` | Judge adds a concise fix `proposal` to each kept finding, emitted in `results.jsonl` `anchored_findings[]` and `--benchmark` findings JSON (never the posted comment). Extra judge output tokens; needs a judge. CLI: `--proposals`. |
| `ENABLE_SUGGESTED_FIXES` | `false` | Posts a `**Suggested fix:**` code block (fence info string `suggested-fix-v1`) under each kept finding that has a usable proposal. Implies proposals and switches them to a code-only contract (dedented code, no prose; wins over `ENABLE_JUDGE_PROPOSALS`), so it changes the judge prompt and `judge_prompt_hash`. All blocks are dropped when the comment would exceed 32,000 characters. Not a recall lever and has no ReviewBench label: under `--benchmark` nothing is posted, only `findings.json` proposals become code. Needs a judge; with `JUDGING_MODEL` empty it warns at startup and does nothing. Logs `suggested_fixes` in the usage record. CLI: `--suggested-fixes` (CI should pass the env var until the deployed bundle has the flag). See [prompt/judge.md](../context/prompt/judge.md). |
| `ENABLE_JUDGE_FILE_CONTEXT` | `false` | Send the judge the same full-file context the reviewer got, not just the diff. Roughly doubles judge input tokens. |
| `ENABLE_JUDGE_QUALITY` | `false` | Judge recall lever, still one judge call: a narrow evidence check that lets a `low_value` candidate with a concrete failing scenario be `validated`, stricter same-file `duplicate` validation, guarded per-file expansion, and an app-side dedup of mechanical double counts (`quality_action` markers). Changes the judge prompt and schema. ReviewBench label `J_QUALITY`. See [prompt/judge.md](../context/prompt/judge.md). |
| `ENABLE_JUDGE_SHOWN_CONTEXT_ANCHORS` | `false` | Accept a numeric anchor on an unchanged line when the pass that produced the candidate (breadth, second-look, lens) or the judge was shown that line; reviewer anchors stay ungated. Logs `anchor_basis` on each decision; not applied in bundled review. ReviewBench label `J_SHOWN_ANCHOR`. |
| `MAX_REPLY_COMMENTS` | `5` | Max agent reply comments per PR (0 = unlimited). Prevents runaway token usage on extended conversations. Default: `5` |
| `SKIP_DIRECTED_REPLIES` | `false` | Skip replying to a dev comment `@`-directed solely at someone else (a human/team, not the agent). Bitbucket only; fail-safe keeps all on any uncertainty. CLI: `--skip-directed-replies`. |
| `MAX_FINDINGS` | `0` | Cap the number of findings the reviewer reports (0 = unlimited). When set, appends a findings-limit instruction to the reviewer prompt. |
| `ENABLE_SPLIT_CHECK` | `true` | Reviewer adds a "Can Be Split" section when the PR spans independent themes that could be separate PRs. Set `false` to disable. |
| `ENABLE_TODO_SCAN` | `true` | Deterministically scan added lines for `TODO`/`FIXME`/`HACK` markers and append a "TODOs Introduced" section (file:line) to the review. Skips `.md`/`.mdx`/`.txt`/`.rst` files and any line that quotes the section name; no per-language comment parsing. |
| `ENABLE_NITPICKS` | `false` | Relax the base template's low-severity certainty rule so the reviewer also surfaces real, concrete, low-impact findings (stale/misleading docs, comments or names; dead code; duplicated logic; vacuous tests), each tagged with its `type`, and adds a rule to review non-code files (instructions, templates, docs, config, CI, shell scripts) like code. Off, the assembled base template is byte-identical to `base-prompt.txt`; the two FORBIDDEN style/nitpick lines are never touched. These land as `minor` at the judge, so they post only under `ENABLE_JUDGE_KEEP_MINOR`. See [prompt/composition.md](../context/prompt/composition.md). |
| `ENABLE_LINE_NUMBERS` | `true` | Prefix every added/context diff line (new-file numbering) and every file-context line with its line number in what the reviewer and judge see, and tell the reviewer to cite them. Without it ~40% of findings came back with no `lines`, because models can't count lines from `@@` headers. Costs a few input tokens per line (counted in the token budget and bundle planning); the raw diff used for anchoring is untouched. On by default because the benchmark UI allows only 6 config labels; set `false` to send the raw diff. See [fetching/strategy.md](../context/fetching/strategy.md). |
| `ENABLE_BREADTH_REVIEW` | `false` | Second reviewer pass for changed files the first pass left without a finding (same defect elsewhere, changed-together inconsistencies, incomplete changes); its findings are judged together with the reviewer's. First, single-pass reviews only; needs a judge. See [review/fsm.md](../context/review/fsm.md). |
| `BREADTH_MODEL` | *(unset → `JUDGING_MODEL`)* | Model for the breadth pass. |
| `REPLY_MODEL` | *(unset → reviewer model)* | Model for developer-reply responses — answering a question needs less depth than a review, so a cheaper model (e.g. `claude-haiku-5-5`) cuts reply cost. Empty uses `CLAUDE_MODEL`. A reply-only run logs + costs at this model. CLI: `--reply-model`. |
| `BREADTH_EFFORT` | *(unset → `JUDGE_EFFORT` when falling back to the judge model)* | Effort for the breadth pass — same scale, providers and fallback behavior as `REVIEW_EFFORT`. |
| `BREADTH_MIN_FILES` | `5` | Skip breadth below this many reviewable changed files. |
| `BREADTH_MIN_UNTOUCHED` | `3` | Skip breadth when fewer reviewable files than this have no reviewer finding. An empty or non-numeric `BREADTH_MIN_FILES` / `BREADTH_MIN_UNTOUCHED` falls back to the default. |
| `ENABLE_BREADTH_PRIORITY_TARGETS` | `false` | Pick the breadth pass's 40 listed untouched files by subsystem diversity and nearness to a finding instead of diff order, leaving release-entry `.changeset/*.md` files out of the briefing; `untouched_files` logs the selection. ReviewBench label `B_PRIORITY`. |
| `ENABLE_SECOND_LOOK` | `false` | Second reviewer pass over the changed files that already have a reviewer finding, shown only those files' diff sections and contexts plus the known findings, to find what the first pass missed there; runs on `CLAUDE_MODEL` at `REVIEW_EFFORT`, and its findings are judged with the reviewer's (`origin` `second_look`). First, single-pass reviews only; needs a judge. CLI: `--second-look`; ReviewBench label `SECOND_LOOK`. See [review/fsm.md](../context/review/fsm.md). |
| `ENABLE_SECOND_LOOK_BREADTH_TARGETS` | `false` | Second-look also re-reads files that only the breadth pass flagged (targets come from reviewer + breadth findings). ReviewBench label `SL_BREADTH`. |
| `ENABLE_LENSES` | `false` | Run the concern-specific reviewer passes named in `LENSES` after second-look; their findings are judged together with the reviewer's (`origin` `lens:<name>`). Each lens is another reviewer-sized call (full diff + file contexts). First, single-pass reviews only; needs a judge. Only the exact string `true` enables it. CLI: `--lenses <list>` (sets `LENSES` and enables). Benchmark: label `LENSES`. See [review/fsm.md](../context/review/fsm.md). |
| `LENSES` | *(empty)* | Comma- or plus-separated lens names, run in order: `reliability`, `security`, `testing`, `performance`, `architecture`, or the aliases `rel`, `sec`, `test`, `perf`, `arch` (case-insensitive; an alias resolves to its full name, deduped on that). Unknown names are warned about and ignored; with no known name no lens runs. |
| `LENS_MODEL` | *(unset → `CLAUDE_MODEL`)* | Model for lens passes. Unset uses the reviewer model at `REVIEW_EFFORT`; set, the lens runs at that model's default effort. |
| `ENABLE_LENS_RECOMMENDATION` | `false` | Log-only: the first-pass reviewer also returns which lenses are worth running for this PR (`lens_recommendations` in `results.jsonl`), via one extra schema field — the system prompt is unchanged and no extra call is made. Never enables, skips or reorders a lens; independent of `ENABLE_LENSES` (alone: what it would recommend; with lenses: attribution against `lens_runs`). First, single-pass reviews only. Only the exact string `true` enables it. CLI: `--lens-recommendation`; ReviewBench label `LENS_REC`. |
| `BENCHMARK_DEADLINE_SECONDS` | `840` | ReviewBench only: the entrypoint kills the agent at this many seconds; breadth, second-look and any remaining lenses are skipped (`skipped_time`) once more than half has elapsed. Malformed or non-positive values fall back to `840`. See [reviewbench/README.md](../../reviewbench/README.md). |
| `ENABLE_BENCHMARK_COUNTERPART_ROWS` | `false` | `--benchmark` only: after the original rows, `findings.json` also gets a copy of each kept, placed finding at each other changed, non-deleted file its reviewer title or body cites with a line (`<file>.<ext>:N`, `:LN`, ` line(s) N[-M]`, ` (line N`, `#LN`, ` LN`), at most 3 per finding. Prompts, model calls, `anchored_findings` and judge decisions are unchanged; the benchmark record logs `counterpart_rows`. Outside `--benchmark` it has no effect at all. Only the exact string `true` enables it. ReviewBench label `XROWS`; no CLI flag. See [vcs/adapter.md](../context/vcs/adapter.md). |
| `AGENT_IDENTITY` | *(BITBUCKET_USERNAME)* | Name shown in review/reply footers. Falls back to `BITBUCKET_USERNAME`, then `'Claude'` |

> Threshold variables can also be set via CLI flags (`--min-changed-files`, etc.)
> which override the env var values. Model/token/effort too: `CLAUDE_MODEL`/`JUDGING_MODEL`
> → `--model`/`--judge-model`; `REPLY_MODEL` → `--reply-model`; `MAX_INPUT_TOKENS`/`MAX_OUTPUT_TOKENS` →
> `--max-input-tokens`/`--max-output-tokens`; `REVIEW_EFFORT`/`JUDGE_EFFORT` →
> `--effort`/`--judge-effort`; `TRIGGER_EVENT`/`TRIGGER_COMMENT_AUTHOR`/`TRIGGER_EVENT_KIND` → `--event`/`--comment-author`/`--event-kind`;
> `LAST_CHECKED_COMMIT` → `--checked-commit`
> (an empty CLI value, as CI systems pass an unset parameter, falls back to the env value). CLI always wins over env.
> `SKIP_SOURCE_BRANCHES`/`SKIP_TARGET_BRANCHES`/`ONLY_TARGET_BRANCHES` → `--skip-source-branches`/`--skip-target-branches`/`--only-target-branches`,
> for per-repo values when the CI env is shared. Here an empty value does **not** fall back: `--skip-target-branches=` is an empty
> list, i.e. that check is off. Write empty values in the `=` form; an unquoted empty value makes the flag swallow the next argument.
> See [review/skip-logic.md §3](../context/review/skip-logic.md). `IGNORE_COMMENT_AUTHORS` has no CLI flag.
>
> **Rollout:** commander rejects an unknown flag with exit 1, so a bundle that predates a flag (or a rollback to one) fails every run
> that passes it. Pass `TRIGGER_EVENT`/`TRIGGER_COMMENT_AUTHOR`/`TRIGGER_EVENT_KIND`/`LAST_CHECKED_COMMIT` as env vars rather than flags in CI; add the
> branch-list flags to a job only once the bundle it runs has them, and remove them before rolling the bundle back.
>
> Threshold counts are **reviewable** files/lines — computed after `DIFF_EXCLUDE_PATTERNS`
> filtering, so excluded files never trip the limits. A PR with zero reviewable lines
> after exclusions is skipped before any API call.

### `--force` CLI flag

Controls dedup bypass behavior. The flag is optional-value — its behavior depends on how it is passed:

| Invocation | `force` value | Effect |
|------------|---------------|--------|
| *(not passed)* | `off` | Normal dedup — skip if same commit already reviewed |
| `--force` | `re-review` | Bypass dedup, keep prior review context |
| `--force clean` | `clean` | Bypass dedup, strip prior review from context |
| `--force ""` / `--force=` / whitespace | `off` | Same as not passed, including the pre-post race check — CI passes an unset parameter as an empty value |
| `--force <anything else>` | passed through | Not rejected: dedups and marks `checked_commit` like `off`, but skips the pre-post race check (only `off` runs it); recorded as given in `force` |

> In CI write `--force="$FORCE"` (or `--force=$FORCE`): an unquoted empty value vanishes in the shell and leaves a bare `--force`, which means re-review on every event.
>
> Note: prior to the fix, Commander's default value caused `--force` to behave as `re-review`
> even when the flag was not passed at all, effectively disabling dedup on every run.

---

## Azure DevOps (Experimental / WIP)

Selected with `--vcs azure` or `VCS_PROVIDER=azure`. Implements the full adapter interface
and is **validated live end-to-end against Azure DevOps Services (cloud)** — on-prem
**Server** is still WIP. Prints a one-line WIP warning on construction.

| Variable | Example | Description |
|----------|---------|-------------|
| `AZURE_BASE_URL` | `https://dev.azure.com` | API base URL. Default is cloud Services; set to an on-prem **Server** collection URL for self-hosted. |
| `AZURE_ORG` | `my-org` | Organization / collection name (required). Can also be set via `--workspace`. |
| `AZURE_PROJECT` | `my-project` | Project name (required). |
| `AZURE_ACCESS_TOKEN` | `$(System.AccessToken)` | OAuth Bearer token — e.g. the Azure Pipelines built-in `System.AccessToken`. Zero-PAT auth. **One of this or `AZURE_PAT` is required.** |
| `AZURE_PAT` | `xxxxxxxx...` | Personal Access Token. Scopes: Code (read) + Threads (read & write). Sent as HTTP Basic `base64(":{PAT}")` (empty username). **One of this or `AZURE_ACCESS_TOKEN` is required.** |

**Auth selection:** if `AZURE_ACCESS_TOKEN` is set it is used as `Authorization: Bearer …`
(preferred in pipelines); otherwise `AZURE_PAT` is used as HTTP Basic. `validateAzureConfig()`
requires `AZURE_ORG`, `AZURE_PROJECT`, and **at least one** of the two credentials — otherwise
it throws `Missing required environment variable: AZURE_PAT or AZURE_ACCESS_TOKEN`.

Repository is passed via `--repo-slug` (repo name or GUID). All calls send `?api-version=7.1`.
The diff is reconstructed from the `diffs/commits` change list + per-file blob content
(no native unified-diff endpoint), using the `diff` (jsdiff) library. See
[`azure/azure-pipelines.yml`](../../azure/azure-pipelines.yml) for a ready-to-use CI pipeline.

---

## GitHub (Experimental — same-repo PRs)

Selected with `--vcs github` or `VCS_PROVIDER=github`. Fully implemented for **same-repo**
PRs and triggered via GitHub Actions; fork PRs are out of scope (read-only token, no secrets).
Reviews and replies are flat issue comments (no threading); no inline comments yet.

| Variable | Example | Description |
|----------|---------|-------------|
| `GITHUB_BASE_URL` | `https://api.github.com` | API base URL. Point at `https://<host>/api/v3` for GitHub Enterprise Server. |
| `GITHUB_OWNER` | `my-org` | Repository owner (org or user). Required. Can also be set via `--workspace`. Logged as the usage record's `workspace` from 0.0.46. |
| `GITHUB_TOKEN` | `ghp_…` / `github_pat_…` | Token with PR read/write on the repo. Required. In Actions, the workflow-provided `GITHUB_TOKEN` secret is used. |

`validateGitHubConfig()` requires `GITHUB_OWNER` and `GITHUB_TOKEN`. Repository is passed via
`--repo-slug`. A large PR whose diff the PR endpoint refuses (406) falls back to the `/compare`
endpoint; past 3000 changed files or a 25 MB diff the run is a clean SKIP, never an error.

**GitHub Actions trigger.** [`.github/workflows/pr-review.yml`](../../.github/workflows/pr-review.yml)
is the GitHub-native equivalent of the Jenkins/Azure pipelines. It reviews on `pull_request`
(opened/synchronize/reopened, and `edited` on a base change) and replies on `issue_comment`
(created), guarded in the job `if:` to same-repo PRs and trusted non-bot commenters, with
`permissions: pull-requests: write` / `contents: read` and job-level `concurrency` per PR without
`cancel-in-progress`. Its LLM secret is `OPENROUTER_API_KEY` (`LLM_PROVIDER: openrouter`). Details:
[github-actions.md](github-actions.md). It sets two env values worth noting:

- `AGENT_IDENTITY: github-actions[bot]` — the name shown in review/reply footers. (The agent
  doesn't re-trigger itself because a comment posted with `GITHUB_TOKEN` starts no workflow run;
  the adapter detects its own comments by footer, not author, and from 0.0.46 never treats a
  `Bot` account's comment as a reply.)
- `SKIP_TARGET_BRANCHES: ""` — the GitHub flow targets `main` directly, so the `main,master`
  default would skip every PR; it must be emptied for the Actions path.

---

## Phase 4 — Inline Comments (planned — not implemented)

| Variable | Example | Description |
|----------|---------|-------------|
| `REVIEW_MODE` | `summary` | `summary` \| `inline` \| `both`. Default: `summary` |
| `MAX_INLINE_COMMENTS` | `30` | Cap on inline comments per review. Remainder goes in summary. |

---

## Backlog — GitLab Adapter

See [phases/phase-3-multi-vcs.md](../phases/phase-3-multi-vcs.md) for env vars
needed when the GitLab adapter is implemented. From 0.0.46 `--vcs gitlab` / `VCS_PROVIDER=gitlab`
exits 1 at startup. A real adapter also needs a working `getCommitDiff` before the checked commit saves
anything: a failed delta fetch withholds `checked_commit` for the run, and GitLab's compare API
returns JSON diffs, so the unified diff must be reconstructed as on Azure.

---

## `.env.example`

The repo-root [`.env.example`](../../.env.example) is the copy-and-edit template (`cp .env.example .env`): the Bitbucket and Anthropic values to fill in, plus the optional settings commented out at their defaults. This page stays the complete reference.
