# GitHub Actions Integration (experimental)

Covers [`.github/workflows/pr-review.yml`](../../.github/workflows/pr-review.yml), the workflow that
runs the agent on this repository's pull requests, and what a repository adopting it should add.
For the adapter (REST mapping, flat reply model, large-diff fallback) see Knowhere
[`docs/context/vcs/adapter.md`](../context/vcs/adapter.md); for the agent's skip rules see
[`docs/context/review/skip-logic.md`](../context/review/skip-logic.md) (§3 branch lists, §7 trigger
check, §8 checked commit); for record fields see [`usage-logging.md`](usage-logging.md); for the
Jenkins equivalent of each topic see [`jenkins.md`](jenkins.md).

Snippets are labelled **shipped** (the workflow file in this repository) or **illustrative, untested**
(shows intent, never run). Statements about GitHub that have not been confirmed are listed under
[Unverified](#unverified).

## Status

- **Verified live (before 0.0.43):** the `pull_request` path. Reviews are posted as
  `github-actions[bot]`, footer dedup finds them, and the delta compare accepts the footer's
  12-character commit.
- **Never run live:** the `issue_comment` (reply) path.
- **Not yet run live:** the guards, job-level concurrency and `edited` filter described below. The
  shipped file is parsed and schema-checked, and its same-repo check was exercised against a stubbed
  `gh`.

## How a run works

```
PR event ─▶ job `if:` (false → job skipped: no runner, no concurrency group)
         ─▶ job-level concurrency group pr-review-<PR number>: one running, one pending
         ─▶ same-repo check (comment events only; ends the job cleanly on a fork PR)
         ─▶ checkout, npm ci, npm run bundle ─▶ agent ─▶ review or reply as an issue comment
```

The agent decides from the PR's current state, not from the event: a comment on a PR with
unreviewed commits produces a delta review, and a push on an already reviewed head ends as
`DEDUP_SKIP` without a model call.

| Event | Runs when | Why |
|---|---|---|
| `pull_request` `opened` / `synchronize` / `reopened` | Head branch is in this repository, the PR author is not `dependabot[bot]` and the PR author's `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR` | Fork PR runs get a read-only token and no Actions secrets, so the agent would fail at startup with a red check; any account with read access can open a PR between two existing branches; Dependabot PRs are never reviewed (below) |
| `pull_request` `edited` | As above, and the base branch changed (`github.event.changes.base` present) | Delivers retargets; title and body edits never start a runner |
| `issue_comment` `created` | On a PR, the PR is open and not opened by `dependabot[bot]`, the commenter is not a `Bot` account and their `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`; then the API confirms the head is in this repository | Anyone can comment on a public repository's PRs; without these checks any account could start paid runs, including on closed or fork PRs |

- **PR-author check on `pull_request`.** GitHub's "Creating a pull request" page says anyone with
  read access can open a PR, so a same-repo head does not imply a trusted author: on a public
  repository any account could open a PR between two existing branches and start a paid run with
  its own title and description in the prompt. The job therefore also requires the PR author's
  `author_association` (`github.event.pull_request.author_association`, set by GitHub) to be
  `OWNER`, `MEMBER` or `COLLABORATOR`. The association is the PR author's, not the pusher's, so a
  trusted person pushing to such a PR does not start a review either. **PRs opened by Apps or bots
  (Renovate, other workflows) or by non-collaborators are not reviewed until a trusted person
  comments** on them; that comment run reviews the PR as usual.
- **Same-repo check for comments.** The `issue_comment` payload has no head repository, so a step
  reads `GET /repos/{repo}/pulls/{n}` with the job token, before checkout and before the LLM key
  reaches any step. It fails
  closed: a fork head, a deleted fork or a failed lookup sets no output and every later step is
  skipped, leaving a notice in the log and a green job.
- **Private organisation membership.** Reports say a member whose organisation membership is
  private can appear as `CONTRIBUTOR` in event payloads. That fails closed (their comment or PR
  starts no run). Make the membership public, add the person as a collaborator, or replace the
  check with a `GET /repos/{repo}/collaborators/{login}/permission` step.
- **The agent's own comments** start no run: a comment posted with `GITHUB_TOKEN` creates no
  workflow run (GitHub's rule for `GITHUB_TOKEN` events; only `workflow_dispatch` and
  `repository_dispatch` are exempt). The `Bot` filter additionally covers an agent posting through a
  GitHub App token. With a PAT the agent posts as a `User`; if that user is a collaborator its
  comments start a run, which is a `DEDUP_SKIP` when the footer names the head and otherwise re-pays
  a delta review (a stored checked commit prevents that).
- **Dependabot PRs are never reviewed.** Both paths test the PR author, not the actor
  (`github.event.pull_request.user.login`, and `github.event.issue.user.login` on comments). A run
  triggered by Dependabot itself gets no Actions secrets, but a human who pushes to or retargets a
  Dependabot PR is the actor: keyed on the actor, that run would get the LLM key and `npm ci` the
  Dependabot branch, running the new dependency versions' install scripts and bundling their code
  into the agent. Comments are excluded too: maintainers drive Dependabot with `@dependabot …`
  comments, and each would start a paid run that answers the command as a developer reply. (A
  comment run checks out the default branch, not the PR, so it never installs the PR's
  dependencies.) The actor is no longer checked, so a Dependabot push to a PR a trusted person
  opened from a `dependabot/*` branch runs without secrets and fails with a red check.

## Concurrency

Shipped:

```yaml
jobs:
  review:
    if: …
    concurrency:
      group: pr-review-${{ github.event.pull_request.number || github.event.issue.number }}
      cancel-in-progress: false
```

- **Why job-level.** Workflow-level `concurrency` is applied when the run is created, before any job
  `if:` is evaluated. A run whose only job will be skipped (a bot comment, a title edit) still joins
  the PR's group, and with `cancel-in-progress: true` it cancels the review in flight, then does
  nothing. A job skipped by `if:` never starts, so it never joins a job-level group. Both are
  reported GitHub behaviour, not yet observed here (see [Unverified](#unverified)).
- **Why no cancellation.** A cancelled run may already have paid for model calls, writes no
  `results.jsonl` record (the spend is invisible), and can be killed while posting or storing state.
  Pushes in quick succession coalesce in the pending slot instead: the pending run reviews the PR's
  current head. A later run on that head deduplicates on the footer when a review was posted; after
  a no-post ending it re-pays the delta review unless the checked commit is stored.
- **The pending slot.** With the default `queue: single`, a group holds one running and one pending
  run, and a newer run cancels and replaces the pending one. That is harmless when the newer run
  reviews, because every run reads the PR's current state. The only in-job early exit is the
  same-repo check, which on a same-repo PR stops a run only when the API lookup fails; if that run
  had replaced a pending push run, the new head waits for the next event. `queue: max`, or moving the
  check into a separate job that the review job `needs`, removes that case (a separate job adds a
  runner start per event, billed per job on private repositories).
- **`queue: max`.** Since 2026-05-07 GitHub.com accepts `queue: max` (up to 100 pending runs, roughly
  FIFO, not combinable with `cancel-in-progress: true`). The shipped workflow does not use it: it is
  not needed while all filtering happens in `if:`, it has not been run here, and the workflow schema
  used for local validation rejects the key (actionlint 1.7.12 reportedly does too). Use it if you
  add in-job early exits that should not displace a pending run.
- **Store inside the group.** Any checked-commit store step must run in the same job after the
  agent, so it happens before the next run of the PR starts. A separate job would recreate the
  Jenkins `post`-after-lock trap ([jenkins.md](jenkins.md#the-store-must-happen-inside-the-lock)).

## Filtering commenters: use the job `if:`, not `IGNORE_COMMENT_AUTHORS`

The agent-side list (skip-logic §7) is a poor fit on GitHub:

- The skip happens after a runner, checkout, `npm ci` and the bundle build, and after the run has
  joined the PR's group. Under the default `queue: single` it can replace a pending push run and then
  exit without looking at the PR, leaving the new head unreviewed until the next event (the
  dropped-push caveat in skip-logic §7).
- The flat reply model reads comments, not triggers: the next run still answers a listed `User`
  account's comments. Comments from `Bot` accounts are never treated as replies by the adapter
  (from 0.0.46).

Filter in the job `if:` instead. It costs no runner and never joins the group. Illustrative, untested
(a repository variable holding a JSON array of logins; `contains` compares case-insensitively):

```yaml
    if: >-
      … (github.event_name == 'issue_comment'
      && …
      && !contains(fromJSON(vars.IGNORED_COMMENTERS || '[]'), github.event.comment.user.login))
```

`TRIGGER_EVENT: ${{ github.event_name }}` and `TRIGGER_COMMENT_AUTHOR: ${{ github.event.sender.login }}`
are safe to pass for logging (the record's `trigger` field) as long as the list is unset; the
shipped workflow passes neither. Pass `github.event_name`, not `github.event.action` alone. From
0.0.46 `pull_request_review` counts as a comment event by name; `pull_request_review_thread` does
not, and `TRIGGER_EVENT_KIND` (`comment` / `other`, 0.0.46+) overrides the name rule per event.
Never set `TRIGGER_EVENT_KIND: comment` job-wide in a workflow that also runs on `pull_request`
(skip-logic §7). The shipped workflow subscribes to none of the `pull_request_review*` events.

## Finding this run's record

On Actions the record's `jenkins` field is null, so the Jenkins recipes in
[`usage-logging.md`](usage-logging.md) that match `jenkins.job` / `jenkins.build` find nothing. Within
one repository, `vcs` + `repo_slug` + `pr_id` identify the PR; from 0.0.46 the record's `workspace`
is the owner (`--workspace`, which the shipped workflow passes, else `GITHUB_OWNER`), so the full
per-PR key works too. Three ways to find this run's line:

- **Fresh runner, single line.** On a GitHub-hosted runner the workspace is new, and
  `results.jsonl` is not tracked, so after the agent step it holds at most this run's line. It does
  not exist after an argument error, config error or crash. Check `pr_id` before using it. Add
  `rm -f results.jsonl` before the agent on self-hosted runners that reuse a workspace.
- **Own file (0.0.46+).** Set `USAGE_RECORD_FILE` in the agent step's `env:` to a path such as
  `${{ runner.temp }}/pr-review-record.json`, `rm -f` it before the agent, and read it after: it
  holds only this run's record ([usage-logging.md](usage-logging.md#finding-this-runs-record)).
- **Export the Jenkins variables from the run.** The `jenkins` field (the name is historical) is
  filled from `JOB_NAME`, `BUILD_NUMBER` and `BUILD_URL`, so the documented `jq` recipes work
  unchanged. `BUILD_URL` also links the footer's `Review #N` and the reply footer to the run; footer
  detection accepts the linked form. Illustrative, untested:

```yaml
        env:
          JOB_NAME: ${{ github.workflow }}
          BUILD_NUMBER: ${{ github.run_id }}-${{ github.run_attempt }}
          BUILD_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

## Checked-commit store

The agent reports the head it genuinely checked as `checked_commit`, and a later run given it as
`LAST_CHECKED_COMMIT` deduplicates a no-post ending (`NO_NEW_FINDINGS`, a quiet reply) without a
review call (skip-logic §8). The shipped workflow stores nothing: wiring it into a live public
repository adds a `statuses: write` permission, two API calls per run and a visible status line, and
it has not been run here. Recommended wiring:

| Store | Fit | Why |
|---|---|---|
| **Commit status on the checked sha**, context `pr-review-agent/checked-pr-<n>`, `state: success`, `description: target=<base branch>` | **Recommended** | `GITHUB_TOKEN` can write it (`statuses: write`). A new push has no status, so the value invalidates itself. The per-PR context keeps PRs that share a head apart (contract item 1), and the description carries the retarget check (item 6). Shows as an extra green line in the PR's checks; it gates nothing unless someone makes that context required. Never post `failure` or `pending`. |
| Artifact of the record per PR | Workable | Invisible, works across event types, needs `actions: read`; expires with the artifact retention period (90 days by default). |
| `actions/cache` | Poor | Keys are immutable. Caches saved by `pull_request` runs are scoped to `refs/pull/<n>/merge` and invisible to `issue_comment` runs, which run on the default branch. Entries unused for 7 days are evicted. |
| Repository variable per PR | Poor | `GITHUB_TOKEN` cannot write variables (needs a PAT or App), variables have a count limit, and closed PRs need cleanup. |
| Hidden PR comment or label | Do not | A comment without the agent footer posted by a `User` account (a PAT) is a developer reply under the flat model, so the agent would answer it, paid; any such comment is a timeline entry. Labels are repository-wide and fire `labeled` events. |

Illustrative, untested. Add `statuses: write` to `permissions` and `STATUS_CONTEXT:
pr-review-agent/checked-pr-<n>` to the job `env`, and pass `LAST_CHECKED_COMMIT` to the agent step
as shown:

```yaml
      - name: Read checked commit (fail open)
        id: checked
        if: steps.guard.outputs.run == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number }}
        run: |
          pr=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER") || exit 0
          head=$(jq -r .head.sha <<<"$pr"); base=$(jq -r .base.ref <<<"$pr")
          desc=$(gh api "repos/$GITHUB_REPOSITORY/commits/$head/status?per_page=100" \
            --jq ".statuses[] | select(.context == \"$STATUS_CONTEXT\") | .description") || exit 0
          if [ "$desc" = "target=$base" ]; then echo "sha=$head" >> "$GITHUB_OUTPUT"; fi

      # agent step: env LAST_CHECKED_COMMIT: ${{ steps.checked.outputs.sha }}

      - name: Store checked commit
        if: steps.guard.outputs.run == 'true' && !cancelled()
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.pull_request.number || github.event.issue.number }}
        run: |
          rec=$(jq -c --arg pr "$PR_NUMBER" 'select(.pr_id == $pr)' results.jsonl 2>/dev/null | tail -n 1)
          sha=$(jq -r '.checked_commit // empty' <<<"$rec"); [ -n "$sha" ] || exit 0
          gh api "repos/$GITHUB_REPOSITORY/statuses/$sha" -f state=success -f context="$STATUS_CONTEXT" \
            -f description="target=$(jq -r .target_branch <<<"$rec")" >/dev/null || true
```

- The read starts from the PR's current head fetched at run time, never the payload: the head only
  picks which status to look up, and the hash passed is one the agent reported, because statuses
  are written only from records.
- The store uses the record's `checked_commit`, never the payload sha, and ignores `action` and the
  exit code. The single-line match assumes a fresh runner (previous section).
- A status description is limited to 140 characters; for a base branch longer than about 130,
  store nothing.
- The combined-status endpoint (`commits/{ref}/status`) returns only the latest status per context,
  paginated by context; `per_page=100` covers a commit with up to 100 status contexts.

## Retargets

The workflow subscribes to `pull_request` `edited` and acts only when `github.event.changes.base` is
present. A PR skipped by `ONLY_TARGET_BRANCHES` has no review footer, so the run after a retarget
does a first review. Same-head limitation: when the last posted footer already names the head, a
retarget without a push ends as `DEDUP_SKIP`, not a review against the new base; a stored checked
commit extends that to no-post endings unless the `target=` check above is in place. Re-reviewing
that case needs a manual run with `--force`.

## Consumer repositories

This repository builds the agent from the same commit as the workflow (the PR merge ref for
`pull_request`, the default branch for `issue_comment`), so a flag can never be newer than the
agent. A repository that downloads `dist/pr-review-agent.cjs` from a pinned tag can hit the
**unknown-flag hazard**: the argument parser rejects an option the pinned bundle does not know with
exit 1 and writes no record.

- Pass newer inputs as env vars: `LAST_CHECKED_COMMIT`, `TRIGGER_EVENT`, `TRIGGER_COMMENT_AUTHOR`,
  `TRIGGER_EVENT_KIND`, `USAGE_RECORD_FILE`, `ONLY_TARGET_BRANCHES`, `SKIP_*`. An older bundle
  ignores unknown env vars, so the feature is simply off. YAML `env:` empty strings stay empty and
  disable a list.
- A pinned bundle needs 0.0.46 for `TRIGGER_EVENT_KIND`, `USAGE_RECORD_FILE`, `workspace` = owner
  in the record and the `Bot`-reply filter.
- Remove flags before rolling the pin back.
- `${{ }}` is substituted before the shell runs, so `--force ${{ inputs.force }}` with an empty input
  becomes a bare `--force` (re-review on every event). Write `--force="${{ inputs.force }}"`, and pass
  anything event-controlled (titles, branch names, comment text) through `env:`, never inline in
  `run:`.
- Commit a `.agent-review-instructions.md` for a repository prompt; `--prompt` needs a local file.

## Other settings

- **LLM secret.** The shipped workflow sets `LLM_PROVIDER: openrouter` and reads
  `OPENROUTER_API_KEY`; with the default provider it is `ANTHROPIC_API_KEY`. `GITHUB_TOKEN` is the
  automatic token; `pull-requests: write` is enough to post reviews.
- **Models.** This repository's own workflow sets `CLAUDE_MODEL`, `JUDGING_MODEL` and `REPLY_MODEL`
  to `anthropic/claude-haiku-5.5` and leaves effort unset: the OpenRouter provider does not send
  `REVIEW_EFFORT`/`JUDGE_EFFORT`, so setting them there has no effect.
- **Context window.** From 0.0.43 `anthropic/…` slugs resolve to their own window (1M for the 5.x
  family), so `MODEL_CONTEXT_TOKENS` is not needed for them.
- **Branch policy.** The shipped workflow empties `SKIP_TARGET_BRANCHES` and keeps the default
  `SKIP_SOURCE_BRANCHES` (`main,master,release/*,hotfix/*`), so `release/*` and `hotfix/*` PRs are
  not reviewed. For trunk-based repositories use the main-only recipe in skip-logic §3:
  `SKIP_TARGET_BRANCHES: ""`, `ONLY_TARGET_BRANCHES: main`, `SKIP_SOURCE_BRANCHES: main,master`.
- **Red checks.** An agent error fails the job, and the PR shows a red `PR Review` check. It blocks
  nothing unless the check is required; add `continue-on-error: true` to the agent step if it should
  always show green.
- **`Build:` in the footer** reads `<merge sha>-dirty` on `pull_request` runs: `npm run bundle`
  rewrites the tracked bundle in a checkout of the ephemeral merge ref, so it is not a fetchable ref.

## Known limitations

- **Flat reply model.** Issue comments have no threads: any comment after the agent's latest one
  that has no agent footer and is not from a `Bot` account is a reply. Human-to-human discussion is
  answered and counts toward `MAX_REPLY_COMMENTS`; `SKIP_DIRECTED_REPLIES` is Bitbucket-only. A
  comment in the same second as the agent's latest comment is never answered.
- **Reviews and inline review comments are invisible.** The adapter reads issue comments only, and
  the workflow does not subscribe to `pull_request_review` or `pull_request_review_comment`. A
  question asked in a review or on a diff line is not answered.
- **Same-head retarget** (see [Retargets](#retargets)).
- **Fork PRs** and **Dependabot PRs** are not reviewed. PRs opened by Apps or bots or by
  non-collaborators are not reviewed until a trusted person comments.

## Unverified

- That workflow-level concurrency with `cancel-in-progress: true` cancels the in-flight run when the
  new run's only job is then skipped by `if:` (widely reported, not observed here), and that a job
  skipped by `if:` never joins a job-level group.
- The `issue_comment` path end to end, including posting replies with `pull-requests: write`.
- The same-repo check against the real API (`gh api --jq` output for a fork, and for a deleted
  fork where `head.repo` is null).
- `author_association` values for private organisation members, on comments and on PRs.
- The PR-author check on a live `pull_request` run (the field is in GitHub's documented payload
  schema; not yet run here).
- Whether GitHub's automatic retarget, after a merged base branch is deleted, sends `edited` with
  `changes.base`, and whether that starts a run when a `GITHUB_TOKEN` workflow deleted the branch.
- `queue: max` at job level, and on GitHub Enterprise Server.
- The commit-status store in the PR checks UI and with branch-protection required checks.
