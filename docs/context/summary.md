---
type: core
---

# Summary

PR Review Agent is a stateless CLI tool that reviews Bitbucket pull requests using Claude. Triggered by Jenkins on PR open/update, it fetches the diff and full file context via the Bitbucket REST API, assembles a structured system prompt (base template merged with repo-specific instructions), calls Claude, and posts a review comment directly on the PR. On re-triggers it skips duplicate reviews via commit hash deduplication, produces delta reviews focused on new commits only, and responds conversationally to developer questions on the review comment thread. No code is checked out; no data is stored beyond the current run.

**Stack:** TypeScript, Node.js, `@anthropic-ai/sdk`, `axios`, `commander`, esbuild (single-file CJS bundle).  
**VCS:** Bitbucket (primary production target); Azure DevOps (experimental, validated live on a cloud project); GitHub (experimental — same-repo PRs, triggered via GitHub Actions); filesystem adapter for `--benchmark`. The GitLab adapter is a stub.  
**Default models:** reviewer `claude-haiku-4-5-20251001` (`CLAUDE_MODEL`), judge `claude-sonnet-5` (`JUDGING_MODEL`, on by default; set empty to disable).
