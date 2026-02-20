# Context Strategy

Diffs alone miss context. The agent fetches additional files so Claude can understand:

- What a changed method actually does in full
- What interfaces/contracts changed classes implement
- What the callers of a modified function look like

---

## Fetching Logic (`src/context/fetcher.ts`)

For each file in the diff:

1. Fetch the **full file content** from the PR branch (not just changed hunks)
2. Optionally detect imports/dependencies and fetch those files too (Phase 5)

### Exclusion Rules

Always skip (send diff-only):
- `*.lock`, `package-lock.json`, `yarn.lock`
- `*-generated.*`, `*.min.js`
- `db/migrate/*`
- `*.snap`
- Files over `MAX_FILE_LINES` lines (default: `500`)

Always include full content:
- Files where **>30% of lines changed** (high-churn = needs full context)

### Limits

| Config | Default | Purpose |
|--------|---------|---------|
| `MAX_CONTEXT_FILES` | `20` | Cap on full-file fetches |
| `MAX_FILE_LINES` | `500` | Skip threshold for large files |

---

## Payload Sent to Claude

```
[SYSTEM PROMPT — from .claude-review-prompt.md or fallback]

[USER MESSAGE]
## Pull Request: {title}
## Branch: {source} → {target}
## Description: {pr description if present}

## Diff:
{unified diff}

## Full file context:
### src/main/java/com/example/SomeService.java
{full file content}

### src/main/java/com/example/SomeRepository.java
{full file content}
...
```

---

## Phase 4: Numbered Lines for Inline Comments

In inline mode, lines are prefixed with their line number so Claude can reference them accurately:

```
[42] +    public void processOrder(Order order) {
[43] +        repository.save(order);
[44] +    }
```

See [phases/phase-4-inline-comments.md](../phases/phase-4-inline-comments.md) for full details
on the diff position mapping algorithm.
