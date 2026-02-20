# Comment Format

## Summary Mode (Phase 1 default)

Claude is instructed via the system prompt to always output in this exact structure:

```markdown
## 🤖 Automated PR Review

### Summary
{2-3 sentence overview of what the PR does and overall quality}

### 🔴 Critical Issues
{Blockers — correctness bugs, security issues, data integrity risks}

### 🟡 Warnings
{Non-blocking but important — performance, missing error handling, unclear contracts}

### 🟢 Suggestions
{Nice-to-haves — refactoring ideas, readability, test coverage gaps}

### ✅ Looks Good
{What was done well — acknowledge positives}

---
*Reviewed by Claude ({model}) | Prompt: {prompt source}*
```

The footer should indicate:
- Which Claude model was used (e.g. `claude-sonnet-4-6`)
- Where the system prompt came from (e.g. `.claude-review-prompt.md`, `prompts/java-spring.txt`, or `default`)

---

## Inline Mode (Phase 4)

In inline mode, Claude returns JSON instead of markdown prose.
See [phases/phase-4-inline-comments.md](../phases/phase-4-inline-comments.md) for the full schema.

After posting inline comments, a summary comment is always posted:

```markdown
## 🤖 Automated PR Review — Summary

{summary text from Claude JSON}

| Severity | Count |
|----------|-------|
| 🔴 Critical | 2 |
| 🟡 Warning | 5 |
| 🟢 Suggestion | 3 |

*10 inline comments posted. Reviewed by Claude (claude-sonnet-4-6) | Prompt: .claude-review-prompt.md*
```
