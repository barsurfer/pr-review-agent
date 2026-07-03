---
type: domain
topic: Review orchestration finite state machine
---

# Review FSM

The review orchestration (`src/review/index.ts`) is an explicit finite state machine. A `State` enum names every node; `ReviewContext` carries accumulated data; `transition(state, ctx)` returns the next state. The runner loops until `DONE`.

Related: [review/skip-logic.md](skip-logic.md) | [review/replies.md](replies.md) | [practices.md](../practices.md)

---

## State Transitions

```
FETCH_PR_INFO
  └─ FETCH_DIFF (+ filterDiff)
       └─ CHECK_THRESHOLDS
            ├─ [fail] → SKIP → DONE
            └─ CHECK_BRANCHES
                 ├─ [branch exclusion match] → SKIP → DONE
                 └─ CHECK_PREVIOUS_REVIEWS
                      ├─ [same commit] → CHECK_REPLIES
                      │    ├─ [unanswered replies] → RESPOND_TO_REPLIES → DONE
                      │    └─ [none] → SKIP → DONE
                      ├─ [delta diff empty after filter] → CHECK_REPLIES
                      │    ├─ [unanswered replies] → RESPOND_TO_REPLIES → DONE
                      │    └─ [none] → SKIP → DONE
                      └─ LOAD_PROMPT → FETCH_CONTEXT → CALL_CLAUDE
                           └─ CHECK_NO_CHANGE
                                ├─ [NO_CHANGE] → SKIP → DONE
                                └─ JUDGE_REVIEW
                                     ├─ [JUDGING_MODEL set] → validate → POST_REVIEW → DONE
                                     └─ [no judge] → POST_REVIEW → DONE
```

**15 states. 7 possible outcomes:**
1. Skip — branch exclusion
2. Skip — threshold (too few/many files or lines)
3. Skip — same commit, no replies
4. Skip — delta diff empty, no replies
5. Skip — reply limit reached
6. Reply — developer question answered
7. Post review — new review comment

---

## Key State Responsibilities

| State | What happens |
|-------|-------------|
| `FETCH_DIFF` | Fetches raw diff from VCS API; calls `filterDiff()` to produce filtered copy; computes reviewable (post-filter) line/file counts; skips immediately if zero reviewable lines |
| `CHECK_THRESHOLDS` | Compares reviewable (post-filter) line/file counts against `MIN/MAX_CHANGED_*` env vars |
| `CHECK_BRANCHES` | Compares source/target branch names against `SKIP_SOURCE_BRANCHES` / `SKIP_TARGET_BRANCHES` glob patterns |
| `CHECK_PREVIOUS_REVIEWS` | Parses commit hash from last review footer; triggers delta diff pre-check if different commit |
| `LOAD_PROMPT` | Fetches `.agent-review-instructions.md` from target repo (source branch → target branch → CLI flag → defaults) |
| `FETCH_CONTEXT` | Fetches full file content for changed files (see [fetching/strategy.md](../fetching/strategy.md)) |
| `CALL_CLAUDE` | Assembles payload (PR info, prior review, developer discussion, diff, file context); calls reviewer model |
| `CHECK_NO_CHANGE` | Inspects raw response for the `NO_CHANGE` stop word (exact, or as a standalone line when the model prepends a summary) before any further processing |
| `JUDGE_REVIEW` | If `JUDGING_MODEL` set: sends diff + review to judge for finding validation; otherwise passthrough |
| `POST_REVIEW` | Applies safety guards (empty/NO_CHANGE guard, pre-post dedup), then posts comment via VCS API |
| `RESPOND_TO_REPLIES` | Bundles unanswered developer questions; calls Claude with reply prompt; posts threaded reply |

---

## POST_REVIEW Safety Guards

Two guards run before every post, even on `--force`:

1. **Empty/NO_CHANGE guard** — cleanup strips prior footers, `DELTA_STATS`, and any leaked preamble before the first `### Summary` heading (`stripPreamble()` — models occasionally think out loud before the review); if what remains is empty or contains a standalone `NO_CHANGE` line, skip. Catches model misbehavior when `CHECK_NO_CHANGE` is bypassed.

2. **Pre-post dedup** — on non-dry-run runs without `--force`, re-fetches review comments immediately before posting and checks if a concurrent agent run already reviewed the same commit. Prevents race conditions from parallel Jenkins triggers.

---

## ReviewContext Interface

```typescript
interface ReviewContext {
  prId: string
  repoSlug: string
  prInfo: PRInfo
  rawDiff: string          // used for metrics, not sent to Claude
  filteredDiff: string     // sent to Claude
  previousReviews: ReviewComment[]
  developerReplies: CommentReply[]
  prompt: string
  contextFiles: ContextFile[]
  reviewText: string       // output from CALL_CLAUDE / JUDGE_REVIEW
  skipReason?: string
}
```

**Invariant:** `filteredDiff` is always derived from `rawDiff` by the same `filterDiff()` function. Never set independently.
