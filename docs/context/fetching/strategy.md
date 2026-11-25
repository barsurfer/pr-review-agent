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

Diff exclusion does not reach file context: `FETCH_CONTEXT` applies only its own rules below, so a changed `package.json` or `*.spec.ts` dropped from the diff can still arrive as a full file. `filterDiff` keys a section on its old `a/` path, so a rename is excluded by its old name. The benchmark-only `DX` label swaps in a generated-files-only list that keeps manifests, configs and tests in the diff (see [vcs/adapter.md](../vcs/adapter.md)).

---

## Full File Context (`src/context/fetcher.ts`)

Beyond the diff, the agent fetches full file content for changed files so Claude can understand the full method body, interface contracts, and call sites — not just the changed lines.

### Exclusion Rules

Always skip (diff-only, no full content):
- `*.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- `*-generated.*`, `*.min.js`, `*.min.css`, `*.map`
- `db/migrate/*`
- `*.snap`
- Files over `MAX_FILE_LINES` lines (default: 500)

Always include full content regardless of size:
- Files where **>30% of lines changed** (high-churn = context matters most)

### Ordering

High-churn files are fetched first. Low-churn files fill remaining capacity up to `MAX_CONTEXT_FILES` (default: 20). Fetches run in **concurrency-bounded batches** (5 at a time) rather than one-at-a-time, preserving churn order, the skip-large-low-churn filter, and the cap.

### Degradation before skip

If the estimated input exceeds `MAX_INPUT_TOKENS` in `ESTIMATE_TOKENS`, the agent **drops the file contexts** (the largest optional payload) and reviews **diff-only** rather than skipping the PR — the usage record's `degraded` flag records this. It only skips outright if the diff alone still exceeds the budget.

`ESTIMATE_TOKENS` always logs a **per-section token breakdown** (`prompt / diff / delta / files ×N / prev_reviews ×N / replies ×N`, ~chars/4) so an over-budget run shows which section drove the size — a large diff vs many file contexts vs a long review/reply history. The breakdown is also included in the skip reason (so `results.jsonl` records the why). With `ENABLE_TOKEN_METRICS` it is also stored as `token_metrics.estimate` (`estimate_initial` holds the first breakdown when the run re-estimated after dropping the delta or file contexts), and bundled reviewer rows carry the packer split in `estimate_parts`.

The estimate lives in `TokenEstimator` (`src/review/token-estimator.ts`, default instance `defaultTokenEstimator`) and is `chars / 4`, rounded up once per summed total. Known limitation: it undercounts real Claude 5.x input by about 1.7x (measured: 69,720 estimated vs 119,054 real; 43,390 vs 70,666; 21,012 vs 34,772), so `MAX_INPUT_TOKENS` effectively allows about 1.7x its value and Haiku's 100k price tier is reached near an estimate of 60k. With `ENABLE_TOKEN_METRICS` the gap is recorded per call: read `token_metrics.reviewer.ratio` (real `prompt_tokens` over the estimate, about 1.7 on Claude 5.x, `null` after a context-length retry) and, per row, `prompt_tokens`, `tier` and `tier_cost_usd` (the premium over base rates, Haiku 5.5 only). Crossings and per-run totals also log as `Long-context tier:` and `Token metrics:` lines. The estimate itself is unchanged. See [usage-logging.md](../../reference/usage-logging.md).

### Limits

| Env var | Default | Purpose |
|---------|---------|---------|
| `MAX_CONTEXT_FILES` | `20` | Cap on full-file fetches per review |
| `MAX_FILE_LINES` | `500` | Skip threshold for large files |

### Testing note — deliberately low limits surface drift

Local smoke-testing runs **tight** limits on purpose (e.g. `MAX_FILE_LINES=200` / `MAX_CONTEXT_FILES=5`), well below the defaults. Starving the reviewer of full-file context is *how review drift is observed*: with the supporting files dropped, the model falls back to speculating about framework internals and out-of-diff symbols (e.g. "does `getTenantId()` exist?"), which exposes weak spots the generous defaults would mask. This is intentional, not a misconfiguration — do not "fix" it by raising the values.

For a realistic (Jenkins-parity or fuller) run, override inline rather than editing the defaults:
`MAX_FILE_LINES=2000 MAX_CONTEXT_FILES=50 node dist/pr-review-agent.cjs …`. The developer-reply flow is the intended backstop for what context can't resolve: an unverifiable finding is raised as a question, the developer answers, and the reply flow acknowledges it and drops the finding. Fetching referenced-but-*unchanged* definitions on demand (symbol fetch) is a deferred enhancement.

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

With `ENABLE_LINE_NUMBERS` (on by default; `false` or label `LNUM=0` turns it off), the diff, delta and file-context blocks are shown numbered: every added/context diff line gets its new-file line number in a 5-char gutter (removed lines get a blank gutter), file content is numbered from 1, and the Diff heading tells the reviewer to cite those numbers in `lines`. The judge and the breadth, second-look and lens passes get the same numbered view. **Why:** models can't reliably count lines from `@@` headers; ~40% of reviewer findings across runs 306/308/309 came back with no `lines`, which left them to downstream anchoring. Only the prompt text is numbered; the raw diff used for anchoring and metrics is unchanged.

**Prompt cache (`ENABLE_PROMPT_CACHE`, default off).** When the reviewer request is marked, its user message is kept byte for byte (`ctx.cachePrefix.block`, from the successful attempt, so after a context-length retry it is the diff-only message) and every eligible breadth, second-look or lens pass sends it as the first, cached content part of its user turn, followed by its briefing as a second part. Cached second look therefore sees the full filtered diff and every file context instead of only the flagged files' sections, and its briefing names the files it covers. Ineligible passes and the judge keep their own payloads. Details: [llm/structured-output.md](../llm/structured-output.md#prompt-cache-enable_prompt_cache).

**Only the most recent review** is included (not the full history). Developer discussion includes all replies across all reviews so the model sees what it already conceded as false positives.

**Suggested-fix blocks are stripped** (`stripOwnSuggestedFixes` in `buildUserMessage`, so every reviewer caller — single pass and each bundle — gets it; breadth, second-look and lens passes see no history at all). The prior review loses its `suggested-fix-v1` blocks when its review footer is its last non-empty line; a discussion entry loses them when the reply footer is its last non-empty line. Text counts as the agent's only by that last line, so a human comment quoting a footer inside a fence or mid-text is untouched, while one whose last non-empty line is footer-shaped is stripped like the agent's. Only exact, bounded blocks outside any open fence are removed, and a body without the marker is passed through as the same string, so runs without blocks send byte-identical input. A finding posted with its fix-free text reaches the reviewer as that text alone, so the reviewer no longer sees the earlier proposed fix. Not gated by `ENABLE_SUGGESTED_FIXES`. The token estimate and the bundle history size keep the raw lengths (a small overestimate). Rule details: [prompt/judge.md](../prompt/judge.md#suggested-fixes-in-the-posted-review-enable_suggested_fixes). The same step also strips recognised lens section blocks (`stripOwnSections`, only from an agent review whose footer is the last line; the reply model sees the raw comment), so section rows never reach the reviewer or `delta_stats`. The section judge gets the numbered diff restricted to its candidates' files plus those files' contexts.

On re-reviews, a **"Changes Since Your Last Review"** section carries the delta diff since the last-reviewed commit — the same diff computed for the skip-gate ([review/skip-logic.md](../review/skip-logic.md)), retained instead of discarded. The full PR diff is the whole PR vs target and does **not** mark which lines are new since the last review, so this delta lets the model ground "resolved vs new" in concrete changed lines rather than the previous review's prose.

After a target-branch merge the delta may be **narrowed** (`ENABLE_TARGET_MERGE_CHECK`, Bitbucket, also in `--dry-run`): files whose PR diff section is exactly the same as at the reviewed commit are dropped, so the section holds only the PR's own changes since then. The comparison is exact (only `index` abbreviation lengths may differ, and only in sections with hunks; a hunk-less section needs an identical `index` line), so a PR file the target also changed is always kept and still shows the target's hunks; a merge that touches no PR file leaves nothing and skips the review. If any diff section's paths cannot be read unambiguously (a git-quoted or ambiguous header), the check gives up and keeps the full delta. The decision compares two PR diffs fetched pinned to commits (the reviewed commit and the head the delta ends at), unfiltered (the exclusion patterns apply only to the delta that is reviewed, since the filter keys on a rename's old path), not the PR diff fetched by PR id, which may belong to another head; that diff still goes to the reviewer untouched. When nothing is dropped the delta is today's string, unchanged; a merge-shaped delta costs two extra GETs (none for a normal fix commit), and so does a fix that reverts a file out of the PR, which keeps every section. If the narrowed delta is still larger than the PR diff it is dropped as before, and that full-diff review always posts. Rule: [review/skip-logic.md §2](../review/skip-logic.md).

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

The reply payload carries the review body and replies raw, suggested-fix blocks included, so the reply model can answer "your fix doesn't compile". See [review/replies.md](../review/replies.md) for how unanswered replies are detected.
