#!/usr/bin/env groovy
// Reference pipeline from a working job, sanitised: adapt the <placeholders>, shared library, credentials and settings maps (docs/reference/jenkins.md).
@Library("<shared-lib>") _

pipeline {
    environment {
        BITBUCKET_WORKSPACE = '<workspace>'
        NODE_VERSION = "22.14.0"
        DEFAULT_ENV_DEPLOY = '<env>'
        SONAR_SERVER = '<sonar-server>'

        LLM_PROVIDER='openrouter'
        MODEL_CONTEXT_TOKENS='1000000'

        MAX_CHANGED_LINES = '4500'

        ENABLE_NITPICKS = true
        ENABLE_JUDGE_KEEP_MINOR = true
        ENABLE_JUDGE_KEEP_UNVERIFIED = true
        SKIP_DIRECTED_REPLIES = true

        ENABLE_BREADTH_REVIEW = true
        BREADTH_MIN_FILES = '1'
        BREADTH_MIN_UNTOUCHED = '0'
    }

    agent {
        kubernetes {
            cloud k8s.getDefaultCloud()
            yaml k8s.getJenkinsWorkerPod()['podDefinition']
            defaultContainer k8s.getJenkinsWorkerPod()['defaultContainer']
        }
    }

    options {
        quietPeriod(30)
    }

    stages {
        stage('AI Review') {
            when {
                expression {
                    def allowedWorkspaces = [
                        '<workspace-2>',
                        '<workspace>'
                    ]
                    return allowedWorkspaces.contains(WORKSPACE_SLUG)
                }
            }
            steps {
                script {
                    currentBuild.displayName = "#${BUILD_NUMBER}-${WORKSPACE_SLUG}-${REPO_SLUG}-${PR_ID}"
                    currentBuild.description = "Review #${PR_ID} on ${REPO_SLUG} (${WORKSPACE_SLUG})"
                }
                script {
                    def cfg = settingsFor(env.WORKSPACE_SLUG, env.PROJECT_KEY ?: '', env.REPO_SLUG)
                    if (cfg.diffExclude) {
                        env.DIFF_EXCLUDE_PATTERNS = cfg.diffExclude
                    }
                    echo "Settings for ${env.REPO_SLUG}: branches=${cfg.branches}, model=${cfg.model}, judge=${cfg.judgeModel}, reply=${cfg.replyModel}, effort=${cfg.effort}/${cfg.judgeEffort}"

                    // Every event waits for a running review of the same PR, so neither a new head nor a person's comment is dropped.
                    // Bot comments never reach the job (webhook filter), and a queued event on an already-checked head ends without a model call.
                    lock(resource: "review-${WORKSPACE_SLUG}-${REPO_SLUG}-${PR_ID}") {
                        resolveReviewCommit()
                        // Read after the lock wait, so a review that finished meanwhile is already visible.
                        // Fails open: any error (e.g. a script-security rejection) just means no stored value.
                        def checked = ''
                        try {
                            checked = lastCheckedCommit(prKey(), env.PR_TARGET ?: '', 500)
                        } catch (e) {
                            echo "Checked-commit lookup failed, reviewing as usual (${e})"
                        }
                        echo(checked ? "Checked commit stored for this PR: ${checked}" : 'No checked commit stored for this PR')

                        catchError(buildResult: 'SUCCESS', stageResult: 'UNSTABLE') {
                            nodejs(nodeJSInstallationName: env.NODE_VERSION) {
                                withCredentials([
                                        string(credentialsId: 'review-agent-anthropic-api-key', variable: 'ANTHROPIC_API_KEY'),
                                        string(credentialsId: 'review-agent-bitbucket-token', variable: 'BITBUCKET_TOKEN'),
                                        string(credentialsId: 'review-agent-bitbucket-username', variable: 'BITBUCKET_USERNAME'),
                                        string(credentialsId: 'review-agent-model', variable: 'CLAUDE_MODEL')
                                ]) {
                                    sh 'curl -fsSL https://raw.githubusercontent.com/barsurfer/pr-review-agent/main/dist/pr-review-agent.cjs -o /tmp/pr-review-agent.cjs'
                                    def branchArgs = branchPolicyArgs(cfg.branches)
                                    def rc = 0
                                    // Env vars, not flags: an older bundle ignores unknown env vars but exits 1 on unknown flags.
                                    // TRIGGER_COMMENT_AUTHOR comes straight from the webhook ($.actor.uuid).
                                    withEnv(["TRIGGER_EVENT=${env.x_event_key ?: ''}", "LAST_CHECKED_COMMIT=${checked}"]) {
                                        rc = sh(returnStatus: true, script: """
                                            node /tmp/pr-review-agent.cjs \\
                                                --repo-slug "\$REPO_SLUG" \\
                                                --workspace "\$WORKSPACE_SLUG" \\
                                                --pr-id "\$PR_ID" \\
                                                --model '${cfg.model}' \\
                                                --judge-model '${cfg.judgeModel}' \\
                                                --reply-model '${cfg.replyModel}' \\
                                                --effort '${cfg.effort}' \\
                                                --judge-effort '${cfg.judgeEffort}' \\
                                                --max-output-tokens 64000 ${branchArgs}
                                        """)
                                    }
                                    // Still inside the lock, so the next queued build of this PR reads it. A failure here must not mark the review failed.
                                    try {
                                        def rec = readOwnRecord()
                                        env.REVIEW_STATUS_TEXT = statusText(rec)
                                        storeCheckedCommit(rec)
                                    } catch (e) {
                                        echo "Could not read this build's result record (${e})"
                                    }
                                    if (rc != 0) {
                                        error("Review agent exited with ${rc}")
                                    }
                                    env.REVIEW_DONE = 'true'
                                    // Generate plot data from results
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
                                            "
                                        fi
                                    '''
                                }
                            }
                        }
                    }
                }
            }
            post {
                always {
                    script {
                        // Always SUCCESSFUL: these repos block merges on failed or in-progress builds, and the AI review must never gate a merge.
                        if (env.REVIEW_DONE == 'true') {
                            postReviewStatus('SUCCESSFUL', env.REVIEW_STATUS_TEXT ?: 'Review complete')
                        } else if (currentBuild.result == 'ABORTED') {
                            postReviewStatus('SUCCESSFUL', 'Review aborted, see build log')
                        } else {
                            postReviewStatus('SUCCESSFUL', 'Review failed, see build log')
                        }
                    }
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
                    }
                }
            }
        }
    }
}


// ---------------------------------------------------------------------------------------------
// Review settings per project and per repository
// ---------------------------------------------------------------------------------------------

// A repo gets DEFAULTS, then its project's entry, then its own entry; a later key wins.
//   branches    'gitflow': the agent's defaults (PRs into main/master and release/hotfix sources are skipped)
//               'trunk'  : PRs into main, master or release/* only, from any source; stacked PRs wait until retargeted
//   model, judgeModel, replyModel, effort, judgeEffort: the agent's --model, --judge-model, --reply-model, --effort, --judge-effort
//   diffExclude : replaces the agent's DIFF_EXCLUDE_PATTERNS
// Projects are keyed 'workspace/PROJECT_KEY' ($.repository.project.key); repos by slug, as before.
def settingsFor(String workspace, String project, String repo) {
    def defaults = [
        branches   : 'gitflow',
        model      : 'anthropic/claude-haiku-5.5',
        judgeModel : 'anthropic/claude-haiku-5.5',
        replyModel : 'anthropic/claude-haiku-5.5',
        effort     : 'high',
        judgeEffort: 'high',
    ]
    def byProject = [
        '<workspace>/<TRUNK_PROJECT>': [branches: 'trunk'],
    ]
    def byRepo = [
        '<repo>': [diffExclude: '*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml,*.json'],
        // 'some-repo'            : [model: 'anthropic/claude-sonnet-5.5'],
    ]
    def cfg = [:]
    cfg.putAll(defaults)
    cfg.putAll(byProject["${workspace}/${project}".toString()] ?: [:])
    cfg.putAll(byRepo[repo] ?: [:])
    return cfg
}

def branchPolicyArgs(String branches) {
    if (branches != 'trunk') {
        return ''
    }
    // A bundle without these flags exits 1 on them, so pass them only when the downloaded bundle knows them.
    if (sh(returnStatus: true, script: "grep -q -- '--only-target-branches' /tmp/pr-review-agent.cjs") != 0) {
        echo "Bundle has no branch flags yet; ${env.REPO_SLUG} runs with the git-flow defaults"
        return ''
    }
    // The = form: an empty value is a real setting and can never swallow the next argument. Quoted so release/* never globs.
    // master is listed so a trunk repo created with master is not skipped silently.
    return "'--skip-target-branches=' '--only-target-branches=main,master,release/*' '--skip-source-branches=main,master'"
}


// ---------------------------------------------------------------------------------------------
// Checked-commit store: one value per PR, kept as variables on this job's builds
// ---------------------------------------------------------------------------------------------

def prKey() {
    return "bitbucket/${env.WORKSPACE_SLUG}/${env.REPO_SLUG}/${env.PR_ID}".toString()
}

// Newest head an earlier build recorded as checked for this PR, or '' so the agent reviews as it does today.
// The walk is bounded: a value older than maxBuilds builds is not found, which only costs a review.
@NonCPS
String lastCheckedCommit(String key, String target, int maxBuilds) {
    // Without the current target a retarget can't be ruled out, and reviewing again is the safe side.
    if (!target) {
        return ''
    }
    def b = currentBuild.previousBuild
    int seen = 0
    while (b != null && seen < maxBuilds) {
        def v = b.buildVariables
        if (v.CHECKED_PR_KEY == key && v.CHECKED_COMMIT) {
            // A head checked against another target proves nothing for this one (retarget without a push).
            return v.CHECKED_TARGET == target ? v.CHECKED_COMMIT : ''
        }
        b = b.previousBuild
        seen++
    }
    return ''
}

// This build's own record in results.jsonl, matched by job and build number, or null.
def readOwnRecord() {
    if (!fileExists('results.jsonl')) {
        return null
    }
    def rec = null
    for (String line : readFile('results.jsonl').split('\n')) {
        if (!line.trim()) {
            continue
        }
        try {
            def r = readJSON(text: line)
            // A JSON null comes back as JSONNull, which is not a Map, so a record without jenkins never matches.
            if (r.jenkins instanceof Map && r.jenkins.job == env.JOB_NAME && r.jenkins.build == env.BUILD_NUMBER) {
                rec = r
            }
        } catch (e) {
            echo "Skipping an unreadable results.jsonl line (${e.message})"
        }
    }
    return rec
}

// readJSON turns a JSON null into JSONNull, which is truthy and prints "null", so text fields are read through this.
def str(value) {
    return value instanceof String ? value : ''
}

// Keeps the checked_commit this build's agent run reported, as build variables that later builds of the PR read.
// Stores nothing when the field is absent, so the value from an earlier build stays in force.
def storeCheckedCommit(rec) {
    if (rec == null || !str(rec.checked_commit)) {
        return
    }
    if (str(rec.vcs) != 'bitbucket' || str(rec.workspace) != env.WORKSPACE_SLUG || str(rec.repo_slug) != env.REPO_SLUG || str(rec.pr_id) != env.PR_ID) {
        echo "Not storing checked commit: the record is for ${str(rec.workspace)}/${str(rec.repo_slug)}#${str(rec.pr_id)}"
        return
    }
    env.CHECKED_PR_KEY = prKey()
    env.CHECKED_COMMIT = str(rec.checked_commit)
    env.CHECKED_TARGET = str(rec.target_branch)
    echo "Stored checked commit ${env.CHECKED_COMMIT} (target ${env.CHECKED_TARGET})"
}

// One line for the Bitbucket build status, so the PR shows what the run did and at which head. The state stays SUCCESSFUL.
def statusText(rec) {
    if (rec == null) {
        return 'Review complete'
    }
    def head = str(rec.checked_commit) ?: str(rec.source_commit)
    def at = (head && head != 'unknown') ? " at ${head.take(12)}" : ''
    switch (str(rec.action)) {
        case 'REVIEW':          return "Reviewed${at}".toString()
        case 'RE_REVIEW':       return "Re-reviewed${at}".toString()
        case 'NO_NEW_FINDINGS': return "No new findings${at}".toString()
        case 'NO_CHANGE':       return "No material change${at}".toString()
        case 'REPLY':           return "Replied to comments${at}".toString()
        case 'DEDUP_SKIP':      return "Already reviewed${at}".toString()
        case 'SKIP':            return "Not reviewed: ${str(rec.skip_reason)}".toString().take(120)
        default:                return "Review complete${at}".toString()
    }
}


// ---------------------------------------------------------------------------------------------
// Bitbucket Cloud commit build status for the PR head commit
// ---------------------------------------------------------------------------------------------

// Best-effort: a failure here is logged and never fails the build. Same key on every post = one status that gets updated.
// Only ever posted as SUCCESSFUL, once per run at the end: an INPROGRESS or failed state would block merges.
// https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commit-statuses/

def resolveReviewCommit() {
    try {
        withBitbucketCredentials {
            def pr = readJSON text: sh(returnStdout: true, script: '''
                curl -fsS -u "$BITBUCKET_USERNAME:$BITBUCKET_TOKEN" \
                    "https://api.bitbucket.org/2.0/repositories/$WORKSPACE_SLUG/$REPO_SLUG/pullrequests/$PR_ID"
            ''')
            // The destination at run time, not from the webhook: a retarget may have landed while this build waited.
            env.PR_TARGET = pr.destination.branch.name
            // PR payloads carry a 12-char hash; resolve it to the full one
            env.REVIEW_SHORT_HASH = pr.source.commit.hash
            def commit = readJSON text: sh(returnStdout: true, script: '''
                curl -fsS -u "$BITBUCKET_USERNAME:$BITBUCKET_TOKEN" \
                    "https://api.bitbucket.org/2.0/repositories/$WORKSPACE_SLUG/$REPO_SLUG/commit/$REVIEW_SHORT_HASH"
            ''')
            env.REVIEW_COMMIT = commit.hash
        }
    } catch (e) {
        echo "Bitbucket status: could not resolve PR head commit, statuses skipped (${e.message})"
    }
}

def postReviewStatus(String state, String description) {
    if (!env.REVIEW_COMMIT) {
        return
    }
    try {
        withBitbucketCredentials {
            // BITBUCKET_USERNAME only exists inside the credentials block
            String username = sh(returnStdout: true, script: 'printf %s "$BITBUCKET_USERNAME"')
            String label = "${username} PR Review"
            writeJSON file: 'bb-status.json', json: [
                key        : label.take(40), // Bitbucket Cloud status keys max out at 40 chars
                name       : label,
                state      : state,
                url        : env.BUILD_URL,
                description: description
            ]
            sh '''
                curl -fsS -o /dev/null -u "$BITBUCKET_USERNAME:$BITBUCKET_TOKEN" \
                    -H 'Content-Type: application/json' --data @bb-status.json \
                    "https://api.bitbucket.org/2.0/repositories/$WORKSPACE_SLUG/$REPO_SLUG/commit/$REVIEW_COMMIT/statuses/build"
            '''
        }
    } catch (e) {
        echo "Bitbucket status: failed to post ${state} (${e.message})"
    }
}

// Same account the review agent uses. Posting a status needs write:repository:bitbucket;
// without it the POST 403s and postReviewStatus just logs it.
def withBitbucketCredentials(Closure body) {
    withCredentials([
            string(credentialsId: 'review-agent-bitbucket-token', variable: 'BITBUCKET_TOKEN'),
            string(credentialsId: 'review-agent-bitbucket-username', variable: 'BITBUCKET_USERNAME')
    ]) {
        body()
    }
}
