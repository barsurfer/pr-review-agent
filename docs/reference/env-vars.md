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
| `VCS_PROVIDER` | `bitbucket` | Which VCS adapter to use. `bitbucket` is production; `azure` is experimental/WIP (see below); `github`/`gitlab` are stubs. |
| `BITBUCKET_BASE_URL` | `https://api.bitbucket.org/2.0` | Bitbucket Cloud API base URL (Server/DC is not supported — different v1 API) |
| `BITBUCKET_WORKSPACE` | `my-workspace` | Bitbucket workspace slug |
| `BITBUCKET_USERNAME` | `you@company.com` | Your Atlassian account email (used for HTTP Basic Auth) |
| `BITBUCKET_TOKEN` | `ATATT3x...` | Atlassian API token with Bitbucket scopes (replaces deprecated app passwords) |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Anthropic API key (billed separately from Claude.ai subscriptions) |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude model ID for reviews (a cheap reviewer paired with a stronger `JUDGING_MODEL` gives the generator-verifier pattern) |
| `RB_MODEL_BASE_URL` | `https://api.anthropic.com` | Anthropic SDK base URL (set by ReviewBench; a trailing `/v1` is stripped). Unset keeps the SDK default (`ANTHROPIC_BASE_URL` or api.anthropic.com). The other `RB_*` vars only apply under `--benchmark`; see [reviewbench/README.md](../../reviewbench/README.md). |
| `LLM_PROVIDER` | `anthropic` | Model backend behind the reviewer/judge. Only `anthropic` is implemented; the `LLMProvider` seam (`src/llm/provider.ts`) exists so a second provider is a new impl, not a re-plumb. Default: `anthropic` |
| `MAX_RETRIES` | `3` | Max retries on 429/5xx errors (SDK built-in exponential backoff). Default: `3` |
| `MAX_INPUT_TOKENS` | `250000` | If estimated input exceeds this, first drop file contexts and review diff-only; skip only if the diff alone still exceeds it (0 = disabled). `ESTIMATE_TOKENS` logs a per-section breakdown (prompt / diff / delta / file-contexts / prev-reviews / replies) so you can see what drove the size |
| `MAX_OUTPUT_TOKENS` | `32000` | Output-token cap for reviewer + judge (raised from 16k because the Claude 5 family thinks by default and thinking counts against this). Requests stream, so large caps don't hit the HTTP timeout. **Effort coupling:** thinking counts against this cap, so `REVIEW_EFFORT`/`JUDGE_EFFORT` at `xhigh`/`max` can exceed 32k on a non-trivial PR and truncate the response (the run errors rather than posting a cut-off review) — raise to ~`64000` when using high effort. Default/`high` effort fits 32k. |
| `MODEL_CONTEXT_TOKENS` | *(derived)* | Override the reviewer's context window. The input budget is `min(MAX_INPUT_TOKENS, window − MAX_OUTPUT_TOKENS)`. Unset (`0`) derives the window from the model id — 200K for 4.5-generation (Haiku 4.5), 1M for 4.6+/5.x (incl. Haiku 5.5) — so a 1M reviewer isn't throttled to a 200K default. Set it only for a model the agent doesn't yet map. The window is the smaller of the reviewer's and the judge's (both see the diff). |
| `ENABLE_BUNDLED_REVIEW` | `false` | When a PR is still over the input budget after dropping file contexts, split it into per-directory bundles (≤85% of budget each), review each with the normal reviewer + judge, then merge and dedupe — instead of skipping. Off by default; every bundle is a reviewer + judge call, so a huge PR is real spend |
| `MAX_BUNDLES` | `8` | Cap on bundles one over-budget PR may split into (0 = unlimited); the review skips if the plan needs more |
| `MAX_CONTEXT_FILES` | `20` | Max number of files to fetch full content for |
| `MAX_FILE_LINES` | `500` | Files over this line count get diff-only (no full content) |
| `MIN_CHANGED_FILES` | `0` | Skip review if PR has fewer reviewable files (0 = disabled) |
| `MAX_CHANGED_FILES` | `200` | Skip review if PR has more reviewable files (0 = disabled). Default: `200` |
| `MIN_CHANGED_LINES` | `0` | Skip review if PR has fewer reviewable lines (0 = disabled) |
| `MAX_CHANGED_LINES` | `3000` | Skip review if PR has more reviewable lines (0 = disabled). Default: `3000` |
| `SKIP_SOURCE_BRANCHES` | `main,master,release/*` | Comma-separated branch patterns. Skip review if PR source branch matches. Default: `main,master,release/*,hotfix/*` |
| `SKIP_TARGET_BRANCHES` | `main,master` | Comma-separated branch patterns. Skip review if PR target branch matches. Default: `main,master` |
| `DIFF_EXCLUDE_PATTERNS` | `*.lock,*.json,*.spec.ts` | Comma-separated file patterns to strip from diff before sending to Claude. Default: `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml,*.json,*.spec.ts` |
| `JUDGING_MODEL` | `claude-sonnet-5` | Judge model for finding validation — **on by default**. Set empty to disable the judge pass. |
| `REVIEW_EFFORT` | *(unset)* | Reviewer thinking effort: `low`\|`medium`\|`high`\|`xhigh`\|`max`. Unset = model default (a strong model like Opus 4.8 at its adaptive default needs no effort flag). Only the 5-family / Opus-4.6+ / Sonnet-5 support it; models that don't (e.g. Haiku 4.5) are retried without it. `xhigh`/`max` need a larger `MAX_OUTPUT_TOKENS` (~64k) — thinking counts against the output cap and otherwise truncates the review. |
| `JUDGE_EFFORT` | *(unset)* | Judge thinking effort — same scale and fallback behavior as `REVIEW_EFFORT`. |
| `MAX_REPLY_COMMENTS` | `5` | Max agent reply comments per PR (0 = unlimited). Prevents runaway token usage on extended conversations. Default: `5` |
| `MAX_FINDINGS` | `0` | Cap the number of findings the reviewer reports (0 = unlimited). When set, appends a findings-limit instruction to the reviewer prompt. |
| `ENABLE_SPLIT_CHECK` | `true` | Reviewer adds a "Can Be Split" section when the PR spans independent themes that could be separate PRs. Set `false` to disable. |
| `ENABLE_TODO_SCAN` | `true` | Deterministically scan added lines for `TODO`/`FIXME`/`HACK` markers and append a "TODOs Introduced" section (file:line) to the review. |
| `AGENT_IDENTITY` | *(BITBUCKET_USERNAME)* | Name shown in review/reply footers. Falls back to `BITBUCKET_USERNAME`, then `'Claude'` |

> Threshold variables can also be set via CLI flags (`--min-changed-files`, etc.)
> which override the env var values. Model/token/effort too: `CLAUDE_MODEL`/`JUDGING_MODEL`
> → `--model`/`--judge-model`; `MAX_INPUT_TOKENS`/`MAX_OUTPUT_TOKENS` →
> `--max-input-tokens`/`--max-output-tokens`; `REVIEW_EFFORT`/`JUDGE_EFFORT` →
> `--effort`/`--judge-effort`. CLI always wins over env.
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

> Note: prior to the fix, Commander's default value caused `--force` to behave as `re-review`
> even when the flag was not passed at all, effectively disabling dedup on every run.

---

## Azure DevOps (Experimental / WIP)

Selected with `--vcs azure` or `VCS_PROVIDER=azure`. Implements the full adapter interface
but is validated against mocked API shapes only — **not yet exercised against a live
instance**. Prints a one-line WIP warning on construction.

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

## Phase 3 — Inline Comments

| Variable | Example | Description |
|----------|---------|-------------|
| `REVIEW_MODE` | `summary` | `summary` \| `inline` \| `both`. Default: `summary` |
| `MAX_INLINE_COMMENTS` | `30` | Cap on inline comments per review. Remainder goes in summary. |

---

## Backlog — GitHub / GitLab Adapters

See [phases/phase-3-multi-vcs.md](../phases/phase-3-multi-vcs.md) for env vars
needed when GitHub/GitLab adapters are implemented.

---

## `.env.example`

```env
# VCS
VCS_PROVIDER=bitbucket
BITBUCKET_BASE_URL=https://api.bitbucket.org/2.0
BITBUCKET_WORKSPACE=
BITBUCKET_USERNAME=
BITBUCKET_TOKEN=

# Azure DevOps (experimental / WIP) — set VCS_PROVIDER=azure to use.
# Provide ONE credential: AZURE_ACCESS_TOKEN (Bearer, e.g. pipeline System.AccessToken)
# OR AZURE_PAT (Basic). Access token wins if both are set.
# AZURE_BASE_URL=https://dev.azure.com
# AZURE_ORG=
# AZURE_PROJECT=
# AZURE_ACCESS_TOKEN=
# AZURE_PAT=

# Claude
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-haiku-4-5-20251001
# LLM_PROVIDER=anthropic   # model backend; only 'anthropic' implemented
MAX_RETRIES=3
# MAX_INPUT_TOKENS=250000

# Agent identity (defaults to BITBUCKET_USERNAME, then 'Claude')
# AGENT_IDENTITY=

# Reply limit — max agent reply comments per PR (0 = unlimited)
# MAX_REPLY_COMMENTS=5

# Context limits
MAX_CONTEXT_FILES=20
MAX_FILE_LINES=500

# PR size thresholds (0 = disabled)
MIN_CHANGED_FILES=0
MAX_CHANGED_FILES=200
MIN_CHANGED_LINES=0
MAX_CHANGED_LINES=3000

# Branch exclusion — skip reviews for merge-back / release PRs
# SKIP_SOURCE_BRANCHES=main,master,release/*,hotfix/*
# SKIP_TARGET_BRANCHES=main,master

# Diff exclusion patterns (comma-separated, default includes lock files, .json, .spec.ts)
# DIFF_EXCLUDE_PATTERNS=*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml,*.json,*.spec.ts

# Judge model (optional — validates findings before posting, empty = skip)
# JUDGING_MODEL=claude-sonnet-4-6
```
