# Environment Variables Reference

All variables across all phases. Only Phase 1 vars are required to start.

## Security Rule

**All API keys and tokens must be supplied via environment variables. Never hardcode
credentials in source code or commit them to version control.**

- Locally: use a `.env` file (`.env` is in `.gitignore`)
- In Jenkins: use masked credentials (`withCredentials` block) — see [phases/phase-2-jenkins.md](../phases/phase-2-jenkins.md)
- Never pass secrets as CLI arguments (they appear in process lists and logs)

---

## Phase 1 — Core (Required)

| Variable | Example | Description |
|----------|---------|-------------|
| `VCS_PROVIDER` | `bitbucket` | Which VCS adapter to use. Only `bitbucket` is implemented. |
| `BITBUCKET_BASE_URL` | `https://api.bitbucket.org/2.0` | Bitbucket API base URL (use your self-hosted URL if applicable) |
| `BITBUCKET_WORKSPACE` | `my-workspace` | Bitbucket workspace slug |
| `BITBUCKET_USERNAME` | `you@company.com` | Your Atlassian account email (used for HTTP Basic Auth) |
| `BITBUCKET_TOKEN` | `ATATT3x...` | Atlassian API token with Bitbucket scopes (replaces deprecated app passwords) |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Anthropic API key (billed separately from Claude.ai subscriptions) |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model ID to use for reviews |
| `MAX_RETRIES` | `3` | Max retries on 429/5xx errors (SDK built-in exponential backoff). Default: `3` |
| `MAX_INPUT_TOKENS` | `150000` | Skip review if estimated input tokens exceed this value (0 = disabled) |
| `MAX_CONTEXT_FILES` | `20` | Max number of files to fetch full content for |
| `MAX_FILE_LINES` | `500` | Files over this line count get diff-only (no full content) |
| `MIN_CHANGED_FILES` | `0` | Skip review if PR has fewer changed files (0 = disabled) |
| `MAX_CHANGED_FILES` | `200` | Skip review if PR has more changed files (0 = disabled). Default: `200` |
| `MIN_CHANGED_LINES` | `0` | Skip review if PR has fewer changed lines (0 = disabled) |
| `MAX_CHANGED_LINES` | `3000` | Skip review if PR has more changed lines (0 = disabled). Default: `3000` |
| `DIFF_EXCLUDE_PATTERNS` | `*.lock,*.json,*.spec.ts` | Comma-separated file patterns to strip from diff before sending to Claude. Default: `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml,*.json,*.spec.ts` |
| `JUDGING_MODEL` | `claude-sonnet-4-6` | Optional judge model for finding validation. Empty = skip judge pass. |
| `MAX_REPLY_COMMENTS` | `3` | Max agent reply comments per PR (0 = unlimited). Prevents runaway token usage on extended conversations. Default: `3` |
| `AGENT_IDENTITY` | *(BITBUCKET_USERNAME)* | Name shown in review/reply footers. Falls back to `BITBUCKET_USERNAME`, then `'Claude'` |

> Threshold variables can also be set via CLI flags (`--min-changed-files`, etc.)
> which override the env var values. `CLAUDE_MODEL` and `JUDGING_MODEL` can be
> overridden with `--model` and `--judge-model` respectively.

---

## Phase 3 — Inline Comments

| Variable | Example | Description |
|----------|---------|-------------|
| `REVIEW_MODE` | `summary` | `summary` \| `inline` \| `both`. Default: `summary` |
| `MAX_INLINE_COMMENTS` | `30` | Cap on inline comments per review. Remainder goes in summary. |

---

## Backlog — GitHub / GitLab Adapters

See [phases/phase-3-multi-vcs.md](../phases/phase-3-multi-vcs.md) for env vars
needed when GitHub/GitLab adapters are implemented.

---

## `.env.example`

```env
# VCS
VCS_PROVIDER=bitbucket
BITBUCKET_BASE_URL=https://api.bitbucket.org/2.0
BITBUCKET_WORKSPACE=
BITBUCKET_USERNAME=
BITBUCKET_TOKEN=

# Claude
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-4-6
MAX_RETRIES=3
# MAX_INPUT_TOKENS=150000

# Agent identity (defaults to BITBUCKET_USERNAME, then 'Claude')
# AGENT_IDENTITY=

# Reply limit — max agent reply comments per PR (0 = unlimited)
# MAX_REPLY_COMMENTS=3

# Context limits
MAX_CONTEXT_FILES=20
MAX_FILE_LINES=500

# PR size thresholds (0 = disabled)
MIN_CHANGED_FILES=0
MAX_CHANGED_FILES=200
MIN_CHANGED_LINES=0
MAX_CHANGED_LINES=3000

# Diff exclusion patterns (comma-separated, default includes lock files, .json, .spec.ts)
# DIFF_EXCLUDE_PATTERNS=*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml,*.json,*.spec.ts

# Judge model (optional — validates findings before posting, empty = skip)
# JUDGING_MODEL=claude-sonnet-4-6
```
