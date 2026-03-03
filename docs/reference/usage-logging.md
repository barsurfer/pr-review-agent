# Usage Logging & Cost Reference

## Rough Estimate Per Review

| Component | Tokens |
|-----------|--------|
| System prompt | 500–1,000 |
| Diff (typical PR) | 1,000–5,000 |
| Full file context (10 files × 200 lines avg) | 15,000–30,000 |
| Output (review comment) | 1,000–2,000 |
| **Total typical** | **20,000–40,000** |

Claude Sonnet context window is large enough for even big PRs, but cost scales with token count.

## Rough Estimate Per Comment Reply

| Component | Tokens |
|-----------|--------|
| Reply system prompt | 100–200 |
| Original review body | 500–2,000 |
| Diff (same as review) | 1,000–5,000 |
| Developer replies (1–3 questions) | 100–500 |
| Output (reply, max_tokens: 2,048) | 200–1,000 |
| **Total typical** | **2,000–8,000** |

Comment replies are significantly cheaper than full reviews because they skip full file
context and use a shorter system prompt. The `max_tokens` cap is 2,048 (vs 4,096 for reviews).

---

## Built-in Mitigations (Phase 1 + 1b)

| Control | Default | Effect |
|---------|---------|--------|
| `MAX_CONTEXT_FILES` | `20` | Cap on full-file fetches |
| `MAX_FILE_LINES` | `500` | Files over this get diff-only |
| Exclusion patterns (context) | see below | Skips generated/lock files from full-file context |
| Diff filtering | always on | Strips lock file sections from diff before sending to Claude |
| Commit hash dedup | always on | Skips API call entirely if same commit already reviewed |
| `NO_CHANGE` stop word | always on | Skips posting if delta review has no meaningful changes |
| Reply timestamp dedup | always on | Skips reply API call if developer question already answered |
| Latest review only | always on | Sends only the most recent previous review (not all) to save tokens |
| Delta review prompt | always on | Findings/Unresolved Questions limited to new items only — reduces output tokens on re-reviews |

### Excluded from Full-File Context

```
*.lock
package-lock.json
yarn.lock
*-generated.*
*.min.js
db/migrate/*
*.snap
```

### Excluded from Diff (Stripped Before API Call)

Configurable via `DIFF_EXCLUDE_PATTERNS` env var (comma-separated). Defaults:

```
*.lock, package-lock.json, yarn.lock, pnpm-lock.yaml, *.json, *.spec.ts
```

Raw diff is kept for line counting and threshold checks. Only the filtered version goes to Claude.

---

## Usage Logging & Cost Tracking

Every run appends a JSON record to `results.jsonl` (controlled by `--log-usage`, default: `true`).
The record is also printed to stdout at the end of every run regardless of the flag.

### Record Schema

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | `string` | Deterministic key: `{vcs}-{repo_slug}-{pr_id}-{commit_short}` |
| `timestamp` | `string` | ISO 8601 UTC |
| `agent_version` | `string` | From `package.json` (injected at bundle time) |
| `vcs` | `string` | VCS provider (e.g. `bitbucket`) |
| `workspace` | `string` | Bitbucket workspace slug |
| `repo_slug` | `string` | Repository slug |
| `pr_id` | `string` | Pull request ID |
| `pr_author` | `string` | PR author display name |
| `source_commit` | `string` | Source commit hash at time of review |
| `source_branch` | `string` | Source branch name (e.g. `feature/AL-1234`) |
| `target_branch` | `string` | e.g. `main`, `develop` |
| `changed_files` | `number` | Number of files changed in the PR |
| `changed_lines` | `number` | Total lines changed (additions + deletions) |
| `context_files_fetched` | `number` | Number of files fetched for full context |
| `review_number` | `number` | 1 = initial review, 2+ = re-review |
| `action` | `string` | `REVIEW` \| `RE_REVIEW` \| `REPLY` \| `NO_CHANGE` \| `SKIP` \| `DEDUP_SKIP` \| `ERROR` |
| `skip_reason` | `string \| null` | Human-readable reason when action is not `REVIEW` |
| `model` | `string` | Claude model ID used |
| `tokens.input` | `number` | Input tokens (from API response) |
| `tokens.output` | `number` | Output tokens (from API response) |
| `tokens.estimated_input` | `number` | Pre-call estimate (`chars / 4`) — compare with `tokens.input` for accuracy |
| `tokens.cache_read` | `number` | Cache read tokens (reserved for prompt caching) |
| `tokens.cache_write` | `number` | Cache write tokens (reserved for prompt caching) |
| `cost_usd` | `number` | Estimated cost from hardcoded per-model pricing table |
| `duration_ms` | `number` | Wall-clock time for the full run |
| `dry_run` | `boolean` | Whether `--dry-run` was used |
| `force` | `boolean` | Whether `--force` was used |
| `prompt_source` | `string` | Prompt file path or `default` |
| `verdict_score` | `number \| null` | Verdict percentage (0–100) parsed from review output |
| `computed_score` | `number \| null` | Code-computed score: `max(0, 100 − HIGHs×12 − MEDIUMs×4)`. Independent of model's verdict. |
| `findings` | `object \| null` | `{ high, medium, low }` — counts parsed from Findings section |
| `delta` | `object \| null` | Re-review only: `{ developer_replies, resolved, still_open, new_findings }` |
| `error` | `object \| null` | `{ type, message, status }` on failure |

### Action Values

| Action | Meaning |
|--------|---------|
| `REVIEW` | First review posted (or printed in dry-run) |
| `RE_REVIEW` | Subsequent review (`review_number > 1`) — includes `delta` stats |
| `REPLY` | Reply to developer question posted |
| `NO_CHANGE` | Claude determined only cosmetic changes — comment suppressed |
| `SKIP` | PR out of scope (size thresholds) — no API call |
| `DEDUP_SKIP` | Commit hash matched previous review, no unanswered replies — no API call |
| `ERROR` | Agent failed — see `error` field |

### Cost Estimation

Cost is calculated client-side from token counts and hardcoded per-model pricing (per 1M tokens):

| Model | Input | Output |
|-------|-------|--------|
| `claude-sonnet-4-6` | $3.00 | $15.00 |
| `claude-opus-4-6` | $15.00 | $75.00 |
| `claude-haiku-4-5-20251001` | $0.80 | $4.00 |

Unknown models fall back to Sonnet pricing. Update the pricing table in `src/review/usage.ts` when Anthropic changes rates.

### Useful Queries

```bash
# Total spend
jq -s '[.[] | .cost_usd // 0] | add' results.jsonl

# Cost by repo
jq -s 'group_by(.repo_slug) | map({repo: .[0].repo_slug, total: (map(.cost_usd // 0) | add)})' results.jsonl

# Average tokens per review
jq -s '[.[] | select(.action=="REVIEW") | .tokens.input] | add/length' results.jsonl

# DEDUP_SKIP rate
jq -s '{total: length, dedup: [.[] | select(.action=="DEDUP_SKIP")] | length}' results.jsonl

# Error rate
jq -s '{total: length, errors: [.[] | select(.action=="ERROR")] | length}' results.jsonl

# Estimate vs actual tokens (accuracy check)
jq -s '[.[] | select(.action=="REVIEW") | {pr: .pr_id, estimated: .tokens.estimated_input, actual: .tokens.input, ratio: (if .tokens.estimated_input > 0 then (.tokens.input / .tokens.estimated_input * 100 | round | tostring + "%") else "n/a" end)}]' results.jsonl

# Average verdict score
jq -s '[.[] | select(.verdict_score != null) | .verdict_score] | add/length | round' results.jsonl

# Reviews by author
jq -s 'group_by(.pr_author) | map({author: .[0].pr_author, reviews: length}) | sort_by(-.reviews)' results.jsonl

# Verdict vs computed score drift
jq -s '[.[] | select(.verdict_score != null and .computed_score != null) | {pr: .pr_id, verdict: .verdict_score, computed: .computed_score, drift: (.verdict_score - .computed_score)}]' results.jsonl

# High-severity findings
jq -s '[.[] | select(.findings.high > 0) | {repo: .repo_slug, pr: .pr_id, high: .findings.high}]' results.jsonl

# Re-review resolution rate
jq -s '[.[] | select(.action=="RE_REVIEW" and .delta != null) | {pr: .pr_id, resolved: .delta.resolved, still_open: .delta.still_open}]' results.jsonl

# Largest PRs reviewed (by changed lines)
jq -s '[.[] | select(.changed_lines != null)] | sort_by(-.changed_lines) | .[:10] | map({repo: .repo_slug, pr: .pr_id, files: .changed_files, lines: .changed_lines})' results.jsonl
```

### Jenkins Archiving

On Jenkins, `results.jsonl` is written to the build workspace and lost on cleanup. Add:

```groovy
post {
  always {
    archiveArtifacts artifacts: 'results.jsonl', allowEmptyArchive: true
  }
}
```
