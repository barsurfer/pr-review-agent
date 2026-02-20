# Token Budget

## Rough Estimate Per Review

| Component | Tokens |
|-----------|--------|
| System prompt | 500–1,000 |
| Diff (typical PR) | 1,000–5,000 |
| Full file context (10 files × 200 lines avg) | 15,000–30,000 |
| Output (review comment) | 1,000–2,000 |
| **Total typical** | **20,000–40,000** |

Claude Sonnet context window is large enough for even big PRs, but cost scales with token count.

---

## Built-in Mitigations (Phase 1)

| Control | Default | Effect |
|---------|---------|--------|
| `MAX_CONTEXT_FILES` | `20` | Cap on full-file fetches |
| `MAX_FILE_LINES` | `500` | Files over this get diff-only |
| Exclusion patterns | see below | Skips generated/lock files entirely |

### Excluded File Patterns

```
*.lock
package-lock.json
yarn.lock
*-generated.*
*.min.js
db/migrate/*
*.snap
```

---

## Phase 5: Cost Tracking

Once the agent is in production and running across multiple repos, add:

- Log `input_tokens` and `output_tokens` from the Anthropic API response per run
- Alert if total tokens exceed a configurable threshold (e.g. `MAX_TOKENS_PER_REVIEW=60000`)
- Aggregate cost reporting per repo per month
