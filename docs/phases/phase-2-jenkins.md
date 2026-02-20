# Phase 2 — Jenkins Integration

## Goal

Auto-trigger the review agent on PR events. No manual steps required after setup.

## Status: 🔲 Not started

> **Prerequisite:** Phase 1 must be locally tested and working against a real Bitbucket PR
> before this phase begins.

---

## Tasks

- [ ] Write `Jenkinsfile.shared` snippet that calls the agent via `sh 'npx tsx src/index.ts ...'`
- [ ] Store `BITBUCKET_TOKEN` and `ANTHROPIC_API_KEY` as Jenkins masked credentials
- [ ] Pass PR metadata (workspace, repo slug, PR ID) from Jenkins env vars injected by Bitbucket webhook
- [ ] Create a shared Jenkins library in `devops-tools` repo so any Jenkinsfile can call:
  ```groovy
  @Library('devops-tools') _
  prReviewAgent()
  ```
- [ ] Add `node { label 'node-agent' }` requirement — ensure Node.js is available on Jenkins agent
- [ ] Add timeout + error handling: if review fails, log and continue (never break the build)
- [ ] Test with a real PR webhook end-to-end

---

## Jenkinsfile Stage Example

```groovy
stage('AI PR Review') {
  when { changeRequest() }
  steps {
    withCredentials([
      string(credentialsId: 'anthropic-api-key', variable: 'ANTHROPIC_API_KEY'),
      string(credentialsId: 'bitbucket-token', variable: 'BITBUCKET_TOKEN')
    ]) {
      sh '''
        cd /opt/pr-review-agent
        npx tsx src/index.ts \
          --workspace $BITBUCKET_WORKSPACE \
          --repo-slug $BITBUCKET_REPO_SLUG \
          --pr-id $BITBUCKET_PULL_REQUEST_ID
      '''
    }
  }
}
```

---

## Jenkins Environment Variables (Injected by Bitbucket Webhook)

| Variable | Source |
|----------|--------|
| `BITBUCKET_WORKSPACE` | Bitbucket webhook payload |
| `BITBUCKET_REPO_SLUG` | Bitbucket webhook payload |
| `BITBUCKET_PULL_REQUEST_ID` | Bitbucket webhook payload |

---

## Completion Criteria

- Opening a PR in any configured repo automatically triggers a Jenkins build
- Review comment appears on the PR within a reasonable time (< 2 min)
- Build pipeline is **not** marked as failed if the review agent errors
- Credentials are masked in Jenkins logs

---

## Notes

- The agent should be deployed at a fixed path on the Jenkins agent (e.g. `/opt/pr-review-agent`)
  OR run from a Docker image — decide during this phase
- Timeout for the review step should be set (suggested: 5 minutes max)
