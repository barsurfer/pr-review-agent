# Phase 4 — Inline Line-Level Comments

## Goal

Post review findings as inline comments on specific PR lines instead of (or in addition to)
a single summary comment.

## Status: ⏸ Deferred

> **Prerequisite:** Phase 2 must be stable in production. Implement Bitbucket inline comments
> only. GitHub and GitLab inline comment support is Phase 5.

---

## Tasks

- [ ] `src/context/diffParser.ts` — unified diff parser, builds position map
- [ ] Add `postInlineComment` to `VCSAdapter` interface
- [ ] Implement `postInlineComment` in `BitbucketAdapter`
- [ ] Update `src/claude/client.ts` — JSON output mode, structured findings schema
- [ ] Update system prompt template to enforce JSON output and line-grounding rules
- [ ] `src/review.ts` — finding validation against diff map, post loop with rate limiting
- [ ] `REVIEW_MODE` env var + `.claude-review-prompt.md` override support
- [ ] Test: verify findings land on correct lines in Bitbucket UI

---

## Mode Selection

Add `REVIEW_MODE` env var:

| Value | Behavior |
|-------|----------|
| `summary` | Single PR comment (Phase 1 behaviour, default) |
| `inline` | Inline comments per finding + summary comment |
| `both` | Inline comments + full summary comment |

Can also be overridden per-repo in `.claude-review-prompt.md`:
```markdown
mode: inline
```

---

## Diff Parser (`src/context/diffParser.ts`)

The hardest part of this phase. Parses unified diff to build a position map:

```
{ filePath, fileLineNumber } → { diffPosition (GitHub), actualLineNumber (Bitbucket) }
```

### Unified Diff Hunk Header Format

```
@@ -oldStart,oldCount +newStart,newCount @@
```

### Algorithm

1. Split diff by file (`--- a/...` / `+++ b/...` boundaries)
2. For each file, walk hunks line by line
3. Track `diffPosition` — increments on every line including hunk headers
4. Track `newLineNumber` — increments only on context lines and `+` lines
5. For `-` lines (deletions): record as removed, no new line number
6. Build lookup: `Map<string, Map<number, DiffPositionEntry>>`

```typescript
interface DiffPositionEntry {
  filePath: string
  newLineNumber: number      // actual line number in new file (for Bitbucket)
  diffPosition: number       // diff offset (for GitHub)
  lineType: 'added' | 'context'
}
```

Only `added` and `context` lines can receive inline comments.
Deleted lines that no longer exist cannot be commented on.

---

## Claude Output Format (Inline Mode)

System prompt must instruct Claude to return **only JSON**, no prose:

```json
{
  "summary": "Brief overall assessment",
  "findings": [
    {
      "file": "src/main/java/com/example/SomeService.java",
      "line": 42,
      "severity": "critical",
      "title": "Missing transaction boundary",
      "comment": "This method calls two repository methods without @Transactional. If the second call fails, the first write is not rolled back."
    },
    {
      "file": "src/main/java/com/example/SomeService.java",
      "line": 87,
      "severity": "warning",
      "title": "Unbounded query",
      "comment": "findAll() with no pagination can cause OOM on large datasets."
    }
  ]
}
```

**Severity values:** `critical` | `warning` | `suggestion`

---

## Keeping Claude Grounded to Real Lines

Risk: Claude hallucinates line numbers from full file content that don't exist in the diff.

### Mitigations

1. **Number every line explicitly in the prompt:**
   ```
   [42] +    public void processOrder(Order order) {
   [43] +        repository.save(order);
   ```

2. **System prompt instruction:**
   *"You may only reference line numbers that appear in the numbered diff below.
   Do not reference lines from the full file context."*

3. **Validate before posting:** After receiving Claude's JSON, check every `{ file, line }`
   pair against the `DiffPositionEntry` map. Drop any finding that references a line not in
   the diff. Log dropped findings for debugging.

---

## Posting Inline Comments

For each valid finding:

1. Look up `DiffPositionEntry` from parsed diff map
2. Call `adapter.postInlineComment(finding, positionEntry)`
3. Rate-limit: add **300ms delay** between calls to avoid API throttling
4. On failure per comment: log and continue — don't abort remaining comments
5. After all inline comments: post one **summary comment** with the `summary` field
   and a count of findings by severity

Cap maximum inline comments at `MAX_INLINE_COMMENTS` (default: `30`).
Post any remaining findings in the summary comment.

---

## Known Risks

| Risk | Mitigation |
|------|-----------|
| GitHub diff position is fragile — resets per file, counts hunk headers | Write unit tests for parser against known diff fixtures |
| Bitbucket only allows inline comments on `ADDED` side | Fall back to summary comment for deletion-only files |
| Large PRs may hit API rate limits | Cap at `MAX_INLINE_COMMENTS`, post remainder in summary |
| Claude occasionally wraps JSON in markdown fences | Strip ` ```json ` fences before `JSON.parse`. Fallback to summary mode on parse failure |
