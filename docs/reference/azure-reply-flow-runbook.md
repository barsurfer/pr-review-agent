# RUNBOOK — Azure DevOps reply-to-comments flow (validated live, WIP)

**Target repo:** `barsurfer/pr-review-agent` (branch: `feature/azure-devops-adapter`)
**Intended final location in repo:** `docs/reference/azure-reply-flow-runbook.md`
**Depends on:** PR #1 (`feat(vcs): Azure DevOps adapter`) already merged/checked out.

> **Validated live** end-to-end on an Azure DevOps Services test org: PR comment → Service Hook →
> Incoming Webhook → reply pipeline → agent posts a reply. Confirmed. The phases below are kept
> as the executable runbook, with inline notes on what was confirmed and the bugs fixed along the
> way.

> Executable runbook for an agent working on a **different machine** with (a) a checkout of
> `pr-review-agent` and (b) admin access to an Azure DevOps Services org/project. Do the phases
> in order. Phase 0 gates everything else — do **not** hardcode payload paths before it.

---

## Goal

Build-validation triggers the agent on PR **create/update** only — never on **comments**. So the
agent's reply-to-developer flow never fires in CI. This wires a second trigger:

```
PR comment  ─▶  Service Hook (git-pullrequest-comment-event)
            ─▶  Incoming Webhook service connection
            ─▶  reply pipeline  ─▶  node agent.cjs --vcs azure --pr-id <id> --repo-slug <name>
```

**Key fact — no agent logic changes required.** A reply run is the *same* CLI invocation as a
review run. The review FSM already decides review-vs-reply internally (`getPreviousReviewComments`
→ `getRepliesToReviewComments` → `CHECK_REPLIES` state) and early-exits before any Claude call when
there is nothing new to answer. This task is **trigger wiring + one new pipeline YAML**. The only
code touched is an *optional* early-exit guard (Phase 4) and docs (Phase 5).

---

## Prerequisites

- [ ] Azure DevOps **Services** org + project with a Git repo and at least one open PR to test on.
- [ ] Project Administrator (needed to create Service Hooks + Service connections).
- [ ] The build-validation review pipeline from PR #1 (`azure/azure-pipelines.yml`) already wired
      as a Branch Policy, and confirmed posting reviews as **Build Service**. (This runbook reuses
      its auth model verbatim.)
- [ ] `ANTHROPIC_API_KEY` available as a secret pipeline variable.
- [ ] `AGENT_TAG` value that includes the Azure adapter (the pinned `v0.0.3` predates it — use the
      adapter branch `feature/azure-devops-adapter` until a release tag ships). Verify:
      `curl -fsSL "https://raw.githubusercontent.com/barsurfer/pr-review-agent/<ref>/dist/pr-review-agent.cjs" | grep -c AzureDevOpsAdapter` → must be `> 0`.

---

## Phase 0 — Capture a REAL comment payload (do this FIRST)

The pipeline reads the PR id out of the webhook payload with **compile-time** template syntax
`${{ parameters.<alias>.<json.path> }}`. A wrong path expands to empty **silently** — no error.
So confirm the exact shape before writing YAML.

1. Go to `https://webhook.site` → copy your unique URL.
   > Alternative (self-hosted): a tiny local receiver + `cloudflared tunnel --protocol http2
   > --url http://localhost:<port>`. Use `--protocol http2` — the default QUIC was flaky and its
   > `trycloudflare.com` DNS failed from Azure.
2. In Azure DevOps: **Project Settings → Service Hooks → `+`**
   - Service: **Web Hooks**
   - Trigger: **Pull request commented on** (`ms.vss-code.git-pullrequest-comment-event`)
   - Filters: (optional) scope to the test repo.
   - Action → URL: paste the webhook.site (or cloudflared) URL. Finish.
3. Open a PR, add a comment. Inspect the captured JSON.
4. **Record the real paths** (confirmed against a live payload):
   - PR id:      `resource.pullRequest.pullRequestId`
   - repo name:  `resource.pullRequest.repository.name`
   - comment author id: `resource.comment.author.id`  (needed for Phase 4 guard)
   - comment author display: `resource.comment.author.displayName`
   - comment body: `resource.comment.content`
5. **Delete this webhook.site subscription** once paths are confirmed.

> ✅ Confirmed against a real payload — Phase 2/3 below use these paths as-is.

---

## Phase 1 — Incoming Webhook service connection

**Project Settings → Service connections → New service connection → Incoming WebHook.**

- **Webhook Name:** `pr-comment`   ← this is the `name` the Service Hook targets in its URL.
  Hyphens are fine here.
- **Secret:** leave **blank** for WIP — validated: the generic Web Hooks service hook still POSTs
  and the pipeline fires with no HMAC/signature check. For production, front it with a relay that
  signs the payload.
- **Service connection name:** `pr-comment` (referenced by `connection:` in the pipeline; hyphens
  are fine here too).

> **HMAC (resolved, validated):** a blank secret works — Azure's Web Hooks consumer doesn't
> compute HMAC on its own, and skipping auth entirely is fine for a throwaway/test repo. Only
> harden this (shared-secret header, or a signing relay) before pointing it at a repo that
> matters.

> **Alias rule:** the pipeline's `resources.webhooks[].webhook:` alias (Phase 2, `prComment`)
> **must be hyphen-free** — it's referenced as `${{ parameters.<alias>.* }}` and a hyphen parses
> as minus in Azure template expressions. Hyphens are fine everywhere else (Webhook Name,
> `connection:`, service-connection name, trigger URL) — just not that alias.

---

## Phase 2 — New reply pipeline YAML

**New file:** `azure/azure-reply-pipeline.yml`

```yaml
# PR Review Agent — Azure DevOps REPLY pipeline (validated live / WIP)
#
# Fires on PR COMMENTS (not pushes). Triggered by a Service Hook on
# ms.vss-code.git-pullrequest-comment-event -> an Incoming Webhook service connection.
# A reply run is the SAME invocation as a review run; the agent FSM decides review-vs-reply
# and early-exits (no Claude call) when there is nothing new to answer.
#
# SETUP: see docs/reference/azure-reply-flow-runbook.md
#   1. Incoming Webhook service connection named "pr-comment". Secret can be BLANK for WIP —
#      validated (see Phase 1). The `webhook:` alias below (prComment) must be hyphen-free.
#   2. Register this YAML as a pipeline. Service Hooks fire the pipeline's DEFAULT-branch YAML,
#      so this file must exist on the repo's default branch (unlike build-validation, which
#      resolves YAML from the PR source branch).
#   3. Service Hook (Web Hooks) -> the incoming-webhook URL (Phase 3).

resources:
  webhooks:
    - webhook: prComment          # alias used in ${{ parameters.prComment.* }} — hyphen-free
      connection: pr-comment      # Incoming Webhook service connection name

trigger: none     # never on CI push
pr: none          # pr: triggers are ignored for Azure Repos anyway

pool:
  vmImage: ubuntu-latest

variables:
  # MUST include the Azure adapter. v0.0.3 predates it — use the adapter branch until a tag ships.
  AGENT_TAG: feature/azure-devops-adapter

steps:
  - task: NodeTool@0
    displayName: 'Use Node.js 22'
    inputs:
      versionSpec: '22.x'

  - script: |
      set -euo pipefail

      curl -fsSL "https://raw.githubusercontent.com/barsurfer/pr-review-agent/$(AGENT_TAG)/dist/pr-review-agent.cjs" -o agent.cjs

      # Split System.CollectionUri into { base URL, org } for the adapter (same as review pipeline).
      COLL="${SYSTEM_COLLECTIONURI%/}"
      export AZURE_ORG="${COLL##*/}"
      export AZURE_BASE_URL="${COLL%/*}"

      # PR_ID/REPO_NAME are step env vars (mapped from the webhook payload) — read as $VAR in
      # bash, NOT $(VAR) which is Azure's pipeline-variable macro and won't resolve them.
      node agent.cjs \
        --vcs azure \
        --repo-slug "$REPO_NAME" \
        --pr-id "$PR_ID"
    displayName: 'PR Review Agent — reply (WIP)'
    continueOnError: true
    env:
      # PR id + repo come from the webhook payload (confirmed in Phase 0). Compile-time expansion:
      PR_ID:      ${{ parameters.prComment.resource.pullRequest.pullRequestId }}
      REPO_NAME:  ${{ parameters.prComment.resource.pullRequest.repository.name }}
      # Auth — identical to the review pipeline (zero-PAT).
      AZURE_ACCESS_TOKEN: $(System.AccessToken)
      AZURE_PROJECT: $(System.TeamProject)
      ANTHROPIC_API_KEY: $(ANTHROPIC_API_KEY)   # secret pipeline variable — mapped explicitly
      SKIP_TARGET_BRANCHES: ''                   # default "main,master" would skip PRs into main

  - task: PublishPipelineArtifact@1
    displayName: 'Archive results.jsonl'
    condition: always()
    continueOnError: true
    inputs:
      targetPath: results.jsonl
      artifact: pr-review-reply-results
```

**Gotchas to bake in:**
- `System.PullRequest.*` variables are **NOT set** on webhook-triggered runs — that is why PR id
  comes from the payload, not `$(System.PullRequest.PullRequestId)`.
- `${{ parameters.prComment.* }}` is **template (compile-time)** expansion; it lands in the step
  as an **env var** (`PR_ID`, `REPO_NAME`). Read it in bash as `$PR_ID`/`$REPO_NAME` —
  `$(PR_ID)` is Azure's *pipeline-variable* macro, doesn't resolve step env vars, and fails
  silently (empty string → "--pr-id is required"). This bit us live; fixed in the YAML above.
- Set `SKIP_TARGET_BRANCHES: ''` in the step `env:` — the default `main,master` skips every PR
  into main.
- Commit this file to the repo **default branch** so the Service Hook can resolve it.

**Register the pipeline:** Pipelines → New pipeline → point at `azure/azure-reply-pipeline.yml` →
Save (do not run). Note its **definitionId** (in the URL) if the Service Hook asks for it.

---

## Phase 3 — Service Hook subscription (the trigger)

**Project Settings → Service Hooks → `+`**

- Service: **Web Hooks**
- Trigger: **Pull request commented on** (`ms.vss-code.git-pullrequest-comment-event`)
- Filters:
  - Repository: the target repo (recommended — keep the blast radius small for WIP).
  - Target branch / other filters: leave default.
  - ⚠️ There is **no reliable comment-author filter** on this event — agent-authored comments will
    also fire it. This is expected; handled in Phase 4 (or accepted as a cheap no-op).
- Action → **URL:**
  ```
  https://dev.azure.com/{ORG}/_apis/public/distributedtask/webhooks/pr-comment?api-version=6.0-preview
  ```
  Replace `{ORG}`; `pr-comment` must match the Incoming Webhook service-connection **Webhook Name**.
- HTTP Headers: none needed if the Incoming Webhook secret is left blank (validated — see
  Phase 1). Only add a signature header if you hardened the service connection with a real secret.
- **Resource details to send:** All.
- Test → Finish.

---

## Phase 4 — (OPTIONAL) self-comment early-exit guard

**Why optional:** the FSM already early-exits *before any Claude call* when a comment thread has no
new human reply, so an agent-authored comment costs only ~1 pipeline run + a few cheap API GETs —
**no Claude tokens, no loop.** For WIP, accepting these no-ops is fine.

**Add the guard only if** the no-op *pipeline runs* (CI minutes / noise) become a problem. If so,
short-circuit at the pipeline level (cheapest — never spins the agent) using the author id captured
in Phase 0:

```yaml
  # Insert BEFORE the "PR Review Agent — reply" script step.
  # Skip the whole run when the comment was authored by the Build Service identity.
  # Replace <BUILD_SERVICE_AUTHOR_ID> with the id observed in Phase 0 for agent-posted comments.
  - script: echo "Comment authored by agent — skipping reply run."
    displayName: 'Skip self-authored comment'
    condition: eq('${{ parameters.prComment.resource.comment.author.id }}', '<BUILD_SERVICE_AUTHOR_ID>')
```

> Alternative (more robust, needs code): add a self-author check inside the adapter's
> `getRepliesToReviewComments` path so the FSM never even considers agent comments as human
> replies — but the existing footer-based dedup already achieves the no-loop guarantee, so prefer
> the pipeline-level guard unless you have a concrete failure case. **Do not add speculative code.**

---

## Phase 5 — Docs

Update `docs/reference/azure-devops.md`:
- Move the **"Open questions — answering comments (reply flow)"** section from *open* to
  *implemented (WIP)*; link to this runbook + `azure/azure-reply-pipeline.yml`.
- Note the confirmed payload paths from Phase 0.
- Note the resolved decisions:
  - **Hybrid kept** — build-validation for reviews (merge-gating, `System.PullRequest.*`, delta
    ordering) + webhook for replies. Not unified.
  - Self-authored comments → cheap no-op run; optional pipeline-level guard available.
  - `/azp run`-style comment commands remain **GitHub-only**; not wired.

Update `docs/context/vcs/adapter.md` (Knowhere) if it documents the trigger model.

---

## Phase 6 — Validate end-to-end

- [ ] Comment on an open PR as a **human** → reply pipeline runs → agent posts a reply thread.
- [ ] Comment again as the **agent/build service** (or observe the auto-fired event) → run is a
      **no-op** (FSM exits pre-Claude; or Phase-4 guard skips). Confirm **no reply loop**.
- [ ] Push a new commit → **review** pipeline (build validation) still runs a delta review,
      unaffected by the new wiring.
- [ ] Check `results.jsonl` artifact: `vcs: azure`, correct `run_id`, and reply-path usage logged.
- [ ] Confirm auth: replies posted as **Build Service** identity (zero-PAT `System.AccessToken`).

---

## Known limitations / flag in PR

- **Throttling:** none native — every comment fires one pipeline run (no debounce/cooldown). A
  burst (or push+comment together) spawns parallel runs racing on the same PR threads; FSM
  footer/timestamp dedup keeps correctness, and the FSM early-exits before any Claude call when
  there's nothing new, so redundant runs cost CI minutes, not tokens. Options if noise matters:
  skip agent-authored comments via a pipeline `condition` on the comment author (kills the main
  noise source — self-reply re-fires); an Environment exclusive lock to serialize runs; the
  free-tier single parallel job naturally queues them; or an external relay (Azure
  Function/Logic App) for real rate-limiting.
- **Review-vs-reply priority:** the FSM handles new commits before answering comments. If the PR
  has commits newer than the last review, a comment triggers a delta **review**, not a reply. A
  **reply** posts only when the current commit is already reviewed (no new commits) and there's
  an unanswered human question in a review thread.
- **HMAC:** resolved — a **blank** Incoming Webhook secret works (validated); the Web Hooks
  consumer doesn't compute HMAC on its own, and skipping auth is fine for a throwaway/test repo.
  Front it with a signing relay before pointing at a repo that matters.
- **On-prem Server:** untested; Service Hooks + incoming webhooks differ on Server/DC.
- **Default-branch YAML:** the reply pipeline resolves from the repo default branch (Service Hook
  behavior), so changes to `azure-reply-pipeline.yml` only take effect once merged to default.

## Unresolved questions (confirm with maintainer)

1. ~~Does the org's Web Hooks consumer actually enforce HMAC, or is a shared-secret header the
   pragmatic WIP path?~~ **Resolved:** neither — a blank secret works for WIP; no HMAC enforced.
2. Exact `resource.comment.author.id` value for the Build Service identity (fill in Phase 4).
3. Is CI-minute cost of no-op runs acceptable, or is the Phase-4 guard required for v1?
4. Any need to gate replies to specific threads (e.g. only replies under agent-authored review
   threads) vs. all PR comments?
