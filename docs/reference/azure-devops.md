# Azure DevOps Integration (experimental / WIP)

Covers the Azure DevOps adapter and its CI wiring. For adapter internals (interface, diff
reconstruction, thread model, auth precedence) see Knowhere
[`docs/context/vcs/adapter.md`](../context/vcs/adapter.md); for the env vars see
[`env-vars.md`](env-vars.md); for a setup quickstart see the README's "Azure DevOps" section.

## Status (verified live)

The **created + updated** paths are validated end-to-end against a cloud Azure DevOps Services
org: a PR push queues build validation, the agent authenticates with the zero-PAT
`System.AccessToken`, posts the review as the *Build Service* identity, and re-queues on every
new commit (delta reviews). Still WIP: on-prem **Server**, and the **reply-to-comments** flow
(designed, not yet live-validated — see below).

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

## Answering comments (reply flow) — designed, pending live validation

Build validation fires on PR **create/update** but **not on comments**, so the agent's
reply-to-developer flow needs a second trigger. The design is now captured in
[azure-reply-flow-runbook.md](azure-reply-flow-runbook.md) and
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

Still unverified before this can ship — see the runbook's Phase 0/1:
- The HMAC handshake between the Web Hooks service hook and the Incoming Webhook connection
  (Azure's Web Hooks consumer doesn't compute HMAC for you; may need a shared-secret fallback).
- The exact webhook payload paths (`resource.pullRequest.pullRequestId` etc.) against a real
  comment payload — a wrong path expands to empty silently.
