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

## CI integration (Azure Pipelines)

Wire [`azure/azure-pipelines.yml`](../../azure/azure-pipelines.yml) as a **Branch Policy → Build
Validation** on the target branch (the YAML `pr:` trigger does not fire for Azure Repos). Set it
**Optional** so a WIP failure never blocks a merge. Auth is zero-PAT via `System.AccessToken`;
grant the **{Project} Build Service ({Org})** identity **Contribute to pull requests**, and add
`ANTHROPIC_API_KEY` as a secret pipeline variable. Full step-by-step is in the README's
"CI integration" subsection.

### First-setup gotchas
- **`AGENT_TAG`** — the pinned `v0.0.3` tag predates the Azure adapter. Until a release tag
  ships, point it at the adapter branch (`feature/azure-devops-adapter`). Sanity-check a ref
  with `curl …/<ref>/dist/pr-review-agent.cjs | grep -c AzureDevOpsAdapter` (must be > 0).
- **`SKIP_TARGET_BRANCHES`** defaults to `main,master`, so a PR into `main` is skipped. Set
  `SKIP_TARGET_BRANCHES: ''` in the pipeline `env:` to review PRs into `main`.
- **YAML location** — build validation resolves the pipeline YAML from the PR's *source branch*,
  so that branch must contain `azure-pipelines.yml` (merge `main` in if the branch predates it).

### Repo-specific prompt in CI
`--prompt` takes a *local* path and the pipeline only downloads the agent bundle (not the
`prompts/` dir), so it can't be used in CI. Instead commit a `.agent-review-instructions.md`
(same `## ROLE / ## REVIEW PRIORITIES / …` format as the `prompts/*.txt` templates) to the
reviewed repo — the agent auto-loads it (`prompt_source: repo`) and the pipeline stays generic
across repos.

## Answering comments (reply flow) — validated live (WIP)

Build validation fires on PR **create/update** but **not on comments**, so the agent's
reply-to-developer flow needs a second trigger. Validated end-to-end on an Azure DevOps Services
test org — captured in [azure-reply-flow-runbook.md](azure-reply-flow-runbook.md) and
[`azure/azure-reply-pipeline.yml`](../../azure/azure-reply-pipeline.yml):

1. a **Service Hook** on `ms.vss-code.git-pullrequest-comment-event` →
2. an Azure Pipelines **Incoming Webhook** trigger (`resources.webhooks`) →
3. a reply pipeline that reads the PR id from the webhook payload
   (`resource.pullRequest.pullRequestId`) — `System.PullRequest.*` is not set on webhook runs.

The agent's FSM already decides review-vs-reply in one entrypoint, so no agent code change is
needed — it's purely trigger wiring. Resolved decisions:

- **Hybrid kept** — build-validation for reviews (merge-gating, `System.PullRequest.*`, delta
  ordering) + webhook for replies. Not unified into one pipeline.
- Agent-authored comments also fire the event → a cheap no-op run (FSM footer/timestamp dedup
  means no loop); an optional pipeline-level guard can skip them if the no-op runs become noise.
- Comment-command triggers (`/azp run`) are **GitHub-only** — not usable for Azure Repos.

Confirmed live:
- **HMAC is a non-issue** — the Incoming Webhook service connection works with a **blank secret**
  (no authentication); the generic Web Hooks service hook POSTs and the pipeline fires. Fine for
  a throwaway/test repo; front it with a signing relay for production.
- Payload paths confirmed against a real comment: `resource.pullRequest.pullRequestId`,
  `resource.pullRequest.repository.name`, `resource.comment.author.displayName`,
  `resource.comment.author.id`, `resource.comment.content`.

Two pipeline-YAML bugs found and fixed:
- Webhook payload values arrive as **step env vars** — read them in bash as
  `$PR_ID`/`$REPO_NAME`, not `$(PR_ID)` (Azure's *pipeline-variable* macro; doesn't resolve step
  env vars and fails silently — empty string → "--pr-id is required").
- Set `SKIP_TARGET_BRANCHES: ''` in the reply pipeline's `env:`, or the default `main,master`
  skips every PR into main.
- The `webhook:` alias (`prComment`) must be **hyphen-free** — it's used as
  `${{ parameters.<alias>.* }}` and a hyphen parses as minus in Azure expressions. Hyphens are
  fine in the `connection:` value and service-connection name.

**Review-vs-reply priority:** the review FSM handles new commits before answering comments. If
the PR has commits newer than the last review, a comment triggers a delta **review** of the new
code, not a reply. A **reply** posts only when the current commit is already reviewed (no new
commits) and there's an unanswered human question in a review thread.

**Throttling:** none native — every comment fires one pipeline run. Cheap though: the FSM
early-exits before any Claude call when there's nothing new, so redundant runs cost CI minutes,
not tokens. Options if noise matters: skip agent-authored comments via a pipeline `condition` on
the comment author (kills the main noise — self-reply re-fires); an Environment exclusive lock to
serialize runs; the free-tier single parallel job naturally queues them; or an external relay
(Azure Function/Logic App) for real rate-limiting.
