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

## Reply flow — set up & test (validated live, WIP)

Build validation fires on PR **create/update** but **not on comments**, so the reply-to-developer
flow needs a second trigger. Validated end-to-end on a cloud Services test org: a comment fires a
Service Hook → an Incoming Webhook → a reply pipeline that runs the agent. No agent code change —
the FSM already decides review-vs-reply and early-exits when there's nothing to answer.

```
PR comment ─▶ Service Hook (ms.vss-code.git-pullrequest-comment-event)
           ─▶ Incoming Webhook service connection
           ─▶ reply pipeline ─▶ node agent.cjs --vcs azure --pr-id <id> --repo-slug <name>
```

Prereqs: the review pipeline (above) already wired, `ANTHROPIC_API_KEY` secret available, and an
`AGENT_TAG` whose bundle includes the Azure adapter (a release tag ≥ `v0.0.4`; verify with
`curl …/<ref>/dist/pr-review-agent.cjs | grep -c AzureDevOpsAdapter` > 0).

### Setup (one-time)

1. **Ship the reply pipeline YAML.** Put [`azure/azure-reply-pipeline.yml`](../../azure/azure-reply-pipeline.yml)
   on the repo's **default branch** — Service Hooks resolve the pipeline's default-branch YAML
   (unlike build validation, which uses the PR *source* branch).
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
thread. A **top-level** comment triggers the run too but no-ops when there's nothing unanswered.
Check the run log prints `reply trigger: PR_ID='…' REPO_NAME='…'` (populated), and `results.jsonl`
shows `vcs: azure` with reply-path usage.

### Gotchas (all found + fixed live)

- **Read payload values as `$VAR`, not `$(VAR)`.** `PR_ID`/`REPO_NAME` arrive as step **env vars**
  (mapped from the payload via `${{ parameters.prComment.* }}`); in bash that's `$PR_ID` /
  `$REPO_NAME`. `$(PR_ID)` is Azure's *pipeline-variable* macro — it doesn't resolve step env vars
  and fails **silently** (empty → "--pr-id is required").
- **`SKIP_TARGET_BRANCHES: ''`** in the reply pipeline `env:`, or the default `main,master` skips
  every PR into main.
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
- **Throttling: none native** — every comment fires one pipeline run (no debounce). Cheap, though:
  the FSM early-exits before any Claude call when there's nothing new, so redundant runs cost CI
  minutes, not tokens. If noise matters: skip agent-authored comments via a pipeline `condition` on
  `resource.comment.author.id` (kills the self-reply re-fires — the main source), an Environment
  exclusive lock to serialize, the free-tier single parallel job (queues naturally), or an external
  relay (Azure Function/Logic App) for real rate-limiting.
- **Resolved:** hybrid kept (build-validation for reviews + webhook for replies, not unified);
  agent-authored comments self-fire a cheap no-op (footer/timestamp dedup → **no loop**);
  `/azp run` comment-commands are **GitHub-only**, not usable for Azure Repos.
