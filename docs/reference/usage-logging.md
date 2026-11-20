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
| Output (reply, max_tokens: 4,096) | 200–1,000 |
| **Total typical** | **2,000–8,000** |

Comment replies are significantly cheaper than full reviews because they skip full file
context and use a shorter system prompt. The reply `max_tokens` cap is 4,096 (reviews use `MAX_OUTPUT_TOKENS`, default 32,000).

---

## Built-in Mitigations (Phase 1 + 1b)

| Control | Default | Effect |
|---------|---------|--------|
| `MAX_CONTEXT_FILES` | `20` | Cap on full-file fetches |
| `MAX_FILE_LINES` | `500` | Files over this get diff-only |
| Exclusion patterns (context) | see below | Skips generated/lock files from full-file context |
| Diff filtering | always on | Strips lock file sections from diff before sending to Claude |
| Commit hash dedup | always on | Skips API call entirely if same commit already reviewed |
| Checked commit from CI | off (`LAST_CHECKED_COMMIT`) | Skips the re-review of a head an earlier run already checked without posting (see [skip-logic.md §8](../context/review/skip-logic.md)) |
| `NO_CHANGE` stop word | always on | Skips posting if delta review has no meaningful changes |
| Reply timestamp dedup | always on | Skips reply API call if developer question already answered |
| Latest review only | always on | Sends only the most recent previous review (not all) to save tokens |
| Delta review prompt | always on | Findings/Unresolved Questions limited to new items only — reduces output tokens on re-reviews |

### Excluded from Full-File Context

```
*.lock
package-lock.json
yarn.lock
pnpm-lock.yaml
*-generated.*
*.min.js
*.min.css
db/migrate/*
*.snap
*.map
```

### Excluded from Diff (Stripped Before API Call)

Configurable via `DIFF_EXCLUDE_PATTERNS` env var (comma-separated). Defaults:

```
*.lock, package-lock.json, yarn.lock, pnpm-lock.yaml, *.json, *.spec.ts
```

Size thresholds are checked against the filtered diff (excluded files don't count); raw counts are kept for the `changed_files`/`changed_lines` record fields. Only the filtered version goes to Claude.

---

## Usage Logging & Cost Tracking

Every run appends a JSON record to `results.jsonl` (controlled by `--log-usage`, default: `true`).
The record is also printed to stdout at the end of every run regardless of the flag.
From 0.0.46, with `USAGE_RECORD_FILE` set (and `--log-usage` on), the same record is also written to that path, overwriting it, so the file holds only this run's record (see [Finding this run's record](#finding-this-runs-record)). From 0.0.54 `--usage-record-file <path>` sets the same path (a non-empty flag wins over the env var). A failed write logs one warning and changes nothing else.

### Record Schema

Every finding array (`review_candidates`, `judge_decisions`, `finding_scores`, `anchored_findings`) is in production order (reviewer, then breadth, second-look and lens candidates, as judged), not the severity order of the posted comment (see [review/fsm.md](../context/review/fsm.md#posted-severity-order)).

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | `string` | Deterministic key: `{vcs}-{repo_slug}-{pr_id}-{commit_short}` |
| `timestamp` | `string` | ISO 8601 UTC |
| `agent_version` | `string` | From `package.json` (injected at bundle time) |
| `vcs` | `string` | VCS provider actually used — a `--vcs` flag override is authoritative (also drives `run_id`) |
| `workspace` | `string` | The provider's owner scope, part of the per-PR key: the Bitbucket workspace (`--workspace`, else `BITBUCKET_WORKSPACE`); the Azure **org** (`AZURE_ORG`) on `azure`; the GitHub **owner** (`--workspace`, else `GITHUB_OWNER`) on `github` from 0.0.46 (bundles up to 0.0.45 logged `BITBUCKET_WORKSPACE` there, usually empty). `--benchmark` logs `BITBUCKET_WORKSPACE`. Not part of `run_id` |
| `repo_slug` | `string` | Repository slug |
| `pr_id` | `string` | Pull request ID |
| `pr_author` | `string` | PR author display name |
| `source_commit` | `string` | Source commit hash at time of review |
| `source_branch` | `string` | Source branch name (e.g. `feature/PROJ-123`) |
| `target_branch` | `string` | e.g. `main`, `develop` |
| `changed_files` | `number` | Number of files changed in the PR |
| `changed_lines` | `number` | Total lines changed (additions + deletions) |
| `diff_size` | `object \| null` | PR size for slicing results: `{ files: {added, modified, deleted, renamed}, lines_added, lines_removed, reviewable_files, reviewable_lines_added, reviewable_lines_removed }` — raw diff vs the part left after `DIFF_EXCLUDE_PATTERNS`; null when the run stopped before the diff was fetched |
| `context_files_fetched` | `number` | Number of files fetched for full context (0 if dropped by degradation) |
| `degraded` | `boolean` | `true` if file contexts were dropped to fit `MAX_INPUT_TOKENS` — the review ran diff-only instead of being skipped |
| `review_number` | `number` | 1 = initial review, 2+ = re-review |
| `action` | `string` | `REVIEW` \| `RE_REVIEW` \| `REPLY` \| `NO_CHANGE` \| `NO_NEW_FINDINGS` \| `SKIP` \| `DEDUP_SKIP` \| `ERROR` |
| `skip_reason` | `string \| null` | Human-readable reason when action is not `REVIEW`/`REPLY` |
| `model` | `string` | Reviewer model ID used; on a reply-only run (`action: REPLY`) with `REPLY_MODEL` set, the reply model |
| `effort` | `string \| null` | Reviewer thinking effort (`REVIEW_EFFORT` / `--effort`); null = model default |
| `tokens.input` | `number` | Input tokens (from API responses), summed over every model call in the run: reviewer or reply, breadth, second-look, lenses, judge |
| `tokens.output` | `number` | Output tokens (from API responses), summed the same way |
| `tokens.estimated_input` | `number` | Pre-call estimate (`chars / 4`) — compare with `tokens.input` for accuracy |
| `tokens.reasoning` | `number` | absent | Reasoning tokens summed like `tokens.output`, of which they are a subset (output and `cost_usd` are unchanged). Present only when above 0, so records of runs without reasoning keep their shape. OpenRouter reports it today (`usage.completion_tokens_details.reasoning_tokens`); the Anthropic provider maps `usage.output_tokens_details.thinking_tokens` when the API returns it (unverified live). Run total only, no per-stage breakdown |
| `tokens.cache_read` | `number` | Cache read tokens summed over all calls; populated by `ENABLE_PROMPT_CACHE` (0 otherwise). `tokens.input` excludes them on both providers under the flag |
| `tokens.cache_write` | `number` | Cache write tokens (5-minute TTL) summed over all calls; populated by `ENABLE_PROMPT_CACHE` |
| `cost_usd` | `number` | Total cost (reviewer + breadth + second-look + lenses + judge): the provider-reported cost where there is one (OpenRouter), else estimated from the per-model pricing table |
| `judge_model` | `string \| null` | Judge model ID, or null if no judge pass |
| `judge_effort` | `string \| null` | Judge thinking effort (`JUDGE_EFFORT`); null = model default |
| `judge_tokens` | `object \| null` | `{ input, output }`, or null if no judge pass. With `ENABLE_PROMPT_CACHE` this and `breadth_tokens`, `second_look_tokens` and `lens_runs[].tokens` add `cache_read` / `cache_write` |
| `judge_cost_usd` | `number \| null` | Judge call cost, or null if no judge |
| `duration_ms` | `number` | Wall-clock time for the full run |
| `dry_run` | `boolean` | Whether `--dry-run` was used |
| `force` | `string` | Force mode: `"off"`, `"clean"` (no prior context), or `"re-review"` (bypass dedup, keep context). An empty or whitespace `--force` value is recorded as `"off"`; any other value is recorded as given |
| `prompt_source` | `string` | `repo`, a `--prompt` path, `stack:<bases+overlays>`, or `default` |
| `prompt_lookup` | `"failed"` \| absent | Present, right after `prompt_source`, only when the `.agent-review-instructions.md` lookup failed (e.g. rate limits past the retry budget), so the run used `prompt_source` without checking for the repo's file; the footer then reads `Prompt: <source> (lookup failed)`. Never written with `ENABLE_INSTRUCTIONS_LOOKUP_RETRY=false` |
| `agent_commit` | `string` | Deploy commit of the agent (`getBuildCommit()`) — config attribution |
| `prompt_hash` | `string \| null` | sha256-12 of the resolved reviewer prompt; null if no prompt loaded |
| `judge_prompt_hash` | `string \| null` | sha256-12 of the judge prompt actually used; null when the judge didn't run |
| `judge_status` | `string \| null` | `disabled` \| `skipped_no_findings` \| `succeeded` \| `failed`; null when the judge stage wasn't reached |
| `verdict_score` | `number \| null` | Merge Confidence percentage (0–100) parsed from final output (judge if used, reviewer otherwise) |
| `computed_score` | `number \| null` | Code-computed score: `max(0, 100 − HIGHs×12 − MEDIUMs×4)` from final findings |
| `review_findings` | `object \| null` | `{ high, medium, low }` — raw findings from reviewer before judge validation |
| `findings` | `object \| null` | `{ high, medium, low }` — final findings (from judge if used, from reviewer otherwise) |
| `finding_scores` | `array \| null` | Judge per-finding `{ title, severity, score, file?, lines? }`; null if no judge |
| `min_finding_score` | `number \| null` | Lowest kept finding score |
| `review_candidates` | `array \| null` | Judge candidates stored once with ids (`c0…`): `{ id, origin, severity, type, title, file, lines, body }`, `origin` = `review` \| `breadth` \| `second_look` \| `lens:<name>`; `type` (the reviewer's issue type, off-enum → `other`, `null` when the reviewer gave none) is present only in `--benchmark` records, so production records keep the `{ id, origin, severity, title, file, lines, body }` shape; with `ENABLE_HIGH_IMPACT` on, every row also gets `scenario` (`install` \| `feature_off` \| `repeat` \| `old_data` \| `order` \| `contract`, or `null`) and, in `--benchmark` records only, `also_affects` (the sanitized `[{ file, lines, where }]`, `[]` when none); a first-pass (`review`) row always logs `scenario: null` and `also_affects: []`, because the reviewer is never asked for either; `unjudged_candidates` rows get the same keys; judge-run only |
| `unjudged_candidates` | `array` \| absent | Same rows as `review_candidates` (`{ id, origin, severity, title, file, lines, body }`, plus `type` in `--benchmark` records), present only on an `ERROR` record whose judge call threw (`judge_status: failed`), so the candidates that were never judged or posted stay readable. Sits right after `review_candidates`, which stays null on that path. Absent on every other record, including a judge failure the run absorbed (`--benchmark`, or a clean reviewer with breadth-only candidates) |
| `judge_decisions` | `array \| null` | One per candidate: `{ candidate_id, reason_category, reclassified_from, action, original_severity, final_severity, score, evidence, note, rewritten, anchor_source, anchor_file, anchor_lines }`; the resolved anchor is logged for **every decided candidate** (kept or dropped) so an offline re-score can place a finding a different policy would keep. Flag-gated extras, absent otherwise: `anchor_basis` (`ENABLE_JUDGE_SHOWN_CONTEXT_ANCHORS`); `duplicate_of`, `invalid_duplicate`, `expansions`, `quality_action`, `retained_candidate_id` (`ENABLE_JUDGE_QUALITY`); `proposal` on kept candidates (`ENABLE_JUDGE_PROPOSALS` or `ENABLE_SUGGESTED_FIXES`); `policy_override: 'test_gap'` on a `low_value` candidate kept as LOW by `ENABLE_JUDGE_KEEP_TEST_GAPS` (`reason_category` stays `low_value`); `body_without_fix` on kept candidates with a proposal when the judge gave a usable fix-free finding text (`ENABLE_SUGGESTED_FIXES`; logged whether or not it was posted). See [prompt/judge.md](../context/prompt/judge.md). Judge-run only |
| `judge_anomalies` | `object \| null` | `{ unknown_ids, undecided, duplicate_ids, drop_without_evidence }`, plus `invalid_duplicate` under `ENABLE_JUDGE_QUALITY`; judge-run only |
| `judge_policy` | `object \| null` | `{ keep_minor, keep_unverified, file_context }` flags in effect, plus `keep_test_gaps: true` only when `ENABLE_JUDGE_KEEP_TEST_GAPS` is on; only when the judge ran |
| `breadth_status` | `string \| null` | `disabled` \| `skipped_no_judge` \| `skipped_rereview` \| `skipped_bundled` \| `skipped_small` \| `skipped_few_untouched` \| `skipped_limit` (first pass already used the whole `MAX_FINDINGS`) \| `skipped_budget` \| `skipped_time` (benchmark only: over half of `BENCHMARK_DEADLINE_SECONDS` elapsed, or no time left before the pass deadline) \| `aborted_time` (`ENABLE_BENCHMARK_PASS_DEADLINE`: the call was stopped at the pass deadline) \| `succeeded` \| `failed`; null when the stage wasn't reached |
| `breadth_model` / `breadth_prompt_hash` | `string \| null` | Model and system-prompt hash of the breadth call, when it ran |
| `breadth_tokens` / `breadth_cost_usd` | `object \| null` / `number \| null` | Breadth usage; cost is the provider's actual, else priced at the breadth model, and is included in `cost_usd` |
| `second_look_status` | `string \| null` | `disabled` \| `skipped_no_judge` \| `skipped_rereview` \| `skipped_bundled` \| `skipped_no_findings` (no changed file carries a finding) \| `skipped_limit` (reviewer + breadth findings already used the whole `MAX_FINDINGS`) \| `skipped_budget` \| `skipped_time` (benchmark only: over half of `BENCHMARK_DEADLINE_SECONDS` elapsed, or no time left before the pass deadline) \| `aborted_time` (stopped at the pass deadline) \| `succeeded` \| `failed`; null when the stage wasn't reached |
| `second_look_prompt_hash` | `string \| null` | System-prompt hash of the second-look call, when it ran |
| `second_look_tokens` / `second_look_cost_usd` | `object \| null` / `number \| null` | Second-look usage; cost is the provider's actual, else priced at the reviewer model (`CLAUDE_MODEL`), and is included in `cost_usd` |
| `lens_runs` | `array \| null` \| absent | One `{ name, status, model, prompt_hash, tokens, cost_usd, findings }` per listed lens, in `LENSES` order; `status` = `skipped_no_judge` \| `skipped_rereview` \| `skipped_bundled` \| `skipped_limit` \| `skipped_budget` \| `skipped_time` \| `aborted_time` \| `succeeded` \| `failed`; `findings` is a count; `cost_usd` (actual, else priced at the lens model) is included in `cost_usd`. Null when `LENS_REVIEW` wasn't reached; the key is absent when lenses are off (`ENABLE_LENSES` off or no known name in `LENSES`) |
| `lens_recommendations` | `array \| null` \| absent | `ENABLE_LENS_RECOMMENDATION` only: the first-pass reviewer's `{ lens, reason }` picks (known lens names, one per lens, `reason` ≤200 chars); `[]` when it recommended none. Log-only — nothing acts on it, so compare it offline with `lens_runs`. Null on a re-review or bundled run, when the model did not return the field, or when no reviewer result was produced; the key is absent when the flag is off |
| `suggested_fixes` | `object \| null` \| absent | `ENABLE_SUGGESTED_FIXES` only: `{ rendered, rejected, dropped?, fix_free?, skipped? }` for the posted comment, or the comment `--dry-run` printed — `rendered` blocks spliced in, `rejected` proposals refused at render time (a fence line, a footer-shaped line, U+2028/U+2029 or a control character other than `\n`/`\t`, or over 500 chars), `dropped` (present only when > 0) kept findings whose judge proposal the sanitizer omitted (raw over 2,000 chars, over 500 chars or 7 lines after dedent, or blank after unwrapping; an absent or whitespace-only proposal is no proposal), `fix_free` (present only when > 0) findings posted with the judge's fix-free text above their block, `skipped` (`cleanup` \| `unbalanced` \| `fence` \| `size`) when every block was dropped. Sanitizer loss rate = `dropped / (dropped + rendered + rejected)` when nothing was skipped. Null when `POST_REVIEW` posted no judged comment (no judge, judge skipped or failed, bundled, benchmark, a pre-post race `DEDUP_SKIP` after the blocks were composed, any skip); the key is absent when the flag is off |
| `counterpart_rows` | `number` \| absent | `--benchmark` with `ENABLE_BENCHMARK_COUNTERPART_ROWS` only: the rows the findings writer actually appended to `findings.json` from counterpart mentions (it reports the count back through the outcome sink), `0` included. Absent when the flag is off, on a bundled review, a judge failure or an unjudged run (they get no counterpart rows), and on every non-benchmark record |
| `also_affects_rows` | `number` \| absent | `--benchmark` with `ENABLE_HIGH_IMPACT` only: the rows the findings writer appended from `also_affects` entries, `0` included (also `0` when the writer threw). Absent when the flag is off, on a bundled review, a judge failure or an unjudged run, and on every non-benchmark record |
| `also_affects` | `array` \| absent | Same condition as `also_affects_rows`, absent when the writer threw: one `{ parent, file, lines, where, status }` per entry, in kept order then model order; `parent` is the kept finding's title, `file`/`lines` as the model gave them, `status` = `row` or the rejection reason (`parent_unanchored`, `unresolved_path`, `deleted_file`, `own_file`, `bad_lines`, `not_changed_line`, `bad_where`, `duplicate`, `over_cap`; see [vcs/adapter.md](../context/vcs/adapter.md)) |
| `pass_calls` | `array` \| absent | `--benchmark` with `ENABLE_BENCHMARK_PASS_DEADLINE` or `ENABLE_FIRST_PASS_SITES` only: one `{ stage, end, max_tokens, output_tokens, reasoning_tokens, limit_ms }` per model call in call order; `stage` = `review` \| `breadth` \| `second_look` \| `lens:<name>` \| `judge`, `end` = `ok` \| `truncated` \| `aborted_time` \| `error`, token counts `null` when the call reported none and always `null` for `aborted_time` (an aborted stream reports only a start-of-message snapshot), `limit_ms` the integer pass-deadline limit (null for reviewer, judge and with the deadline off). Every attempt is one entry, failed ones included: a truncated or context-rejected reviewer attempt appears before its diff-only retry, and a run that then errors keeps them. A bundled run logs one `review` and (when judged) one `judge` entry per bundle. One entry per stage call: a provider-internal resend (OpenRouter's one missing-field resend) is summed into that call's entry, not listed apart. Answers which pass hit truncation and what it spent. With `CACHED_PASS_EFFORT` set, a shared-pass entry (every request it sent, rejected ones included) adds `pass_effort` (the effort its request sent: the setting with the per-message message, else the reviewer's effort or `default` after a rejection) and `final_reasoning_tokens` (the accepted response's reported reasoning count, 0 included; `null` = not reported; never summed into stage or run totals) |
| `prompt_cache` | `object \| null` \| absent | `ENABLE_PROMPT_CACHE` only: `{ ttl: "5m", reviewer_marked, shared_stages, uncached: [{ stage, reason }], session_id? }`. `shared_stages` lists the passes that sent the cached shape; `uncached` reasons are `model` / `effort` / `unsupported_model` / `rejected_400: <message>` (the first non-overflow 400 on a cached pass, upstream text up to 120 chars) / `off_after_400` (every later shared pass) / `skipped_after_plan: <status>` (a planned shared pass a findings-dependent gate skipped, or `not_reached`) or a gate already certain before the reviewer call (`skipped_small` / `skipped_few_untouched` / `skipped_no_findings` / `skipped_budget` / `skipped_time`) for a pass and `rereview` / `no_judge` / `unsupported_model` / `no_shared_pass` / `bundled` for the reviewer (stage `review`). `session_id` only under OpenRouter. Null when the run never reached a model call. With the flag on, `pass_calls` is always recorded (production too) and each entry adds `input_tokens`, `cache_read_tokens`, `cache_write_tokens` and `cost_usd` (the provider's actual, else estimated at the stage model; all `null` when the call reported no usage or was `aborted_time`). A miss shows as `cache_write_tokens` on a pass. With `CACHED_PASS_EFFORT` set it also holds `pass_effort: { effort, status }`, `status` = `on` \| `unsupported_model` \| `no_shared_pass` \| `rejected_400: <message>` (the first non-overflow 400 on a pass sending the message; later passes keep the shipped cached request without it) |
| `first_pass_sites_named` | `array \| null` \| absent | `--benchmark` with `ENABLE_FIRST_PASS_SITES` only: every sanitized `{ id, file, lines, where, via }` breadth and second-look named, kept parents or not (join with `judge_decisions` by `id`); null when neither pass succeeded |
| `first_pass_sites_dropped` | `object \| null` \| absent | Same flag: per pass that succeeded (`breadth`, `second_look`), the count of entries the sanitizer rejected by reason: `not_array` (the field was present but not a list, counted once), `not_object`, `unknown_id` (an id the pass was not briefed with), `bad_file`, `bad_lines`, `bad_where` (empty or missing), `over_keep` (more than 10 for one id); `{}` when none; null when neither pass succeeded |
| `first_pass_site_rows` | `number` \| absent | Same flag, single-pass judged path only: rows appended from first-pass sites, `0` included (also when the writer threw); separate from `also_affects_rows` |
| `first_pass_sites` | `array` \| absent | Same condition, absent when the writer threw: one `{ id, via, parent, file, lines, where, status }` per site of a kept first-pass finding; `id` is the parent's own candidate id, `status` as for `also_affects` except that `duplicate` means any earlier row on overlapping lines of that file |
| `untouched_files` | `object \| null` | `{ count, paths (≤40, diff order), cut }` — reviewable files without a reviewer finding, when the trigger was evaluated. With `ENABLE_BREADTH_PRIORITY_TARGETS`, `paths` is the prioritized selection, `cut` the eligible files left unlisted, and an extra `deprioritized` counts the release-entry files left out of the briefing |
| `recall_levers` | `object` | `{ j_quality, sl_breadth, j_shown_anchor, b_priority }` — whether `ENABLE_JUDGE_QUALITY`, `ENABLE_SECOND_LOOK_BREADTH_TARGETS`, `ENABLE_JUDGE_SHOWN_CONTEXT_ANCHORS` and `ENABLE_BREADTH_PRIORITY_TARGETS` were on; always present. `high_impact: true` is added only when `ENABLE_HIGH_IMPACT` is on, and `first_pass_sites: true` only with `ENABLE_FIRST_PASS_SITES` under `--benchmark`, so flag-off records keep the four keys |
| `anchored_findings` | `array \| null` | Compact kept-finding rows `{ anchor, severity, type, description, proposal?, quality_action? }` resolved to a real line; `proposal?` only with `ENABLE_JUDGE_PROPOSALS` or `ENABLE_SUGGESTED_FIXES` (under the latter: a short instruction, plus the corrected code for a local edit), `quality_action?` only with `ENABLE_JUDGE_QUALITY`; judge-run only |
| `touch_rate` | `number \| null` | Re-review only: `resolved / (resolved + still_open) × 100` — percentage of previous findings addressed by the developer |
| `delta` | `object \| null` | Re-review only: `{ developer_replies, human_replies, agent_replies, resolved, still_open, new_findings }`. `developer_replies` is every reply in the discussion handed to the run and keeps its meaning from earlier versions (on a re-review it includes the agent's own earlier replies); `human_replies` + `agent_replies` always equal it. An agent reply is one the adapter labelled `Agent (prior reply)` (its reply footer matched), the same rule on Bitbucket, Azure and GitHub |
| `reply_authors` | `string[]` \| absent | Distinct authors of the human replies this run answered (a `REPLY` run) or took into account (a re-review), first-seen order, agent replies excluded. Each entry is the platform's stable account id when the payload had one (Bitbucket `user.uuid`, else `user.account_id`; Azure the comment author `id`), else the display name; on GitHub the entry is the `login` (a handle, not an opaque id). Absent when there is no human reply. Sits right after `delta`. Personal data: ids, logins and names identify people, so apply your log retention and access rules to the index. Not sent to any model |
| `reply_limit_note` | `true` \| absent | Present only with `ENABLE_REPLY_LIMIT_PER_REVIEW` when this run posted the one-time reply-limit note (or would have, under `--dry-run`). Sits before `jenkins`, after `dedup_source` |
| `inline` | `object` | absent | Only with `ENABLE_INLINE_REVIEWS`. `{ active: false, reason: "unsupported_vcs" | "benchmark" }` when the flag is on but the legacy flow ran; otherwise `{ active, completed, outcome, identity, summary_check, summary, roots, suppressed, raised_over_resolved, answers, reply_usage, untrusted_markers, writes_reconciled, rows_collapsed, footer_lines_removed, head_moved_at? }`. `outcome`: `written`, `write_failed` (a refused summary write, or a re-list failure before any write; the run errors), `replies_only`, `dedup` (also set when a dedup run errors on a failed reply call), `skipped` (a budget, context-window or bundling skip after the load, nothing posted, even if the reply attempt failed), `incoherent_no_change`, `write_uncertain`, `force_invalidate_failed`, `head_moved_skip`, `head_moved_partial`, `concurrent_run`, `identity_unavailable`, `identity_mismatch`, `dry_run`. `completed` is true when the head is recorded in the summary state, including a dedup run that errors on a head completed earlier. Reply-model usage (`reply_usage`) is priced at `REPLY_MODEL`, summed into `cost_usd` and taken out of the reviewer stage. `suppressed` is `{ open_duplicate, resolved, in_run_duplicate }`: findings matching an existing open thread, a developer-resolved thread, or a root already planned earlier in the same run (strict match only). See `docs/context/review/inline-engine.md` |
| `checked_commit` | `string` \| absent | The full `source_commit`, present only when this run genuinely checked that head (posted review, pre-post race, footer or checked-commit match, zero-reviewable delta, coherent structured `NO_CHANGE`, `NO_NEW_FINDINGS`, a quiet reply) and did not fail afterwards. Never on `SKIP`/`ERROR`, dry-run, `--benchmark`, `--force clean`/`re-review`, after a failed delta fetch or on an uncertain bundle, and, from 0.0.46, never for a head that fails the `LAST_CHECKED_COMMIT` rule (12–64 hex), so a provider that reports an empty head yields no value. CI stores exactly this value per PR and passes it back as `LAST_CHECKED_COMMIT`. See [review/skip-logic.md §8](../context/review/skip-logic.md) |
| `dedup_source` | `"checked_commit"` \| `"target_merge"` \| absent | `checked_commit`: the run matched the head against the checked commit CI passed (`LAST_CHECKED_COMMIT`). `target_merge`: the delta came from a target-branch merge and the PR diff was unchanged since the reviewed commit (`ENABLE_TARGET_MERGE_CHECK`). Kept even if the run then errored |
| `jenkins` | `object \| null` | `{ job, build, url }` from the `JOB_NAME`/`BUILD_NUMBER`/`BUILD_URL` env vars, whatever the CI (Jenkins sets them; any other CI can export them from its own run ids), or null when all three are empty — maps a run to its build/artifact. The name predates other CIs |
| `trigger` | `object` \| absent | `{ event, comment_author }` — raw trimmed values from `--event`/`--comment-author` (or `TRIGGER_EVENT`/`TRIGGER_COMMENT_AUTHOR`), null for the one not given, plus `event_kind` (`comment` \| `other`, from 0.0.46) only when `--event-kind`/`TRIGGER_EVENT_KIND` was given with a valid value. The key is absent when neither event nor author was given, so those records serialize as before. See [review/skip-logic.md §7](../context/review/skip-logic.md) |
| `error` | `object \| null` | `{ type, message, status }` on failure. On a max-tokens truncation, `type` is `TruncatedResponseError` and `tokens.*` still hold the real spend (not zeros). A reviewer response whose `findings` is null or not a list gives `Structured output missing required field(s): findings` (`type` `Error`, the same as a missing key) and also keeps the spend. A missing required key (`Structured output missing required field(s): …`) keeps the spend too: both providers attach the call's usage, and on OpenRouter, which resends such a response once, the usage of both attempts |

### Action Values

| Action | Meaning |
|--------|---------|
| `REVIEW` | First review posted (or printed in dry-run) |
| `RE_REVIEW` | Subsequent review (`review_number > 1`) — includes `delta` stats |
| `REPLY` | Reply to developer question posted |
| `NO_CHANGE` | Re-review found nothing material; no review posted. Still runs `CHECK_REPLIES` — answers a pending developer reply (→ `REPLY`), else skips keeping this label |
| `NO_NEW_FINDINGS` | Re-review produced 0 findings and the prior review was clean with nothing open — nothing posted. Also a narrowed re-review after a target-branch merge (head is a merge on the reviewed commit) that found nothing and reported nothing resolved: `skip_reason: Re-review after a target-branch merge found no new findings` |
| `SKIP` | Out of scope — branch exclusion (incl. a target not in `ONLY_TARGET_BRANCHES`), a comment event by an `IGNORE_COMMENT_AUTHORS` actor (no VCS call: PR fields are `unknown`, `review_number` 0), size thresholds, input budget, or context-window overflow — no review posted |
| `DEDUP_SKIP` | Commit already reviewed with no unanswered reply, or the reply limit with no review run (`reply limit reached (n/N)`) / a pre-post race — no review posted. A head matched against the checked commit from CI has `skip_reason: head already checked by an earlier run and no unanswered questions` and `dedup_source: checked_commit`. A target-branch merge that left the PR diff unchanged has `skip_reason: target branch merged in; PR diff unchanged since the last review and no unanswered questions`, `dedup_source: target_merge` and `checked_commit` |
| `ERROR` | Agent failed — see `error` field. Includes the **cut guard**: a review truncated before its final section (judge → Merge Confidence; reviewer → Unresolved Questions) is refused rather than posted partial, and retries on the next trigger. |

### Telling Skipped from Reviewed in CI

There is no distinct exit code for a skip:
- `0` for every non-error outcome (nothing calls `process.exit`).
- `1` for `ERROR`: the record is written, then the error is rethrown.
- `1` for argument/config errors, with no record written.
- `--benchmark` always exits 0.

Read `action` from **this run's** record instead (next section). The same JSON is printed to stdout under `=== Usage ===` regardless of `--log-usage`, pretty-printed over many lines, so prefer a record file.

| `action` | Posted? |
|---|---|
| `REVIEW`, `RE_REVIEW` | review comment posted |
| `REPLY` | threaded reply posted |
| `SKIP`, `DEDUP_SKIP`, `NO_CHANGE`, `NO_NEW_FINDINGS` | nothing posted |
| `ERROR` | nothing posted; exit 1 |

With `dry_run: true` nothing is posted, whatever the `action`. Tell the allow-list and ignored-author skips apart by `skip_reason` (it contains `ONLY_TARGET_BRANCHES` or `IGNORE_COMMENT_AUTHORS`).

### Finding this run's record

`results.jsonl` is appended in the working directory and accumulates when that directory is reused (a Jenkins workspace, a self-hosted runner or agent). A run that fails before writing (argument/config error, crash) leaves an earlier run's record as the last line, so the last line alone can describe the wrong run. Any of these works, on any CI:

| Option | How | Notes |
|---|---|---|
| Match the run ids | The line whose `jenkins.job` / `jenkins.build` equal `$JOB_NAME` / `$BUILD_NUMBER`, last match | Jenkins sets both. Another CI exports `JOB_NAME` / `BUILD_NUMBER` / `BUILD_URL` from its own run ids (per provider in [skip-logic.md §9](../context/review/skip-logic.md)); the `jenkins` field is built from exactly these, and the footer's `Review #N` then links to the run |
| Fresh file | Run in a fresh working directory, or `rm -f results.jsonl` before the run; read the single line and check its key (`vcs`, `workspace`, `repo_slug`, `pr_id`) | Empty file = the run wrote no record |
| Own file (from 0.0.46) | `USAGE_RECORD_FILE=<path>` (or, from 0.0.54, `--usage-record-file <path>`); `rm -f <path>` before the run; read that file | Holds only this run's record (overwritten). Needs `--log-usage` on. A bundle older than the variable writes no file, so CI reads nothing (fail open) |

```sh
# This run's record by run ids (empty when the run wrote none); REVIEW|RE_REVIEW|REPLY = posted; SKIP|DEDUP_SKIP|NO_CHANGE|NO_NEW_FINDINGS = nothing posted
RECORD=$(jq -c --arg job "$JOB_NAME" --arg build "$BUILD_NUMBER" 'select(.jenkins.job == $job and .jenkins.build == $build)' results.jsonl | tail -n 1)
# Or, with USAGE_RECORD_FILE (deleted before the run)
RECORD=$(cat "$USAGE_RECORD_FILE" 2>/dev/null)
ACTION=$(printf '%s' "$RECORD" | jq -r '.action // empty')
```

### Storing `checked_commit` for the Next Run

To skip re-reviews of a head that was already checked without a post, CI stores `checked_commit` per PR and passes it back as `LAST_CHECKED_COMMIT` (full contract in [skip-logic.md §8](../context/review/skip-logic.md)):
- Read **this run's** record (above), not just the last line: a crashed run writes nothing.
- Key by `vcs` + `workspace` + `repo_slug` + `pr_id`, and check that the key is this PR's. `workspace` is the Bitbucket workspace, the Azure org or the GitHub owner (record schema above). If the record has a non-empty `checked_commit`, overwrite the stored value; otherwise store nothing. Ignore `action` and the exit code.
- Fail open: a missing, unreadable or malformed value means pass nothing.

It is a separate field, not an `action`, because `NO_CHANGE`, `REPLY` and `DEDUP_SKIP` each mix trustworthy endings (structured `NO_CHANGE`, quiet reply, recognised head) with untrustworthy ones (regex `NO_CHANGE`, a reply that still owes a confirmation post). A reply limit after a `NO_CHANGE` review is no longer a `DEDUP_SKIP` case: it keeps the `NO_CHANGE` action and its reason, and a limit at the 0-finding gate ends as `NO_NEW_FINDINGS` or a posted re-review, and a `SKIP` or `ERROR` never means the head was reviewed.

From 0.0.46 the agent emits `checked_commit` only as a 12–64 hex head, but filter on a non-empty value anyway: `select(.checked_commit)` is also true for `""` in jq, which a record from an older bundle could carry.

```sh
# This run's record, last match; prints nothing when there is nothing to store
jq -c --arg job "$JOB_NAME" --arg build "$BUILD_NUMBER" 'select(.jenkins.job == $job and .jenkins.build == $build)' results.jsonl | tail -n 1 \
  | jq -c 'select((.checked_commit // "") != "") | {vcs, workspace, repo_slug, pr_id, checked_commit}'
# The same from USAGE_RECORD_FILE, for this PR only
jq -c --arg pr "$PR_ID" 'select(.pr_id == $pr and (.checked_commit // "") != "") | {vcs, workspace, repo_slug, pr_id, checked_commit}' "$USAGE_RECORD_FILE" 2>/dev/null
```

### Cost Estimation

Cost is calculated client-side from token counts and a per-model pricing table (per 1M tokens) in `MODEL_PRICING` (`src/review/usage.ts`) — the single source of truth, covering the haiku / sonnet / opus 4.x and 5.x families (`claude-haiku-5-5` is tiered by input size). Unknown models fall back to Sonnet 4.6 pricing with a `No pricing entry` warning. Update that table when Anthropic changes rates. A call whose provider reports its own cost (OpenRouter) is logged at that cost instead of the table estimate.

Cache tokens (only present with `ENABLE_PROMPT_CACHE`): cost = input × rate + write × rate × 1.25 + read × rate × r + output × out rate, with r = 0.1 by default, 0.05 for Sonnet 5.5 and Opus 5.5, 0.025 for Fable/Mythos 5.1+. Haiku 5.5's 100K tier is decided on input + read + write. The reviewer-only estimate subtracts every stage's cache fields as well as its input and output, so passes' reads never push the reviewer over a tier. With the flag on, OpenRouter tokens are normalized on every response (marked or not), and a call resent once for a missing field is priced attempt by attempt (`estimateAttemptsCost`, rounded once), so two 100K prompts never price as one 200K prompt.

OpenRouter's Anthropic slugs price as their table entry: the lookup strips an `anthropic/` prefix and a `:variant` suffix, turns dots into dashes and drops a `-YYYYMMDD` date, so `anthropic/claude-sonnet-5.5[:beta]` prices as `claude-sonnet-5-5` and `anthropic/claude-haiku-5.5` gets the Haiku 5.5 tier. Ids that already resolved price exactly as before. Non-Anthropic slugs (`openai/…`), version-first names (`anthropic/claude-3.7-sonnet`) and models absent from the table still fall back and warn. This touches only the estimate path, i.e. calls without a provider-reported cost, and only five logged fields: `cost_usd`, `judge_cost_usd`, `breadth_cost_usd`, `second_look_cost_usd` and `lens_runs[].cost_usd`. No code path reads them (the FSM never reads a cost). For a slug that used to fall back, those estimates move from Sonnet 4.6 rates to the model's own rates (e.g. an unreported `anthropic/claude-haiku-5.5` judge call is now ~30× lower). A zero-call run stays at `cost_usd: 0` and just loses the warning line.

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

# Checked heads to store per PR, and runs the checked commit deduped
jq -c 'select((.checked_commit // "") != "") | {vcs, workspace, repo_slug, pr_id, checked_commit}' results.jsonl
jq -s '[.[] | select(.dedup_source=="checked_commit")] | length' results.jsonl

# Error rate
jq -s '{total: length, errors: [.[] | select(.action=="ERROR")] | length}' results.jsonl

# Reasoning share of output (runs that report it)
jq -s '[.[] | select(.tokens.reasoning) | {pr: .pr_id, reasoning: .tokens.reasoning, output: .tokens.output, share: (.tokens.reasoning / .tokens.output * 100 | round)}]' results.jsonl

# Estimate vs actual tokens (accuracy check)
jq -s '[.[] | select(.action=="REVIEW") | {pr: .pr_id, estimated: .tokens.estimated_input, actual: .tokens.input, ratio: (if .tokens.estimated_input > 0 then (.tokens.input / .tokens.estimated_input * 100 | round | tostring + "%") else "n/a" end)}]' results.jsonl

# Average computed score
jq -s '[.[] | select(.computed_score != null) | .computed_score] | add/length | round' results.jsonl

# Reviews by author
jq -s 'group_by(.pr_author) | map({author: .[0].pr_author, reviews: length}) | sort_by(-.reviews)' results.jsonl

# Judge finding validation (raw vs validated)
jq -s '[.[] | select(.review_findings != null and .findings != null and .judge_model != null) | {pr: .pr_id, raw: .review_findings, validated: .findings, judge: .judge_model}]' results.jsonl

# Cost breakdown by stage (reviewer = total minus every other stage)
jq -s '[.[] | select(.judge_cost_usd != null) | ([.lens_runs[]?.cost_usd // 0] | add) as $lens | {pr: .pr_id, review_cost: (.cost_usd - .judge_cost_usd - (.breadth_cost_usd // 0) - (.second_look_cost_usd // 0) - $lens), breadth_cost: .breadth_cost_usd, second_look_cost: .second_look_cost_usd, lens_cost: $lens, judge_cost: .judge_cost_usd, total: .cost_usd}]' results.jsonl

# High-severity findings
jq -s '[.[] | select(.findings.high > 0) | {repo: .repo_slug, pr: .pr_id, high: .findings.high}]' results.jsonl

# Re-review resolution rate
jq -s '[.[] | select(.action=="RE_REVIEW" and .delta != null) | {pr: .pr_id, resolved: .delta.resolved, still_open: .delta.still_open}]' results.jsonl

# Average touch rate (% of findings addressed by developers)
jq -s '[.[] | select(.touch_rate != null) | .touch_rate] | if length > 0 then (add/length | round) else "no data" end' results.jsonl

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
