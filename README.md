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

## How It Works

The agent sends Claude **two things** for every review:

1. **The full unified diff** — all changed hunks across all files in the PR
2. **Full file content** — for up to `MAX_CONTEXT_FILES` changed files (default: 20),
   fetched from the source branch. This gives Claude surrounding context beyond just
   the changed lines.

The context fetcher is selective about which files get full content:
- **Excluded:** lockfiles, `.min.js`, `.map`, snapshots, migrations, generated files
- **Skipped:** files over `MAX_FILE_LINES` (default: 500) unless they have high churn
  (>30% of lines changed)
- **Prioritized:** high-churn files are fetched first since they benefit most from
  full context

On re-reviews (PR updated after a previous review), the agent also sends its earlier
review comments so Claude can produce a delta review — acknowledging fixes and only
flagging new or unresolved issues.

See [docs/architecture/context-strategy.md](docs/architecture/context-strategy.md) for
the full payload format and exclusion rules.

---

## Running

### From source (development)

```bash
npm run dev -- \
  --repo-slug your-repo \
  --pr-id 42
```

### From the bundle (production — no npm install needed)

The repo includes a pre-built single-file bundle at `dist/pr-review-agent.cjs`.
It has all dependencies baked in — only Node.js 20+ is required.

```bash
node dist/pr-review-agent.cjs \
  --repo-slug your-repo \
  --pr-id 42
```

Within ~30 seconds a review comment should appear on the PR in Bitbucket.

### Rebuilding the bundle

After making source changes, rebuild with:

```bash
npm run bundle
```

---

## CLI Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--pr-id <id>` | **Yes** | Pull request ID to review |
| `--repo-slug <slug>` | **Yes** (Bitbucket) | Repository slug |
| `--workspace <workspace>` | No | Overrides `BITBUCKET_WORKSPACE` env var |
| `--vcs <provider>` | No | `bitbucket` \| `github` \| `gitlab` — overrides `VCS_PROVIDER` env var (default: `bitbucket`) |
| `--dry-run` | No | Print the review to stdout instead of posting to the PR |
| `--prompt <path>` | No | Path to a local prompt file (overrides repo `.claude-review-prompt.md`) |
| `--min-changed-files <n>` | No | Skip review if PR has fewer changed files (overrides `MIN_CHANGED_FILES`) |
| `--max-changed-files <n>` | No | Skip review if PR has more changed files (overrides `MAX_CHANGED_FILES`) |
| `--min-changed-lines <n>` | No | Skip review if PR has fewer changed lines (overrides `MIN_CHANGED_LINES`) |
| `--max-changed-lines <n>` | No | Skip review if PR has more changed lines (overrides `MAX_CHANGED_LINES`) |

---

## Environment Variables

All credentials and settings are provided via environment variables.
**Never pass secrets as CLI arguments** — they appear in process lists and logs.

### Required

| Variable | Example | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Anthropic API key ([get one here](https://console.anthropic.com)) |
| `BITBUCKET_USERNAME` | `you@company.com` | Your Atlassian account email (HTTP Basic Auth username) |
| `BITBUCKET_TOKEN` | `ATATT3x...` | Atlassian API token with Bitbucket scopes |
| `BITBUCKET_WORKSPACE` | `my-workspace` | Bitbucket workspace slug (can also use `--workspace` flag) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `VCS_PROVIDER` | `bitbucket` | Which VCS adapter to use (`bitbucket` \| `github` \| `gitlab`) |
| `BITBUCKET_BASE_URL` | `https://api.bitbucket.org/2.0` | Bitbucket API base URL (change for self-hosted) |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model ID to use for reviews |
| `MAX_CONTEXT_FILES` | `20` | Max files to fetch full content for |
| `MAX_FILE_LINES` | `500` | Files over this line count get diff-only context |
| `MIN_CHANGED_FILES` | `0` (disabled) | Skip review if PR has fewer changed files |
| `MAX_CHANGED_FILES` | `0` (disabled) | Skip review if PR has more changed files |
| `MIN_CHANGED_LINES` | `0` (disabled) | Skip review if PR has fewer changed lines |
| `MAX_CHANGED_LINES` | `0` (disabled) | Skip review if PR has more changed lines |

### How to Provide Environment Variables

There are three ways to supply credentials, depending on your environment:

**Option 1: `.env` file (local development)**

Create a `.env` file in the directory where you run the agent. The agent uses
`dotenv` to load it automatically.

```bash
cp .env.example .env
# edit .env with your values
npm run dev -- --repo-slug my-repo --pr-id 42
```

**Option 2: Inline environment variables (standalone / one-off runs)**

Export them before running, or pass them inline:

```bash
ANTHROPIC_API_KEY=sk-ant-... \
BITBUCKET_USERNAME=you@company.com \
BITBUCKET_TOKEN=ATATT3x... \
BITBUCKET_WORKSPACE=my-workspace \
  node dist/pr-review-agent.cjs --repo-slug my-repo --pr-id 42
```

**Option 3: CI/CD secrets (Jenkins, GitHub Actions, etc.)**

Use your CI platform's secret management. For Jenkins:

```groovy
withCredentials([
  string(credentialsId: 'anthropic-api-key', variable: 'ANTHROPIC_API_KEY'),
  string(credentialsId: 'bitbucket-token', variable: 'BITBUCKET_TOKEN'),
  string(credentialsId: 'bitbucket-username', variable: 'BITBUCKET_USERNAME')
]) {
  sh 'node dist/pr-review-agent.cjs --repo-slug $REPO --pr-id $PR_ID'
}
```

> **Note:** The `.env` file approach also works on CI — just create it as a
> build step from secrets. But inline env vars or `withCredentials` are preferred
> since they don't write secrets to disk.

---

## Customising the Review Prompt

The agent uses a **base template** with shared rules (scope, mandatory rules, forbidden,
output format) and fills in three customisable sections per repo. To customise, add a file
called `.claude-review-prompt.md` to the **root of the target repo** (not this repo).

The file can include any combination of these sections:

| Section | Purpose | Default if missing |
|---------|---------|-------------------|
| `## ROLE` | Reviewer persona | "Senior Architect and Production Gatekeeper" |
| `## REVIEW PRIORITIES` | Technology-specific checklist | Generic priorities (logic, safety, correctness) |
| `## MENTAL MODEL` | Assumptions about the environment | Production load, real users, large dataset, 3am |

Example for a Java/Spring Boot project:

```markdown
## ROLE
You are a Senior Backend Architect and Production Gatekeeper.

## REVIEW PRIORITIES (STRICT ORDER)

### 1. Behavioral Differences (Highest Priority)
- Logic changes
- Query semantics (Hibernate / GORM / SQL)
- Transaction boundary changes
- API contract changes

### 2. Production Safety
- N+1 queries
- Missing indexes
- Deadlock risk
- Unbounded loops / retries

### 3. Correctness
- Null handling
- Concurrency issues
- Transaction isolation assumptions

## MENTAL MODEL
- Production load
- Real users
- Real money
- Large dataset
- It is 3am
```

Any section you omit uses the default. A file with only `## REVIEW PRIORITIES` is perfectly
valid — the base role and mental model will be used automatically.

The agent fetches this file via the Bitbucket API — no checkout required.
See [docs/architecture/prompt-convention.md](docs/architecture/prompt-convention.md) for
details and more examples. Full example prompts are in the [`prompts/`](prompts/) directory.

---

## Jenkins Integration (Phase 2)

Once you've verified local runs work, integrate into your Jenkins pipeline.
The pre-built bundle means **no `npm install` is needed** on the Jenkins agent — just
Node.js and the single file.

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

Requirements on the Jenkins agent:
- Node.js v20+ installed
- This repo cloned to a fixed path (e.g. `/opt/pr-review-agent`)
- Secrets stored as **masked** Jenkins credentials (see [Environment Variables](#environment-variables) above)

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
