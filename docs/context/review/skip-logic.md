---
type: domain
topic: All skip mechanisms — dedup (footer + CI checked commit), delta pre-check, branch exclusion/allow-list, thresholds, trigger pre-check, per-provider CI wiring
---

# Skip Logic

All mechanisms that cause the agent to exit without posting a review. Related: [review/fsm.md](fsm.md) | [practices.md](../practices.md)

---

## 1. Commit Hash Deduplication

Every review comment ends with a footer:
```
*Reviewed by Claude (claude-haiku-4-5-20251001) | Prompt: repo | Review #2 | Commit: a1b2c3d4e5f6 | Build: 919a10b*
```
`Commit:` is the PR source commit (dedup anchor); `Build:` is the agent's own deployed
commit (runtime `git rev-parse` in its checkout, `-dirty` suffix on local uncommitted runs).
When a CI job URL is available (`BUILD_URL`), `Review #N` is a markdown link to that build —
Bitbucket renders HTML comments as visible text, so the job link rides on the footer instead
of a hidden comment. Off-CI it's plain `Review #N`.
Detection (`hasReviewFooter`) accepts footers with or without `Build:` **and** with or without
the `Review #N` link — older and non-CI footers still dedup correctly.

The hash is read from the **last** footer-pattern line of the comment (`extractCommitHash`, same pattern as `hasReviewFooter`), never from the first `Commit: <hex>` anywhere in the body: finding text above the footer can contain one (`Commit: fix bug` reads as `f`), which made dedup miss and the delta base bogus. While the old and new readings are compared on real PRs, a disagreement logs a `Footer commit … differs from legacy first match …` warning; the footer value is used.

On re-trigger, `CHECK_PREVIOUS_REVIEWS` parses this footer and compares the commit hash against the current PR source commit (`PRInfo.sourceCommit`). If they match: same commit, no new code → fall through to `CHECK_REPLIES` instead of calling Claude. The footer only moves when a review is posted; a head checked without a post can be recognised through the checked commit CI passes back (§8).

**Invariant:** The footer regex must remain stable. Changing the format silently breaks dedup for all PRs reviewed before the change.

`--force` (no value) = `re-review` mode: bypasses dedup, keeps prior review context.  
`--force clean` = strips prior review from context before calling Claude.  
In CI write `--force="$FORCE"` (or `--force=$FORCE`): an unquoted empty value vanishes in the shell and leaves a bare `--force`, which means re-review on every event.

---

## 2. Delta Diff Pre-Check

When the commit hash has changed (new commits pushed), before calling Claude, the agent fetches the **commit-to-commit diff** (`VCSAdapter.getCommitDiff(fromCommit, toCommit)`) between the last-reviewed commit and the current head.

After applying `filterDiff()` with `DIFF_EXCLUDE_PATTERNS`:
- **Zero lines remain** → no review call; falls through to `CHECK_REPLIES` — answers a pending developer reply (→ `REPLY`), else `DEDUP_SKIP`. No reviewer tokens.
- **Lines remain** → proceed with the delta review, and retain the delta (`ctx.deltaDiff`) to feed the reviewer as a **"Changes Since Your Last Review"** section (see [fetching/strategy.md](../fetching/strategy.md)) so the model sees exactly which lines are new/fixed, not just the full PR diff.

This is deterministic — it does not rely on Claude to detect that nothing changed. Catches commits that only add tests, lock files, translations, or other excluded file types.

**Fallback:** If the commit-to-commit diff API call fails (e.g. force-push removed the old commit), the agent falls back to the full PR diff flow. On Azure the footer's abbreviated hash is also looked up in the PR's iterations (from 0.0.46), so a force-push alone no longer fails the delta (unverified live); a delta that still fails falls back on every event until a review posts, and `checked_commit` is withheld meanwhile (§8).

---

## 3. Branch Exclusion

Checked in `CHECK_BRANCHES` before any diff is fetched.

| Env var | CLI | Default | Effect |
|---------|-----|---------|--------|
| `SKIP_SOURCE_BRANCHES` | `--skip-source-branches=<list>` | `main,master,release/*,hotfix/*` | Skip if PR source branch matches |
| `SKIP_TARGET_BRANCHES` | `--skip-target-branches=<list>` | `main,master` | Skip if PR target branch matches |
| `ONLY_TARGET_BRANCHES` | `--only-target-branches=<list>` | *(empty = off)* | When set, skip if PR target branch matches **none** of the patterns |

Patterns support `*` wildcard (e.g. `release/*` matches `release/1.5.0`). Set to empty string to disable. All three lists use the same matcher and the same parsing (comma-separated, entries trimmed, empty entries dropped).

**Per-repo arguments:** CI env vars are usually shared by every repo the job serves, so each list also has a CLI flag. Unlike `--event` / `--checked-commit`, an empty flag value is a real setting, not a fallback:
- flag absent → the env var, else the default (unchanged);
- flag with a value → replaces the env var, parsed exactly like it;
- flag with an empty value → empty list, so that check is off. This is how a main-only repo turns off the default `main,master` target skip.

Write an empty value as `--skip-target-branches=`. The separate form `--skip-target-branches ""` works only when the empty string really reaches the agent: an unquoted empty variable (`--skip-target-branches $EMPTY`) vanishes in the shell, and the flag then swallows the next argument as its value (`--skip-target-branches --only-target-branches=main` sets the skip list to `--only-target-branches=main` and leaves the allow-list unset). When the value comes from a variable, use the `=` form (`--only-target-branches="$TARGETS"`). It never swallows the next argument, but an empty variable still disables that list, the same trap as an empty env var (below), so pass a flag only from the job of the repo it is meant for.

**Rollout rule:** commander rejects an unknown flag with exit 1, so an agent bundle older than these flags fails every run that passes them (a CI step that tolerates failure, such as the reference Jenkins pipeline's `catchError`, hides it). Add the flags to a job only once the bundle it runs (for the reference Jenkins job, `main`'s) contains them, and remove them **before** rolling the bundle back. Same rule as `--checked-commit` (§8).

**Rationale:** Merge-back PRs (`main→develop`) and release PRs (`feature→main`) are intentionally excluded — the former are noise, the latter are gated by human review.

**Precedence** (evaluated in this order; first hit wins):
1. `SKIP_SOURCE_BRANCHES` matches source → SKIP (`source branch "X" matches SKIP_SOURCE_BRANCHES`)
2. `SKIP_TARGET_BRANCHES` matches target → SKIP (`target branch "X" matches SKIP_TARGET_BRANCHES`). If `ONLY_TARGET_BRANCHES` also lists that target, one warning line says the skip list wins.
3. `ONLY_TARGET_BRANCHES` set and target matches none → SKIP (`target branch "X" is not in ONLY_TARGET_BRANCHES (<list>)`)
4. otherwise → `FETCH_DIFF`

Deny wins: the skip lists keep their exact meaning whatever `ONLY_TARGET_BRANCHES` holds, and a target in both lists is a contradiction whose safe reading is "don't review". `--force` does not bypass branch checks. `--benchmark` clears all three lists (branch names there are placeholders).

**Recipes:**

| Repo model | Arguments (or the matching env vars) | Result |
|---|---|---|
| Main-only (trunk) | `--skip-target-branches= --only-target-branches=main --skip-source-branches=main,master` (your trunk: `main` or `master`) | PRs into the trunk are reviewed, including `hotfix/*` and `release/*` sources (the source default would skip them, and in a trunk-only repo they land). Stacked PRs (target = another feature branch) are skipped until retargeted to the trunk. |
| Git-flow | defaults + `--only-target-branches=develop,release/*` | feature→develop and fix→release/* are reviewed. Release/hotfix→main is skipped as today. Feature→feature (stacked) is skipped until retargeted to `develop`. |
| Today's behaviour | pass none of the flags and leave `ONLY_TARGET_BRANCHES` unset | Unchanged |

**Empty-value trap (env vars):** an explicitly empty variable stays empty (the default applies only when the variable is unset). If a shared Jenkins job defines `SKIP_TARGET_BRANCHES` as an always-passed parameter, every repo gets `''`, which silently disables the `main,master` default for git-flow repos too. Set it per repo: as an argument in that repo's job, or with `withEnv`, not as a job-wide parameter.

**How "until retargeted" works:** it needs a CI trigger that fires when a PR's destination changes. The agent side is generic: a skipped PR has no posted review, so `CHECK_PREVIOUS_REVIEWS` finds no footer and runs a first review. (A PR that was already reviewed at the same head before the retarget is a `DEDUP_SKIP`, not a re-review against the new target; with a stored checked commit, so is one whose last run at that head posted nothing — see §8.) Without a retarget trigger, a skipped stacked PR waits for its next push or comment, and if none comes it can merge unreviewed. Which CI setups fire on a retarget is in the wiring table (§9): Bitbucket webhooks do (`pullrequest:updated`); the shipped GitHub workflow does, through `pull_request` `edited` filtered to a base change (not yet run live); Azure DevOps and Bitbucket Pipelines are unverified (believed not to). Unverified: whether Bitbucket Cloud retargets a stacked PR automatically when its destination branch is deleted on merge, and sends the event if so. A CI lock that drops events (skip-if-locked) can also drop the retarget event; the PR is then reviewed on its next push or comment.

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
| `MAX_INPUT_TOKENS` | `250000` | Skip if estimated input tokens exceed the budget (this or the context window minus `MAX_OUTPUT_TOKENS`, whichever is smaller) after dropping file contexts |

All can be overridden via CLI flags (`--min-changed-files`, etc.). `0` disables the threshold. With `ENABLE_BUNDLED_REVIEW` on, `MAX_CHANGED_FILES`/`MAX_CHANGED_LINES` don't skip, and a PR still over the input budget is reviewed in directory bundles instead (skipped only past `MAX_BUNDLES`; see [fsm.md](fsm.md)).

**Rationale for upper bounds:** Very large PRs (>200 files, >3000 lines) produce unreliable reviews and high token costs. Teams should split such PRs.

---

## 5. Reply Limit

Once the agent has replied `MAX_REPLY_COMMENTS` times (default: 5) on a PR, further developer questions are logged but not answered. Prevents runaway token usage on contentious PRs or adversarial follow-ups.

Set `MAX_REPLY_COMMENTS=0` to disable.

---

## 6. Oversized Diff (fetch failure) — GitHub

When an adapter cannot fetch a PR's complete diff because it exceeds the provider's size ceilings, it throws `PrTooLargeError` (`src/vcs/adapter.ts`); `FETCH_DIFF` catches it and exits as a clean **SKIP**, never an ERROR — an AI review never gates a merge, so an unreviewable PR fails open.

Currently only `GitHubAdapter` raises it. GitHub's PR diff endpoint returns **406** past its render limits (~300 files / 20k lines / 1 MB); the adapter falls back to the `/compare` endpoint (no size ceiling), bounded by **>3000 changed files** and a **25 MB** download cap — either breach → `PrTooLargeError`. See [../vcs/adapter.md](../vcs/adapter.md). A non-size compare failure is a genuine error (run → ERROR, retried), not a skip.

---

## 7. Trigger Pre-Check (`IGNORE_COMMENT_AUTHORS`)

`CHECK_TRIGGER`, the first FSM state, runs before any VCS or model call. Off unless CI passes what started the run.

| Env var | CLI | Default | Effect |
|---------|-----|---------|--------|
| `TRIGGER_EVENT` | `--event <name>` | empty | What started the run, e.g. `pullrequest:comment_created`. Logged (`Trigger: …`) and recorded (`trigger` in `results.jsonl`). |
| `TRIGGER_COMMENT_AUTHOR` | `--comment-author <id>` | empty | Account id of the event **actor**. Logged and recorded. |
| `TRIGGER_EVENT_KIND` | `--event-kind <kind>` | empty (name rule) | From 0.0.46. `comment` or `other`: whether this event is a comment event, whatever its name. Overrides the name rule below. Case-insensitive, trimmed; any other value logs one warning and is ignored. |
| `IGNORE_COMMENT_AUTHORS` | none | empty (off) | Comma list of account ids. A comment event whose actor is listed → SKIP, exit 0. |

CLI wins over env; an empty or whitespace CLI value (how CI systems pass an unset parameter) falls back to the env value.

**Skips only when all hold:** a non-empty ignore list, a non-empty author, and a **comment event**. An author without an event never skips (one warning when the list is set); an event without an author never skips. A list set with neither value given warns once that it is inactive.

**What counts as a comment event:**
- With `TRIGGER_EVENT_KIND` set, the kind decides: `comment` makes any event a comment event, even one with no name, and `other` makes no event one. A kind given without an event or author has no effect.
- Otherwise the name decides: it contains `comment` (case-insensitive), or it is exactly `note`, `Note Hook` or `pull_request_review` (case-insensitive; these three from 0.0.46). That covers Bitbucket `pullrequest:comment_*`, GitHub `issue_comment`, `pull_request_review_comment` and `pull_request_review`, Azure `ms.vss-code.git-pullrequest-comment-event`, and GitLab `note` / `Note Hook`. Per-provider names: §9.
- A push or PR-update event is never a comment event by name: Bitbucket `pullrequest:created` / `pullrequest:updated`, GitHub `pull_request` / `push`, Azure `git.pullrequest.*` / `git.push` / `PullRequest`, GitLab `merge_request_event` / `Merge Request Hook` / `Push Hook`. Providers send an actor with every PR event (the pusher on Bitbucket `pullrequest:updated`), so a listed bot's push (Renovate etc.) is still reviewed.
- Not comment events by name: GitHub `pull_request_review_thread`, and `pull_request_review.submitted` (pass `github.event_name`, not `github.event.action` or `name.action`). Use `TRIGGER_EVENT_KIND` for these or for any name a relay invents.
- **Set the kind per event, never as a job-wide constant**, unless the job only ever receives comment events (an Azure reply pipeline fed by the comment service hook, a relay that forwards only notes). `TRIGGER_EVENT_KIND=comment` on a job that also runs on pushes makes a listed author's push skippable.

**Matching:** exact, after trim → strip one surrounding `{…}` → trim → lowercase on both sides. No wildcard, no substring (`bot` does not match `bot2`).

**Which id to pass:** the event **actor**, never the PR author and never the comment's original author. With the PR author, listing a bot would silence humans' comments on that bot's PRs. On Bitbucket `comment_resolved` / `comment_reopened` the actor is the person acting, which is the intent ("ignore events caused by this account"). Use a stable id, not a display name (mutable, not unique, may contain commas). The id field per provider is in §9.
- Bitbucket: `$.actor.uuid` from the webhook body (`account_id` works equally well; the matcher handles both), not `display_name` or `nickname`. A repository access token acts as an `app_user` with a different uuid in every repository, so no id list covers it; filter such bots in CI by `$.actor.type` instead (see [jenkins.md](../../reference/jenkins.md#bot-comment-filter)).
- The matcher lowercases both sides, which suits Bitbucket uuids, GitHub numeric ids and logins, Azure GUIDs and GitLab numeric ids. Avoid case-sensitive ids such as GitHub `node_id`.
- GitHub: filter commenters in the workflow's job `if:` rather than with `IGNORE_COMMENT_AUTHORS`, as the shipped workflow does. Under the default `queue: single`, an Actions concurrency group keeps at most one pending run, so an ignored run can replace a queued push run; `queue: max` keeps them all but is not used by the shipped workflow (see [github-actions.md](../../reference/github-actions.md#concurrency)).
- Azure: `resource.comment.author.id` (a GUID) from the comment service hook's payload, which the sample reply pipeline passes; how to find the agent's own GUID: [azure-devops.md](../../reference/azure-devops.md#skip-the-agents-own-comments-ignore_comment_authors).

Example, Bitbucket webhook + Jenkins Generic Webhook Trigger ([jenkins.md](../../reference/jenkins.md#webhook-variables)): the trigger variable `TRIGGER_COMMENT_AUTHOR` (JSONPath `$.actor.uuid`) reaches the agent directly, and the header variable `x_event_key` (`X-Event-Key`) is passed on as the event:

```groovy
withEnv(["TRIGGER_EVENT=${env.x_event_key ?: ''}"]) { sh 'node pr-review-agent.cjs ...' }
```

In CI prefer this env form over `--event` / `--comment-author` / `--event-kind`: an older bundle exits 1 on these unknown flags (rollout rule, §8).

**Caveat: an ignored event never catches up a dropped push.** An ignored comment event exits without looking at the PR. Today any event catches up: a comment event on a PR whose head moved reviews the new head. If CI dropped the preceding push event (Bitbucket `pullrequest:updated`, GitHub `pull_request` `synchronize`, an Azure build-validation run; a per-PR lock with skip-if-locked drops events that arrive during a run), the new head stays unreviewed until the next non-ignored event (push, human comment, retarget); if none comes, the PR can merge unreviewed. So:
- List an author only when CI **queues** rather than drops push events.
- Prefer listing bots that never comment in response to a push.
- Do not list the agent's own id under a dropping lock: its own comment event, fired when a long run posts, is often the event that catches up a push dropped during that run. The same applies to other review bots that comment on pushes, and to filtering these events in CI before the agent runs.
- Once bot comments are ignored or filtered, queue comment events too: a developer reply dropped by the lock otherwise waits for the next push or human comment. The reference Jenkins pipeline queues every event (see [jenkins.md](../../reference/jenkins.md#per-pr-lock)).

**Other cases:**

| Case | Behaviour |
|---|---|
| Push dropped by a skip-if-locked CI lock, then an ignored comment event | The new head is not reviewed until the next non-ignored event (see caveat) |
| `--force` / `--force clean` + listed author on a comment event | Runs anyway, one log line — the manual-replay lever |
| `--dry-run` | The list still applies (record has `dry_run: true`) |
| `--benchmark` / `--validate-prompt` | No check; no `trigger` field |
| A listed bot replies in the agent's thread | That run is skipped; the reply is still answered on the next non-ignored run (`CHECK_REPLIES` reads content, not triggers). The list suppresses runs, not replies |
| Agent account shared with a human | Do not list it: that human's comment events would stop triggering replies until the next event |
| `--vcs gitlab` / `VCS_PROVIDER=gitlab` | From 0.0.46, rejected at startup with one error line, exit 1, no record. The adapter is a stub, so the run never reaches `CHECK_TRIGGER`, whatever the event or author |
| `TRIGGER_EVENT_KIND=comment` with no event name and a listed author | SKIP; `skip_reason` reads `comment event by "<author>" …`, and the missing-event warning is not logged |

The agent's own comments are not auto-ignored: `AGENT_IDENTITY` / `BITBUCKET_USERNAME` never equal a webhook actor id, and looking the id up would cost a VCS call before the decision.

**Record:** `action: SKIP`, `skip_reason: '<event> by "<author>" matches IGNORE_COMMENT_AUTHORS'`, `review_number: 0`, PR fields `unknown`, `diff_size: null`, `cost_usd: 0`, and `trigger: { event, comment_author }`, plus `event_kind` only when `TRIGGER_EVENT_KIND` / `--event-kind` was given with a valid value (also on runs that are not skipped). The log line becomes `Trigger: <event> by <author> (event kind: <kind>)` in that case only. No distinct exit code — CI tells skipped from reviewed by `action` (see [usage-logging.md](../../reference/usage-logging.md#telling-skipped-from-reviewed-in-ci)).

---

## 8. Checked Commit from CI (`LAST_CHECKED_COMMIT`)

**Rule:** the head counts as already reviewed if it equals the last review footer's `Commit:` (§1, unchanged) **or** the checked commit passed by CI.

The footer only moves when a review is posted. After a no-post ending (`NO_NEW_FINDINGS`, a structured `NO_CHANGE`, a quiet reply, a reply limit) the footer still names an older commit, so every later event on the same head re-pays the delta review. The agent reports the head it genuinely checked as `checked_commit`; CI stores it per PR and passes it back on the next run.

| Env var | CLI | Default | Effect |
|---------|-----|---------|--------|
| `LAST_CHECKED_COMMIT` | `--checked-commit <hash>` | empty (off) | The `checked_commit` an earlier run reported for this PR. 12 to 64 hex characters (SHA-1 or SHA-256 heads), trimmed, case-insensitive; anything else logs one warning and is treated as unset. |

CLI wins over env; an empty or whitespace CLI value falls back to the env value. In CI use the env var (rollout rule below). If you do use the flag, write it as `--checked-commit="$X"`: an unquoted empty variable vanishes in the shell, and the flag then swallows the next argument as its value. The same applies to `--event` / `--comment-author` / `--event-kind`.

**Where it is read:** only in `CHECK_PREVIOUS_REVIEWS`, when previous reviews exist, the run is not forced and the footer same-commit check missed. `--force clean` / `--force re-review` are forced; CI's empty `--force ''` is not (the CLI runs it as `off`).
- **Match** → `CHECK_REPLIES`, exactly like the same-commit path: a pending reply is answered (`REPLY`), the reply limit applies (its own `skip_reason`), else `DEDUP_SKIP` with `skip_reason: head already checked by an earlier run and no unanswered questions`. The record gets `dedup_source: checked_commit`. One log line: `Source commit <head12> already checked by an earlier run (checked commit) — checking for unanswered replies...`.
- **Matching** is a prefix rule, because the stored value's length depends on the VCS: the shorter of value and head (at least 12 characters) must prefix the longer.
- **No match** (stale value, a newer push) → one log line (`Checked commit <value12> is not the current head <head12> — ignoring it`) and today's path.
- It never changes the delta base (`footerCommit..head`), and nothing else reads it. A first review, a footer match and a forced run never consult it, and log nothing about it. Dry-run consults it (read-only, like the footer) but never marks.

**Output: `checked_commit`.** The record carries `checked_commit` (the full `source_commit`) only when the run's head was genuinely checked:

| Marked (present) | Never marked (absent) |
|---|---|
| Review posted (`REVIEW` / `RE_REVIEW`) | Any `SKIP` or `ERROR` run, including an error after a mark (reply fetch, reply generation, reply post) and a reviewer response whose `findings` is null or not a list (it errors like a missing key) |
| Footer same-commit, zero-reviewable delta or checked-commit match, ending `DEDUP_SKIP` or `REPLY` | `--dry-run`, `--benchmark`, `--force clean` / `--force re-review` |
| Coherent structured `NO_CHANGE` (`no_change: true`, zero findings), with or without a reply | A regex-only or self-contradicting `NO_CHANGE` (`no_change` plus findings, a bare `NO_CHANGE` line inside a finding) |
| `NO_NEW_FINDINGS`, single-pass or bundled | `POST_REVIEW`'s "empty or NO_CHANGE after cleanup" skip |
| 0-finding re-review that answers a reply, when the prior review was clean and nothing is still open | The same reply when the prior review had findings or one is still open (today's next-event confirmation post is kept) |
| JUDGE-gate reply limit | A run whose delta fetch failed (the full-diff fallback was told to report only new findings but could not see what was new). A delta dropped as larger than the PR diff still marks |
| Pre-post race (another run already posted for this head) | A bundled run with an unreviewed file or a self-contradicting `NO_CHANGE` bundle |

Why a field and not `action`: `NO_CHANGE`, `REPLY` and `DEDUP_SKIP` each mix trustworthy endings with untrustworthy ones, and storing the head of a `SKIP` would suppress the review once the skip condition lifts. With nothing set, `checked_commit` is the only record change: an additive key on checked runs. Posted reviews carry it too; the footer already covers them, so CI needs no special case.

**CI contract** (the agent cannot check any of it):
1. **Key:** `vcs` + `workspace` + `repo_slug` + `pr_id` from the record. A head hash alone is shared by PRs from one source branch. `workspace` is the provider's owner scope: the Bitbucket workspace (`--workspace`, else `BITBUCKET_WORKSPACE`), the Azure organization (`AZURE_ORG`; the project is not recorded, and Azure PR ids are believed unique per organization, unverified), the GitHub owner from 0.0.46 (`--workspace`, else `GITHUB_OWNER`; bundles up to 0.0.45 logged `BITBUCKET_WORKSPACE` there, usually empty, so a GitHub key stored from those records changes once).
2. **This run's record:** `results.jsonl` appends and a run that fails before writing (argument or config error, crash) writes nothing, so the last line can belong to an earlier run in a reused working directory. Pick one:
   - **Jenkins:** the record whose `jenkins.job` / `jenkins.build` equal `$JOB_NAME` / `$BUILD_NUMBER`. Jenkins sets both.
   - **Any other CI, same recipe:** export `JOB_NAME`, `BUILD_NUMBER` and `BUILD_URL` to the agent from the CI's own run ids (per provider in §9). The record's `jenkins` field is built from exactly these three variables (null when all are empty), so the Jenkins recipe works unchanged, and the footer's `Review #N` links to the run.
   - **Any CI, no matching:** run in a fresh working directory, or delete `results.jsonl` before the run, then read its single line and check that its key (item 1) is this PR's.
   - **Any CI, own file (from 0.0.46):** set `USAGE_RECORD_FILE` to a path that receives only this run's record (overwritten, written next to the `results.jsonl` append, so not with `--log-usage false`). Delete it before the run: a run that fails before writing leaves the previous file. An older bundle ignores the variable and writes no file, so CI stores nothing (fail open).
3. **Store:** if that record has a non-empty `checked_commit`, overwrite the PR's value with it; otherwise store nothing. From 0.0.46 the agent emits it only for a 12–64 hex head (the input rule), so a provider that reports an empty or odd head never yields a storable value. Ignore `action` and the exit code. Never take the head from the webhook payload or from a CI variable such as a merge commit. Store inside the per-PR serialisation. Jenkins example: a declarative `post` section runs after a `lock` inside `steps` has released, so a queued build of the same PR could read before the write.
4. **Read:** at run start, inside the per-PR serialisation, not when the webhook is queued. Pass it as `LAST_CHECKED_COMMIT`. **Fail open:** if the value is missing, the read fails or the value is malformed, pass nothing (today's behaviour).
5. **Concurrency:** an older run finishing last is harmless. Its head was genuinely checked for this PR, and a newer head won't match it (at most one extra review). PR info (and so `checked_commit`) is read once, before the diff; the delta and file contexts are pinned to that head. The PR diff itself is re-read by PR id, so a push in between makes the reviewed content newer than `checked_commit`, the safe direction (at most one extra review). Unverified: whether any provider's PR diff endpoint can lag behind the head its PR API already reports.
6. **Optional hardening (retarget):** store the record's `target_branch` alongside, and withhold the value when the PR's current destination differs.
7. **Rollback:** stop passing the value. If the CLI flag is used, stop before rolling back the bundle.
8. **Store choice is CI's.** Jenkins: build variables on the build (for ephemeral agents such as a fresh pod per build; read by a bounded walk back through previous builds), a per-PR file on persistent storage, or a Bitbucket commit build status with a per-PR key. A build status must be `SUCCESSFUL` only: it can count toward "minimum successful builds", and the AI review must never gate a merge. Trade-offs and snippets: [jenkins.md](../../reference/jenkins.md#checked-commit-state). Other providers: §9.

The input is VCS-agnostic: it compares with `PRInfo.sourceCommit`. Bitbucket and GitHub always fill it. Azure takes `lastMergeSourceCommit`; from 0.0.46 a PR without it fails the run (`ERROR`, retried on the next event) instead of reporting `''` (whether an active PR can lack it is unverified). An empty head (possible up to 0.0.45) never matches a checked commit; from 0.0.46 it is also never emitted as `checked_commit` (older records can carry `""`, so CI stores only a non-empty value). GitLab is rejected at startup (§7).

**Rollout rule:** commander rejects an unknown option with exit 1, and CI wrappers that tolerate a failed step (Jenkins `catchError`, Azure `continueOnError`, GitHub `continue-on-error`) hide the failure. A bundle without this change therefore fails every run that passes `--checked-commit`, even with an empty value. Pass the flag only once the bundle you run contains it, and stop passing it **before** any bundle rollback. The env var has no such hazard, so it is the recommended CI path. The same applies to `--event` / `--comment-author` / `--event-kind` (§7): in CI prefer `TRIGGER_EVENT` / `TRIGGER_COMMENT_AUTHOR` / `TRIGGER_EVENT_KIND`.

**Known limitations:**
- **Retarget.** Today a same-head retarget is already deduped when the last *posted* footer names that head. The checked commit extends this to no-post endings: once CI stores head H, retargeting the PR without a push skips the review of the new target's diff, where today that event re-reviews (the footer names an older head). Mitigation: contract item 6.
- **Shared heads.** Correctness across PRs that share a head depends on CI keying per PR (item 1).
- **Deleted review.** Once CI stores head H (any posted review does, as does any later run at H), deleting the agent's latest review no longer brings a re-review at H: the older footer misses but the stored H matches. Today that event re-reviews. H was reviewed, so nothing unreviewed is skipped; use `--force` to re-review a head CI has stored.

---

## 9. Per-Provider Wiring

What CI passes for §3, §7 and §8, per setup. The agent logic is the same everywhere; only the names, ids and stores differ. Values marked unverified were not tested live.

| CI setup | Comment events (`TRIGGER_EVENT`) | Push events | Actor id (`TRIGGER_COMMENT_AUTHOR`) | Retarget starts a run? | Checked-commit store | This run's record (§8 item 2) | Reference |
|---|---|---|---|---|---|---|---|
| Bitbucket Cloud webhook + Jenkins | `pullrequest:comment_created`, `_updated`, `_deleted`, `_resolved`, `_reopened` (header `X-Event-Key`) | `pullrequest:created`, `pullrequest:updated` | `$.actor.uuid` (or `account_id`); access-token bots by `$.actor.type` in CI | Yes: `pullrequest:updated` | Build variables, a per-PR file, or a per-PR commit build status (`SUCCESSFUL` only) | Match `jenkins.job` / `jenkins.build`; Jenkins sets `JOB_NAME` / `BUILD_NUMBER` / `BUILD_URL` | [jenkins.md](../../reference/jenkins.md) |
| Bitbucket Pipelines (`pull-requests:`) | None: no comment trigger, so replies wait for the next push | Every run is a push to the PR's source branch; no event name to pass | None (`BITBUCKET_STEP_TRIGGERER_UUID` is the pusher; do not feed it to the ignore list) | No (unverified) | None native; leave `LAST_CHECKED_COMMIT` unset (every run is a new head, so it saves almost nothing) | Each step starts in a fresh container: the single line; `BUILD_NUMBER=$BITBUCKET_BUILD_NUMBER` optional | — |
| GitHub Actions | `issue_comment`, `pull_request_review_comment`, `pull_request_review`: pass `${{ github.event_name }}`. The shipped workflow subscribes to `issue_comment` only and passes no trigger env (it filters in the job `if:`) | `pull_request` (`opened`, `synchronize`, `reopened`) | `${{ github.event.sender.login }}` or `sender.id`; filter commenters in the job `if:`, not with `IGNORE_COMMENT_AUTHORS` (§7) | Yes in the shipped workflow: `pull_request` type `edited`, filtered in the job `if:` to `github.event.changes.base` (not yet run live) | Recommended: per-PR commit status on the checked head; the shipped workflow stores none | Hosted runners start clean: `rm -f results.jsonl` and read the single line, or `USAGE_RECORD_FILE` (0.0.46+); or `JOB_NAME=${{ github.workflow }}`, `BUILD_NUMBER=${{ github.run_id }}-${{ github.run_attempt }}`, `BUILD_URL=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}` | [github-actions.md](../../reference/github-actions.md) |
| Azure DevOps: build validation + "Pull request commented on" service hook | `ms.vss-code.git-pullrequest-comment-event`, the live-validated service-hook event of the reply trigger, classified as a comment by name. The sample reply pipeline passes it as a literal, because only that hook starts it (the payload's `eventType` is unverified and unused). The reply pipeline receives only comment events, so `TRIGGER_EVENT_KIND=comment` (0.0.46+) is safe there | Build validation runs per push, with no event name (`$(Build.Reason)` = `PullRequest`, never a comment event) | `resource.comment.author.id` (GUID) from the payload, passed by the sample reply pipeline; none in build validation | Unverified whether a target-branch change re-queues build validation | None shipped; recommended PR properties, alternative build tags (both unverified) | `JOB_NAME=$(Build.DefinitionName)`, `BUILD_NUMBER=$(Build.BuildId)`, `BUILD_URL=$(System.CollectionUri)$(System.TeamProjectId)/_build/results?buildId=$(Build.BuildId)` (both samples map them); self-hosted agents can reuse the directory, so also `rm -f results.jsonl` (the samples do) or use `USAGE_RECORD_FILE` (0.0.46+) | [azure-devops.md](../../reference/azure-devops.md) |
| GitLab | **Unsupported:** `--vcs gitlab` exits 1 at startup from 0.0.46 (stub adapter; older bundles fail the run at the first adapter call). The name rule already treats `note` / `Note Hook` as comment events for a future adapter; MR pipelines (`merge_request_event`) have no comment source, so notes would need a webhook relay | — | — | — | — | — | — |

Other CI systems on Bitbucket webhooks (TeamCity, Buildkite, a relay) get the same event names and actor ids as the Jenkins row. They need the same three pieces: per-PR serialisation, a per-PR store and this run's record. TeamCity sets `BUILD_NUMBER` itself, so also export `JOB_NAME` before matching on `jenkins`.
