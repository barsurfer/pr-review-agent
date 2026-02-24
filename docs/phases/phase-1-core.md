# Phase 1 — Core Script (Local Testable)

## Goal

Working end-to-end locally with a real PR, real Bitbucket, real Claude.
No Jenkins. No CI. Just a CLI you can run from your terminal.

## Status: ✅ Complete

---

## Tasks

- [x] Project scaffold: `ts-node`, `tsx`, `@anthropic-ai/sdk`, `axios`, `commander`
- [x] `src/vcs/bitbucket.ts` — implement all `VCSAdapter` interface methods using Bitbucket REST API v2
- [x] `src/prompt/loader.ts` — fetch `.agent-review-instructions.md` from repo root via API, fallback chain
- [x] `src/context/fetcher.ts` — fetch full file contents for changed files with exclusion rules
- [x] `src/claude/client.ts` — send assembled payload to `claude-sonnet-4-6`, return review text
- [x] `src/review.ts` — orchestrate: fetch info → check previous reviews → load prompt → fetch context → call Claude → post comment
- [x] `src/index.ts` — CLI: `--workspace`, `--repo-slug`, `--pr-id`, `--vcs` (default: `bitbucket`), `--dry-run`
- [x] `.env.example` with all required vars
- [x] Local test: run against a real open PR, verify comment appears in Bitbucket

---

## Required Environment Variables

```env
VCS_PROVIDER=bitbucket
BITBUCKET_BASE_URL=https://api.bitbucket.org/2.0
BITBUCKET_WORKSPACE=your-workspace
BITBUCKET_TOKEN=your-app-password
ANTHROPIC_API_KEY=your-key
CLAUDE_MODEL=claude-sonnet-4-6
MAX_CONTEXT_FILES=20
MAX_FILE_LINES=500
```

---

## CLI Usage

```bash
npx tsx src/index.ts \
  --workspace myws \
  --repo-slug myrepo \
  --pr-id 42
```

---

## Completion Criteria

- Agent posts a formatted review comment on a real Bitbucket PR
- Comment follows the structure defined in [reference/comment-format.md](../reference/comment-format.md)
- Exclusion rules correctly skip lockfiles and generated files
- Prompt resolution falls back correctly through the chain
- No errors on a PR with >10 changed files
- Re-running against a PR that already has a review produces a delta review (no duplicated issues, fixed items acknowledged)

---

## Notes

- See [architecture/vcs-adapter.md](../architecture/vcs-adapter.md) for the interface to implement
- See [architecture/context-strategy.md](../architecture/context-strategy.md) for fetcher logic
- See [reference/local-testing.md](../reference/local-testing.md) for the test procedure
- GitHub/GitLab adapter stubs (`src/vcs/github.ts`, `src/vcs/gitlab.ts`) should be created but throw `NotImplementedError`
