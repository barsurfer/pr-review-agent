// PR Review Agent — Jenkins Pipeline Script
// Paste this into: Job → Pipeline → Definition → Pipeline script
//
// Prerequisites:
//   - Generic Webhook Trigger plugin
//   - NodeJS plugin (with 'Node20' installation configured)
//   - Lockable Resources plugin (optional, for per-PR dedup)
//   - Credentials: anthropic-api-key, bitbucket-token, bitbucket-username

pipeline {
    agent any

    options {
        quietPeriod(30)  // Coalesce rapid triggers (e.g. multiple pushes within 30s)
    }

    stages {
        stage('AI Review') {
            steps {
                script {
                    currentBuild.displayName = "#${BUILD_NUMBER}-${REPO_SLUG}-${PR_ID}"
                    currentBuild.description = "PR #${PR_ID} on ${REPO_SLUG}"
                }
                lock(resource: "review-${REPO_SLUG}-${PR_ID}", skipIfLocked: true) {
                    catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE') {
                        nodejs(nodeJSInstallationName: 'Node20') {
                            withCredentials([
                                string(credentialsId: 'anthropic-api-key', variable: 'ANTHROPIC_API_KEY'),
                                string(credentialsId: 'bitbucket-token', variable: 'BITBUCKET_TOKEN'),
                                string(credentialsId: 'bitbucket-username', variable: 'BITBUCKET_USERNAME')
                            ]) {
                                sh """
                                    curl -fsSL https://raw.githubusercontent.com/<org>/pr-review-agent/main/dist/pr-review-agent.cjs \
                                        -o /tmp/pr-review-agent.cjs
                                    node /tmp/pr-review-agent.cjs \
                                        --repo-slug "\$REPO_SLUG" \
                                        --pr-id "\$PR_ID" \
                                        --model "claude-haiku-4-5-20251001" \
                                        --judge-model "claude-sonnet-4-6"
                                """
                            }
                        }
                    }
                }
            }
            post {
                always {
                    sh 'cat results.jsonl >> /opt/pr-review-agent/results.jsonl 2>/dev/null || true'
                    archiveArtifacts artifacts: 'results.jsonl', allowEmptyArchive: true
                }
            }
        }
    }
}
