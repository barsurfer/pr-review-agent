---
type: core
---

# Summary

PR Review Agent is a stateless CLI tool that reviews Bitbucket pull requests using Claude. Triggered by Jenkins on PR open/update, it fetches the diff and full file context via the Bitbucket REST API, assembles a structured system prompt (base template merged with repo-specific instructions), calls Claude, and posts a review comment directly on the PR. On re-triggers it skips duplicate reviews via commit hash deduplication, produces delta reviews focused on new commits only, and responds conversationally to developer questions on the review comment thread. No code is checked out; no data is stored beyond the current run.

**Stack:** TypeScript, Node.js, `@anthropic-ai/sdk`, `axios`, `commander`, esbuild (single-file CJS bundle).  
**VCS:** Bitbucket (production). GitHub/GitLab adapters are stubs.  
**Default model:** `claude-sonnet-4-6`, configurable via `CLAUDE_MODEL`. Optional judge model via `JUDGING_MODEL`.
