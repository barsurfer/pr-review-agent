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
| `BITBUCKET_TOKEN` | `your-app-password` | Bitbucket app password or access token |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | Anthropic API key |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Claude model ID to use for reviews |
| `MAX_CONTEXT_FILES` | `20` | Max number of files to fetch full content for |
| `MAX_FILE_LINES` | `500` | Files over this line count get diff-only (no full content) |

---

## Phase 4 — Inline Comments

| Variable | Example | Description |
|----------|---------|-------------|
| `REVIEW_MODE` | `summary` | `summary` \| `inline` \| `both`. Default: `summary` |
| `MAX_INLINE_COMMENTS` | `30` | Cap on inline comments per review. Remainder goes in summary. |

---

## Phase 3 — GitHub Adapter

| Variable | Example | Description |
|----------|---------|-------------|
| `GITHUB_BASE_URL` | `https://api.github.com` | GitHub API base URL |
| `GITHUB_TOKEN` | `ghp_...` | GitHub personal access token |
| `GITHUB_OWNER` | `my-org` | GitHub org or username |

---

## Phase 3 — GitLab Adapter

| Variable | Example | Description |
|----------|---------|-------------|
| `GITLAB_BASE_URL` | `https://gitlab.com/api/v4` | GitLab API base URL |
| `GITLAB_TOKEN` | `glpat-...` | GitLab personal access token |
| `GITLAB_PROJECT_ID` | `12345` | GitLab numeric project ID |

---

## `.env.example` (Phase 1)

```env
# VCS
VCS_PROVIDER=bitbucket
BITBUCKET_BASE_URL=https://api.bitbucket.org/2.0
BITBUCKET_WORKSPACE=
BITBUCKET_TOKEN=

# Claude
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-4-6

# Context limits
MAX_CONTEXT_FILES=20
MAX_FILE_LINES=500
```
