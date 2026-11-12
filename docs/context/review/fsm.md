---
type: domain
topic: Review orchestration finite state machine
---

# Review FSM

The review orchestration (`src/review/index.ts`) is an explicit finite state machine. A `State` enum names every node; `ReviewContext` carries accumulated data; `transition(state, ctx)` returns the next state. The runner loops until `DONE`.

Related: [review/skip-logic.md](skip-logic.md) | [review/replies.md](replies.md) | [practices.md](../practices.md)

---

## State Transitions

```
CHECK_TRIGGER (passthrough unless CI passed --event/--comment-author)
  ├─ [comment event by an IGNORE_COMMENT_AUTHORS id, no --force] → SKIP → DONE
  └─ FETCH_PR_INFO (below)
FETCH_PR_INFO
  └─ CHECK_BRANCHES
       ├─ [branch exclusion match, or target not in ONLY_TARGET_BRANCHES] → SKIP → DONE
       └─ FETCH_DIFF (+ filterDiff)
            ├─ [no reviewable changes after exclusions] → SKIP → DONE
            └─ CHECK_THRESHOLDS
                 ├─ [fail] → SKIP → DONE
                 └─ CHECK_PREVIOUS_REVIEWS
                      ├─ [same commit] → CHECK_REPLIES
                      │    ├─ [unanswered replies] → RESPOND_TO_REPLIES → DONE
                      │    └─ [none] → SKIP → DONE
                      ├─ [head = checked commit from CI (LAST_CHECKED_COMMIT), not forced] → CHECK_REPLIES
                      │    ├─ [unanswered replies] → RESPOND_TO_REPLIES → DONE
                      │    └─ [none] → SKIP → DONE
                      ├─ [delta diff empty after filter] → CHECK_REPLIES
                      │    ├─ [unanswered replies] → RESPOND_TO_REPLIES → DONE
                      │    └─ [none] → SKIP → DONE
                      └─ LOAD_PROMPT → FETCH_CONTEXT → ESTIMATE_TOKENS (still over budget → BUNDLED_REVIEW when enabled, else SKIP) → CALL_MODEL
                           └─ CHECK_NO_CHANGE
                                ├─ [NO_CHANGE] → CHECK_REPLIES (answer a dev reply even with no code change; else SKIP, label kept NO_CHANGE)
                                └─ BREADTH_REVIEW (passthrough unless ENABLE_BREADTH_REVIEW + triggered)
                                     └─ SECOND_LOOK (passthrough unless ENABLE_SECOND_LOOK + flagged files)
                                          ├─ [ENABLE_LENSES + ≥1 known name in LENSES] → LENS_REVIEW → JUDGE_REVIEW
                                          └─ JUDGE_REVIEW
                                               ├─ [0-finding re-review + unanswered dev reply] → RESPOND_TO_REPLIES → DONE (reply priority)
                                               ├─ [JUDGING_MODEL set] → validate reviewer + breadth + second-look + lens candidates → POST_REVIEW → DONE
                                               └─ [no judge] → POST_REVIEW → DONE
```

Both inbound edges to `RESPOND_TO_REPLIES` (`CHECK_REPLIES` and this `JUDGE_REVIEW` reply-priority branch) run the optional directed-elsewhere filter (`SKIP_DIRECTED_REPLIES`, Bitbucket) before their reply-limit check — see [replies.md](replies.md).

**Bundled path (`ENABLE_BUNDLED_REVIEW=true`, default off):** after `FETCH_CONTEXT`, `ESTIMATE_TOKENS` drops file contexts if over `MAX_INPUT_TOKENS`; if the diff alone is still over budget it routes to `BUNDLED_REVIEW` instead of SKIP, then `POST_REVIEW`. In-budget PRs never enter it. It bypasses `BREADTH_REVIEW`, `SECOND_LOOK` and `LENS_REVIEW`; the usage record infers their statuses (each active lens → `skipped_bundled`).

**21 states. 11 possible outcomes:**
1. Skip — ignored comment author (`IGNORE_COMMENT_AUTHORS`, before any VCS call)
2. Skip — branch exclusion (incl. a target not in `ONLY_TARGET_BRANCHES`)
3. Skip — no reviewable changes after exclusions
4. Skip — threshold (too few/many reviewable files or lines)
5. Skip — same commit (or the head CI reported as checked), no replies
6. Skip — delta diff empty, no replies
7. Skip — reply limit reached
8. Skip — NO_CHANGE re-review (falls through to CHECK_REPLIES first; skips only when no reply is pending)
9. Skip — re-review produced no new findings and the prior review was clean (`NO_NEW_FINDINGS`)
10. Reply — developer question answered (including after a NO_CHANGE re-review)
11. Post review — new review comment

(Fine-grained skips — input-budget exceeded, context-window overflow, a bundled review that needs too many bundles, an oversized diff the adapter can't fetch (`PrTooLargeError`, GitHub), and the pre-post race — fall under outcomes 2–4; see [skip-logic.md](skip-logic.md).)

---

## Key State Responsibilities

| State | What happens |
|-------|-------------|
| `CHECK_TRIGGER` | Initial state. With no trigger passed (`--event`/`--comment-author` or `TRIGGER_EVENT`/`TRIGGER_COMMENT_AUTHOR`), goes straight to `FETCH_PR_INFO` with no log and no I/O. Otherwise logs `Trigger: …`, and SKIPs a comment event whose actor id is in `IGNORE_COMMENT_AUTHORS` unless `--force` is set; non-comment events are never skipped. See [skip-logic.md §7](skip-logic.md) |
| `FETCH_DIFF` | Fetches raw diff from VCS API; calls `filterDiff()` to produce filtered copy; computes reviewable (post-filter) line/file counts; skips immediately if zero reviewable lines. A `PrTooLargeError` from the adapter (diff over the provider's size ceilings — GitHub only today) is caught here and becomes a clean SKIP, not an ERROR |
| `CHECK_THRESHOLDS` | Compares reviewable (post-filter) line/file counts against `MIN/MAX_CHANGED_*` env vars |
| `CHECK_BRANCHES` | Compares source/target branch names against `SKIP_SOURCE_BRANCHES` / `SKIP_TARGET_BRANCHES` glob patterns, then (when set) skips a target matching none of `ONLY_TARGET_BRANCHES`; the skip lists win on overlap. Each list can be overridden per repo by its CLI flag (`--skip-source-branches` etc.), where an empty value turns that list off |
| `CHECK_PREVIOUS_REVIEWS` | Parses commit hash from last review footer; same commit → `CHECK_REPLIES`. On a footer miss, a checked commit passed by CI (`LAST_CHECKED_COMMIT` / `--checked-commit`) that equals the head → `CHECK_REPLIES` too (`dedup_source: checked_commit`); not consulted on a first review or under `--force clean` / `re-review`, and never changes the delta base. Otherwise triggers the delta diff pre-check. See [skip-logic.md §8](skip-logic.md) |
| `LOAD_PROMPT` | Fetches `.agent-review-instructions.md` from the target repo (CLI `--prompt` → source commit → target branch; each ref probes root → `docs/` → single-module-dir fallback; then composed tech-stack rule sets; defaults last) |
| `FETCH_CONTEXT` | Fetches full file content for changed files (see [fetching/strategy.md](../fetching/strategy.md)) |
| `ESTIMATE_TOKENS` | Estimates input (~chars/4); over the input budget (min of `MAX_INPUT_TOKENS` and the context window — the smaller of the reviewer's and judge's, each derived from the model id (OpenRouter `anthropic/` slugs resolve as their bare id), with `MODEL_CONTEXT_TOKENS` overriding the reviewer's — minus the output reserve) → drops file contexts (diff-only); still over → `BUNDLED_REVIEW` when enabled, else SKIP |
| `CALL_MODEL` | Assembles payload (PR info, prior review, developer discussion, diff, file context); calls reviewer model. The reviewer returns a typed object (`ctx.reviewObject`); `renderReview` builds `reviewText`. See [llm/structured-output.md](../llm/structured-output.md). With `ENABLE_LENS_RECOMMENDATION` (or `--lens-recommendation`, or the `LENS_REC` label) on and a first review, `runReview` gets one trailing `true`, so the same call also returns which lenses the reviewer recommends; they go to `ctx.lensRecommendations`, one `Lens recommendations: <lens> (<reason>), …` / `none` / `unavailable` (field not returned) log line and `lens_recommendations` in the usage record — never into `reviewObject`, the judge or the post. Log-only: `LENS_REVIEW` still runs every listed lens. Re-reviews and bundle reviewers never request it, and the context-length retry repeats the same call |
| `CHECK_NO_CHANGE` | Inspects `reviewText` for the `NO_CHANGE` sentinel (rendered when the reviewer sets `no_change`) before any further processing |
| `BREADTH_REVIEW` | Off unless `ENABLE_BREADTH_REVIEW`. On a first, single-pass review with a judge configured, ≥`BREADTH_MIN_FILES` (5) reviewable changed files and ≥`BREADTH_MIN_UNTOUCHED` (3) of them without any reviewer finding, runs a second reviewer-sized call (`runBreadth`) on `BREADTH_MODEL` (unset → judge model, resolved here so benchmark labels apply). Same system prompt + a `## BREADTH LENS` block (untouched files, same defect elsewhere, changed-together, incomplete changes — all on added/modified lines), same diff/contexts + first-pass findings (`file:lines — title`) + the untouched list. Findings go to `ctx.breadthFindings` (never into `reviewObject`, so reviewer metrics and the judge-failure fallback stay reviewer-only). Every skip and failure is recorded in `breadth_status`; a failure never fails the review. Under `--benchmark` it is skipped (`skipped_time`) once over half of `BENCHMARK_DEADLINE_SECONDS` has elapsed. The judge holds breadth numeric anchors to changed lines (reviewer anchors stay ungated), and if the judge fails after a clean reviewer + breadth-only candidates, the breadth findings are dropped and the reviewer's own review posts (with reviewer findings it still throws). **Why:** run 312 left 32% of golden issues in files with no finding at all |
| `SECOND_LOOK` | Off unless `ENABLE_SECOND_LOOK` (or `--second-look`, or the `SECOND_LOOK` benchmark label). On a first, single-pass review with a judge configured, re-reads the reviewable changed files that already carry a reviewer finding (`flaggedFiles`, the inverse of breadth's untouched list) for problems the first pass missed. One reviewer-sized call (`runBreadth` with label `second-look`) on the reviewer model (`CLAUDE_MODEL`) at `REVIEW_EFFORT`: reviewer prompt + a `## SECOND LOOK` block (same defect elsewhere in these files, changed-together inconsistencies, incomplete changes — all on added/modified lines; plus a `## FINDINGS LIMIT` of what `MAX_FINDINGS` leaves after reviewer and breadth findings), only the flagged files' diff sections and file contexts, and a briefing of the known reviewer + breadth findings in those files (`file:lines — title`). Findings go to `ctx.secondLookFindings` (never `reviewObject`) and reach the judge after breadth candidates as `origin: 'second_look'`, numeric anchors held to changed lines as for breadth. Status in `second_look_status`: off → `disabled`; no judge → `skipped_no_judge`; re-review → `skipped_rereview`; no flagged file → `skipped_no_findings`; `MAX_FINDINGS` used up → `skipped_limit`; estimate on the restricted inputs over the budget (min of `MAX_INPUT_TOKENS` and the reviewer model's window minus `MAX_OUTPUT_TOKENS`) → `skipped_budget`; under `--benchmark`, over half of `BENCHMARK_DEADLINE_SECONDS` elapsed → `skipped_time`; a thrown call → `failed` (a truncated call's usage still counts) and the review continues. Whatever its status, the next state is `LENS_REVIEW` when lenses are active, else `JUDGE_REVIEW`. **Why:** a second pass over files that already got findings, excluding the known ones, lifts recall where the first pass stopped at one problem per file |
| `LENS_REVIEW` | Entered only when `ENABLE_LENSES` (or `--lenses`, or the `LENSES` benchmark label) is on and `LENSES` names ≥1 known lens (comma/plus list of `reliability`, `security`, `testing`, `performance`, `architecture`, or the aliases `rel`, `sec`, `test`, `perf`, `arch`; case-insensitive, an alias resolves to its full name and dedupes on it, unknown names warned and ignored); otherwise `SECOND_LOOK` goes straight to `JUDGE_REVIEW`, so lens-off runs are unchanged. Runs the listed lenses sequentially, in list order, each a full-PR reviewer-sized call (`runLens`) on `LENS_MODEL` (unset → reviewer model at `REVIEW_EFFORT`; set → model-default effort): reviewer prompt + lens overlay (see [prompt/composition.md](../prompt/composition.md)), the full filtered diff + every file context the reviewer got, and a briefing of all earlier findings (reviewer, breadth, second-look, earlier lenses). Findings stay in `ctx.lensRuns` (never `reviewObject`) and reach the judge after second-look candidates as `origin: 'lens:<name>'`, so they post only if judged; a judge failure never posts them unjudged. Per-lens status in `lens_runs`: no judge → all `skipped_no_judge`; re-review → all `skipped_rereview`; `MAX_FINDINGS` used up → `skipped_limit` for this and every later lens; estimate (reviewer input estimate + overlay/limit/briefing) over the budget (min of `MAX_INPUT_TOKENS` and the lens model's window minus `MAX_OUTPUT_TOKENS`) → `skipped_budget` for that lens only; under `--benchmark`, over half of `BENCHMARK_DEADLINE_SECONDS` elapsed (re-checked before each lens) → `skipped_time` for this and every later lens; a thrown call → `failed` (a truncated call's usage still counts) and the review continues. **Why:** a recall lever for concern categories the general pass misses, without growing `base-prompt.txt`. **Status:** experimental and default off. In benchmark runs the reliability lens added findings the platform accepted but did not repeatably add golden hits or grounded F1, and the performance lens added none, because the first pass and breadth already cover that concern. Each lens costs roughly one extra reviewer-sized call, and under `--benchmark` the half-deadline guard skips lenses on the largest PRs, so enabling lenses is not expected to raise recall |
| `JUDGE_REVIEW` | If `JUDGING_MODEL` set: sends diff + review to judge for finding validation; stores per-finding scores (`ctx.judgeScores`). With breadth, second-look or lens findings, the judge gets reviewer + breadth + second-look + lens candidates in one call (ids in that order, `origin` logged in `review_candidates`, never shown to the judge). Skipped only when all lists are empty. Otherwise passthrough |
| `SECOND_LOOK` (recall lever) | `ENABLE_SECOND_LOOK_BREADTH_TARGETS` / `RB_CONFIG_SL_BREADTH` (default off): flagged files come from review + breadth findings instead of review only, so breadth-only findings can trigger second-look; the restricted diff, contexts, known-findings briefing and budget all follow the wider set. |
| `BREADTH_REVIEW` (recall lever) | `ENABLE_BREADTH_PRIORITY_TARGETS` / `RB_CONFIG_B_PRIORITY` (default off): the 40 listed untouched targets come from `prioritizeUntouched` — release-entry `.changeset/*.md` left out of the briefing (diff untouched), 32 slots for code/config/tests + 8 for docs with backfill, round-robin by `packages/<n>` / `apps/<n>` / first dir, ranked by nearness to a finding, then change size, then path. `untouched_files` in the usage record logs the actual selection plus `deprioritized`. |
| `BUNDLED_REVIEW` | Big-PR map-reduce (`bundled.ts`): `planBundles` groups per-file diffs by directory into bundles of ≤85% of the input budget (min of `MAX_INPUT_TOKENS` and model context) minus fixed overhead (prompt, history); per bundle runs the normal `runReview` + `runJudge` sequentially with that bundle's diff/delta/file contexts; `aggregate.ts` parses each result's markdown, dedupes findings (same file + overlapping lines + similar title), merges sections, Merge Confidence = min across bundles. Files bigger than a whole bundle are listed under Unresolved Questions as unreviewed. Skips if bundles > `MAX_BUNDLES` (default 8) or fixed overhead leaves no room. While enabled, `MAX_CHANGED_FILES/LINES` don't skip. Not handled: unanswered-reply routing on 0-finding re-reviews |
| `POST_REVIEW` | Applies safety guards (empty/NO_CHANGE guard, pre-post dedup), then posts comment via VCS API. With an outcome sink (`--benchmark`), it passes the structured review + judge result to the sink instead and skips cleanup, guards and posting |
| `RESPOND_TO_REPLIES` | Bundles unanswered developer questions; calls Claude with reply prompt; posts threaded reply |

---

## POST_REVIEW Safety Guards

Three guards run before every post (guard 3 only when `--force` is off; all skipped in benchmark/outcome-sink mode):

1. **Empty/NO_CHANGE guard** — cleanup strips prior footers, `DELTA_STATS`, leaked preamble before the first `### Summary` heading (`stripPreamble()`), and any echoed jenkins comment; if what remains is empty or contains a standalone `NO_CHANGE` line, skip. Catches model misbehavior when `CHECK_NO_CHANGE` is bypassed.

2. **Cut guard** — a complete review ends with its final mandatory section (judge path → `Merge Confidence`; reviewer-only path → `Unresolved Questions`). A truncated model response — valid JSON envelope with a cut-off `review_markdown` string — slips past the `max_tokens` guard; this throws (run → `ERROR`, nothing posted, retries next trigger) so a half-review is never posted.

3. **Pre-post dedup** — on non-dry-run runs without `--force`, re-fetches review comments immediately before posting and checks if a concurrent agent run already reviewed the same commit. Prevents race conditions from parallel Jenkins triggers.

**Checked-commit mark:** the states that end a run on a genuinely checked head (posted review, pre-post race, footer or checked-commit match, zero-reviewable delta, coherent structured `NO_CHANGE`, `NO_NEW_FINDINGS`, a quiet reply, the JUDGE-gate reply limit) set `ctx.headChecked`, which emits `checked_commit` in the record. Dry-run, benchmark, forced runs, a failed delta fetch and an uncertain bundle never mark, and an error after the mark drops it. Full table in [skip-logic.md §8](skip-logic.md).

---

## ReviewContext Interface

Abridged; the full interface (per-stage statuses, usage, prompt hashes, shown sources) is in `src/review/types.ts`.

```typescript
interface ReviewContext {
  readonly prId: string
  readonly repoSlug: string
  readonly force: 'off' | 'clean' | 're-review'
  readonly outcomeSink?: OutcomeSink   // benchmark mode: receives the ReviewOutcome instead of a posted comment
  readonly trigger?: TriggerInfo       // { event, commentAuthor } from CI; undefined when none was passed
  readonly checkedCommit?: string      // head CI passed back (LAST_CHECKED_COMMIT); read only in CHECK_PREVIOUS_REVIEWS
  prInfo?: PRInfo
  diff?: string            // raw diff — metrics only, never sent to the model
  filteredDiff?: string    // sent to the model
  deltaDiff?: string       // changes since the last-reviewed commit (re-reviews)
  previousReviews?: ReviewComment[]
  replies?: CommentReply[]
  prompt?: LoadedPrompt
  fileContexts?: FileContext[]
  reviewText?: string      // rendered markdown from CALL_MODEL / JUDGE_REVIEW
  reviewObject?: ReviewObject   // reviewer's typed output — source for findings/delta metrics
  breadthFindings?: ReviewFinding[]
  secondLookFindings?: ReviewFinding[]
  lensRuns?: LensRun[]
  judgeScores?: FindingScore[]  // judge's per-finding 0–10 confidence — logged, never posted
  judgedFindings?: KeptFinding[]
  skipReason?: string
  headChecked?: boolean    // set at the checked-commit mark points; emits checked_commit
}
```

**Invariant:** `filteredDiff` is always derived from `diff` by the same `filterDiff()` function. Never set independently.
