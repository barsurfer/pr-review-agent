---
type: core
---

# Practices

Patterns and conventions specific to this project.

---

## Stateless Design

The agent derives all state from the PR's comment history via API on each run. No database, no stored diffs. Review number is computed by counting existing review comments; dedup key is parsed from the last review footer. This means the agent can be deployed anywhere with no persistent infrastructure.

## API-Only Access

Nothing is ever checked out. All file content (diffs, full files, `.agent-review-instructions.md`) is fetched via Bitbucket REST API. This is an explicit constraint — not a limitation.

## FSM Orchestration

Review logic is an explicit finite state machine with a `State` enum, a `ReviewContext` accumulator, and a `transition(state, ctx)` function that returns the next state. The runner loops until `DONE`. New logic goes into a new state or a guard within an existing state — not into inline conditionals inside `transition()`.

See [review/fsm.md](review/fsm.md).

## Footer-Based Dedup

The commit hash is embedded in the review comment footer and parsed on re-trigger. No external store is needed to avoid duplicate reviews. The format must be stable — changing the footer regex breaks dedup for all in-flight PRs.

See [review/skip-logic.md](review/skip-logic.md).

## Two-Form Diff

A filtered copy of the diff (lockfiles, generated files stripped) is used for all Claude API calls and for size-threshold checks — excluded files don't count toward `MIN/MAX_CHANGED_*`, and zero reviewable lines after filtering skips the run. The raw diff is retained for usage-record metrics (`changed_files`/`changed_lines`). Both forms are derived from the same VCS API response in `FETCH_DIFF`.

## Generator-Verifier Pattern

When `JUDGING_MODEL` is set, the reviewer generates candidate findings and the judge validates each MEDIUM/HIGH finding against the actual diff. Invalid findings are dropped. Use a cheap model for generation (Haiku), a stronger model for validation (Sonnet). The judge is skipped automatically when the reviewer produces zero findings.

See [prompt/judge.md](prompt/judge.md).

## VCS Adapter

All VCS interactions go through `VCSAdapter` interface in `src/vcs/adapter.ts`. Orchestration logic never calls Bitbucket APIs directly. GitHub/GitLab adapters are stubs — extending to a new VCS means implementing the interface, not touching orchestration.

See [vcs/adapter.md](vcs/adapter.md).

## Reply Bundling

All unanswered developer questions from the current reply cycle are sent in one Claude call. One reply per trigger. This prevents per-question token cost and keeps the conversation thread clean.

## FORBIDDEN Rules as Invariants

The base prompt's FORBIDDEN rules are production-tested constraints, not style preferences. Each rule has a documented incident behind it (e.g. hallucinated footers, contradicting findings vs unresolved questions, re-raising developer-acknowledged findings). Do not weaken these rules without understanding the original failure.

See [prompt/composition.md](prompt/composition.md).

## Build & Deploy

The agent ships as a single-file CJS bundle (`dist/pr-review-agent.cjs`) built with esbuild. All dependencies are baked in; only Node.js 20+ is required on the host. Rebuild with `npm run bundle` after source changes. The bundle is committed to the repo so Jenkins requires no `npm install`.

## Versioning & Releases

Because the bundle is committed, any git ref serves a downloadable build via `raw.githubusercontent.com/<owner>/<repo>/<ref>/dist/pr-review-agent.cjs` — the ref is the version selector (branch, tag, or commit SHA). No release infrastructure needed. Pin production Jenkins to a **tag** (immutable, no CDN lag); `main` is the moving latest channel. Cut a version with `npm version patch` — a `version` lifecycle script rebuilds and stages the bundle during the bump, so the embedded `__AGENT_VERSION__` (hence `agent_version` in `results.jsonl` and nothing in the footer contradicts it) always matches the tag. The footer's `Build: <hash>` maps any comment back to the exact bundle commit.

## CI

`.github/workflows/ci.yml` runs typecheck + the vitest suite + a bundle build on every push to `main` and every PR. It is the gate that keeps `main` releasable; it does not publish anything (releases are git tags, see above). No strict `dist/` drift check — the bundle embeds a per-commit build hash, so a rebuilt bundle always differs; correctness relies on the discipline of rebuilding and committing `dist/` alongside source changes.
