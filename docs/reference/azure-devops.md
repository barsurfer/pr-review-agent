# Azure DevOps Integration (experimental / WIP)

Covers the Azure DevOps adapter and its CI wiring. For adapter internals (interface, diff
reconstruction, thread model, auth precedence) see Knowhere
[`docs/context/vcs/adapter.md`](../context/vcs/adapter.md); for the env vars see
[`env-vars.md`](env-vars.md); for a setup quickstart see the README's "Azure DevOps" section.

## Status (verified live)

The **created + updated** paths are validated end-to-end against a cloud Azure DevOps Services
org: a PR push queues build validation, the agent authenticates with the zero-PAT
`System.AccessToken`, posts the review as the *Build Service* identity, and re-queues on every
new commit (delta reviews). The **reply-to-comments** flow is also validated live (WIP — see
below). Still WIP: on-prem **Server**.

The shared settings file, `checkout: none`, run linkage, trigger env and the checked-commit
recipe have **not** been run on a live pipeline yet; see [Unverified](#unverified).

## Runner choice: native vs Jenkins-triggered

The adapter is **runner-agnostic** — it does all Azure REST work (fetch diff, post comments) through the API regardless of where the agent process runs, so this is a trigger/host choice, not a VCS one.
- **Native Azure Pipelines (default):** what this doc wires — zero-PAT (`System.AccessToken`), fewest hops, validated on cloud.
- **Azure → Jenkins job:** only when CI is standardized on Jenkins. Azure Service Hooks (PR create/update for reviews, commented for replies) trigger a Jenkins job running the same `--vcs azure --repo-slug … --pr-id …`, with `AZURE_ACCESS_TOKEN`/`AZURE_PAT` in Jenkins credentials (you lose the zero-PAT OAuth). No agent change — migrating later is just re-pointing the trigger.

## CI integration (Azure Pipelines)

Three files, kept in **one folder** of the reviewed repo:

| File | Role |
|---|---|
| [`azure/azure-pipelines.yml`](../../azure/azure-pipelines.yml) | Reviews: build validation on PR create/update |
| [`azure/azure-reply-pipeline.yml`](../../azure/azure-reply-pipeline.yml) | Replies: Service Hook on PR comments (see [Reply flow](#reply-flow--set-up--test-validated-live-wip)) |
| [`azure/pr-review-settings.yml`](../../azure/pr-review-settings.yml) | Shared variables template: `AGENT_TAG`, branch policy, ignore list. Both pipelines include it |

Wire `azure-pipelines.yml` as a **Branch Policy → Build Validation** on the target branch (the
YAML `pr:` trigger does not fire for Azure Repos). Set it **Optional** so a WIP failure never
blocks a merge. Auth is zero-PAT via `System.AccessToken`; grant the **{Project} Build Service
({Org})** identity **Contribute to pull requests**, and add `ANTHROPIC_API_KEY` as a secret
pipeline variable. Full step-by-step is in the README's "CI integration" subsection.

What the sample steps do, and why:
- **`checkout: none`.** The agent needs nothing from the working directory: the prompts are
  embedded in the bundle and the repo prompt (`.agent-review-instructions.md`) is read through the
  REST API. With the implicit `checkout: self` the bundle lands inside the reviewed repo, so the
  footer's `Build:` and the record's `agent_commit` show the reviewed repo's merge commit plus
  `-dirty` (the agent runs `git rev-parse` in its own directory), and `dotenv` loads a `.env`
  committed to the reviewed repo into the agent's settings. It also saves the clone.
- **`rm -f results.jsonl`** before the run: on a self-hosted agent the directory can be reused,
  and a run that dies before writing would leave an older run's record last.
- **Run linkage:** see [Run linkage and this run's record](#run-linkage-and-this-runs-record).

### First-setup gotchas
- **`AGENT_TAG`** lives in `pr-review-settings.yml` and is pinned to `v0.0.47`, which has every fix
  in [Agent version](#agent-version). The pipeline downloads the bundle from that tag, so a pin to a
  tag that does not exist fails every run. Pin an immutable release tag. Sanity-check a ref with
  `curl …/<ref>/dist/pr-review-agent.cjs | grep -c AzureDevOpsAdapter` (must be > 0).
- **YAML location** — build validation resolves the pipeline YAML **and** the settings template
  from the PR's *source branch*, so that branch must contain both (merge the target in if the
  branch predates them).
- **Branch names are case-sensitive.** `main` does not match `Main` (common in TFS-migrated
  repos); spell the patterns in the branch's exact case.

### Agent version

The bundle is downloaded at `AGENT_TAG`. Minimum version for what this doc uses (v0.0.46 was never
published as a tag, so v0.0.47 is the first published version with its changes):

| Feature | Minimum |
|---|---|
| Azure adapter | v0.0.4 |
| Run linkage from `JOB_NAME` / `BUILD_NUMBER` / `BUILD_URL` (record `jenkins`, footer build link) | v0.0.4 |
| Deleted Azure comments ignored | v0.0.34 |
| `ONLY_TARGET_BRANCHES`, `TRIGGER_EVENT` / `TRIGGER_COMMENT_AUTHOR` / `IGNORE_COMMENT_AUTHORS`, `LAST_CHECKED_COMMIT` + `checked_commit` | v0.0.43 |
| Delta after a rebase / force-push (old head found in the PR's iterations); a blob 404 fails the delta instead of dropping the file; a PR without `lastMergeSourceCommit` fails the run instead of posting a footer with an empty commit | v0.0.47 |
| `TRIGGER_EVENT_KIND`, `USAGE_RECORD_FILE`; `checked_commit` only for a 12–64 hex head | v0.0.47 |

The samples pass every setting as an **env var**, never a flag: an older bundle ignores an
unknown env var (for example v0.0.42 ignores `ONLY_TARGET_BRANCHES` and reviews every PR), but
exits 1 on an unknown flag, which `continueOnError: true` turns into a quiet "succeeded with
issues" and no review.

### Branch policy (both pipelines)

The branch lists are pipeline variables in `pr-review-settings.yml`, named exactly like the
agent's env vars (`ONLY_TARGET_BRANCHES` / `SKIP_TARGET_BRANCHES` / `SKIP_SOURCE_BRANCHES`).
Azure exports non-secret pipeline variables to every script step's environment, so both pipelines
get the same lists without mapping them in `env:`. They must agree because the comment Service Hook
fires for **every PR in the repo**, and a comment on a PR that has no review yet gets a **first
review**. With different lists, a comment reviews PRs build validation skips: a release PR into
`main`, or a stacked PR into a feature branch (which, once reviewed at a head, is a `DEDUP_SKIP`
after it is retargeted at that head, so the review against the real target never happens).

- **Shipped (active): the agent defaults.** The template defines none of the three, so the agent
  skips PRs into `main` / `master` and from `main`, `master`, `release/*`, `hotfix/*`, and
  `ONLY_TARGET_BRANCHES` is off. If your build-validation policy sits on `main`, every run is a
  `SKIP` until you switch to the trunk alternative. With the defaults the reply pipeline can also
  first-review a PR into a branch that has no build-validation policy (a stacked PR); add
  `ONLY_TARGET_BRANCHES` listing exactly the policy branches (git-flow: `develop,release/*`) to
  keep it inside the same scope.
- **Trunk alternative (commented in the template):** `ONLY_TARGET_BRANCHES: main`,
  `SKIP_TARGET_BRANCHES: ''`, `SKIP_SOURCE_BRANCHES: main,master`. Uncomment all three, with
  `ONLY_TARGET_BRANCHES` listing exactly the branches that carry the build-validation policy.
  Precedence and recipes: [skip-logic §3](../context/review/skip-logic.md).
- **Unset vs empty:** a list that is not defined keeps the agent default; a defined `''` turns that
  list **off**. To return to a default, delete the entry, never empty it.
- Do not also map a branch list in a step's `env:`: it overrides the template in that pipeline only.
  Variables of the same name set in the pipeline UI or a variable group apply when the template
  defines none, and a template definition overrides them.
- Build validation reads the settings from the PR's source branch, the reply pipeline from the
  default branch. After a policy change the two can disagree on an open PR until its source
  branch contains the change.
- Optionally also filter the Service Hook by target branch, if "Pull request commented on"
  offers that filter (unverified).

### Pipeline variables: the `$(var)` trap

Azure replaces `$(name)` in an `env:` value only when the variable exists; otherwise the agent
receives the literal text `$(name)`:

| Env var receiving a literal `$(x)` | Effect |
|---|---|
| `SKIP_TARGET_BRANCHES` / `SKIP_SOURCE_BRANCHES` | A one-entry list that matches nothing: the `main,master` default is silently off and PRs into `main` are reviewed |
| `ONLY_TARGET_BRANCHES` | Every PR is skipped (visible in `skip_reason`) |
| `LAST_CHECKED_COMMIT` | One warning, treated as unset |
| `TRIGGER_*` / `IGNORE_COMMENT_AUTHORS` | Never matches, so the ignore list is inactive |

Inside a bash script body an unresolved `$(x)` is command substitution instead: empty, plus
"command not found" on stderr. `--force="$(FORCE)"` is then off, but an unquoted `--force $(FORCE)`
collapses to a bare `--force` = re-review on every event.

How the samples avoid it:
- Branch lists are not mapped at all: they reach the agent as exported pipeline variables
  ([Branch policy](#branch-policy-both-pipelines)), so a missing one is unset, never a literal.
- The ignore list uses **compile-time** `${{ variables.x }}` from the settings template. A missing
  entry compiles to `''` (list off), never to a literal. This only sees variables defined in YAML,
  not UI, queue-time or variable-group variables.
- Webhook payload values use `${{ parameters.prComment.* }}` (compile-time as well).
- `$(…)` macros are used only for predefined variables (`System.*`, `Build.*`), which always
  exist, and for `ANTHROPIC_API_KEY` (a missing secret fails the run loudly).
- Compute `LAST_CHECKED_COMMIT` as a shell variable in the same script step that runs node (see
  [Checked commit](#checked-commit-on-azure-optional)), not as a pipeline variable.

### Run linkage and this run's record

The agent reads its CI run from the Jenkins names `JOB_NAME` / `BUILD_NUMBER` / `BUILD_URL`,
which Azure does not set. Both samples map them in the step `env:`:

| Agent env | Azure source |
|---|---|
| `JOB_NAME` | `$(Build.DefinitionName)` |
| `BUILD_NUMBER` | `$(Build.BuildId)` (unique; `Build.BuildNumber` is the run name and is not) |
| `BUILD_URL` | `$(System.CollectionUri)$(System.TeamProjectId)/_build/results?buildId=$(Build.BuildId)` |

The record's `jenkins` field is then `{ job, build, url }` instead of `null`, and the footer's
`Review #N` / `Reply by` link to the run (dedup accepts the linked footer). `TeamProjectId` is
the project GUID, so a project name with spaces cannot end up inside the markdown link.

This build's record is then found with the recipe in
[usage-logging.md](usage-logging.md#telling-skipped-from-reviewed-in-ci), unchanged, from inside
the same script step (the mapped names are step env vars there):

```sh
RECORD=$(jq -c --arg job "$JOB_NAME" --arg build "$BUILD_NUMBER" 'select(.jenkins.job == $job and .jenkins.build == $build)' results.jsonl | tail -n 1)
```

From v0.0.47 there is also `USAGE_RECORD_FILE`: set it in the step `env:` to a path, `rm -f` it
before the run, and read that file, which holds only this run's record
([usage-logging.md](usage-logging.md#finding-this-runs-record)). The samples do not set it,
because the feature is optional.

The record's head is `source_commit` = the PR's `lastMergeSourceCommit` (the source branch head),
which matches the pipeline variable `System.PullRequest.SourceCommitId`. Never compare it with
`Build.SourceVersion`: build validation builds the PR **merge** commit.

### Repo-specific prompt in CI
`--prompt` takes a *local* path and the pipeline only downloads the agent bundle (not the
`prompts/` dir), so it can't be used in CI. Instead commit a `.agent-review-instructions.md`
(same `## ROLE / ## REVIEW PRIORITIES / …` format as the `prompts/*.txt` templates) to the
reviewed repo — the agent auto-loads it through the API (`prompt_source: repo`) and the pipeline
stays generic across repos.

## Checked commit on Azure (optional)

The review footer only moves when a review is posted. After a run that checked the head without
posting (`NO_NEW_FINDINGS`, a structured `NO_CHANGE`, a quiet reply), every later event on that
head re-pays the delta review — on Azure that is every comment and every build-validation
re-queue. The agent reports the head it genuinely checked as `checked_commit`; CI stores it per
PR and passes it back as `LAST_CHECKED_COMMIT` (needs `AGENT_TAG` ≥ v0.0.43). Contract:
[skip-logic §8](../context/review/skip-logic.md); the samples do **not** wire it.

- **Key:** `vcs` + `workspace` (`AZURE_ORG`) + `repo_slug` + `pr_id` from the record. Pass
  `--repo-slug` in the same form (name or GUID) in both pipelines, or the keys differ.
- **Store (recommended): PR properties.** Per-PR by construction, reachable from both pipelines
  with `System.AccessToken`, survives runs, no extra infrastructure. Any PR contributor can
  overwrite it, which adds no power beyond editing the pipeline YAML on the source branch.
  **Unverified:** the response shape (`.value["<key>"]["$value"]`), the JSON Patch content type,
  and the permission the Build Service needs (expected: Contribute to pull requests).
- **Alternatives:** build tags (`##vso[build.addbuildtag]`, read back with a `tagFilters` query)
  lose values when retention deletes the build (fails open). Not suitable: the Cache task
  (immutable per key), pipeline or variable-group variables via REST (they mutate shared
  definitions), previous-run artifacts (no cheap lookup by PR across the two pipelines).
- **Read and store in the same script step as node,** in both pipelines: read before, fail open,
  and pass the value only when its stored target equals the PR's current target (retarget
  hardening, contract item 6), taken from the PR API rather than the webhook payload. Store
  after, from this build's record, only when it carries `checked_commit`; ignore `action` and the
  exit code.
- **Lock: not needed for correctness.** An older run finishing last is harmless (contract item 5),
  and a read that misses a concurrent write costs at most one extra review.
- **Force-push.** Before v0.0.47 a rebase or force-push made every later Azure delta fail (the
  footer's abbreviated hash could only be expanded from commits still reachable from the head),
  and a run with a failed delta never reports `checked_commit`, so the feature stayed off until a
  review posted. From v0.0.47 the adapter also looks the hash up in the PR's iterations. If Azure
  still refuses to diff that commit (unverified), the run falls back to the full diff and
  withholds `checked_commit`, as before.
- **Rebase limit (from v0.0.47).** The delta from an iteration head is two-dot (old head → new
  head), so it shows what the developer changed, not how the PR diff changed. After a rebase onto a
  moved target it can be empty while the PR diff did change: if the target deleted a line and the
  rebase kept it, the new head's tree equals the reviewed one, so the run ends as `DEDUP_SKIP` and
  reports `checked_commit`, although the PR diff now adds that line. Merging the target into the
  source branch can hide such a line the same way on every provider. `--force` re-reviews such a
  head.

Illustrative, **untested** replacement for the `node agent.cjs …` line of the reply pipeline
(needs `jq`, preinstalled on Microsoft-hosted Ubuntu images). In build validation use
`$(System.PullRequest.PullRequestId)` / `$(Build.Repository.Name)` for `PR_ID` / `REPO_NAME`. A
repo name with spaces must be URL-encoded in `API` (or use the repo GUID there).

```sh
API="${SYSTEM_COLLECTIONURI}${SYSTEM_TEAMPROJECTID}/_apis/git/repositories/$REPO_NAME/pullRequests/$PR_ID"
AUTH="Authorization: Bearer $AZURE_ACCESS_TOKEN"

# read: fail open; only a value stored for the PR's current target counts
PR_TARGET=$(curl -fsS -H "$AUTH" "$API?api-version=7.1" | jq -r '.targetRefName // empty' | sed 's#^refs/heads/##' || true)
PROPS=$(curl -fsS -H "$AUTH" "$API/properties?api-version=7.1" || true)
STORED_TARGET=$(printf '%s' "$PROPS" | jq -r '.value["PrReviewAgent.CheckedTarget"]["$value"] // empty' 2>/dev/null || true)
LAST_CHECKED_COMMIT=""
if [ -n "$PR_TARGET" ] && [ "$STORED_TARGET" = "$PR_TARGET" ]; then
  LAST_CHECKED_COMMIT=$(printf '%s' "$PROPS" | jq -r '.value["PrReviewAgent.CheckedCommit"]["$value"] // empty' 2>/dev/null || true)
fi
export LAST_CHECKED_COMMIT

rc=0
node agent.cjs --vcs azure --repo-slug "$REPO_NAME" --pr-id "$PR_ID" || rc=$?

# store: this build's record for this PR, only when it carries checked_commit
RECORD=$(jq -cR --arg job "$JOB_NAME" --arg build "$BUILD_NUMBER" --arg pr "$PR_ID" \
    'fromjson? | select(.jenkins != null and .jenkins.job == $job and .jenkins.build == $build
                        and .vcs == "azure" and .pr_id == $pr and (.checked_commit // "") != "")' \
    results.jsonl 2>/dev/null | tail -n 1 || true)
if [ -n "$RECORD" ]; then
  printf '%s' "$RECORD" \
    | jq -c '[{op: "add", path: "/PrReviewAgent.CheckedCommit", value: .checked_commit},
              {op: "add", path: "/PrReviewAgent.CheckedTarget", value: .target_branch}]' \
    | curl -fsS -X PATCH -H "$AUTH" -H 'Content-Type: application/json-patch+json' \
        --data-binary @- "$API/properties?api-version=7.1" >/dev/null \
    || echo "checked-commit store failed (ignored)"
fi
exit "$rc"
```

## Reply flow — set up & test (validated live, WIP)

Build validation fires on PR **create/update** but **not on comments**, so the reply-to-developer
flow needs a second trigger. Validated end-to-end on a cloud Services test org: a comment fires a
Service Hook → an Incoming Webhook → a reply pipeline that runs the agent. No agent code change —
the FSM already decides review-vs-reply and exits without a model call when there's nothing to
answer.

```
PR comment ─▶ Service Hook (ms.vss-code.git-pullrequest-comment-event)
           ─▶ Incoming Webhook service connection
           ─▶ reply pipeline ─▶ node agent.cjs --vcs azure --pr-id <id> --repo-slug <name>
```

Prereqs: the review pipeline (above) already wired, `ANTHROPIC_API_KEY` secret available, and
`AGENT_TAG` in `pr-review-settings.yml` at a release that has what you use ([Agent version](#agent-version);
≥ v0.0.43 for the trigger env and the shared branch policy).

### Setup (one-time)

1. **Ship the reply pipeline YAML.** Put [`azure/azure-reply-pipeline.yml`](../../azure/azure-reply-pipeline.yml)
   and [`azure/pr-review-settings.yml`](../../azure/pr-review-settings.yml) on the repo's
   **default branch** — Service Hooks resolve the pipeline's default-branch YAML (unlike build
   validation, which uses the PR *source* branch).
2. **Incoming Webhook service connection.** Project Settings → **Service connections → New → Incoming WebHook**.
   - **Webhook Name** and **Service connection name**: e.g. `pr-comment` (hyphens fine here).
   - **Secret: leave blank.** Validated — the generic Web Hooks sender can't compute an HMAC, and a
     blank secret works (the POST fires the pipeline with no signature check). Fine for a test repo;
     front it with a signing relay before a repo that matters.
3. **Register the pipeline + secret.** Pipelines → **New pipeline → Azure Repos Git → {repo} →
   Existing YAML** → `/azure-reply-pipeline.yml` → **Save** (don't run). Then **Edit → Variables →
   New** → `ANTHROPIC_API_KEY` (mark secret). The Build Service already has "Contribute to pull
   requests" from the review pipeline, so it can post.
4. **Comment Service Hook (the trigger).** Project Settings → **Service Hooks → + → Web Hooks** →
   trigger **Pull request commented on** (`ms.vss-code.git-pullrequest-comment-event`) → filter to
   the repo → **Action URL**:
   ```
   https://dev.azure.com/{ORG}/_apis/public/distributedtask/webhooks/pr-comment?api-version=6.0-preview
   ```
   (`pr-comment` = the Webhook Name from step 2.) **Resource details to send: All** → Finish. No
   HTTP header needed while the secret is blank.

### Test

Comment **inside the agent's review thread** (a reply under its review) with a question — e.g.
*"why is the N+1 a problem here?"* → the reply pipeline fires → the agent posts an answer in that
thread. A **top-level** comment triggers the run too; on a PR already reviewed at its head it
posts nothing when there's nothing unanswered, but on an in-policy PR with no review yet it
posts a first review.
Check the run log prints `reply trigger: PR_ID='…' REPO_NAME='…' COMMENT_AUTHOR='…'` (populated),
and `results.jsonl` shows `vcs: azure` with reply-path usage and a `trigger` field.

### Skip the agent's own comments (`IGNORE_COMMENT_AUTHORS`)

Every comment fires a run, including the agent's own review and reply posts. Such a run costs
no model tokens, but the agent reconstructs the whole PR diff before it can tell there is
nothing to do: a few PR and change-list calls plus up to two blob GETs per changed file, so about 200
REST calls on a 100-file PR, against the Build Service identity's rate limit (thresholds unverified).

The reply pipeline passes `TRIGGER_EVENT` (a literal `ms.vss-code.git-pullrequest-comment-event`,
because only that hook fires it) and `TRIGGER_COMMENT_AUTHOR` (the payload's
`resource.comment.author.id`, a GUID; never `displayName`, which is mutable and may contain
commas). A comment whose author is listed in `IGNORE_COMMENT_AUTHORS` then exits before any
Azure call ([skip-logic §7](../context/review/skip-logic.md)). The event name already counts as a
comment event by name, so `TRIGGER_EVENT_KIND` (v0.0.47+) is not needed; `comment` would be safe
here because this pipeline only receives comment events, but never set it in build validation.

1. Find the agent's GUID: leave `prReviewIgnoreCommentAuthors` empty, let a review post, and
   read `trigger.comment_author` from the record of the reply-pipeline run that the review's own
   comment fired.
2. Put it in `prReviewIgnoreCommentAuthors`. It is the **{Project} Build Service ({Org})**
   identity, or **Project Collection Build Service ({Org})** when the job authorization scope is
   the collection. If the agent posts with a PAT, use that account's GUID, and do not list it
   if a human also comments with that account.

**Caveat:** an ignored event never catches up a push the CI dropped (skip-logic §7). That is
safe on stock Azure: build validation queues a run for every push, so nothing depends on a
comment run to catch up. It stops being safe under a lock that cancels waiting runs (see the
lock bullet below).

A pipeline `condition` on the author would skip the job itself (no bundle download, no record);
the env route keeps a `SKIP` record per run.

### Gotchas (all found + fixed live)

- **Read payload values as `$VAR`, not `$(VAR)`.** `PR_ID`/`REPO_NAME` arrive as step **env vars**
  (mapped from the payload via `${{ parameters.prComment.* }}`); in bash that's `$PR_ID` /
  `$REPO_NAME`. `$(PR_ID)` is Azure's *pipeline-variable* macro — it doesn't resolve step env vars
  and fails **silently** (empty → "--pr-id is required").
- **Branch policy comes from `pr-review-settings.yml`**, as in the review pipeline. Do not map a
  branch env var in one pipeline only: the old `SKIP_TARGET_BRANCHES: ''` here made comments
  review PRs into `main` that build validation skipped.
- **The `webhook:` alias must be hyphen-free** (`prComment`) — it's used as
  `${{ parameters.<alias>.* }}` and a hyphen parses as *minus* in Azure expressions. Hyphens are
  fine in `connection:`, the service-connection name, and the URL.
- **`System.PullRequest.*` isn't set** on webhook runs — the PR id comes from the payload
  (`resource.pullRequest.pullRequestId`), which is why the env-var mapping exists.

### Verify the payload (only if a path ever differs)

Point the Service Hook at a request bin (`webhook.site`) or a self-hosted receiver behind
`cloudflared tunnel --protocol http2 --url http://localhost:<port>` (use **http2** — the default
QUIC was flaky and its `trycloudflare.com` DNS failed from Azure), post a comment, and read the
JSON. Confirmed present: `resource.pullRequest.pullRequestId`, `resource.pullRequest.repository.name`,
`resource.comment.author.displayName`, `resource.comment.author.id`, `resource.comment.content`.

### Behavior & limits

- **Review-vs-reply priority:** the FSM handles new commits before answering comments. If the PR
  has commits newer than the last review, a comment triggers a delta **review** of the new code,
  not a reply. A **reply** posts only when the current commit is already reviewed (no new commits)
  and there's an unanswered human question in a review thread.
- **Throttling: none native** — every comment fires one pipeline run (no debounce). A run with
  nothing to do costs CI minutes and the diff reconstruction's REST calls, not model tokens.
  Skip the agent's own comment events with `IGNORE_COMMENT_AUTHORS` (above); the free tier's
  single parallel job queues runs naturally; an external relay (Azure Function/Logic App) can
  rate-limit.
- **Locks: none needed for correctness.** Azure has no per-PR lock; an exclusive lock on an
  Environment or other resource serializes **all** PRs (and both pipelines, if they share the
  resource). If you add one to save cost, set `lockBehavior: sequential`: the default
  `runLatest` cancels waiting runs (per Microsoft's docs; unverified live), which drops events
  and makes `IGNORE_COMMENT_AUTHORS` unsafe.
- **Resolved:** hybrid kept (build-validation for reviews + webhook for replies, not unified);
  agent-authored comments self-fire a run that posts nothing (footer/timestamp dedup → **no
  loop**); `/azp run` comment-commands are **GitHub-only**, not usable for Azure Repos.

## Unverified

Nothing below has been run against a live Azure org:

1. The new sample YAML as a whole: the `variables: - template:` include, compile-time
   `${{ variables.x }}` in step `env:`, template variables exported to the script's environment,
   `checkout: none` with `Build.Repository.Name` / `System.PullRequest.PullRequestId` still set,
   and `PublishPipelineArtifact` finding `results.jsonl` in the default working directory. YAML
   syntax was checked with a parser only.
2. That a pipeline variable defined as `''` (the trunk alternative's `SKIP_TARGET_BRANCHES`)
   reaches the agent as an empty env var, like the literal step-`env:` `''` that was validated on
   a Linux hosted agent, rather than not at all, and on every agent OS. If it does not arrive, the
   `main,master` default stays on and PRs into `main` are skipped (visible in `skip_reason`, with a
   warning that the target is in both lists); map `SKIP_TARGET_BRANCHES: ''` in the step `env:` of
   **both** pipelines instead.
3. That `$(System.CollectionUri)$(System.TeamProjectId)/_build/results?buildId=…` opens the run
   (project GUID in the URL).
4. That the agent's comment author id in the payload is the Build Service GUID, and which
   Build Service identity posts under each job authorization scope.
5. The payload's top-level `eventType` (not used: the sample passes the event as a literal).
6. PR properties: response shape, JSON Patch content type, the permission the Build Service
   needs; the build-tag read query. The checked-commit script has never run.
7. Whether `diffs/commits` and the Items API accept a commit that is no longer reachable from any
   branch but is still listed in a PR iteration (the force-push fix). If not, the delta still
   fails and the run falls back to the full diff, as before.
8. Microsoft's default `lockBehavior` (`runLatest`) for exclusive-lock checks.
9. Whether "Pull request commented on" also fires on comment edits, deletions, reactions or
   thread status changes, and whether its Service Hook can filter by target branch.
10. Whether the Items API returns 404 for a symlink or other special blob listed in
    `diffs/commits`. If it does, every delta touching one now fails and falls back to a paid full
    review, repeated on every event (each build-validation re-queue, each comment) until a review
    posts and moves the footer; no review is missed.
11. That an active PR always carries `lastMergeSourceCommit`. Microsoft's sample response for
    creating a PR already has it (and `lastMergeTargetCommit`) with `mergeStatus: queued`, i.e.
    before the merge is computed. If a PR lacks it, the run fails with `ERROR` and is retried on the
    next event; the PR diff reads both fields, so it could not be built without them anyway.
