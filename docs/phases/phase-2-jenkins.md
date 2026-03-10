# Phase 2 — Jenkins Integration

## Goal

Auto-trigger the review agent on PR events. No manual steps required after setup.

## Status: ✅ Complete

> Webhook-triggered Jenkins job is live. Bitbucket PR events (create, update,
> comment) trigger the agent automatically via the Generic Webhook Trigger plugin.

---

## Architecture

```
Bitbucket Cloud                    Jenkins
─────────────                      ───────
PR created/updated/commented
        │
        ▼
  Webhook POST ──────────────►  /generic-webhook-trigger/invoke?token=...
  (X-Event-Key header)                │
                                      ▼
                               Extract: REPO_SLUG, PR_ID
                               Optional filter: repo allowlist
                                      │
                                      ▼
                               Pipeline runs pr-review-agent
                               (downloads bundle or uses local clone)
```

The agent handles all three event types with a single entry point — no special
flags needed per event type:

| Bitbucket Event | Agent Behavior |
|----------------|----------------|
| `pullrequest:created` | First review |
| `pullrequest:updated` | Delta review (new commits) or dedup skip (same commit) |
| `pullrequest:comment_created` | Reply to developer questions, or dedup skip |

---

## Option A: Generic Webhook Trigger (Standalone Job)

A single Jenkins job that reviews any repo in the workspace. No Jenkinsfile in
target repos required — everything is configured in the Jenkins UI.

### Prerequisites

- **Generic Webhook Trigger** plugin installed in Jenkins
- **NodeJS** plugin installed (or Node 20+ available on the agent)
- Jenkins endpoint accessible from Bitbucket Cloud (see [Network Requirements](#network-requirements))

### Step-by-Step Setup

#### 1. Create Jenkins Job

- New Item → **Pipeline** → name it (e.g. `pr-review-agent`)

#### 2. Configure Generic Webhook Trigger

Under **Build Triggers → Generic Webhook Trigger**:

**Token:**
```
pr-review-agent
```

**Post content parameters** (extract fields from Bitbucket JSON payload):

| Variable | Expression | JSONPath |
|----------|-----------|----------|
| `REPO_SLUG` | `$.repository.name` | JSONPath |
| `PR_ID` | `$.pullrequest.id` | JSONPath |

**Request header** (optional — for logging/filtering by event type):

| Variable | Header name |
|----------|-------------|
| `x_event_key` | `X-Event-Key` |

> **Note:** The plugin auto-converts header names to lowercase with underscores.
> `X-Event-Key` becomes variable `x_event_key`.

**Optional filter** (repo allowlist — rejects builds at trigger level):

| Field | Value |
|-------|-------|
| Expression | `$REPO_SLUG` |
| Text | `^(my-app\|my-other-app)$` |

Only repos matching the regex will trigger a build. Non-matching repos are
rejected immediately (no build queued).

#### 3. Pipeline Script

Copy the contents of [`jenkins/pipeline.groovy`](../../jenkins/pipeline.groovy) into
**Pipeline → Definition → Pipeline script**.

The pipeline includes:
- **Quiet period** (30s) — coalesces rapid triggers into one build
- **`lock(skipIfLocked: true)`** — only one review per repo+PR at a time (requires Lockable Resources plugin)
- **Build display name** — `#42-alice-mobile-app-709` instead of just `#42`
- **`archiveArtifacts`** — saves `results.jsonl` per build
- **Plot plugin** — visualizes cost, tokens, duration, and touch rate across builds (see [Metrics & Plots](#metrics--plots))

> **Important:** Model IDs must NOT be stored as Jenkins credentials. Jenkins
> masks all credential values in logs and API calls, which corrupts the model ID
> and causes "unknown model" errors. Use `--model` and `--judge-model` CLI flags
> or hardcode in the pipeline script.

#### 4. Configure Bitbucket Webhook

In the Bitbucket repository (or workspace-level for all repos):

1. **Settings → Webhooks → Add webhook**
2. **URL:** `https://<jenkins-host>/generic-webhook-trigger/invoke?token=pr-review-agent`
3. **Triggers:** Select these events:
   - `pullrequest:created`
   - `pullrequest:updated`
   - `pullrequest:comment_created`
4. **Save**

For workspace-level webhooks, configure once and all repos in the workspace will
trigger the job (filtered by the optional regex in step 2).

#### 5. Store Credentials in Jenkins

| Credential ID | Maps to env var | Type | Description |
|---------------|-----------------|------|-------------|
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | Secret text | Anthropic API key |
| `bitbucket-token` | `BITBUCKET_TOKEN` | Secret text | Atlassian API token |
| `bitbucket-username` | `BITBUCKET_USERNAME` | Secret text | Atlassian account email |

All must be **Secret text** with masking enabled.

---

## Option B: Per-Repo Jenkinsfile Stage

Each target repo adds an `AI Review` stage to its own `Jenkinsfile` / `build.jenkins`.
Triggered by the repo's existing multibranch pipeline on PR events.

```groovy
environment {
    APP_NAME = 'your-repo-slug'
    BITBUCKET_WORKSPACE = 'your-workspace'
}

stage('AI Review') {
    when {
        changeRequest()
    }
    steps {
        catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE') {
            nodejs(nodeJSInstallationName: env.NODE_VERSION) {
                withCredentials([
                    string(credentialsId: 'anthropic-api-key', variable: 'ANTHROPIC_API_KEY'),
                    string(credentialsId: 'bitbucket-token', variable: 'BITBUCKET_TOKEN'),
                    string(credentialsId: 'bitbucket-username', variable: 'BITBUCKET_USERNAME')
                ]) {
                    sh """
                        curl -fsSL https://raw.githubusercontent.com/<org>/pr-review-agent/main/dist/pr-review-agent.cjs \
                            -o /tmp/pr-review-agent.cjs
                        node /tmp/pr-review-agent.cjs \
                            --repo-slug ${env.APP_NAME} \
                            --pr-id ${env.CHANGE_ID} \
                            --model "claude-haiku-4-5-20251001" \
                            --judge-model "claude-sonnet-4-6"
                    """
                }
            }
        }
    }
}
```

- **`when { changeRequest() }`** — only runs on PRs, not branch builds
- **`CHANGE_ID`** — Jenkins built-in variable for the PR number

### With PR size thresholds (optional)

```groovy
sh """
  node /tmp/pr-review-agent.cjs \
    --repo-slug ${env.APP_NAME} \
    --pr-id ${env.CHANGE_ID} \
    --min-changed-lines 5 \
    --max-changed-lines 2000
"""
```

---

## Deployment Options

**Download at build time (recommended for getting started):**

```groovy
sh """
  curl -fsSL https://raw.githubusercontent.com/<org>/pr-review-agent/main/dist/pr-review-agent.cjs \
      -o /tmp/pr-review-agent.cjs
  node /tmp/pr-review-agent.cjs ...
"""
```

Always gets latest. GitHub raw CDN may cache for a few minutes after push.

**Clone to a fixed path on the Jenkins agent:**

```bash
git clone <this-repo-url> /opt/pr-review-agent
```

Then reference `node /opt/pr-review-agent/dist/pr-review-agent.cjs`. Update with
`git pull`. Gives more control and avoids CDN cache delay.

---

## Network Requirements

The Generic Webhook Trigger endpoint (`/generic-webhook-trigger/invoke`) must be
accessible from Bitbucket Cloud's public IP ranges.

If Jenkins is behind a VPN/firewall, you need to whitelist this path for
Bitbucket Cloud IPs — the same way `/bitbucket-scmsource-hook/notify` is
whitelisted for multibranch pipeline triggers.

Bitbucket Cloud IP ranges are published at:
[Bitbucket Cloud IP ranges](https://support.atlassian.com/organization-administration/docs/ip-addresses-and-domains-for-atlassian-cloud-products/)

**Testing the endpoint from within the network:**

```bash
curl -s -X POST "https://<jenkins-host>/generic-webhook-trigger/invoke?token=pr-review-agent" \
  -H "Content-Type: application/json" \
  -H "X-Event-Key: pullrequest:comment_created" \
  -d '{
    "repository": {"name": "my-app"},
    "pullrequest": {"id": 709},
    "comment": {"user": {"nickname": "testuser"}}
  }'
```

If this returns 200 from VPN but Bitbucket gets 404, it's a network/firewall issue.

---

## Metrics & Plots

The pipeline uses the [Jenkins Plot plugin](https://plugins.jenkins.io/plot/) to
visualize review metrics over time. After each review, a `node -e` script extracts
values from `results.jsonl` into `.properties` files, which the Plot plugin reads in
the `post` block.

### Charts

| Chart | File | Data Source | Notes |
|-------|------|-------------|-------|
| Cost per Review (USD) | `plot-cost.properties` | `cost_usd` | Every build |
| Input Tokens | `plot-tokens.properties` | `tokens.input` | Every build |
| Duration (ms) | `plot-duration.properties` | `duration_ms` | Every build |
| Finding Touch Rate (%) | `plot-touchrate.properties` | `touch_rate` | Re-reviews only |

### Prerequisites

- **Plot plugin** installed in Jenkins
- Charts appear under **"Review Metrics"** link in the **job** left sidebar (not build page)
- Needs 2+ builds to render meaningful charts
- `csvFileName` in the pipeline is the Plot plugin's internal history file — not user-created

### Touch Rate

Measures whether developers act on review findings: `resolved / (resolved + still_open) × 100`.
Only populated on re-reviews (when `DELTA_STATS` is present). The plot only gets data points
when re-reviews happen, so it will be sparser than the other 3 charts.

### `fileExists` Guards

- The 3 core plots (`cost`, `tokens`, `duration`) are guarded by `fileExists('plot-cost.properties')` —
  if the lock was skipped or the agent errored before writing results, no plot data is written
- The touch rate plot has its own `fileExists('plot-touchrate.properties')` guard since it's
  only generated on re-reviews
- `archiveArtifacts` uses `allowEmptyArchive: true` for the same reason

---

## Key Design Decisions

- **`catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE')`** — agent failure never breaks the build
- **`nodejs()` wrapper** — uses the Jenkins NodeJS plugin to ensure Node 20+
- **Model IDs as CLI flags, not credentials** — Jenkins masks credential values everywhere (including API calls), corrupting model IDs
- **Single entry point** — the agent's state machine handles all event types (create, update, comment) with the same CLI invocation
- **Optional filter at trigger level** — non-matching repos don't even queue a build

---

## Future: Version Pinning

Currently the bundle is downloaded from `main` with no version pinning.
A future iteration could:
- Pin to a specific commit hash or tag in the `curl` URL
- Add a `--version` flag to the agent for compatibility checking
- Use releases with checksums

---

## Completion Criteria

- [x] Opening a PR triggers a Jenkins build with the review stage
- [x] Review comment appears on the PR
- [x] Build pipeline is **not** marked as failed if the review agent errors
- [x] Credentials are masked in Jenkins logs
- [x] Generic Webhook Trigger job handles multiple repos with allowlist
- [x] `--model` and `--judge-model` CLI flags avoid credential masking issues
