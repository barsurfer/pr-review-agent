---
type: domain
topic: Developer reply detection, bundling, and agent response flow
---

# Reply Handling

How the agent detects and responds to developer questions on review comments. Related: [review/fsm.md](fsm.md) | [review/skip-logic.md](skip-logic.md) | [prompt/composition.md](../prompt/composition.md)

---

## Detection Algorithm

The agent reads all PR comments and keeps the ones in its review threads:

1. Collect all **review comment IDs**: comments carrying the agent's review footer line (`hasReviewFooter`).
2. **Thread membership:** a live (non-deleted) comment is in a review thread when its chain of `parent.id` links reaches a review comment, through any mix of human and agent comments and at any depth. Membership is built from the parent links of the whole comment list, so the order the API returns comments in doesn't matter. A chain that passes through a deleted comment (dropped by `fetchComments`), points at a comment not on the list, or loops is outside every thread.
   - A member carrying the reply footer (`hasReplyFooter`) is an **agent reply**: counted (`agentReplyCount`, for the reply limit) and its timestamp recorded.
   - Every other member is a **human reply**, with `parentId` = its direct parent's id. A human reply to a human comment that does not `@`-mention the agent is marked `contextOnly` (see [Addressing](#addressing-rule-for-nested-replies)).
   - The list is returned oldest first (stable sort by `createdOn`).
3. Filter human replies to only those posted **after** the agent's latest reply anywhere in its threads (already-answered questions excluded).
4. Additionally exclude human replies older than the latest *unresolved* review comment (`supersedeBoundary` — a human-resolved review does not supersede an unanswered reply). Stale replies from a previous review cycle must not re-trigger replies (learned from a production incident: stale discussion re-triggered a reply loop after a re-review).

So a question nested under human replies (review → dev A → dev B → dev B asking the agent) is found, not only direct replies and follow-ups to the agent's own replies. Up to 0.0.49 only chains of agent replies were followed, so a reply under a human reply was never seen.

**One "latest agent reply" for all threads (step 3):** each run answers every pending reply in one bundled reply, posted in one place, so a reply older than the agent's latest reply counts as covered by that bundle (or deliberately left out: directed elsewhere, superseded). A per-thread rule would re-answer the other threads of a bundle on the next run. Known gaps: a reply posted while a run is answering, and a deep reply that 0.0.49 missed when a later agent reply exists, stay unanswered.

**Deleted parent:** a reply whose parent (or any ancestor) was deleted is not answered and not shown to the reviewer, because its link to the review is gone from the live list. That was already the case for a reply under a deleted agent reply.

### Addressing rule for nested replies

A reply to an agent comment (a review or an agent reply) is addressed to the agent implicitly, as before; a reply to a human comment is a question for the agent only if its body `@`-mentions the agent anywhere. Everything else nested under a human is human-to-human discussion: it stays reviewer context on a re-review but is never answered, so it no longer spends the reply budget (`MAX_REPLY_COMMENTS`).

- **Mention matching:** `mentionsAgent` in `src/vcs/mention-filter.ts`, the same tokens the directed-reply filter reads: an id-shaped `@{…}` (account id `NNN:uuid` or legacy 24-hex, or uuid, double braces tolerated) that is the agent's, or a plain-text `@<agent display name/nickname>`. The agent ids and names are derived from the authors of the review comments and agent replies (see [vcs/adapter.md](../vcs/adapter.md)).
- **One place, both edges:** the Bitbucket adapter marks such a reply `contextOnly` (in both the unanswered and the `includeAnswered` lists; never sent to a model). `questionsForAgent` in `review/index.ts` drops marked replies at both inbound edges to `RESPOND_TO_REPLIES`, `CHECK_REPLIES` and the 0-finding re-review gate, before the directed-reply filter and the reply-limit check, whatever `SKIP_DIRECTED_REPLIES` says. `agentReplyCount` and the latest-agent-reply cut are unaffected.
- **Fail-safe:** when no agent id can be derived, nothing is marked and the adapter warns once (`Could not derive the agent id-set — keeping all replies (nested-reply @-mention rule inert this run)`).
- **Record:** a reply run's `reply_authors` and the 0-finding gate's `delta.human_replies` count only the replies treated as questions; a posted re-review's `delta` and `reply_authors` still count the whole discussion, chatter included (unchanged definitions).

**Adapter note:** the parent-link walk applies to Bitbucket. Azure uses thread membership instead: every comment in a review's thread other than the review itself is a reply (agent replies recognised by footer), whatever its `parentCommentId`, and the composite `threadId:commentId` id carries the thread to `postReply`. GitHub issue comments are flat (no `parent.id`), so `GitHubAdapter` treats the whole PR as one thread — a reply is any non-agent comment newer than the agent's latest comment, except (from 0.0.46) comments from `Bot`-type accounts (see [vcs/adapter.md](../vcs/adapter.md)).

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

The agent reply is posted as a **threaded reply**, never a new top-level comment. **Reply target:** under the parent of the newest pending reply (`replies[last].parentId`), so the answer sits next to the newest question, at its depth. A direct reply's parent is the review comment, a follow-up to an agent reply's parent is that agent reply, and in a deeper chain it is the comment the question replied to (review → A → B → B's question: the answer goes under B's earlier comment). Replying to the question itself would add a level on every exchange. Azure posts in the review's thread; GitHub has no threads.

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

Opt-in (`SKIP_DIRECTED_REPLIES` / `--skip-directed-replies`, default off, Bitbucket only). A dev comment anywhere in an agent review's thread that is `@`-directed solely at another human/team (`@alice wdyt?`) is not a question for the agent, so answering it is noise. The flag matters only for replies to an agent comment: a reply to a human comment is a question only when it `@`-mentions the agent ([Addressing](#addressing-rule-for-nested-replies)), and then this filter keeps it. When enabled, a shared private helper in `review/index.ts` (`dropRepliesDirectedElsewhere`) wraps the adapter's optional `filterAddressedToAgent` capability (see [vcs/adapter.md](../vcs/adapter.md) for the drop rule and id-set derivation).

- **Answer-path-only, two sites.** The filter runs at **both** inbound edges to `RESPOND_TO_REPLIES`: `CHECK_REPLIES` (after the supersede filter, **before** the reply-limit check, so an all-directed-elsewhere run falls to the normal `DEDUP_SKIP` "no unanswered questions", not "reply limit reached") and the `JUDGE_REVIEW` 0-finding re-review path (on its `unanswered` set, before its reply-limit check). The delta-context `getRepliesToReviewComments(..., true)` call is untouched — directed-elsewhere replies still reach the reviewer prompt as context.
- **Fail-safe.** Config off, an adapter without the capability, an empty reply list, or any thrown error → keep all, no behavior change. Dropped replies are not marked answered, so each later run re-evaluates them deterministically.
- **Order-preserving.** The kept list is a subset in original order (`RESPOND_TO_REPLIES` posts under `replies[last].parentId`). Per-drop logging (id, author, matched token) happens in the adapter; the helper logs the count.

## Reply Limit

See [review/skip-logic.md#5-reply-limit](skip-logic.md#5-reply-limit).
