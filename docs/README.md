# PR Review Agent — Documentation

Automated PR code review agent powered by Claude. Triggers via Jenkins on PR open/update,
fetches the diff + relevant context from Bitbucket, sends it to Claude, and posts a
structured review as a PR comment.

---

## Current Status

| Phase | Name | Status |
|-------|------|--------|
| [Phase 1](phases/phase-1-core.md) | Core Script (Local Testable) | ✅ Complete |
| [Phase 1b](phases/phase-1b-comment-replies.md) | Comment Reply Handling | ✅ Complete |
| [Phase 2](phases/phase-2-jenkins.md) | Jenkins Integration | ✅ Complete |
| [Phase 3](phases/phase-4-inline-comments.md) | Inline Line-Level Comments | ⏸ Deferred |
| [Backlog](phases/phase-5-backlog.md) | Further Backlog | ⏸ Deferred |

> Phase 1, 1b, and 2 are complete. Jenkins integration is live.
>
> [Multi-VCS Support](phases/phase-3-multi-vcs.md) has been moved to the backlog —
> Bitbucket is the only VCS needed for now.

---

## Architecture Docs

| Doc | Contents |
|-----|----------|
| [architecture/overview.md](architecture/overview.md) | Purpose, repository structure, tech stack, out of scope |
| [architecture/vcs-adapter.md](architecture/vcs-adapter.md) | VCS adapter interface definition |
| [architecture/context-strategy.md](architecture/context-strategy.md) | Context fetching logic, payload format sent to Claude |
| [architecture/prompt-convention.md](architecture/prompt-convention.md) | Repo-specific `.agent-review-instructions.md` system |

## Reference Docs

| Doc | Contents |
|-----|----------|
| [reference/env-vars.md](reference/env-vars.md) | All environment variables across phases |
| [reference/usage-logging.md](reference/usage-logging.md) | Usage logging, record schema, cost estimates, and analytics queries |
| [reference/copilot-integration.md](reference/copilot-integration.md) | Sharing prompt files with GitHub Copilot |

---

## Key Design Principles

- **No local git checkout** — everything goes through the VCS REST API only
- **Stateless per run** — no persistent database, no stored diffs
- **Comment only** — agent never modifies, approves, or merges PRs
- **Smart skip logic** — commit hash dedup, NO_CHANGE stop word, timestamp-based reply dedup
- **Conversational** — responds to developer questions on review comments
- **Optional judge model** — validates findings against the diff before posting (generator-verifier pattern)
- **VCS-agnostic architecture** — Bitbucket now, GitHub/GitLab later via adapter pattern
- **Repo-specific prompts** — each target repo can tune review behaviour via `.agent-review-instructions.md`
