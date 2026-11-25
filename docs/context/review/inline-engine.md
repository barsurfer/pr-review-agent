# Inline reviews (stage 1)

Opt-in, Bitbucket only. Findings are posted as inline threads on the diff, with one signed summary comment per PR, instead of one big review comment.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `ENABLE_INLINE_REVIEWS` | `false` | Turns the inline engine on. Off: the legacy flow runs as before; replies use the shared reply prompt, which is not flag-gated. |
| `ENABLE_INLINE_LOW_THREADS` | `true` | Open threads for LOW findings too. Unset or empty means true (CI passes unset parameters as empty); `false` lists LOW findings in the summary only; any other value warns once and uses true. |
| `AGENT_ACCOUNT_ID` | empty | The agent's Bitbucket account id. Optional only when `GET /2.0/user` works. In the PR 112 pilot the Jenkins credentials got 200 from it and matched the setting (`identity: "api"`); the 403 seen earlier came from local credentials without account read scope. Without an identity the engine stops with "agent identity is unavailable" and posts nothing, so set this to the bot's `account_id` (`712020:...` form). The `{uuid}` form also works (braces are stripped; both forms are compared against the author's `account_id` and `uuid`); a value that disagrees with the adapter stops the run (`identity_mismatch`). |
| `INLINE_HIDE` | empty | Comma-separated parts of the inline output to hide (see Hiding output); empty hides nothing, unknown values warn once and are ignored. |
| `MAX_FINDING_REPLIES` | `5` | Agent answers per finding thread (0 = unlimited). At the limit the agent posts one "Replies paused" note, then stays silent. |

With the flag on but a non-Bitbucket adapter, or a `--benchmark` run, the legacy flow runs and the record says `inline: { active: false, reason }`. A PR that already holds the agent's own legacy comments also runs legacy (see Flow choice per PR).

## Separate engine

The engine in `src/inline/` has its own state and its own writer. It hooks into `review()` through `ctx.inline.step`, which intercepts a few FSM states (see [fsm.md](fsm.md)); every other state, and the whole pipeline that produces findings (reviewer, passes, judge, bundled review), is the legacy code. With the flag off no engine is built and nothing behaves differently; the identity fixtures under `src/__tests__/__fixtures__/identity-v00*` pin this.

Each engine sees only its own artifacts. Flag off on a PR with inline artifacts gives a legacy first review; flag on again resumes from the inline summary and threads. The legacy comment is never edited. On a PR with the agent's own legacy comments and no inline artifacts the flow check (below) reads those legacy footers and the run stays legacy. `--force clean` is an explicit manual override: it skips the hand-back below and starts a fresh inline review beside legacy comments (never editing them); `--force re-review` and no force keep the hand-back. The inline engine starts as review 1 and does not read the legacy reviews as previous reviews (`ctx.previousReviews` is always empty once it runs).

## Flow choice per PR

Decided in the engine's load step, from the comment list it already fetched (the listing predicate also matches legacy footers, so there is no extra request; threads handed to the registry are still only the inline-marked ones):

1. Flag off: legacy, as always.
2. Flag on and the PR has an inline summary (any one by the agent's ids) or a trusted finding thread: inline continues, including pilot PRs that had a legacy review first.
3. Flag on, no inline artifacts, and at least one comment by the agent's own ids carrying the legacy review footer or reply footer (a reply or the reply-limit note): the engine hands control back before touching `ctx`, and the run is a plain legacy run with the legacy output and usage record; only `inline` differs: `{ active: false, reason: "legacy_pr" }`. The PR stays legacy until it holds an inline summary, which only a flag-on run with no legacy comments can create.
4. Flag on and nothing from the agent: first inline review.

The choice needs the agent's identity: with the flag on and no identity (`GET /2.0/user` fails and `AGENT_ACCOUNT_ID` is unset), the run stops as `identity_unavailable` before the check, so a legacy-only PR gets no review either. Falling back to legacy without an identity would let any comment carrying a footer decide the flow.

The check reads legacy footers (the listing predicate also matches them) and the footer test is the legacy flow's own (`hasReviewFooter`, `hasReplyFooter`) plus the author-id trust the engine uses everywhere, so a human comment or another author carrying a footer never moves a PR to legacy. Limits: only roots matching a footer or marker, and the comments under them, are visible to the check; a legacy reply under an unmarked human root is not seen.

## Output

- **Finding threads.** One root comment per HIGH/MEDIUM finding (and per LOW finding unless `ENABLE_INLINE_LOW_THREADS=false`, which lists LOW findings in the summary only), anchored to a line in the diff; with `ENABLE_SUGGESTED_FIXES` the judge's accepted code proposal follows the body as a `Suggested fix` block (same acceptance rules as the legacy review). The last line is a marker, `*Finding F<k> | opened at <c12> | <model> | Build <build>*`; the model is the summary footer's model string, the build is the footers' build (omitted when there is none), and `*`, `|` and control characters are stripped from both. Markers from 0.0.63/0.0.64 have no suffix and parse the same, and with the model hidden the suffix is the build alone, `| Build <build>`. Ids `F1`, `F2`... are per PR and never reused. At most 20 new threads per run; the rest, and findings that cannot be anchored, are listed in the summary as `no thread` rows without ids.
- **Summary.** One top-level comment, edited in place on every completed review (a clean review writes "No findings."). It opens with the single heading `### Review summary *(inline)*`, directly followed by the narrative text (its own `### Summary` heading is dropped); there is no machine tag, the signed state line and the agent's own author identify it. Summaries from 0.0.63/0.0.64 (`### Review summary` plus the `*inline-summary v1 | maintained by the review agent*` line) are still recognised, edited in place and rewritten in the new layout, and their narrative is carried over. It lists open threads, summary-only findings, developer-resolved threads and a review history; the `Open threads` and `Not posted as threads` labels are followed by a blank line so Bitbucket renders the rows as lists. An open-thread row ends with ` · line changed since <c7>`, ` · file changed since <c7>` or ` · file deleted since <c7>` when later commits changed the anchored line or file (or deleted it) after the commit in the thread's own marker; `same`, `none` and `unknown` show no note. It reuses the reply flow's `codeSince` and its 5-base delta cap (one fetch per distinct opening commit, shared with the replies), a failed or capped lookup gives no note and never blocks a write, and one console line summarises the notes. Old rows with ` · changed in this push` still parse and are rewritten. Its last line is the state line, `*inline-state v1 | n=<review> | commits=<c12,...> | sig=<hash>*`: the review count, every head that was fully reviewed, and a signature over the text above it and the agent's id. A head in `commits` is deduped without a model call.
- **Summary size.** Capped at `COMMENT_BUDGET`. Over budget it trims in order: history to 5 lines, resolved rows, summary-only bodies, the TODOs list to 10 items (`- and N more`), the narrative tail, the TODOs list to one count line, summary-only rows past 20, all summary-only rows into a count, open rows down to 10, the compact open line, the open count. If that still does not fit, the overflow form keeps open-thread and summary-only counts by severity plus the HIGH/MEDIUM summary-only rows as titles (only rows in the summary reach the next run; counted ones do not), and never says "No findings." while findings exist. Narrative, unresolved questions, history, resolved rows and the TODOs list are all bounded by these steps.
- **Answers.** A developer reply in a finding thread is answered in that thread only, ending with `*Answer on F<k> | through <comment id> | <model> | Build <build>*`, which marks the question as covered (the model is the one that served the reply, `REPLY_MODEL` or the reviewer model; suffix-less markers from 0.0.63/0.0.64 cover the same way). At `MAX_FINDING_REPLIES` the agent posts `*Replies paused on F<k>*` once.
- **Finding status.** Each finding thread in a reply batch (never the summary thread, a deferred thread or one at its limit) gets a `Finding status:` line under its header, computed from the root's own `opened at` marker commit against the current head: `same`, `line` (a later commit changed the anchored line), `file`, `none`, `deleted` or `unknown`. It costs one commit-diff request per distinct marker commit, within the shared 5-base cap (a failed or capped lookup is `unknown` and never blocks the answer). The reply model is told that if a later commit removed the problem it says a later commit fixed it and suggests resolving the thread, and never calls the finding wrong only because the code moved; status claims written inside comments are ignored.
- **Directed replies.** A reply that @-mentions only someone else is still answered unless `SKIP_DIRECTED_REPLIES=true`, which drops it exactly as the legacy reply flow does.
- **Summary thread.** Replies under the summary are answered too. Its budget is `MAX_REPLY_COMMENTS`, counted only over trusted answers inside the summary thread; finding-thread answers do not count.

## Hiding output

`INLINE_HIDE` applies to inline output only; the legacy review, legacy replies and legacy footer never change.

- `model`: the summary footer reads `*Inline review by <identity> | Review n | Commit c12 | Build b*` (no `(model)`), and root and answer markers drop the model but keep `| Build <b>`. The three marker forms (full, build-only, suffix-less) all parse.
- `confidence`: the `### Merge Confidence: N%` heading is removed from the composed summary; a `---` rule replaces it and the disclaimer line stays below as a standalone human-review notice. It is removed at compose time after the truncation guard, so the judged text, `verdict_score` and every other record field are unchanged, and `carryNarrative` keeps the disclaimer on carried summaries. A summary written either way reads back as `valid` and is edited in place when the setting changes.

## Content-filter refusal

A refused reviewer or judge call (see [skip-logic.md](skip-logic.md) section 5b) writes the same summary comment with the approved notice (and its marker line `*Review not completed: content filter*`) in place of the narrative; thread rows, resolved rows and history are kept, no thread is opened, the head goes into the signed state line (so the same head dedups) and the run ends `SKIP`. The summary has the marker as its first line under the header and no `### Findings` filler. The notice takes a state number but not a review number: completed reviews are counted from the history lines that are not notices, so the next push is a first review (`REVIEW`, all passes, the NO_CHANGE guard intact). It reviews the whole PR (no delta against the notice head), so it can raise threads on code that an earlier real review already covered, and the notice is replaced by the real review. A refused reply is answered with a decline answer (normal answer marker) and recorded as `content_filter` stage `reply`. A bundled review with some refused bundles ends its `### Findings` section with the one-line note.

## Rules

- **The agent closes nothing.** It never resolves, reopens or deletes a thread. A fixed finding stays open until a developer resolves it.
- **The judge sees open threads.** On an inline re-review with open threads, the judge gets a trailing `## Still Open on This PR` block (open registry entries only, 40 rows, by severity then newest) and a system-prompt addendum so its summary, production risk and merge confidence weigh them; decisions on candidates are unchanged. In bundled reviews each bundle's judge gets only the threads in its own files. Dedup against open threads stays in deterministic code.
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
- In bundled mode an open finding on a since-renamed file is left out of that bundle's judge block (same limit as the reviewer prior list).
- Without a fresh judge pass the narrative can lag open threads: a bundle with no findings, files outside every bundle, a re-review with zero candidates, and quiet or unchanged runs that carry an older narrative.

## Before enabling in production

1. Run `node scripts/inline-phase0.mjs --execute` against a sandbox PR whose title contains `[inline-sandbox]` (without `--execute` it only reads), and resolve any failed check: P1 (summary edit round-trip) and P5 (resolution visible in the comment list) block the rollout; P2 failing means set `AGENT_ACCOUNT_ID`.
2. Confirm the Jenkins/webhook trigger ignores the agent's own comment events and that the per-PR lock exists. The agent now posts many comments per run; without this filter each one re-triggers a run.

The PR 112 pilot verified P1, P5, the bot-event filter and the per-PR lock live.

## Stage 2 (not built)

Closing findings (verifier pass, resolve, fixed/obsolete states) is deferred; stage 1 keeps the markers, signed state and per-thread reply coverage it needs.

## Tests

`src/inline/__tests__/`: unit suites per module, `wiring.test.ts` and `e2e.test.ts` drive the real `review()` over a stateful fake Bitbucket (`fake-bitbucket.ts`), with multiple runs on one fake PR.
