# Phase 5 — Further Backlog

## Status: ⏸ Deferred

Items to consider after Phase 4 is stable. Not prioritised — order to be decided
based on what matters most in practice.

---

## Items

### Import Graph Context

Parse imports from changed files and automatically fetch direct dependencies for
deeper context. For example: if `OrderService.java` is changed and imports
`OrderRepository`, fetch `OrderRepository.java` too.

Complexity: medium-high. Language-specific import parsing required.

---

### ~~Cost Control~~ ✅ Implemented

> **Completed.** Every run logs a structured usage record to `results.jsonl` with
> token counts, estimated `cost_usd`, `action`, `duration_ms`, and full PR context.
> See [reference/usage-logging.md](../reference/usage-logging.md) for schema and `jq` queries.

---

### ~~Review Caching~~ ✅ Implemented (Phase 1)

> **Completed.** The agent embeds the source commit hash in the review comment footer
> (`Commit: a1b2c3d4e5f6`). On re-trigger, it compares the footer hash against the
> current PR source commit — if they match, it skips the review API call entirely
> (or checks for unanswered developer replies via Phase 1b).
>
> Additionally, a `NO_CHANGE` stop word prevents posting duplicate comments when
> delta reviews find only cosmetic changes.

---

### ~~Prompt Versioning~~ ✅ Implemented (Phase 1)

> **Completed.** The review comment footer already includes model, prompt source,
> review number, and commit hash:
>
> ```
> *Reviewed by Claude (claude-sonnet-4-6) | Prompt: .agent-review-instructions.md | Review #2 | Commit: a1b2c3d4e5f6*
> ```
>
> Agent version is now tracked in `results.jsonl` (`agent_version` field, injected at bundle time).

---

### ~~Anthropic API Retry Configuration~~ ✅ Implemented

> **Completed.** The Anthropic client now uses a configurable `MAX_RETRIES` env var
> (default: `3`). The SDK's built-in exponential backoff handles 429/5xx retries
> automatically. Retry count is logged with each API call.

---

### ~~Token Estimation Before API Call~~ ✅ Implemented

> **Completed.** After building the payload, the agent estimates input tokens
> (`total chars / 4`) and logs the estimate. `MAX_INPUT_TOKENS` defaults to
> `150000` — reviews exceeding the estimate are skipped. Set to `0` to disable.
> The usage record includes `tokens.estimated_input` alongside actual
> `tokens.input` for accuracy tracking.

---

### ~~Sensible Default Thresholds~~ ✅ Implemented

> **Completed.** `MAX_CHANGED_FILES` defaults to `200` and `MAX_CHANGED_LINES` defaults
> to `3000`. PRs exceeding these limits are skipped with a log message. Set to `0` to
> disable. `MIN_CHANGED_FILES` and `MIN_CHANGED_LINES` remain `0` (disabled).

---

### ~~Prompt Section Logging~~ ✅ Implemented

> **Completed.** After loading any prompt (local, repo, or default), the loader
> logs which sections (ROLE, REVIEW PRIORITIES, MENTAL MODEL) were parsed from
> the file and which fell back to defaults. A `--validate-prompt` flag (requires
> `--prompt <path>`) parses a local prompt file and exits without running a review.

---

### ~~Jenkins Stage Hardening~~ ✅ Implemented (Phase 2)

> **Completed.** The production Jenkinsfile uses `catchError(buildResult: 'SUCCESS',
> stageResult: 'UNSTABLE')` so agent failures never break the build. Retry is handled
> by the agent itself (`MAX_RETRIES`). See [phase-2-jenkins.md](phase-2-jenkins.md).

---

### ~~Node.js Version Check at Startup~~ ✅ Implemented

> **Completed.** The entry point (`src/index.ts`) checks `process.versions.node`
> before any imports and exits with a clear error if the major version is below 20.

---

### Results Dashboard (Simple UI)

A lightweight local web UI that reads `results.jsonl` and renders useful charts.
No backend required — just a static HTML/JS page or a minimal Node.js server that
serves parsed JSONL.

**Proposed dashboards (driven by available fields):**

#### 1. Activity Feed
Table of recent reviews: `timestamp`, `repo_slug`, `pr_id`, `action`, `review_number`,
`findings` (H/M/L), `verdict_score`, `cost_usd`. Sortable, filterable by repo/action.

#### 2. Cost Tracker
- Total spend over time (line chart, daily/weekly buckets)
- Cost per repo (bar chart — who is spending the most?)
- Cost breakdown: `cost_usd` (reviewer) vs `judge_cost_usd` (judge) per run
- Average cost per action type (REVIEW vs RE_REVIEW vs SKIP)

#### 3. Finding Quality / Judge Impact
- Stacked bar: `review_findings` (before judge) vs `findings` (after judge) — how many get dropped
- Judge drop rate per severity: % of HIGH/MEDIUM/LOW findings that don't survive validation
- Useful for tuning judge calibration — if drop rate is too high, judge is too aggressive

#### 4. Merge Confidence Distribution
- Histogram of `verdict_score` — how many PRs land in each band (90-100, 70-89, 50-69, <50)
- Average confidence by repo
- Trend over time — is code quality improving?

#### 5. Action Breakdown
- Pie/bar: REVIEW / RE_REVIEW / REPLY / SKIP / NO_CHANGE / ERROR / DEDUP_SKIP
- Skip reasons breakdown (threshold, dedup, token limit)
- Error rate — how often does the agent fail, and which error types?

#### 6. PR Size vs. Cost / Findings
- Scatter: `changed_lines` vs `cost_usd` — cost linearity check
- `changed_lines` vs `findings.high + findings.medium` — do bigger PRs have more issues?

#### 7. Token Efficiency
- `tokens.estimated_input` vs `tokens.input` — how accurate is the estimation?
- Cache hit rate: `tokens.cache_read / tokens.input` (once cache is enabled)
- Output token distribution — is the reviewer being verbose?

#### 8. Re-review Effectiveness (Delta)
- `delta.resolved` vs `delta.still_open` per PR over time
- PRs with persistent `still_open` findings — potential quality blockers
- Average rounds to resolve all findings

**Tech options:**
- Simplest: single HTML file, reads `results.jsonl` via drag-and-drop or file input, renders with Chart.js
- Slightly better: `npm run dashboard` starts a minimal express server on port 3000, serves a pre-built HTML page

Complexity: low-medium. All data is already in `results.jsonl`.

---

### GitHub and GitLab Inline Comments (Phase 5)

Full inline comment support for GitHub and GitLab adapters, following the same
pattern as Phase 4 (Bitbucket). Each has a different position format — see
[architecture/vcs-adapter.md](../architecture/vcs-adapter.md) for details.
