---
type: domain
topic: Developer reply detection, bundling, and agent response flow
---

# Reply Handling

How the agent detects and responds to developer questions on review comments. Related: [review/fsm.md](fsm.md) | [review/skip-logic.md](skip-logic.md) | [prompt/composition.md](../prompt/composition.md)

---

## Detection Algorithm

The agent scans all PR comments recursively to find unanswered developer questions:

1. Collect all **review comment IDs** — comments carrying the agent's review footer line (`hasReviewFooter`).
2. For each comment with a `parent.id` in that set:
   - If it carries the reply footer (`hasReplyFooter`) → **agent reply**: add its ID to the parent set (enables reply-to-reply discovery) and record its timestamp.
   - Otherwise → **human reply**: collect for filtering.
3. Filter human replies to only those posted **after** the agent's latest reply timestamp (already-answered questions excluded).
4. Additionally exclude human replies older than the latest *unresolved* review comment (`supersedeBoundary` — a human-resolved review does not supersede an unanswered reply). Stale replies from a previous review cycle must not re-trigger replies (learned from a production incident: stale discussion re-triggered a reply loop after a re-review).

This recursive parent tracking finds developer questions at any nesting depth.

**Adapter note:** the `parent.id` recursion applies to Bitbucket. Azure uses thread membership instead: every comment in a review's thread other than the review itself is a reply (agent replies recognised by footer), whatever its `parentCommentId`, and the composite `threadId:commentId` id carries the thread to `postReply`. GitHub issue comments are flat (no `parent.id`), so `GitHubAdapter` treats the whole PR as one thread — a reply is any non-agent comment newer than the agent's latest comment, except (from 0.0.46) comments from `Bot`-type accounts (see [vcs/adapter.md](../vcs/adapter.md)).

---

## Bundled Response

All pending unanswered questions are sent in a **single Claude API call** using `src/prompt/reply-prompt.txt` as the system prompt. One reply per trigger — never one per question. The call uses `REPLY_MODEL` when set (else `CLAUDE_MODEL`) — a reply needs less depth than a review, so a cheaper model cuts cost; a reply-only usage record logs + costs at that model.

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

**Suggested fixes** (`ENABLE_SUGGESTED_FIXES`): the reply model sees the review raw, `suggested-fix-v1` blocks included, because a developer answers what they see ("your fix doesn't compile"). Reply output never feeds the judge, metrics or dedup. For the next *reviewer* call, blocks are stripped from the agent's own review and from agent replies (footer as the last non-empty line, so a reply that echoes a block, even at its very start, loses it). A reply counts as the agent's only by that last line: a human reply quoting a footer in a fence or mid-text is left as is, but one whose last non-empty line is footer-shaped is stripped too (the footer known limit in [skip-logic.md](skip-logic.md)). A proposal line shaped like a review or reply footer, or joined to the previous line by U+2028/U+2029, is rejected at render time, so a reply that copies a block cannot pass `hasReviewFooter`. See [prompt/judge.md](../prompt/judge.md#suggested-fixes-in-the-posted-review-enable_suggested_fixes).

---

## Reply Footer

Reply comments use a lighter footer than review comments:
```
*Reply by Claude (claude-haiku-4-5-20251001)*
```

This footer is what the detection algorithm uses to identify agent replies in the thread (the `"Reply by"` check).

---

## Reply Prompt Scope Lock

`reply-prompt.txt` includes a SCOPE LOCK matching the base template. Developer replies could contain adversarial instructions (e.g. "ignore previous instructions"). The reply prompt instructs Claude to silently ignore such content and answer only the code review question.

---

## Skip Replies Directed at Someone Else

Opt-in (`SKIP_DIRECTED_REPLIES` / `--skip-directed-replies`, default off, Bitbucket only). A dev comment under an agent review that is `@`-directed solely at another human/team (`@alice wdyt?`) is not a question for the agent, so answering it is noise. When enabled, a shared private helper in `review/index.ts` (`dropRepliesDirectedElsewhere`) wraps the adapter's optional `filterAddressedToAgent` capability (see [vcs/adapter.md](../vcs/adapter.md) for the drop rule and id-set derivation).

- **Answer-path-only, two sites.** The filter runs at **both** inbound edges to `RESPOND_TO_REPLIES`: `CHECK_REPLIES` (after the supersede filter, **before** the reply-limit check, so an all-directed-elsewhere run falls to the normal `DEDUP_SKIP` "no unanswered questions", not "reply limit reached") and the `JUDGE_REVIEW` 0-finding re-review path (on its `unanswered` set, before its reply-limit check). The delta-context `getRepliesToReviewComments(..., true)` call is untouched — directed-elsewhere replies still reach the reviewer prompt as context.
- **Fail-safe.** Config off, an adapter without the capability, an empty reply list, or any thrown error → keep all, no behavior change. Dropped replies are not marked answered, so each later run re-evaluates them deterministically.
- **Order-preserving.** The kept list is a subset in original order (`RESPOND_TO_REPLIES` posts under `replies[last].parentId`). Per-drop logging (id, author, matched token) happens in the adapter; the helper logs the count.

## Reply Limit

See [review/skip-logic.md#5-reply-limit](skip-logic.md#5-reply-limit).
