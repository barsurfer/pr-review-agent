# Jenkins + Bitbucket Cloud Integration

Covers the Jenkins job that runs the agent on Bitbucket Cloud pull-request events: how a build
runs, the webhook variables and bot-comment filter, the per-PR lock, the checked-commit store,
per-repo settings, build statuses and troubleshooting. For first-time setup (plugins, credentials,
webhook URL, network) see [`phases/phase-2-jenkins.md`](../phases/phase-2-jenkins.md); for the
agent's skip rules see Knowhere [`docs/context/review/skip-logic.md`](../context/review/skip-logic.md)
(§3 branch lists, §7 trigger check, §8 checked commit); for record fields see
[`usage-logging.md`](usage-logging.md); for every setting see [`env-vars.md`](env-vars.md).

Snippets are labelled **reference pipeline** (taken from a working job, sanitised, placeholders in
`<…>`) or **illustrative** (shows intent, not run as written). Statements about Jenkins or
Bitbucket that have not been confirmed are listed under
[Known limitations and unverified items](#known-limitations-and-unverified-items).

## Reference pipeline

[`jenkins/pipeline.groovy`](../../jenkins/pipeline.groovy) is a working production job with names,
uuids and tokens replaced by placeholders. Adapt before use:

- **Site-specific parts:** the shared library and the `agent { kubernetes … }` block (any agent
  with Node 22+ works), the allowed workspaces, the `byProject` / `byRepo` maps and the credential
  IDs (`review-agent-*`). `DEFAULT_ENV_DEPLOY` and `SONAR_SERVER` are not read by the agent.
- **Operator choices, not requirements:** the `environment` block and the `settingsFor` defaults
  (models, effort, breadth, nitpicks). See [Models, effort and breadth](#models-effort-and-breadth).
- **Plugins:** Generic Webhook Trigger, Lockable Resources, NodeJS, Pipeline Utility Steps
  (`readJSON`, `writeJSON`), Plot, Kubernetes.
- **Bitbucket webhook events:** `pullrequest:created`, `pullrequest:updated`,
  `pullrequest:comment_created`.

## How a build runs

```
PR event ─▶ Bitbucket webhook ─▶ Generic Webhook Trigger: extract variables, drop bot comments
         ─▶ quiet period (30 s) ─▶ build on a fresh agent (a Kubernetes pod)
         ─▶ settings for the repo (defaults → project → repo)
         ─▶ per-PR lock ┬ fetch the PR: current head and destination
                        ├ read the stored checked commit
                        ├ run the agent
                        └ store checked_commit from this build's record
         ─▶ after the lock: one SUCCESSFUL commit status, archive results.jsonl
```

| Step | What happens | Details |
|---|---|---|
| 1. Webhook | Bitbucket posts the event to the Generic Webhook Trigger, whose filter drops comment events from bots before any build exists. | [Webhook variables](#webhook-variables) |
| 2. Quiet period | The build starts 30 seconds later. | |
| 3. Settings | Branch policy, models, effort and diff excludes: the defaults, then the project's entry, then the repo's. | [Settings](#per-repo-and-per-project-settings) |
| 4. Lock | Every event waits for a running build of the same PR. | [Per-PR lock](#per-pr-lock) |
| 5. Read | Inside the lock, after the wait: fetch the PR's destination and read the stored checked commit. | [Checked-commit state](#checked-commit-state) |
| 6. Run | Download the bundle and run the agent, with the event, actor and checked commit as env vars. | [Passing inputs](#passing-inputs) |
| 7. Store | Still inside the lock: find this build's record in `results.jsonl` and store its `checked_commit`. | [Checked-commit state](#checked-commit-state) |
| 8. Status | After the lock: post one `SUCCESSFUL` commit status that says what the run did, and archive `results.jsonl`. | [Build status](#build-status) |

The agent decides from the PR's state when it runs, not from the event. One invocation serves every
event type; the event only feeds the trigger check (`IGNORE_COMMENT_AUTHORS`) and the record's
`trigger` field. A build on a head that is already reviewed, or stored as checked, ends without a
model call unless a developer reply is waiting.

## Webhook variables

Generic Webhook Trigger variables of the reference pipeline. The trigger exports them to the build
environment.

| Variable | Source | Used for |
|---|---|---|
| `REPO_SLUG` | `$.repository.name` | `--repo-slug`, lock name |
| `PR_ID` | `$.pullrequest.id` | `--pr-id`, lock name |
| `WORKSPACE_SLUG` | `$.repository.workspace.slug` | `--workspace`, allowed workspaces |
| `PROJECT_KEY` | `$.repository.project.key` | Settings per project |
| `TRIGGER_COMMENT_AUTHOR` | `$.actor.uuid` | Read by the agent directly from the environment; filter |
| `ACTOR_TYPE` | `$.actor.type` | Filter |
| `COMMENT_AUTHOR` | `$.comment.user.nickname` | Display only |
| `x_event_key` | Header `X-Event-Key` | `TRIGGER_EVENT`, filter |

- **Actor, not author.** The agent's trigger check expects the event actor's id (`$.actor.uuid`).
  Never pass `$.pullrequest.author` or the comment user, and never a nickname or display name (see
  skip-logic §7).
- **Header names.** The trigger lowercases header names and turns `-` into `_`, so `X-Event-Key`
  becomes `x_event_key`.

### Bot-comment filter

Reference pipeline, in the trigger's **Optional filter**. A build starts only when the text matches
the expression.

```
Text:       $x_event_key|$ACTOR_TYPE|$TRIGGER_COMMENT_AUTHOR|$REPO_SLUG/$PR_ID
Expression: ^(?!pullrequest:comment_\w+\|(app_user\|[^|]*|[^|]*\|\{(<review-bot-uuid>|<agent-account-uuid>)\})\|)[^|]*\|[^|]*\|[^|]*\|\S+/\d+$
```

| Event | Result |
|---|---|
| Comment event (`pullrequest:comment_*`) whose actor type is `app_user` | Dropped |
| Comment event by a listed uuid (here a review bot running as a user, and the agent's own account) | Dropped |
| Comment event by a person | Build |
| `pullrequest:created` / `pullrequest:updated` by any account, bots included | Build |
| Text without a `<repo>/<numeric id>` at the end | Dropped, as a plain `^\S+/\d+$` filter would |
| Event header not resolved | The lookahead cannot match, so nothing is dropped |

- **Why bots are matched by `$.actor.type`.** A repository access token acts as an `app_user` with a
  different uuid in every repository, so a uuid list cannot cover it. Matching the type covers every
  repository at once. User accounts (the agent's own account, a review bot running as a user) are
  listed by uuid, without braces, because the expression adds them.
- **Filter or `IGNORE_COMMENT_AUTHORS`.** The webhook filter costs nothing: no build starts.
  `IGNORE_COMMENT_AUTHORS` starts a build that ends as `SKIP` before any VCS or model call, and it
  matches ids only, so it cannot cover access tokens either.
- **Either one changes the lock rule.** Filtering bot comments removes the events that otherwise
  catch up work dropped by the lock, so every event must queue (next section).
- **Debugging.** Bitbucket's webhook request log shows the trigger's response, including the
  resolved filter text and whether a build was triggered. For a person's comment the text reads
  like `pullrequest:comment_created|user|{…}|<repo>/948`.

## Per-PR lock

Reference pipeline:

```groovy
lock(resource: "review-${WORKSPACE_SLUG}-${REPO_SLUG}-${PR_ID}") {
    // fetch the PR, read the checked commit, run the agent, store the checked commit
}
```

One lock per PR, with the workspace in the name when the job serves several. It serialises the
read, run and store of one PR, which the checked-commit store relies on.

| Event | While another build of the PR holds the lock |
|---|---|
| `pullrequest:created`, `pullrequest:updated` | Always wait. |
| Comment events | May be skipped only while no bot comments are filtered (webhook filter or `IGNORE_COMMENT_AUTHORS`). Once they are, wait too. |

**Why push events wait.** The running build read the PR's head when it started, so a push that lands
during the run is not in it. The agent always reads the current head, so any later event catches the
push up. The usual later event is a bot comment: the agent's own comment when the running build
posts, or another review bot reacting to the push. A bot-comment filter removes exactly those
events, so a dropped push can stay unreviewed until a person comments or pushes again, and the PR can
merge in the meantime.

**Why comment events wait once bots are filtered.** A comment cannot move the head, but a developer
reply dropped while the lock is held waits for the next event on the PR. Without a filter, the
agent's own comment event, fired when the running build posts, is often that event. With the agent's
comments filtered, the reply waits for the next push or human comment. The reference pipeline
therefore queues every event.

**The cost.** Each waiting build holds its executor; in the reference pipeline that is a Kubernetes
pod, because the `agent` is allocated before the stage and the lock is a step inside it. A queued
build on an already-checked head makes VCS reads only (no model call unless a developer reply is
waiting), but it still holds the pod while it waits and runs.

Illustrative, for a job that does not filter bot comments and wants to drop comment events while
locked (`skipIfLocked` is a Lockable Resources parameter):

```groovy
def isPushEvent = env.x_event_key in ['pullrequest:created', 'pullrequest:updated']
lock(resource: "review-${env.WORKSPACE_SLUG}-${env.REPO_SLUG}-${env.PR_ID}", skipIfLocked: !isPushEvent) {
    // same body
}
```

## Checked-commit state

The review footer only moves when a review is posted. After a run that checked the head without
posting (`NO_NEW_FINDINGS`, a structured `NO_CHANGE`, a quiet reply), every later event on that head
re-pays the delta review. The agent reports the head it genuinely checked as `checked_commit`; the
job stores it per PR and passes it back as `LAST_CHECKED_COMMIT`. A run on that head then goes to the
reply check and ends as `DEDUP_SKIP` (`dedup_source: checked_commit`) or a reply, without a review
call. Which runs carry the field is in skip-logic §8.

### Contract

1. **Key:** `vcs` + `workspace` + `repo_slug` + `pr_id`, all from the record (`pr_id` is a string).
   `workspace` is the `--workspace` value when passed, else `BITBUCKET_WORKSPACE`. A head hash alone
   is not a key: PRs from one source branch share heads.
2. **This build's record:** the `results.jsonl` line whose `jenkins.job` and `jenkins.build` equal
   `$JOB_NAME` and `$BUILD_NUMBER` (both strings); take the last match. Never use just the last line:
   a run that fails before writing (unknown flag, config error, crash) leaves an earlier build's
   record last.
3. **Store only when present:** if the record has a non-empty `checked_commit`, overwrite the PR's
   value with it, verbatim. Otherwise store nothing and keep the previous value. Ignore `action` and
   the exit code. On Bitbucket the value is the PR API's `source.commit.hash`, which may be
   abbreviated; the agent matches by prefix.
4. **Never from the webhook payload.** The payload head can be newer than what the agent reviewed;
   storing it would mark an unreviewed head as checked.
5. **Read and store inside the lock.** Read after the lock wait, and store before the lock is
   released (see the trap below). Pass the value as the env var `LAST_CHECKED_COMMIT`.
6. **Fail open.** A missing value, a failed read or a malformed value means pass nothing. The agent
   itself ignores a value that is not 12 to 64 hex characters, with one warning.
7. **Concurrency.** An older run finishing last is harmless: its head was genuinely checked for this
   PR, and a newer head will not match it. It costs at most one extra review.

### The store must happen inside the lock

A declarative `post` section runs after a `lock` block inside `steps` has been released. If the
store happens in `post`, a queued build of the same PR can take the lock and read the old value
before the new one is written, and re-pay a review the previous build just made unnecessary. Store
right after the agent call, inside the lock, as the reference pipeline does; leave only the status
and archiving to `post`. The rule applies to every store below.

### Store options

| Store | Fits | How | Trade-offs |
|---|---|---|---|
| **Build variables on the Jenkins build** | Ephemeral agents, e.g. a fresh Kubernetes pod per build | **Write**, inside the lock: set `env.CHECKED_PR_KEY` (`bitbucket/<workspace>/<repo>/<pr>`), `env.CHECKED_COMMIT` and `env.CHECKED_TARGET`; Pipeline keeps variables set on `env` with the build. **Read**, after the lock wait: walk `currentBuild.previousBuild` back at most N builds and take the newest build whose `buildVariables.CHECKED_PR_KEY` matches. | No storage and no VCS side effects. The walk is bounded: a value more than N builds of the job back is not found, which costs one review (the reference pipeline uses 500). Builds removed by the job's retention policy lose their values the same way. Values belong to the job; a new job starts empty. |
| **A file per PR on persistent storage** | The controller, or agents with a shared or persistent volume | `<state-dir>/bitbucket/<workspace>/<repo>/<pr>.json` holding `{"checked_commit": …, "target_branch": …}`; write a temp file, then `mv`. | Simple and without VCS side effects. Needs a directory that survives workspace cleanup and is reachable from every node that runs the build. Files can be pruned at any time, because a missing value fails open. |
| **A per-PR commit build status** | No Jenkins storage, and repositories without merge checks on build statuses | **Write:** a `SUCCESSFUL` status on commit `checked_commit` with key `ai-review-checked-pr-<pr_id>` and the target branch in its description. **Read:** look up that key on the PR's current head; if present, pass that head. | Visible on the PR, and needs repository write access. It adds a status per checked commit, and a `SUCCESSFUL` status counts toward a "minimum successful builds" merge check. Post it only as `SUCCESSFUL`, and avoid this store where merge checks use build statuses. |

The build-variable store is implemented in the reference pipeline by `readOwnRecord`,
`storeCheckedCommit` and `lastCheckedCommit` (`@NonCPS`; no script approvals were needed).

The build-status read is safe even though it starts from a head: the head only picks which status to
look up, and the hash passed is one the agent reported, because statuses are written only from
records. If the head has moved since, the agent sees no match and reviews as usual.

File store, illustrative (POSIX `sh` with `jq`, run inside the lock; `PR_TARGET` is the destination
fetched at run time):

```sh
STATE_FILE="$STATE_DIR/bitbucket/$WORKSPACE_SLUG/$REPO_SLUG/$PR_ID.json"

# read, after the lock wait
LAST_CHECKED_COMMIT=""
if [ -r "$STATE_FILE" ] && [ -n "$PR_TARGET" ] \
   && [ "$(jq -r '.target_branch // empty' "$STATE_FILE" 2>/dev/null)" = "$PR_TARGET" ]; then
  LAST_CHECKED_COMMIT=$(jq -r '.checked_commit // empty' "$STATE_FILE" 2>/dev/null || true)
fi
export LAST_CHECKED_COMMIT

# store, after the agent call and before the lock is released
NEW_STATE=$(jq -cR --arg job "$JOB_NAME" --arg build "$BUILD_NUMBER" \
    'fromjson? | select(.jenkins != null and .jenkins.job == $job and .jenkins.build == $build)' \
    results.jsonl 2>/dev/null | tail -n 1 \
  | jq -c --arg ws "$WORKSPACE_SLUG" --arg repo "$REPO_SLUG" --arg pr "$PR_ID" \
    'select(.vcs == "bitbucket" and .workspace == $ws and .repo_slug == $repo and .pr_id == $pr
            and (.checked_commit // "") != "") | {checked_commit, target_branch}' 2>/dev/null)
if [ -n "$NEW_STATE" ]; then
  mkdir -p "$(dirname "$STATE_FILE")" \
    && printf '%s\n' "$NEW_STATE" > "$STATE_FILE.tmp.$BUILD_NUMBER" \
    && mv -f "$STATE_FILE.tmp.$BUILD_NUMBER" "$STATE_FILE"
fi
```

Build-status store, illustrative (the read endpoint is not confirmed; check it against Atlassian's
API documentation):

```sh
# store, on the checked head
curl -fsS -u "$BITBUCKET_USERNAME:$BITBUCKET_TOKEN" -H 'Content-Type: application/json' \
  -X POST "https://api.bitbucket.org/2.0/repositories/$WORKSPACE_SLUG/$REPO_SLUG/commit/$CHECKED/statuses/build" \
  -d "$(jq -nc --arg key "ai-review-checked-pr-$PR_ID" --arg url "$BUILD_URL" --arg tgt "$TARGET" \
        '{key: $key, state: "SUCCESSFUL", name: "AI review: head checked", url: $url, description: ("target=" + $tgt)}')"

# read, on the PR's current head; pass HEAD only when this prints "target=$PR_TARGET"
curl -fsS -u "$BITBUCKET_USERNAME:$BITBUCKET_TOKEN" \
  "https://api.bitbucket.org/2.0/repositories/$WORKSPACE_SLUG/$REPO_SLUG/commit/$HEAD/statuses/build/ai-review-checked-pr-$PR_ID" \
  | jq -r 'select(.state == "SUCCESSFUL") | .description'
```

### Retarget hardening

Store the record's `target_branch` with the value. Before passing the value, compare it with the PR's
destination fetched at run time, inside the lock, from the PR API rather than the webhook payload: a
retarget can land while the build waits. Pass nothing when they differ or when the destination could
not be fetched. The reference pipeline does this in `resolveReviewCommit` and `lastCheckedCommit`.

This restores a review after a retarget without a push, except when the last posted review's footer
already names the head: the agent then deduplicates on the footer, whatever CI passes. Use a manual
`--force` run for that case.

## Per-repo and per-project settings

CI env vars are shared by every repository the job serves, so per-repo settings are passed as
arguments, or as env vars set for one invocation. The reference pipeline's `settingsFor(workspace,
project, repo)` starts from the defaults, then applies `byProject['<workspace>/<PROJECT_KEY>']`,
then `byRepo['<repo>']`; a later key wins.

| Key | Becomes |
|---|---|
| `branches` | `gitflow`: no branch flags. `trunk`: the trunk flags below, when the bundle has them. |
| `model`, `judgeModel`, `replyModel` | `--model`, `--judge-model`, `--reply-model` |
| `effort`, `judgeEffort` | `--effort`, `--judge-effort` |
| `diffExclude` | `DIFF_EXCLUDE_PATTERNS` (no flag). It replaces the whole default list, so repeat the lock-file patterns you still want excluded. |

### Branch policy

| Policy | Arguments | Result |
|---|---|---|
| Git-flow | none | The agent's defaults (`SKIP_SOURCE_BRANCHES=main,master,release/*,hotfix/*`, `SKIP_TARGET_BRANCHES=main,master`). PRs into `develop`, `release/*` and feature branches are reviewed; PRs into `main`/`master` and from release or hotfix branches are skipped. Stacked PRs are reviewed on every push. |
| Git-flow, stacked PRs wait | `'--only-target-branches=develop,release/*'` | As above, but PRs into any other branch are skipped until retargeted. |
| Trunk | `'--skip-target-branches=' '--only-target-branches=main' '--skip-source-branches=main,master'` | PRs into `main` are reviewed, including from `hotfix/*` and `release/*`. Stacked PRs are skipped until retargeted to `main`. |
| Trunk, as in the reference pipeline | `'--skip-target-branches=' '--only-target-branches=main,master,release/*' '--skip-source-branches=main,master'` | Also reviews PRs into `master` and `release/*`. |

- **Use the `=` form** for every branch flag. In the separate form an unquoted empty variable
  vanishes in the shell and the flag swallows the next argument as its value
  (`--skip-target-branches --only-target-branches=main` sets the skip list to
  `--only-target-branches=main`).
- **Quote values that contain `*`** so the shell never globs them.
- **An empty value turns the list off.** For the three branch flags an empty value is a real setting
  and does not fall back to the env var or the default. (For `--event`, `--comment-author` and
  `--checked-commit` an empty value does fall back to the env var.)
- **Pass branch flags only for the repositories in the map.** An always-present parameter with an
  empty default, such as `--skip-target-branches="$SKIP_TARGETS"`, silently disables the `main,master`
  skip in every git-flow repository. The same applies to env vars: an explicitly empty
  `SKIP_TARGET_BRANCHES` disables the default, so never set branch-list env vars job-wide.
- **Env form, per invocation:** `SKIP_TARGET_BRANCHES= ONLY_TARGET_BRANCHES=main
  SKIP_SOURCE_BRANCHES=main,master node … ` behaves the same on 0.0.43 and later and never exits 1 on
  an older bundle. An older bundle ignores `ONLY_TARGET_BRANCHES`, though, so that repository would
  then review every PR, stacked ones included. Use the flags behind the probe, or the env form, not
  both.

### Bundle probe

Reference pipeline. Check for the flag in the downloaded bundle on every build, so that a rollback
can never meet a flag it does not know:

```groovy
if (sh(returnStatus: true, script: "grep -q -- '--only-target-branches' /tmp/pr-review-agent.cjs") != 0) {
    echo "Bundle has no branch flags yet; ${env.REPO_SLUG} runs with the git-flow defaults"
    return ''
}
```

The string is absent from bundles before 0.0.43 and present from 0.0.43 on. All six flags added in
0.0.43 (`--skip-source-branches`, `--skip-target-branches`, `--only-target-branches`, `--event`,
`--comment-author`, `--checked-commit`) arrived together, so one probe covers them.

### Models, effort and breadth

The reference pipeline's values are the operator's choices, not requirements of the integration:
OpenRouter (`LLM_PROVIDER=openrouter`) with `anthropic/claude-haiku-5.5` as reviewer, judge and reply
model, effort `high` for reviewer and judge, `--max-output-tokens 64000`, nitpicks posted as LOW
(`ENABLE_NITPICKS`, `ENABLE_JUDGE_KEEP_MINOR`), unverifiable findings kept
(`ENABLE_JUDGE_KEEP_UNVERIFIED`), directed replies skipped, `MAX_CHANGED_LINES=4500`, and the breadth
pass on every first review (`ENABLE_BREADTH_REVIEW=true`, `BREADTH_MIN_FILES=1`,
`BREADTH_MIN_UNTOUCHED=0`). Facts that matter when choosing your own:

- **Model ids as flags.** `--model` overrides `CLAUDE_MODEL`, so the `CLAUDE_MODEL` credential the
  reference pipeline also binds has no effect while `--model` is passed.
- **OpenRouter key.** With `LLM_PROVIDER=openrouter` and no `OPENROUTER_API_KEY`, the agent uses the
  `ANTHROPIC_API_KEY` value as the OpenRouter key and prints one warning.
- **Effort needs output room.** `xhigh` / `max` effort needs `--max-output-tokens` of about 64000;
  thinking counts against the cap and a cut-off response is refused, not posted.
- **Effort under OpenRouter.** Up to 0.0.47 an OpenRouter run dropped `--effort` / `--judge-effort`
  silently, so the reference pipeline's `high` ran at the model default (`medium` for Haiku 5.5).
  From the next release it is sent as `reasoning.effort`, which OpenRouter maps to Anthropic's
  `output_config.effort`, so the same pipeline reasons more: more output tokens, higher cost and
  slower runs, which is what the setting always asked for.
- **Breadth follows the judge.** With `BREADTH_MODEL` and `BREADTH_EFFORT` unset, the breadth pass
  runs on the judge model at the judge effort, so `--judge-model` and `--judge-effort` set it too. It
  runs only on first, single-pass reviews with a judge. With `BREADTH_MIN_UNTOUCHED=0` it runs on
  every first review that has at least `BREADTH_MIN_FILES` reviewable files, even when the reviewer
  flagged every file.
- **Context window.** From 0.0.43, `anthropic/…` Claude slugs resolve to their own context window
  (1M for the 5.x family), so `MODEL_CONTEXT_TOKENS` is only needed for models the agent does not map.

## Passing inputs

| Input | Pass as | Why |
|---|---|---|
| `TRIGGER_EVENT` | Env var, e.g. `withEnv(["TRIGGER_EVENT=${env.x_event_key ?: ''}"])` | `--event` exits 1 on bundles before 0.0.43 |
| `TRIGGER_COMMENT_AUTHOR` | Env var; name the trigger variable this so it arrives directly | `--comment-author` exits 1 on bundles before 0.0.43 |
| `LAST_CHECKED_COMMIT` | Env var (`withEnv`) | `--checked-commit` exits 1 on bundles before 0.0.43 |
| `IGNORE_COMMENT_AUTHORS` | Env var, job-wide | No flag |
| `DIFF_EXCLUDE_PATTERNS` | Env var, per repository | No flag |
| Branch lists | Flags per repository, behind the bundle probe; or env vars for one invocation | [Branch policy](#branch-policy) |
| Models, effort, output cap | Flags | Present in 0.0.42 and later |
| Secrets | `withCredentials` | Never as arguments: they appear in process lists and logs |

- **Precedence.** A CLI flag always wins over its env var.
- **Unknown flags.** The argument parser rejects an unknown option with exit 1 and writes no record.
  Under `catchError(buildResult: 'SUCCESS', …)` the build stays green; in the reference pipeline the
  stage turns unstable and the status reads `Review failed, see build log`. Remove new flags from the
  job before rolling the bundle back.
- **Unknown env vars** are ignored, so the env route is safe on any bundle; on an older bundle the
  feature is simply off.
- **Shell quoting.** Let the shell expand webhook values (`"\$REPO_SLUG"` inside a Groovy `"""`
  string) instead of interpolating them in Groovy, as the reference pipeline does.
- **`--force`.** Write `--force="$FORCE"` (or `--force=$FORCE`). An unquoted empty value vanishes in
  the shell and leaves a bare `--force`, which means re-review: every event posts a new review and no
  `checked_commit` is ever written. From 0.0.43 an empty value runs exactly as if the flag were
  absent.

## Build status

Where repositories have merge checks on build statuses, the AI review must never gate a merge:

- Post only `SUCCESSFUL`, once, at the end of the run, with a description of what the run did.
- Never post `INPROGRESS` or `FAILED`. Either one blocks a merge check on failed or in-progress
  builds, and an `INPROGRESS` that is never replaced blocks it indefinitely.
- A `SUCCESSFUL` AI status still counts toward a "minimum N successful builds" merge check, so it can
  satisfy a check meant for real CI builds. Decide per repository whether to post one at all.

Status text in the reference pipeline (`statusText`), always with state `SUCCESSFUL`:

| Agent result | Status text |
|---|---|
| `REVIEW` / `RE_REVIEW` | `Reviewed at <head12>` / `Re-reviewed at <head12>` |
| `NO_NEW_FINDINGS` / `NO_CHANGE` | `No new findings at …` / `No material change at …` |
| `REPLY` / `DEDUP_SKIP` | `Replied to comments at …` / `Already reviewed at …` |
| `SKIP` | `Not reviewed: <skip_reason>`, cut to 120 characters |
| Agent failed / build aborted | `Review failed, see build log` / `Review aborted, see build log` |

- The hash is the head the agent read (`checked_commit`, else `source_commit`). The status itself is
  posted on the head the job resolved at the start of the locked section, under the same key on every
  run, so each commit carries one status that later runs update.
- Posting a status needs repository write access (`write:repository:bitbucket` on an API token). The
  agent itself needs only `read:repository:bitbucket`, `read:pullrequest:bitbucket` and
  `write:pullrequest:bitbucket`. A failed post is logged and never fails the build.

## Telling skipped from reviewed

There is no distinct exit code for a skip: every non-error outcome exits 0, `ERROR` exits 1 after
writing its record, and an argument or config error exits 1 without one. Read `action` from this
build's record (`readOwnRecord` in the reference pipeline; a `jq` version is in
[`usage-logging.md`](usage-logging.md#telling-skipped-from-reviewed-in-ci)).

| `action` | Posted |
|---|---|
| `REVIEW`, `RE_REVIEW` | Review comment |
| `REPLY` | Threaded reply |
| `NO_CHANGE`, `NO_NEW_FINDINGS`, `DEDUP_SKIP`, `SKIP` | Nothing |
| `ERROR` | Nothing; exit 1 |

With `dry_run: true` nothing is posted, whatever the `action`. `skip_reason` tells skips apart, and
`dedup_source: checked_commit` marks a run deduplicated by the stored checked commit.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `No checked commit stored for this PR` on every build | (1) This build's record has no `checked_commit`. That is normal for `SKIP`, `ERROR`, dry-run and forced runs (skip-logic §8); a record with `force: "re-review"` on every run means a bare `--force`. (2) No record was found: `jenkins` is null because `JOB_NAME` / `BUILD_NUMBER` do not reach the agent process, the job passes `--log-usage false`, or the record was read from another directory. (3) Key mismatch: the reference pipeline logs `Not storing checked commit: the record is for …`; the record's `workspace` is `--workspace` when passed, else `BITBUCKET_WORKSPACE`. (4) The store step failed: `Could not read this build's result record`. |
| Value stored, but no run shows `dedup_source: checked_commit` | Expected when the footer already names the head (the footer check comes first) or the PR has no previous review (the value is consulted only then). Otherwise read the log: `Checked commit <x> is not the current head <y> — ignoring it` means the head moved; `Warning: ignoring the checked commit` means a malformed value; no `Checked commit stored for this PR` line means the read missed it (store in `post`, read before the lock wait, the build walk's bound, or the retarget hardening withholding it). |
| Reviews silently stopped; builds are green | The log shows `error: unknown option '…'` and no `=== Usage ===` block: a flag the downloaded bundle does not know, usually after a rollback or a pinned older ref. `catchError` hides it. Pass new inputs as env vars and keep flags behind the bundle probe. |
| The same head is reviewed twice | The store runs in `post`, after the lock is released, so the queued build read the old value; or the value is read before the lock wait; or the lock is not per PR. |
| A new review on every event | A bare `--force` from an unquoted empty variable; the records show `force: "re-review"`. |
| Bot comments still start builds | Read the resolved filter text in Bitbucket's webhook request log. Check the header variable name (`x_event_key`), that listed uuids are written without braces and exactly as the payload shows them, and that access-token bots are covered by the `app_user` branch. |
| A git-flow repository reviews PRs into `main` | An empty `SKIP_TARGET_BRANCHES` or `--skip-target-branches=` reaches every repository, e.g. as a job-wide parameter. |
| A trunk repository skips its PRs into `main` | The bundle probe found no branch flags (`Bundle has no branch flags yet`), so the git-flow defaults applied; or the project is missing from `byProject`. |
| Builds pile up | Every event waits for the per-PR lock, and each waiting build holds its pod. |

## Known limitations and unverified items

**Limitations**

- **Retarget with the same head.** When the last posted review's footer names the head, a retarget
  without a push ends as `DEDUP_SKIP` instead of a review against the new target. A stored checked
  commit extends this to runs that posted nothing, unless the retarget hardening is in place. The
  hardening cannot help the footer case; use a manual `--force` run.
- **Deleted review.** Once a head is stored, deleting the agent's latest review no longer brings a
  re-review at that head: the older footer misses, but the stored value matches. Use `--force`.
- **Bounded build walk.** With the build-variable store, a value more than N builds of the job back,
  or on a build that retention has removed, is not found; the PR gets one extra review.
- **Bundle from `main`.** The reference pipeline downloads the bundle from `main` on every build, so a
  merge to `main` deploys. Pin a tag in the download URL to control rollout (README, "Versioning &
  Releases").

**Unverified**

- Whether Bitbucket Cloud sends `pullrequest:updated` when it retargets a stacked PR automatically,
  after the PR's destination branch is deleted on merge. If it does not, a PR skipped by
  `ONLY_TARGET_BRANCHES` stays unreviewed until its next push or human comment; with bot comments
  filtered, a quiet PR can reach `main` unreviewed.
- That `buildVariables` of an earlier build already shows the values it set inside the lock while
  that build is still running its `post` section. The build-variable store relies on it; a run
  deduplicated by the stored value has not yet been observed on the reference job.
- That every app user, including workspace and project access tokens, reports `actor.type`
  `app_user`. It has been observed for repository access tokens.
- Whether the 30-second quiet period merges webhook calls with different payloads into one build.
- The 40-character limit on status keys and the `write:repository:bitbucket` scope for posting
  statuses come from the reference pipeline's notes, not from Atlassian's documentation.
