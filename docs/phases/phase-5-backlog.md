# Phase 5 — Further Backlog

## Status: ⏸ Deferred

Items to consider after Phase 4 is stable. Not prioritised — order to be decided
based on what matters most in practice.

---

## Items

### Import Graph Context

Parse imports from changed files and automatically fetch direct dependencies for
deeper context. For example: if `OrderService.java` is changed and imports
`OrderRepository`, fetch `OrderRepository.java` too.

Complexity: medium-high. Language-specific import parsing required.

---

### Cost Control

- Log token usage (input + output) per review run
- Alert (log warning or send notification) if token usage exceeds a configurable threshold
- Per-repo cost tracking if multiple repos are reviewed

---

### ~~Review Caching~~ ✅ Implemented (Phase 1)

> **Completed.** The agent embeds the source commit hash in the review comment footer
> (`Commit: a1b2c3d4e5f6`). On re-trigger, it compares the footer hash against the
> current PR source commit — if they match, it skips the review API call entirely
> (or checks for unanswered developer replies via Phase 1b).
>
> Additionally, a `NO_CHANGE` stop word prevents posting duplicate comments when
> delta reviews find only cosmetic changes.

---

### ~~Prompt Versioning~~ ✅ Implemented (Phase 1)

> **Completed.** The review comment footer already includes model, prompt source,
> review number, and commit hash:
>
> ```
> *Reviewed by Claude (claude-sonnet-4-6) | Prompt: .claude-review-prompt.md | Review #2 | Commit: a1b2c3d4e5f6*
> ```
>
> Agent version tracking is not yet included — add if needed for debugging regressions.

---

### GitHub and GitLab Inline Comments (Phase 5)

Full inline comment support for GitHub and GitLab adapters, following the same
pattern as Phase 4 (Bitbucket). Each has a different position format — see
[architecture/vcs-adapter.md](../architecture/vcs-adapter.md) for details.
