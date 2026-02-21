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

### 2. A Bitbucket API Token

> **Note:** Bitbucket App Passwords were deprecated in September 2025 and replaced
> by Atlassian API Tokens.

Create a scoped API token:

1. Go to [id.atlassian.com](https://id.atlassian.com) → **Security** → **Create and manage API tokens**
2. Click **Create API token with scopes**
3. Give it a name (e.g. `pr-review-agent`) and set an expiry
4. Select **Bitbucket** as the app
5. Select these scopes:
   - `read:repository:bitbucket` — read diffs, source files, commits
   - `read:pullrequest:bitbucket` — read PR metadata and comments
   - `write:pullrequest:bitbucket` — post review comments
6. Confirm and copy the token (starts with `ATATT3x...`)

Authentication uses **HTTP Basic Auth** with your Atlassian account email as the
username and the API token as the password. You'll need both `BITBUCKET_USERNAME`
(your email) and `BITBUCKET_TOKEN` in your `.env`.

### 3. An Anthropic API Key

Get one at [console.anthropic.com](https://console.anthropic.com).

> **Important:** The Anthropic API is billed separately from a Claude.ai / Claude Code
> subscription. You need to add credits at
> [console.anthropic.com/settings/billing](https://console.anthropic.com/settings/billing)
> for API calls to work.

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
BITBUCKET_USERNAME=your-atlassian-email@company.com
BITBUCKET_TOKEN=ATATT3x...

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
--dry-run              # Run the full review but print output to stdout instead of posting to the PR
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
      string(credentialsId: 'bitbucket-token', variable: 'BITBUCKET_TOKEN'),
      string(credentialsId: 'bitbucket-username', variable: 'BITBUCKET_USERNAME')
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
- `BITBUCKET_TOKEN`, `BITBUCKET_USERNAME`, and `ANTHROPIC_API_KEY` stored as **masked** Jenkins credentials

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

## Troubleshooting

### 401 Unauthorized from Bitbucket

- **Wrong token type:** You need an Atlassian API token created at
  [id.atlassian.com](https://id.atlassian.com), not a Jira/Confluence-only token.
  When creating, make sure you select **Bitbucket** as the app and pick the right scopes.
- **Missing scopes:** The token must have `read:repository:bitbucket`,
  `read:pullrequest:bitbucket`, and `write:pullrequest:bitbucket`. Without
  `read:repository`, diffs and source files will return 401 even if PR metadata works.
- **Wrong email:** `BITBUCKET_USERNAME` must be the email you log into Atlassian with
  (check under Bitbucket → Personal Settings → Email Aliases).
- **Token has `=` in it:** If you test with `source .env` in bash, the `=` characters
  inside the token value will break shell parsing. The agent uses `dotenv` which handles
  this correctly, so always test via `npx tsx src/index.ts`, not by sourcing `.env`.

### 404 on diff/diffstat endpoints

Bitbucket's PR diff and diffstat endpoints return a **302 redirect**. Some HTTP clients
(including axios by default) strip auth headers on redirect. The agent handles this
automatically — if you see 404s, make sure you're running the latest code.

### Anthropic API errors

- **401 / "Invalid API key":** Double-check `ANTHROPIC_API_KEY` in your `.env`.
- **402 / "Insufficient credits":** The Anthropic API is pay-per-use, separate from
  any Claude.ai subscription. Add credits at
  [console.anthropic.com/settings/billing](https://console.anthropic.com/settings/billing).

---

## What the Agent Does NOT Do

- It does not checkout your code — everything goes through the VCS API
- It does not approve, merge, or modify PRs — it comments only
- It does not store diffs or file contents — stateless per run
