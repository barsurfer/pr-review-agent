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

### Review Caching

Skip re-review if the diff hasn't changed since the last posted comment.

Approach: hash the diff content, store hash in the PR comment footer,
compare before triggering a new review.

Benefit: prevents duplicate reviews when Jenkins re-runs on unrelated triggers.

---

### Prompt Versioning

Track which prompt version (and which model) was used for each review.
Include in the comment footer:

```
*Reviewed by claude-sonnet-4-6 | Prompt: .claude-review-prompt.md@a3f9b2c | Agent v1.4.0*
```

Useful for debugging review quality regressions after prompt changes.

---

### GitHub and GitLab Inline Comments (Phase 5)

Full inline comment support for GitHub and GitLab adapters, following the same
pattern as Phase 4 (Bitbucket). Each has a different position format — see
[architecture/vcs-adapter.md](../architecture/vcs-adapter.md) for details.
