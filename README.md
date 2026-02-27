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

# Agent identity (defaults to BITBUCKET_USERNAME, then 'Claude')
# AGENT_IDENTITY=

# Context limits (optional — these are the defaults)
MAX_CONTEXT_FILES=20
MAX_FILE_LINES=500
```

> **.env is gitignored.** Never commit it. Never hardcode secrets in source files.

---

## How It Works

The agent sends Claude **two things** for every review:

1. **The filtered diff** — all changed hunks across all files in the PR, with lock files
   stripped out (the raw diff is still used for line counting and threshold checks)
2. **Full file content** — for up to `MAX_CONTEXT_FILES` changed files (default: 20),
   fetched from the source branch. This gives Claude surrounding context beyond just
   the changed lines.

The context fetcher is selective about which files get full content:
- **Excluded:** lockfiles, `.min.js`, `.map`, snapshots, migrations, generated files
- **Skipped:** files over `MAX_FILE_LINES` (default: 500) unless they have high churn
  (>30% of lines changed)
- **Prioritized:** high-churn files are fetched first since they benefit most from
  full context

### Re-reviews and Delta Logic

On re-reviews (PR updated after a previous review), the agent sends its **most recent**
review comment and **all developer replies** across all previous reviews. Claude produces
a **delta review** focused on new code only — previous findings are briefly referenced in
the Summary ("still open" or "fixed") but not re-listed in Findings or Unresolved Questions.

If developers have replied to the previous review with explanations (e.g. "this is handled
in a different PR" or "the API contract guarantees X"), the agent includes those replies in
context. The prompt instructs Claude to treat developer replies as authoritative about
codebase state outside the diff.

If the new commits contain only cosmetic changes (typos, formatting, renames) with no
new or resolved findings, Claude returns a `NO_CHANGE` stop word and no comment is posted.

### Commit Hash Deduplication

Every review comment includes a footer with the source commit hash:

```
*Reviewed by Claude (claude-sonnet-4-6) | Prompt: .agent-review-instructions.md | Review #2 | Commit: a1b2c3d4e5f6*
```

On re-trigger, the agent compares this hash against the current PR source commit. If
they match (no new code pushed), it **skips the review API call entirely** — saving
time and tokens.

### Comment Reply Handling

When the commit hasn't changed but a developer has replied to the review comment with
a question (e.g. "Why is this HIGH severity?" or "This is intentional, does that change
your assessment?"), the agent detects the unanswered reply and sends it to Claude with
the diff and original review. Claude's response is posted as a **threaded reply** under
the relevant comment.

Replies use timestamp-based deduplication — if the agent has already responded, it won't
re-answer the same question on subsequent triggers.

See [docs/architecture/context-strategy.md](docs/architecture/context-strategy.md) for
the full payload format, skip logic, and exclusion rules.

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
| `--pr-id <id>` | **Yes**\* | Pull request ID to review |
| `--repo-slug <slug>` | **Yes** (Bitbucket) | Repository slug |
| `--workspace <workspace>` | No | Overrides `BITBUCKET_WORKSPACE` env var |
| `--vcs <provider>` | No | `bitbucket` \| `github` \| `gitlab` — overrides `VCS_PROVIDER` env var (default: `bitbucket`) |
| `--dry-run` | No | Print the review to stdout instead of posting to the PR |
| `--force` | No | Ignore previous reviews and produce a fresh review |
| `--log-usage [bool]` | No | Log usage record to `results.jsonl` (default: `true`, use `--log-usage false` to disable). See [docs/reference/token-budget.md](docs/reference/token-budget.md) for schema. |
| `--prompt <path>` | No | Path to a local prompt file (overrides repo `.agent-review-instructions.md`) |
| `--validate-prompt` | No | Validate prompt and exit — local via `--prompt`, or repo via `--pr-id` |
| `--min-changed-files <n>` | No | Skip review if PR has fewer changed files (overrides `MIN_CHANGED_FILES`) |
| `--max-changed-files <n>` | No | Skip review if PR has more changed files (overrides `MAX_CHANGED_FILES`) |
| `--min-changed-lines <n>` | No | Skip review if PR has fewer changed lines (overrides `MIN_CHANGED_LINES`) |
| `--max-changed-lines <n>` | No | Skip review if PR has more changed lines (overrides `MAX_CHANGED_LINES`) |

\* Not required when using `--validate-prompt --prompt <path>` (local file validation).

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
| `MAX_RETRIES` | `3` | Max retries on 429/5xx errors (exponential backoff) |
| `MAX_INPUT_TOKENS` | `150000` | Skip review if estimated input tokens exceed this value (0 = disabled) |
| `MAX_CONTEXT_FILES` | `20` | Max files to fetch full content for |
| `MAX_FILE_LINES` | `500` | Files over this line count get diff-only context |
| `MIN_CHANGED_FILES` | `0` (disabled) | Skip review if PR has fewer changed files |
| `MAX_CHANGED_FILES` | `0` (disabled) | Skip review if PR has more changed files |
| `MIN_CHANGED_LINES` | `0` (disabled) | Skip review if PR has fewer changed lines |
| `MAX_CHANGED_LINES` | `0` (disabled) | Skip review if PR has more changed lines |
| `AGENT_IDENTITY` | `BITBUCKET_USERNAME` | Name shown in review footers. Falls back to `BITBUCKET_USERNAME`, then `'Claude'` |

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
output format) and fills in four customisable sections per repo. To customise, add a file
called `.agent-review-instructions.md` to the **root or `docs/` directory** of the target repo (not this repo). The agent checks the PR's source branch first, then the target branch.

The file can include any combination of these sections:

| Section | Purpose | Default if missing |
|---------|---------|-------------------|
| `## ROLE` | Reviewer persona | "Senior Architect and Production Gatekeeper" |
| `## REVIEW PRIORITIES` | Technology-specific checklist | Generic priorities (logic, safety, correctness) |
| `## EXCEPTIONS` | Things to skip during review | No exceptions |
| `## MENTAL MODEL` | Assumptions about the environment | Production load, real users, large dataset, 3am |

YAML frontmatter (`---` delimited) is stripped before parsing, so the same file can include
metadata for other tools (e.g. GitHub Copilot `.prompt.md` files) without affecting the agent.

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
details and more examples. Full example prompts are in the [`prompts/`](prompts/) directory:

| File | Stack | Format |
|------|-------|--------|
| `prompts/angular-ionic.txt` | Angular / Ionic / Capacitor | Agent only |
| `prompts/java-spring.txt` | Java / Spring Boot / Hibernate | Agent only |
| `prompts/angular-ionic-copilot.prompt.md` | Angular / Ionic / Capacitor | Copilot + Agent |
| `prompts/angular-copilot.prompt.md` | Angular (web) | Copilot + Agent |

The `.prompt.md` files include YAML frontmatter and a `## HOW TO REVIEW` section for
GitHub Copilot — see [docs/reference/copilot-integration.md](docs/reference/copilot-integration.md).

---

## Jenkins Integration

Add an `AI Review` stage to your repo's Jenkinsfile. The bundle is downloaded at
build time — no cloning or `npm install` needed on the Jenkins agent.

```groovy
stage('AI Review') {
  when { changeRequest() }
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

Key points:
- **`catchError`** ensures agent failures never break the build
- **`CLAUDE_MODEL` as a credential** lets you switch models without code changes
- The bundle can also be served from a fixed path — see [docs/phases/phase-2-jenkins.md](docs/phases/phase-2-jenkins.md) for alternatives and full details

---

## Project Documentation

All design decisions, architecture, and per-phase plans live in [`docs/`](docs/):

| Doc | Contents |
|-----|----------|
| [docs/README.md](docs/README.md) | Phase status overview |
| [docs/architecture/overview.md](docs/architecture/overview.md) | Repo structure, tech stack |
| [docs/architecture/prompt-convention.md](docs/architecture/prompt-convention.md) | How `.agent-review-instructions.md` works |
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
