# PR Review Agent

Automated pull request code reviewer powered by Claude. When a PR is opened or updated,
the agent fetches the diff and relevant file context from your VCS, sends it to Claude,
and posts a structured review comment directly on the PR.

**Current VCS support:** Bitbucket (GitHub and GitLab coming in Phase 3)

---

## Prerequisites

Install these before anything else:

### 1. Node.js (v20) via NVM (recommended)

Using NVM lets you match the exact Node version this project requires.

**Windows** — install [nvm-windows](https://github.com/coreybutler/nvm-windows/releases)
(download `nvm-setup.exe`), then in a new terminal:

```bash
nvm install 20
nvm use 20
```

**macOS/Linux** — install [nvm](https://github.com/nvm-sh/nvm), then:

```bash
nvm install 20
nvm use 20
```

The repo includes a `.nvmrc` file pinned to Node 20, so you can also just run:

```bash
nvm use       # reads .nvmrc automatically
```

Verify:
```bash
node --version   # should print v20.x.x
npm --version    # should print 10.x or higher
```

### 2. A Bitbucket App Password

You need a Bitbucket account with access to the target repo and an app password
that has the following permissions:

- **Repositories:** Read
- **Pull requests:** Read + Write (Write is needed to post the review comment)

Create one at: Bitbucket → Personal Settings → App passwords

### 3. An Anthropic API Key

Get one at [console.anthropic.com](https://console.anthropic.com).
Make sure the key has access to `claude-sonnet-4-6`.

---

## Setup

### 1. Clone the repo

```bash
git clone <this-repo-url>
cd pr-review-agent
```

### 2. Install dependencies

```bash
npm install
```

This installs:

| Package | Purpose |
|---------|---------|
| `tsx` | Runs TypeScript directly without a separate compile step |
| `@anthropic-ai/sdk` | Official Anthropic client for calling Claude |
| `axios` | HTTP client for Bitbucket REST API calls |
| `commander` | CLI argument parsing |
| `dotenv` | Loads `.env` file into `process.env` |
| `typescript` | TypeScript compiler (dev dependency) |
| `@types/node` | Node.js type definitions (dev dependency) |

### 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
# Which VCS to use — only 'bitbucket' is implemented
VCS_PROVIDER=bitbucket

# Bitbucket — get base URL from your Bitbucket instance
# Cloud: https://api.bitbucket.org/2.0
# Self-hosted (Bitbucket Server/DC): https://bitbucket.yourcompany.com/rest/api/1.0
BITBUCKET_BASE_URL=https://api.bitbucket.org/2.0
BITBUCKET_WORKSPACE=your-workspace-slug
BITBUCKET_TOKEN=your-app-password

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-6

# Context limits (optional — these are the defaults)
MAX_CONTEXT_FILES=20
MAX_FILE_LINES=500
```

> **.env is gitignored.** Never commit it. Never hardcode secrets in source files.

---

## Running Locally

Point the agent at any open PR:

```bash
npx tsx src/index.ts \
  --workspace your-workspace \
  --repo-slug your-repo \
  --pr-id 42
```

Within ~30 seconds a review comment should appear on the PR in Bitbucket.

### Optional flags

```bash
--vcs bitbucket        # VCS provider (default: bitbucket, matches VCS_PROVIDER env var)
--dry-run              # Assemble and print the prompt without calling Claude or posting
```

---

## Customising the Review Prompt

By default the agent uses a generic prompt. To customise how Claude reviews a specific repo,
add a file called `.claude-review-prompt.md` to the **root of that target repo**
(not this repo — the repo being reviewed).

Example for a Java/Spring Boot project:

```markdown
You are a senior backend engineer reviewing Java + Spring Boot pull requests.

Focus on:
- Correctness of business logic and edge cases
- Transaction boundaries and data consistency
- Security: input validation, auth checks, SQL injection surface
- Performance: N+1 queries, missing indexes, unbounded queries

Do not nitpick formatting or variable naming unless it causes ambiguity.
Output a structured review with sections: Summary, Critical Issues, Warnings, Suggestions.
```

The agent fetches this file via the Bitbucket API — no checkout required.
See [docs/architecture/prompt-convention.md](docs/architecture/prompt-convention.md) for the full resolution order and more examples.

---

## Jenkins Integration (Phase 2)

Once you've verified local runs work, integrate into your Jenkins pipeline:

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

Requirements on the Jenkins agent node:
- Node.js v18+ installed
- This repo checked out or deployed to a fixed path (e.g. `/opt/pr-review-agent`)
- `npm install` run on that path
- `BITBUCKET_TOKEN` and `ANTHROPIC_API_KEY` stored as **masked** Jenkins credentials

See [docs/phases/phase-2-jenkins.md](docs/phases/phase-2-jenkins.md) for the full guide.

---

## Project Documentation

All design decisions, architecture, and per-phase plans live in [`docs/`](docs/):

| Doc | Contents |
|-----|----------|
| [docs/README.md](docs/README.md) | Phase status overview |
| [docs/architecture/overview.md](docs/architecture/overview.md) | Repo structure, tech stack |
| [docs/architecture/prompt-convention.md](docs/architecture/prompt-convention.md) | How `.claude-review-prompt.md` works |
| [docs/reference/env-vars.md](docs/reference/env-vars.md) | All environment variables |
| [docs/reference/local-testing.md](docs/reference/local-testing.md) | Local test guide + troubleshooting |

---

## What the Agent Does NOT Do

- It does not checkout your code — everything goes through the VCS API
- It does not approve, merge, or modify PRs — it comments only
- It does not store diffs or file contents — stateless per run
