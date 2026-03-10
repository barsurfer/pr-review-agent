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
                            // Generate plot data from results (needs Node)
                            sh '''
                                if [ -f results.jsonl ]; then
                                    node -e "
                                      const fs = require('fs');
                                      const lines = fs.readFileSync('results.jsonl','utf8').trim().split('\\n');
                                      const r = JSON.parse(lines[lines.length - 1]);
                                      const props = [
                                        'YVALUE=' + (r.cost_usd || 0)
                                      ].join('\\n');
                                      fs.writeFileSync('plot-cost.properties', props);
                                      fs.writeFileSync('plot-tokens.properties', 'YVALUE=' + ((r.tokens && r.tokens.input) || 0));
                                      fs.writeFileSync('plot-duration.properties', 'YVALUE=' + (r.duration_ms || 0));
                                      if (r.touch_rate != null) fs.writeFileSync('plot-touchrate.properties', 'YVALUE=' + r.touch_rate);
                                    "
                                fi
                            '''
                        }
                    }
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'results.jsonl', allowEmptyArchive: true
                    script {
                        if (fileExists('plot-cost.properties')) {
                            plot group: 'Review Metrics', style: 'line', csvFileName: 'plot-cost.csv',
                                 title: 'Cost per Review (USD)', yaxis: 'USD',
                                 propertiesSeries: [[file: 'plot-cost.properties', label: 'cost']]
                            plot group: 'Review Metrics', style: 'line', csvFileName: 'plot-tokens.csv',
                                 title: 'Input Tokens', yaxis: 'Tokens',
                                 propertiesSeries: [[file: 'plot-tokens.properties', label: 'tokens']]
                            plot group: 'Review Metrics', style: 'line', csvFileName: 'plot-duration.csv',
                                 title: 'Duration (ms)', yaxis: 'ms',
                                 propertiesSeries: [[file: 'plot-duration.properties', label: 'duration']]
                        }
                        if (fileExists('plot-touchrate.properties')) {
                            plot group: 'Review Metrics', style: 'line', csvFileName: 'plot-touchrate.csv',
                                 title: 'Finding Touch Rate (%)', yaxis: '%',
                                 propertiesSeries: [[file: 'plot-touchrate.properties', label: 'touch_rate']]
                        }
                    }
                }
            }
        }
    }
}
