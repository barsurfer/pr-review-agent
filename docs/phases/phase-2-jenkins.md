# Phase 2 — Jenkins Integration

## Goal

Auto-trigger the review agent on PR events. No manual steps required after setup.

## Status: ✅ Complete

> Phase 1 and 1b are complete and tested against live Bitbucket PRs.
> Jenkins integration is live.

---

## How It Works

Each target repo adds an `AI Review` stage to its own `Jenkinsfile` / `build.jenkins`.
The stage downloads the bundle from the agent repo and runs it. No shared library required.

### Deployment Options

**Option A: Download at build time (current approach)**

```groovy
sh """
  curl -fsSL https://raw.githubusercontent.com/<org>/pr-review-agent/main/dist/pr-review-agent.cjs -o /tmp/pr-review-agent.cjs
  node /tmp/pr-review-agent.cjs \
    --repo-slug ${env.APP_NAME} \
    --pr-id ${env.CHANGE_ID}
"""
```

Simple, always gets latest. No version pinning yet — planned for a future iteration.

**Option B: Clone to a fixed path on the Jenkins agent**

```bash
git clone <this-repo-url> /opt/pr-review-agent
```

Then reference `node /opt/pr-review-agent/dist/pr-review-agent.cjs` in the Jenkinsfile.
Update with `git pull`.

Both approaches work — Option A is easier to roll out across repos, Option B gives more control.

---

## Jenkinsfile Stage Example

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
                    string(credentialsId: 'bitbucket-username', variable: 'BITBUCKET_USERNAME'),
                    string(credentialsId: 'claude-model', variable: 'CLAUDE_MODEL')
                ]) {
                    sh """
                        curl -fsSL https://raw.githubusercontent.com/<org>/pr-review-agent/main/dist/pr-review-agent.cjs -o /tmp/pr-review-agent.cjs
                        node /tmp/pr-review-agent.cjs \
                            --repo-slug ${env.APP_NAME} \
                            --pr-id ${env.CHANGE_ID}
                    """
                }
            }
        }
    }
}
```

### Key Design Decisions

- **`catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE')`** — agent failure never breaks the build
- **`CLAUDE_MODEL` as a Jenkins credential** — switch models without code changes
- **`nodejs()` wrapper** — uses the Jenkins NodeJS plugin to ensure the right version
- **`when { changeRequest() }`** — only runs on PRs, not on branch builds
- **`CHANGE_ID`** — Jenkins built-in variable for the PR number

### With PR size thresholds (optional)

Skip trivially small PRs (< 5 lines) and excessively large ones (> 2000 lines):

```groovy
sh """
  node /tmp/pr-review-agent.cjs \
    --repo-slug ${env.APP_NAME} \
    --pr-id ${env.CHANGE_ID} \
    --min-changed-lines 5 \
    --max-changed-lines 2000
"""
```

Thresholds can also be set via environment variables (`MIN_CHANGED_LINES`,
`MAX_CHANGED_LINES`, `MIN_CHANGED_FILES`, `MAX_CHANGED_FILES`). See the
[README](../../README.md#environment-variables) for the full list.

---

## Credentials to Store in Jenkins

| Credential ID | Maps to env var | Description |
|---------------|-----------------|-------------|
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | Anthropic API key |
| `bitbucket-token` | `BITBUCKET_TOKEN` | Atlassian API token with Bitbucket scopes |
| `bitbucket-username` | `BITBUCKET_USERNAME` | Atlassian account email |
| `claude-model` | `CLAUDE_MODEL` | Claude model ID (e.g. `claude-sonnet-4-6`) |

All must be stored as **Secret text** credentials with masking enabled.

---

## Jenkins Environment Variables

| Variable | Source |
|----------|--------|
| `CHANGE_ID` | Jenkins built-in — PR number |
| `APP_NAME` | Set in pipeline `environment` block |
| `BITBUCKET_WORKSPACE` | Set in pipeline `environment` block |

---

## Shared Library (Optional, Not Required)

A shared Jenkins library is possible but not required. Each repo can add the stage
directly to its own Jenkinsfile — copy-paste is fine for a handful of repos.

If scaling to many repos, consider extracting to a shared library.

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
