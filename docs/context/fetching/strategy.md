---
type: domain
topic: Context fetching — diff filtering, full file content strategy, payload format
---

# Context Fetching Strategy

How the agent builds the context payload sent to Claude. Related: [review/fsm.md](../review/fsm.md) | [vcs/adapter.md](../vcs/adapter.md)

---

## Two-Form Diff

The agent keeps the diff in two forms simultaneously:

| Form | Used for |
|------|---------|
| **Raw diff** | Usage-record metrics (`changed_files`/`changed_lines`) |
| **Filtered diff** | All Claude API calls (review, judge, reply), threshold checks `MIN/MAX_CHANGED_*`, zero-reviewable skip |

`filterDiff()` in `src/review/parsers.ts` applies `DIFF_EXCLUDE_PATTERNS` to strip noise from the filtered form. The raw form is never sent to Claude.

### Default Exclusions (configurable via `DIFF_EXCLUDE_PATTERNS`)

```
*.lock, package-lock.json, yarn.lock, pnpm-lock.yaml, *.json, *.spec.ts
```

**Note:** JSON files (e.g. i18n translations) are excluded by default because they're typically large, generated, or auto-merged. If a project needs JSON diffs reviewed, remove `*.json` from `DIFF_EXCLUDE_PATTERNS`.

---

## Full File Context (`src/context/fetcher.ts`)

Beyond the diff, the agent fetches full file content for changed files so Claude can understand the full method body, interface contracts, and call sites — not just the changed lines.

### Exclusion Rules

Always skip (diff-only, no full content):
- `*.lock`, `package-lock.json`, `yarn.lock`
- `*-generated.*`, `*.min.js`, `*.map`
- `db/migrate/*`
- `*.snap`
- Files over `MAX_FILE_LINES` lines (default: 500)

Always include full content regardless of size:
- Files where **>30% of lines changed** (high-churn = context matters most)

### Ordering

High-churn files are fetched first. Low-churn files fill remaining capacity up to `MAX_CONTEXT_FILES` (default: 20). Fetches run in **concurrency-bounded batches** (5 at a time) rather than one-at-a-time, preserving churn order, the skip-large-low-churn filter, and the cap.

### Degradation before skip

If the estimated input exceeds `MAX_INPUT_TOKENS` in `ESTIMATE_TOKENS`, the agent **drops the file contexts** (the largest optional payload) and reviews **diff-only** rather than skipping the PR — the usage record's `degraded` flag records this. It only skips outright if the diff alone still exceeds the budget.

### Limits

| Env var | Default | Purpose |
|---------|---------|---------|
| `MAX_CONTEXT_FILES` | `20` | Cap on full-file fetches per review |
| `MAX_FILE_LINES` | `500` | Skip threshold for large files |

---

## Payload Sent to Claude (Full Review)

```
[SYSTEM PROMPT — base template with repo sections]

[USER MESSAGE]
## Pull Request: {title}
## Branch: {source} → {target}
## Description: {pr description if present}

## Previous Review by This Agent (latest of N total):
{most recent review only — saves tokens while preserving delta context}

## Developer Discussion on Previous Review(s):
{all replies across all previous reviews — human AND agent — so the model
 sees its prior conclusions and does not re-raise findings it already conceded}

## Diff:
{filtered diff — the whole PR vs target}

## Changes Since Your Last Review:      ← re-reviews only
{the delta diff since the last-reviewed commit, so the model sees exactly which
 lines are new/fixed instead of inferring changes from the review prose above}

## Full file context:
### src/some/File.ts
{full file content}
...
```

**Only the most recent review** is included (not the full history). Developer discussion includes all replies across all reviews so the model sees what it already conceded as false positives.

On re-reviews, a **"Changes Since Your Last Review"** section carries the delta diff since the last-reviewed commit — the same diff computed for the skip-gate ([review/skip-logic.md](../review/skip-logic.md)), retained instead of discarded. The full PR diff is the whole PR vs target and does **not** mark which lines are new since the last review, so this delta lets the model ground "resolved vs new" in concrete changed lines rather than the previous review's prose.

---

## Payload Sent to Claude (Reply)

```
[SYSTEM PROMPT — reply-prompt.txt]

[USER MESSAGE]
## Your Original Review:
{last review body}

## Diff:
{filtered diff}

## Developer Replies (answer all of these):
**John Smith** (2025-01-15T10:30:00Z):
> Can you explain why this is HIGH severity?
```

See [review/replies.md](../review/replies.md) for how unanswered replies are detected.
