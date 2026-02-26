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
> See [reference/token-budget.md](../reference/token-budget.md) for schema and `jq` queries.

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

### Anthropic API Retry Configuration

The `@anthropic-ai/sdk` has built-in retry for 429/5xx (2 retries by default), but the agent
doesn't explicitly configure it. For multi-repo Jenkins environments with concurrent PRs,
rate limiting is expected.

- Explicitly set `maxRetries` on the Anthropic client (e.g. 3 with backoff)
- Log retry attempts so they appear in usage output
- Consider a configurable `MAX_RETRIES` env var

Priority: **HIGH** — required before scaling to many repos.

---

### Token Estimation Before API Call

No token count estimation happens before sending the payload to Claude. A PR with 20 files
at 499 lines each could push toward model limits.

- Estimate tokens after building the payload (rough: `chars / 4`)
- Warn if estimated tokens exceed a configurable threshold (e.g. `MAX_INPUT_TOKENS=100000`)
- Consider truncating or skipping files to stay under budget

Priority: **HIGH** — prevents surprise failures on large PRs.

---

### Sensible Default Thresholds

`MIN_CHANGED_FILES`, `MAX_CHANGED_FILES`, `MIN_CHANGED_LINES`, `MAX_CHANGED_LINES` all
default to `0` (disabled). A 10,000-line PR will be reviewed without question, consuming
significant tokens and likely producing low-quality output.

- Set `MAX_CHANGED_LINES=3000` (or similar) as default
- Set `MAX_CHANGED_FILES=50` as default
- Document rationale

Priority: **MEDIUM**

---

### Prompt Section Logging

When loading `.agent-review-instructions.md`, the loader logs which file was used but NOT
which sections (ROLE, REVIEW PRIORITIES, MENTAL MODEL) were found vs defaulted. A malformed
file silently falls back to defaults with no feedback.

- Log which sections were parsed from the repo prompt
- Log which sections fell back to defaults
- Consider a `--validate-prompt` flag for explicit checking

Priority: **MEDIUM**

---

### Jenkins Stage Hardening

The documented Jenkins example is missing error handling. Recommended additions:

- `catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE')` — agent failure shouldn't block the build
- `timeout(time: 3, unit: 'MINUTES')` — prevent hanging API calls from blocking the executor
- `retry(2)` — retry on transient failures
- `archiveArtifacts` for `results.jsonl` (documented in token-budget.md)

Priority: **MEDIUM** — required before Phase 2 Jenkins rollout.

---

### Node.js Version Check at Startup

`.nvmrc` pins Node 20 and `package.json` has `engines.node >= 20`, but nothing validates
at runtime. On a Jenkins agent running Node 18, behavior is undefined.

```typescript
const [major] = process.versions.node.split('.').map(Number)
if (major < 20) { console.error(`Node.js 20+ required. Current: ${process.version}`); process.exit(1) }
```

Priority: **LOW**

---

### GitHub and GitLab Inline Comments (Phase 5)

Full inline comment support for GitHub and GitLab adapters, following the same
pattern as Phase 4 (Bitbucket). Each has a different position format — see
[architecture/vcs-adapter.md](../architecture/vcs-adapter.md) for details.
