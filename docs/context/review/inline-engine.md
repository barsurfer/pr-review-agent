# Inline reviews (stage 1)

Opt-in, Bitbucket only. Findings are posted as inline threads on the diff, with one signed summary comment per PR, instead of one big review comment.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `ENABLE_INLINE_REVIEWS` | `false` | Turns the inline engine on. Off: the legacy flow runs exactly as before. |
| `ENABLE_INLINE_LOW_THREADS` | `false` | Also open threads for LOW findings. Off: LOW findings are listed in the summary only. |
| `AGENT_ACCOUNT_ID` | empty | The agent's Bitbucket account id. Optional only when `GET /2.0/user` works. That call returns 403 for Bitbucket credentials without account read scope (seen in a live dry run); the adapter then has no identity, the engine stops with "agent identity is unavailable" and posts nothing, so set this to the bot's `account_id` (`712020:...` form). The `{uuid}` form also works (braces are stripped; both forms are compared against the author's `account_id` and `uuid`); a value that disagrees with the adapter stops the run (`identity_mismatch`). |
| `MAX_FINDING_REPLIES` | `5` | Agent answers per finding thread (0 = unlimited). At the limit the agent posts one "Replies paused" note, then stays silent. |

With the flag on but a non-Bitbucket adapter, or a `--benchmark` run, the legacy flow runs and the record says `inline: { active: false, reason }`.

## Separate engine

The engine in `src/inline/` has its own state and its own writer. It hooks into `review()` through `ctx.inline.step`, which intercepts a few FSM states (see [fsm.md](fsm.md)); every other state, and the whole pipeline that produces findings (reviewer, passes, judge, bundled review), is the legacy code. With the flag off no engine is built and nothing behaves differently; the identity fixtures under `src/__tests__/__fixtures__/identity-v00*` pin this.

Each engine sees only its own artifacts. Flag off on a PR with inline artifacts gives a legacy first review; flag on again resumes from the inline summary and threads. First enable on a PR with legacy reviews gives a full first inline review, and the legacy comment is never edited. The first inline run starts as review 1 and does not read the legacy reviews as previous reviews (`ctx.previousReviews` is always empty in the engine).

## Output

- **Finding threads.** One root comment per HIGH/MEDIUM finding, anchored to a line in the diff; with `ENABLE_SUGGESTED_FIXES` the judge's accepted code proposal follows the body as a `Suggested fix` block (same acceptance rules as the legacy review). The last line is a marker, `*Finding F<k> | opened at <c12>*`. Ids `F1`, `F2`... are per PR and never reused. At most 20 new threads per run; the rest, and findings that cannot be anchored, are listed in the summary as `no thread` rows without ids.
- **Summary.** One top-level comment, edited in place on every completed review (a clean review writes "No findings."). It lists open threads, summary-only findings, developer-resolved threads and a review history. Its last line is the state line, `*inline-state v1 | n=<review> | commits=<c12,...> | sig=<hash>*`: the review count, every head that was fully reviewed, and a signature over the text above it and the agent's id. A head in `commits` is deduped without a model call.
- **Answers.** A developer reply in a finding thread is answered in that thread only, ending with `*Answer on F<k> | through <comment id>*`, which marks the question as covered. At `MAX_FINDING_REPLIES` the agent posts `*Replies paused on F<k>*` once.
- **Directed replies.** A reply that @-mentions only someone else is still answered unless `SKIP_DIRECTED_REPLIES=true`, which drops it exactly as the legacy reply flow does.
- **Summary thread.** Replies under the summary are answered too. Its budget is `MAX_REPLY_COMMENTS`, counted only over trusted answers inside the summary thread; finding-thread answers do not count.

## Rules

- **The agent closes nothing.** It never resolves, reopens or deletes a thread. A fixed finding stays open until a developer resolves it.
- **Re-raise rule.** A finding matching a developer-resolved thread is not posted again at the same or lower severity. At a higher severity it opens a new thread with a new id, titled `(was F<k>, dismissed)`.
- **Matching.** Findings match threads by file, title similarity and line, with lines mapped through each push's delta. Within one run only the strict match (title similarity 0.8 plus nearby lines) merges findings, so a repeat of a root planned in this run gets no thread and no id of its own but stays a `no thread` row (reason `duplicate`), while a loosely similar distinct finding still gets a thread. Titles are compared in the capped form posted in rows and roots, so a long title matches itself.
- **Trust.** Markers and state count only on comments by the agent's own ids. A forged marker or a summary edited by someone else is ignored (`untrusted_markers`, `summary_check: tampered`); the next run overwrites a tampered summary in place.
- **Writes are checked.** The head is re-read before the first write (moved: nothing posted, `head_moved_skip`; moved after some writes: `head_moved_partial`; lookup failed: `head_check_failed`, no further writes, head not recorded, no retry); other runs' threads or summary appearing after planning stop the run (`concurrent_run`); a created comment under another author stops it (`identity_mismatch`). The head is also re-read after the re-list that precedes a recreated summary (the summary edit returned 404 and the summary is gone). A planned re-raise is cancelled, with no thread and no id, when any thread reopened since planning matches it by the open-match rule; the reopened thread's summary row stands for the finding.
- **Uncertain creates** (timeout, no response) are never resent in the same run and the head is not recorded, so the next run re-reviews and finds the comment if it landed. Cost: one extra review. A new summary is created without the head and the head is added by an edit once the create is acknowledged; a lost create, or a failed or uncertain head edit, leaves the head unrecorded and the next run edits the one existing summary.
- **`--force`** on a completed head first removes it from the signed state, then reviews again; no duplicate threads.
- **Unchanged runs keep the review.** A merge-only push, a zero-line delta or a coherent `NO_CHANGE` refreshes the summary (thread rows, history, footer, state) but keeps the last verified narrative and its `no thread` rows; only a summary with no usable narrative falls back to a one-line placeholder.
- **Quiet re-reviews keep them too.** A re-review that ran but kept nothing new (`NO_NEW_FINDINGS`) carries the earlier `no thread` rows (minus any that now have a thread) and uses its own narrative when it has one, else the last verified one, else "No new findings.".
- **Failures.** A re-list failure before any write, or a refused summary write, ends the run as an error (outcome `write_failed`) so CI retries; the head is not recorded. A reply-model failure on a dedup (replies-only) run with nothing posted also errors, recorded as outcome `dedup`; on a review run, or after a budget, context-window or bundling skip, it is swallowed (and so is a re-list failure with nothing written after a skip), so the finished review or the legacy SKIP stays. Without `ENABLE_SUGGESTED_FIXES` no fix block is posted, even with `ENABLE_JUDGE_PROPOSALS`.
- **Dry run** prints and writes nothing.

## Usage record

With the flag on, the record has an `inline` key (outcome, identity source, summary check, thread/answer counts, reply usage). Reply-model usage is priced at `REPLY_MODEL` and summed into `cost_usd`. Details: [../../reference/usage-logging.md](../../reference/usage-logging.md).

## Accepted risks

- A file rename can let a dismissed finding return once.
- A run that loses the head race wastes its model spend.
- An uncertain create costs the next run a full re-review.
- Fixed findings stay open until a developer resolves them (stage 2 would close them).

## Before enabling in production

1. Run `node scripts/inline-phase0.mjs --execute` against a sandbox PR whose title contains `[inline-sandbox]` (without `--execute` it only reads), and resolve any failed check: P1 (summary edit round-trip) and P5 (resolution visible in the comment list) block the rollout; P2 failing means set `AGENT_ACCOUNT_ID`.
2. Confirm the Jenkins/webhook trigger ignores the agent's own comment events and that the per-PR lock exists. The agent now posts many comments per run; without this filter each one re-triggers a run.

## Stage 2 (not built)

Closing findings (verifier pass, resolve, fixed/obsolete states) is deferred; stage 1 keeps the markers, signed state and per-thread reply coverage it needs.

## Tests

`src/inline/__tests__/`: unit suites per module, `wiring.test.ts` and `e2e.test.ts` drive the real `review()` over a stateful fake Bitbucket (`fake-bitbucket.ts`), with multiple runs on one fake PR.
