# Phase 2 — Jenkins Integration

## Goal

Auto-trigger the review agent on PR events. No manual steps required after setup.

## Status: 🔲 Not started

> **Prerequisite:** Phase 1 is complete — the agent works locally against real Bitbucket PRs.

---

## Tasks

- [ ] Write `Jenkinsfile.shared` snippet that calls the agent via `node dist/pr-review-agent.cjs`
- [ ] Store `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`, and `ANTHROPIC_API_KEY` as Jenkins masked credentials
- [ ] Pass PR metadata (workspace, repo slug, PR ID) from Jenkins env vars injected by Bitbucket webhook
- [ ] Create a shared Jenkins library in `devops-tools` repo so any Jenkinsfile can call:
  ```groovy
  @Library('devops-tools') _
  prReviewAgent()
  ```
- [ ] Add `node { label 'node-agent' }` requirement — ensure Node.js v20+ is available on Jenkins agent
- [ ] Add timeout + error handling: if review fails, log and continue (never break the build)
- [ ] Configure PR size thresholds (optional) to skip trivially small or excessively large PRs
- [ ] Test with a real PR webhook end-to-end

---

## Deployment

The agent ships as a **single-file bundle** (`dist/pr-review-agent.cjs`) with all
dependencies baked in. No `npm install` is needed on the Jenkins agent — only Node.js v20+.

Clone this repo to a fixed path on the Jenkins agent:

```bash
git clone <this-repo-url> /opt/pr-review-agent
```

To update, just `git pull` — the bundle is committed to the repo.

---

## Jenkinsfile Stage Example

```groovy
stage('AI PR Review') {
  when { changeRequest() }
  steps {
    withCredentials([
      string(credentialsId: 'anthropic-api-key', variable: 'ANTHROPIC_API_KEY'),
      string(credentialsId: 'bitbucket-token', variable: 'BITBUCKET_TOKEN'),
      string(credentialsId: 'bitbucket-username', variable: 'BITBUCKET_USERNAME')
    ]) {
      sh '''
        node /opt/pr-review-agent/dist/pr-review-agent.cjs \
          --workspace $BITBUCKET_WORKSPACE \
          --repo-slug $BITBUCKET_REPO_SLUG \
          --pr-id $BITBUCKET_PULL_REQUEST_ID
      '''
    }
  }
}
```

### With PR size thresholds (optional)

Skip trivially small PRs (< 5 lines) and excessively large ones (> 2000 lines):

```groovy
sh '''
  node /opt/pr-review-agent/dist/pr-review-agent.cjs \
    --workspace $BITBUCKET_WORKSPACE \
    --repo-slug $BITBUCKET_REPO_SLUG \
    --pr-id $BITBUCKET_PULL_REQUEST_ID \
    --min-changed-lines 5 \
    --max-changed-lines 2000
'''
```

Thresholds can also be set via environment variables (`MIN_CHANGED_LINES`,
`MAX_CHANGED_LINES`, `MIN_CHANGED_FILES`, `MAX_CHANGED_FILES`). See the
[README](../../README.md#environment-variables) for the full list.

---

## Jenkins Environment Variables (Injected by Bitbucket Webhook)

| Variable | Source |
|----------|--------|
| `BITBUCKET_WORKSPACE` | Bitbucket webhook payload |
| `BITBUCKET_REPO_SLUG` | Bitbucket webhook payload |
| `BITBUCKET_PULL_REQUEST_ID` | Bitbucket webhook payload |

---

## Credentials to Store in Jenkins

| Credential ID | Maps to env var | Description |
|---------------|-----------------|-------------|
| `anthropic-api-key` | `ANTHROPIC_API_KEY` | Anthropic API key |
| `bitbucket-token` | `BITBUCKET_TOKEN` | Atlassian API token with Bitbucket scopes |
| `bitbucket-username` | `BITBUCKET_USERNAME` | Atlassian account email |

All three must be stored as **Secret text** credentials with masking enabled.

---

## Completion Criteria

- Opening a PR in any configured repo automatically triggers a Jenkins build
- Review comment appears on the PR within a reasonable time (< 2 min)
- Build pipeline is **not** marked as failed if the review agent errors
- Credentials are masked in Jenkins logs

---

## Notes

- The agent is deployed at a fixed path on the Jenkins agent (e.g. `/opt/pr-review-agent`)
  OR run from a Docker image — decide during this phase
- Timeout for the review step should be set (suggested: 5 minutes max)
- The bundle is ~1.2 MB — lightweight enough to commit to the repo
