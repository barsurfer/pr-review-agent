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

## Diff Filtering

Before sending the diff to Claude, the agent strips sections for files that add noise
without review value. The raw diff is still used for line counting and threshold checks —
only the filtered version goes to the API.

### Excluded from Diff

```
package-lock.json
yarn.lock
pnpm-lock.yaml
*.lock
```

JSON files (e.g. i18n translations) are **not** filtered — their diffs can reveal
missing keys or inconsistent additions across locales.

---

## Payload Sent to Claude

### Full Review (first review or delta review)

```
[SYSTEM PROMPT — base template with repo sections filled in]

[USER MESSAGE]
## Pull Request: {title}
## Branch: {source} → {target}
## Description: {pr description if present}

## Previous Review by This Agent (latest of N total):
{only the most recent review — saves tokens while keeping delta context}

## Developer Discussion on Previous Review(s):
{all replies across all previous reviews — developer replies AND agent's own
 prior responses, so the model sees its prior conclusions and does not re-raise
 findings it already conceded as false positives}

## Diff:
{unified diff, with lock files stripped}

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

## Reply Flow

When the agent is re-triggered on the **same commit** (no new code), it checks for
unanswered developer questions and responds conversationally.

### Detection

The agent scans all PR comments looking for replies to its review comments:

1. Start with the set of **review comment IDs** (comments containing `"Reviewed by"`)
2. For each comment with a matching `parent.id`:
   - If it contains `"Reply by"` → it's an **agent reply** — add its ID to the parent set
     (so replies-to-replies are also discovered) and track the timestamp
   - Otherwise → it's a **human reply** — collect it
3. Filter human replies to only those posted **after** the agent's latest reply
   (already-answered questions are excluded)
4. Additionally filter out human replies older than the latest review comment — a new
   review supersedes the prior discussion thread. This prevents stale replies from a
   previous review cycle from re-triggering a reply loop (PR 712 incident).

This recursive parent tracking means the agent finds developer questions at any nesting
depth — not just direct replies to the review, but also follow-ups to the agent's own
replies.

### One Reply per Trigger

Each trigger produces **at most one agent reply** that answers all pending questions:

- All unanswered developer questions are bundled into a single Claude API call
- Claude receives the original review, the diff, and all pending questions
- The response is posted as a **threaded reply** under the review comment

On the next trigger:
- New unanswered questions → reply again (one response)
- No new questions → skip ("no unanswered questions")

### Reply Limit (`MAX_REPLY_COMMENTS`)

To prevent runaway token usage from extended back-and-forth conversations, the agent
enforces a per-PR reply cap. Default: **3 replies**.

Once the limit is reached, the agent logs the unanswered questions but skips the API
call: `"reply limit reached (3/3)"`. This prevents:
- Developers gaming the agent with infinite follow-up questions
- Token cost spiraling on contentious PRs
- The agent getting baited into off-topic conversations

Set `MAX_REPLY_COMMENTS=0` to disable the limit (unlimited replies).

---

## Review Comment Footer

Every review comment posted by the agent includes a structured footer:

```
*Reviewed by Claude (claude-sonnet-4-6) | Prompt: .agent-review-instructions.md | Review #2 | Commit: a1b2c3d4e5f6*
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

## Branch Exclusion

Before fetching any diff or context, the `CHECK_BRANCHES` state compares the PR's source
and target branches against configurable glob patterns:

- **`SKIP_SOURCE_BRANCHES`** (default: `main,master,release/*,hotfix/*`) — skips merge-back
  PRs like `main→develop` or `release/1.5→develop`
- **`SKIP_TARGET_BRANCHES`** (default: `main,master`) — skips release PRs merging into production

Patterns support `*` wildcards (e.g. `release/*` matches `release/1.5.0`). Set either to
an empty string to disable that filter.

---

## Skip Logic (Commit Hash Dedup)

The review flow is implemented as a finite state machine (see
[architecture/overview.md](overview.md#review-flow-finite-state-machine)). The
`CHECK_PREVIOUS_REVIEWS` state checks the most recent review comment's footer for the
commit hash. If it matches the current PR source commit:

1. **Same commit** → `CHECK_REPLIES` → check for unanswered developer replies
2. **Unanswered replies found** → `RESPOND_TO_REPLIES` → send to Claude, post threaded response
3. **No replies** → `SKIP` → done ("no new commits and no unanswered questions")
4. **Different commit** → **delta diff pre-check** → fetch developer discussion → proceed

### Delta Diff Pre-Check (Step 4)

Before sending the full PR diff to Claude, the agent fetches the commit-to-commit diff
between the last-reviewed commit and the current head. After applying `DIFF_EXCLUDE_PATTERNS`:

- **0 lines remain** → deterministic `NO_CHANGE` skip. No API call, no tokens, no cost.
  This catches commits that only add tests (`.spec.ts`), lock files, translations, etc.
- **Lines remain** → proceed with full delta review (fetch discussion, load prompt, call Claude)

This is a **deterministic** check — it doesn't rely on Claude to detect that nothing
changed. The filtering uses the same `filterDiff()` function as the main diff pipeline.

The delta diff is fetched via `VCSAdapter.getCommitDiff(fromCommit, toCommit)`. If the
API call fails (e.g. commit no longer exists after force-push), the agent falls back to
the full PR diff flow.

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
