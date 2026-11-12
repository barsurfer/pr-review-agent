# Knowhere Map

Hierarchical index of project documentation for AI agents.

Rule: Each entry has a 1-sentence summary: key concepts, keywords, tech; ends with "read for X" to indicate when to consult.

---

## Core

- [summary.md](summary.md) — One-paragraph snapshot of the agent: what it does, stack, VCS support, model; read for orientation.
- [terminology.md](terminology.md) — Domain glossary: PR Review, Delta Review, NO_CHANGE, commit hash dedup, checked commit, generator-verifier, repo prompt sections; read when vocabulary is ambiguous.
- [practices.md](practices.md) — Project-wide patterns: stateless design (plus the optional CI-held checked commit), FSM orchestration, API-only, footer-based dedup, generator-verifier, VCS adapter, reply bundling, FORBIDDEN rules, bundle/deploy (LF-normalised embedded prompts, `.gitattributes` eol pins), versioning/releases (raw-URL by tag), CI test gate; read before making architectural decisions.
- [../../AGENTS.md](../../AGENTS.md) — code conventions: comments (WHY-not-WHAT, one line, no ticket numbers, no breadcrumbs/commented-out code) and commits (stop at the edit, stage by path, single-line `<KEY> -> type(scope): summary`, no trailers); read before writing code or committing. `/deslop` enforces the comment rules.

---

## Domain Specs

- [review/](review/)
  - [review/fsm.md](review/fsm.md) — 21-state FSM: all states, transitions, 11 skip/review outcomes, CHECK_TRIGGER initial state (IGNORE_COMMENT_AUTHORS skip before any VCS call), CHECK_BRANCHES incl. ONLY_TARGET_BRANCHES, CHECK_PREVIOUS_REVIEWS checked-commit dedup (LAST_CHECKED_COMMIT → CHECK_REPLIES) and the checked_commit mark points, BREADTH_REVIEW second pass (ENABLE_BREADTH_REVIEW, untouched-files trigger, BREADTH_MODEL → judge model), SECOND_LOOK re-read of already-flagged files (ENABLE_SECOND_LOOK, restricted diff, reviewer model, second_look_status values), LENS_REVIEW concern-specific lenses (ENABLE_LENSES/LENSES/LENS_MODEL, reliability/security/testing/performance/architecture + aliases rel/sec/test/perf/arch, per-lens skip statuses, budget/deadline, experimental status with no repeatable recall gain), log-only lens recommendation at CALL_MODEL (ENABLE_LENS_RECOMMENDATION, first single-pass review), BUNDLED_REVIEW big-PR path (directory bundles, per-bundle reviewer+judge, merge/dedupe, ENABLE_BUNDLED_REVIEW/MAX_BUNDLES), abridged ReviewContext interface, POST_REVIEW safety guards; read when changing orchestration logic.
  - [review/skip-logic.md](review/skip-logic.md) — All skip mechanisms: commit hash dedup, delta diff pre-check, branch exclusion + ONLY_TARGET_BRANCHES allow-list (precedence, per-repo --skip-*/--only-target-branches flags where an empty value disables a list, `=` form for empty values, main-only/git-flow recipes as arguments, stacked PRs until retargeted, empty-value trap), size thresholds, reply limit, oversized-diff fetch failure (`PrTooLargeError` → SKIP, GitHub), trigger pre-check (--event/--comment-author, IGNORE_COMMENT_AUTHORS, actor id not PR author, dropped-push caveat), checked commit from CI (LAST_CHECKED_COMMIT/--checked-commit, prefix match, checked_commit mark rule, CI store/read contract, env-over-flag rollout rule, retarget limitation); read when debugging unexpected skips or wiring CI dedup.
  - [review/replies.md](review/replies.md) — Reply detection algorithm, recursive parent tracking, stale-reply loop fix, bundled response, reply footer, reply limit; read when working on comment threading.

- [prompt/](prompt/)
  - [prompt/composition.md](prompt/composition.md) — Prompt assembly: base template vs repo sections, ENABLE_NITPICKS (relaxed low-severity rule + non-code files rule), lens prompts (reviewer prompt + FINDINGS LIMIT + code-side lens overlays, lens briefing, testing-lens caveat), resolution order incl. monorepo module-dir fallback and composable tech-stack fallback (base language + framework overlays detected from changed files/diff, template suffixes peeled), generic OWASP security baseline (swappable by a repo/stack SECURITY section), FORBIDDEN rules with rationale, delta review rules, developer trust rules, SCOPE LOCK, structured reviewer output (fields, not markdown), reply prompt; read when changing prompt logic or adding FORBIDDEN rules.
  - [prompt/judge.md](prompt/judge.md) — Judge model: model choice (reviewer sets the recall ceiling), when it runs (reviewer + breadth/second-look/lens candidates, origin `lens:<name>`), what it sees (numbered diff, optional file context), decision contract (candidate ids, reason categories, app-side policy table, ENABLE_JUDGE_KEEP_MINOR/KEEP_UNVERIFIED/FILE_CONTEXT/PROPOSALS flags (proposals = optional per-finding fix in JSON outputs), evidence rule, anomalies), anchor resolution, logged judge_decisions/review_candidates, Merge Confidence vs computed_score, finding_scores; read when configuring or modifying the generator-verifier pass.

- [llm/](llm/)
  - [llm/structured-output.md](llm/structured-output.md) — LLMProvider seam with Anthropic + OpenRouter impls (complete/completeStructured, LLM_PROVIDER, LLMUsage/cost_usd, OpenRouter strict:false/error normalization), structured reviewer output (REVIEW_OUTPUT_SCHEMA → renderReview; no_change/can_be_split/delta_stats fields; findings-only `runLens` core + BREADTH_OUTPUT_SCHEMA shared by breadth/second-look/lenses; `reviewOutputSchema` lens_recommendations variant, stripped in `runReview`), structured judge output (decisions + narrative; app renders the comment, benchmark reads judgedFindings), and which metrics read the typed object vs regex (incl. `lens_runs` / `lens_recommendations` usage rows); read when changing model I/O, output shape, or metrics sourcing.

- [vcs/](vcs/)
  - [vcs/adapter.md](vcs/adapter.md) — VCSAdapter interface, Bitbucket implementation (auth, redirect handling, required scopes), Azure DevOps adapter (WIP but live-validated on cloud — why the diff is reconstructed since there's no unified-diff REST endpoint, thread model, composite IDs, dual auth, ref version-type lookup), GitHub adapter (experimental, same-repo via Actions — flat issue-comment reply model, Link pagination, 406→compare diff fallback + `PrTooLargeError`), provider selection, ReviewBench filesystem adapter + `--benchmark` findings output (file-level anchor fallback, `LENSES` value label + `lenses=` echo, `LENS_REC` label + `lens_rec=1` echo), supporting types, Phase 4 inline comment extension; read when changing VCS behavior, adding a new adapter, or touching benchmark mode.

- [fetching/](fetching/)
  - [fetching/strategy.md](fetching/strategy.md) — Two-form diff (raw vs filtered), full file context exclusion rules, high-churn priority, MAX_CONTEXT_FILES/MAX_FILE_LINES, why local testing runs deliberately low limits (drift observation), full payload format for review and reply, numbered diff/file-context gutter (ENABLE_LINE_NUMBERS); read when changing what context is sent to Claude.

---

## Reference

- [../reference/env-vars.md](../reference/env-vars.md) — Every environment variable with its default (VCS/Azure/GitHub credentials, LLM_PROVIDER/OpenRouter, models and effort, token budgets, thresholds, judge policy flags, breadth/second-look/lens/recall levers, BENCHMARK_DEADLINE_SECONDS, branch skip/allow lists, TRIGGER_EVENT/TRIGGER_COMMENT_AUTHOR/IGNORE_COMMENT_AUTHORS, LAST_CHECKED_COMMIT) and its CLI override, plus why CI should pass env vars rather than new flags; read when adding, renaming or defaulting a setting.
- [../reference/usage-logging.md](../reference/usage-logging.md) — results.jsonl record schema (tokens summed over all calls, cost_usd actual-or-estimated, per-stage breadth/second_look/lens_runs cost and status, judge_decisions with flag-gated extras, recall_levers, optional trigger, optional checked_commit/dedup_source), action values, telling skipped from reviewed in CI (exit codes, last-line action), storing checked_commit per PR for the next run, MODEL_PRICING cost estimation incl. OpenRouter anthropic/ slug normalization, jq queries incl. cost by stage; read when adding a usage field or analysing runs.
- [../../reviewbench/README.md](../../reviewbench/README.md) — ReviewBench image: --benchmark flow, fail-safe/deadline entrypoint, every RB_CONFIG_* label and its env var, 6-label manifest cap and 64-char row-id limit (short keys, lens aliases, omit MODEL when baked), Dockerfile baked ENV/build-arg defaults, Benchmark settings echo line; read before configuring or interpreting a benchmark run.
- [../reference/azure-devops.md](../reference/azure-devops.md) — Azure DevOps CI wiring: build-validation pipeline, System.AccessToken auth, first-setup gotchas, Service Hook → Incoming Webhook reply pipeline; read when setting up or debugging the Azure trigger.
- [../reference/copilot-integration.md](../reference/copilot-integration.md) — Sharing one prompt file between the agent (.agent-review-instructions.md sections) and GitHub Copilot (.prompt.md) via symlinks; read when authoring a repo prompt for both tools.
- [../architecture/overview.md](../architecture/overview.md) — Repository structure (src/ module map, prompts/, workflows, reviewbench/), tech stack, condensed FSM and out-of-scope list; read for orientation on where code lives.


## Session greeting (read-proof)

When you finish loading this map, open your first reply of the session with the
greeting below, verbatim. It is the proof that you actually read the map - it lives
nowhere else, so reciting it confirms the gate was honored.

> Just another day at the office, lets do it!
