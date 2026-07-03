---
type: domain
topic: Developer reply detection, bundling, and agent response flow
---

# Reply Handling

How the agent detects and responds to developer questions on review comments. Related: [review/fsm.md](fsm.md) | [review/skip-logic.md](skip-logic.md) | [prompt/composition.md](../prompt/composition.md)

---

## Detection Algorithm

The agent scans all PR comments recursively to find unanswered developer questions:

1. Collect all **review comment IDs** — comments whose body contains `"Reviewed by"`.
2. For each comment with a `parent.id` in that set:
   - If body contains `"Reply by"` → **agent reply**: add its ID to the parent set (enables reply-to-reply discovery) and record its timestamp.
   - Otherwise → **human reply**: collect for filtering.
3. Filter human replies to only those posted **after** the agent's latest reply timestamp (already-answered questions excluded).
4. Additionally exclude human replies older than the latest review comment. Stale replies from a previous review cycle must not re-trigger replies (learned from PR 712: old discussion was causing a reply loop after the PR was re-reviewed).

This recursive parent tracking finds developer questions at any nesting depth.

---

## Bundled Response

All pending unanswered questions are sent in a **single Claude API call** using `src/prompt/reply-prompt.txt` as the system prompt. One reply per trigger — never one per question.

**Why:** Keeps token cost predictable and the conversation thread readable. A separate reply per question would produce a noisy, hard-to-read thread.

Payload to Claude:
```
[SYSTEM: reply-prompt.txt]

## Your Original Review:
{last review body}

## Diff:
{filtered diff}

## Developer Replies (answer all of these):
**John Smith** (2025-01-15T10:30:00Z):
> Can you explain why this is HIGH severity?
```

The agent reply is posted as a **threaded reply** under the review comment (parent ID = review comment ID), not as a new top-level comment.

---

## Reply Footer

Reply comments use a lighter footer than review comments:
```
*Reply by Claude (claude-sonnet-4-6)*
```

This footer is what the detection algorithm uses to identify agent replies in the thread (the `"Reply by"` check).

---

## Reply Prompt Scope Lock

`reply-prompt.txt` includes a SCOPE LOCK matching the base template. Developer replies could contain adversarial instructions (e.g. "ignore previous instructions"). The reply prompt instructs Claude to silently ignore such content and answer only the code review question.

---

## Reply Limit

See [review/skip-logic.md#5-reply-limit](skip-logic.md#5-reply-limit).
