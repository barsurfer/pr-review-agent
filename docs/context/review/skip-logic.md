---
type: domain
topic: All skip mechanisms — dedup, delta pre-check, branch exclusion, thresholds
---

# Skip Logic

All mechanisms that cause the agent to exit without posting a review. Related: [review/fsm.md](fsm.md) | [practices.md](../practices.md)

---

## 1. Commit Hash Deduplication

Every review comment ends with a footer:
```
*Reviewed by Claude (claude-sonnet-4-6) | Prompt: .agent-review-instructions.md | Review #2 | Commit: a1b2c3d4e5f6*
```

On re-trigger, `CHECK_PREVIOUS_REVIEWS` parses this footer and compares the commit hash against the current PR source commit (`PRInfo.sourceCommit`). If they match: same commit, no new code → fall through to `CHECK_REPLIES` instead of calling Claude.

**Invariant:** The footer regex must remain stable. Changing the format silently breaks dedup for all PRs reviewed before the change.

`--force` (no value) = `re-review` mode: bypasses dedup, keeps prior review context.  
`--force clean` = strips prior review from context before calling Claude.

---

## 2. Delta Diff Pre-Check

When the commit hash has changed (new commits pushed), before calling Claude, the agent fetches the **commit-to-commit diff** (`VCSAdapter.getCommitDiff(fromCommit, toCommit)`) between the last-reviewed commit and the current head.

After applying `filterDiff()` with `DIFF_EXCLUDE_PATTERNS`:
- **Zero lines remain** → deterministic `NO_CHANGE` skip. No API call. No tokens.
- **Lines remain** → proceed with full delta review.

This is deterministic — it does not rely on Claude to detect that nothing changed. Catches commits that only add tests, lock files, translations, or other excluded file types.

**Fallback:** If the commit-to-commit diff API call fails (e.g. force-push removed the old commit), the agent falls back to the full PR diff flow.

---

## 3. Branch Exclusion

Checked in `CHECK_BRANCHES` before any diff is fetched.

| Env var | Default | Effect |
|---------|---------|--------|
| `SKIP_SOURCE_BRANCHES` | `main,master,release/*,hotfix/*` | Skip if PR source branch matches |
| `SKIP_TARGET_BRANCHES` | `main,master` | Skip if PR target branch matches |

Patterns support `*` wildcard (e.g. `release/*` matches `release/1.5.0`). Set to empty string to disable.

**Rationale:** Merge-back PRs (`main→develop`) and release PRs (`feature→main`) are intentionally excluded — the former are noise, the latter are gated by human review.

---

## 4. Size Thresholds

Checked in `CHECK_THRESHOLDS` against **reviewable** counts — files/lines that survive
`DIFF_EXCLUDE_PATTERNS` filtering. Excluded files (locks, i18n bundles, specs) do not
count toward the limits, so a PR bloated by excluded churn is still reviewed.

A PR whose diff is 100% excluded files exits earlier, in `FETCH_DIFF`, with
`no reviewable changes after exclusions` — no thresholds checked, no API call.

| Env var | Default | Behavior |
|---------|---------|----------|
| `MIN_CHANGED_FILES` | `0` (disabled) | Skip if PR has fewer files |
| `MAX_CHANGED_FILES` | `200` | Skip if PR has more files |
| `MIN_CHANGED_LINES` | `0` (disabled) | Skip if PR has fewer lines |
| `MAX_CHANGED_LINES` | `3000` | Skip if PR has more lines |
| `MAX_INPUT_TOKENS` | `150000` | Skip if estimated input tokens exceed this |

All can be overridden via CLI flags (`--min-changed-files`, etc.). `0` disables the threshold.

**Rationale for upper bounds:** Very large PRs (>200 files, >3000 lines) produce unreliable reviews and high token costs. Teams should split such PRs.

---

## 5. Reply Limit

Once the agent has replied `MAX_REPLY_COMMENTS` times (default: 3) on a PR, further developer questions are logged but not answered. Prevents runaway token usage on contentious PRs or adversarial follow-ups.

Set `MAX_REPLY_COMMENTS=0` to disable.
