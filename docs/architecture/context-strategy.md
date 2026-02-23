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

### Full Review (first review or delta review)

```
[SYSTEM PROMPT — base template with repo sections filled in]

[USER MESSAGE]
## Pull Request: {title}
## Branch: {source} → {target}
## Description: {pr description if present}

## Previous Review(s) by This Agent (N total):
### Review from {timestamp}:
{previous review body — only included on delta reviews}

## Diff:
{unified diff}

## Full file context:
### src/main/java/com/example/SomeService.java
{full file content}

### src/main/java/com/example/SomeRepository.java
{full file content}
...
```

### Comment Reply (same commit, developer asked a question)

```
[SYSTEM PROMPT — reply-prompt.txt]

[USER MESSAGE]
## Your Original Review:
{last review body}

## Diff:
{unified diff}

## Developer Replies (answer all of these):
**John Smith** (2025-01-15T10:30:00Z):
> Can you explain why this is HIGH severity?
```

---

## Review Comment Footer

Every review comment posted by the agent includes a structured footer:

```
*Reviewed by Claude (claude-sonnet-4-6) | Prompt: .claude-review-prompt.md | Review #2 | Commit: a1b2c3d4e5f6*
```

The footer serves multiple purposes:

| Field | Purpose |
|-------|---------|
| Model | Tracks which Claude model produced the review |
| Prompt source | Shows whether repo prompt or default was used |
| Review number | Sequential count for this PR |
| Commit hash | **Deduplication key** — on re-trigger, the agent compares this against the current source commit to skip redundant API calls |

Reply comments use a lighter footer: `*Reply by Claude (claude-sonnet-4-6)*`

The base prompt includes a FORBIDDEN rule preventing Claude from generating its own footer
(it was observed copying the footer pattern from previous reviews included in context).
The orchestrator also strips any hallucinated footer via regex before appending the real one.

---

## Skip Logic (Commit Hash Dedup)

Before calling Claude, the agent checks the most recent review comment's footer for the
commit hash. If it matches the current PR source commit:

1. **Same commit** → skip full review, check for unanswered developer replies instead
2. **Unanswered replies found** → send to Claude with reply prompt, post threaded response
3. **No replies** → skip entirely ("no new commits and no unanswered questions")
4. **Different commit** → proceed with full delta review

This prevents duplicate reviews when Jenkins re-triggers on unrelated events and avoids
unnecessary API costs.

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
