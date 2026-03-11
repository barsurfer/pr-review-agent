# Phase 1b — Comment Reply Handling

**Status:** ✅ Complete

## Problem

When the agent reviews a PR and a developer replies to the review comment with a question
(e.g. "Can you explain why this is HIGH severity?" or "This is intentional because X, does
that change your assessment?"), the agent currently has no way to respond.

If the same commit is still on the PR and the agent is re-triggered (e.g. by a webhook or
manual re-run), it sees the commit hash matches and skips entirely. The developer's question
goes unanswered.

## Solution

When the commit hash matches (no new code pushed), instead of skipping immediately:

1. Fetch all comments on the PR
2. Find replies under our review comments that we haven't responded to yet
3. If unanswered replies exist, send them to Claude with the diff and original review
4. Post Claude's response as a threaded reply under the relevant review comment
5. If no unanswered replies, skip as before

## Implementation

### Types added to `src/vcs/adapter.ts`

```ts
export interface CommentReply {
  id: string
  parentId: string
  author: string
  body: string
  createdOn: string
}
```

### Methods added to `VCSAdapter`

```ts
/** Fetch replies to review comments (unanswered human replies only). */
getRepliesToReviewComments(prId: string, reviewCommentIds: string[]): Promise<CommentReply[]>

/** Post a threaded reply to an existing comment. */
postReply(prId: string, parentId: string, body: string): Promise<void>
```

Implemented in `BitbucketAdapter`. GitHub and GitLab adapters have stubs that throw
`NotImplementedError`.

### Reply prompt: `src/prompt/reply-prompt.txt`

A dedicated system prompt for conversational replies, separate from the review prompt.
Key rules:

- Answer questions concisely based on the diff and original analysis
- Acknowledge when developer context changes the assessment
- Give definitive recommendations — no open-ended questions back (automated agent, not chat partner)
- No review structure (no Summary, Findings, etc.) — short and direct
- No footer — the system adds one automatically

The reply prompt is loaded from file at runtime (`src/prompt/reply-prompt.txt`) with a
fallback to the embedded copy (`__REPLY_PROMPT__`) in the bundled build, matching the
same pattern used for the base review prompt.

### Claude client: `src/claude/client.ts`

```ts
export async function runCommentResponse(
  apiKey: string,
  model: string,
  diff: string,
  originalReview: string,
  replies: CommentReply[]
): Promise<string>
```

Sends the original review, the diff, and all unanswered developer replies to Claude
with the reply prompt. Max tokens: 2048 (shorter than full reviews).

### Orchestration: `src/review/index.ts`

The commit-hash-match branch in the review flow:

```ts
if (commitMatch && commitMatch[1] === prInfo.sourceCommit.slice(0, 12)) {
  // Same commit — check for unanswered replies
  const reviewIds = previousReviews.map(r => r.id)
  const replies = await adapter.getRepliesToReviewComments(prId, reviewIds)
  if (replies.length > 0) {
    // Send to Claude and post threaded response
    const responseText = await runCommentResponse(...)
    await adapter.postReply(prId, targetParentId, replyBody)
  } else {
    console.log('Skipping: no new commits and no unanswered questions.')
  }
  return
}
```

### Bitbucket API

Comments endpoint: `GET /repositories/{workspace}/{repo}/pullrequests/{pr_id}/comments`

Each comment has:
- `id` — comment ID
- `parent.id` — parent comment ID (for threaded replies)
- `user.display_name` — author
- `content.raw` — body text
- `created_on` — ISO timestamp

Reply posting: `POST /repositories/{workspace}/{repo}/pullrequests/{pr_id}/comments`
with body: `{ parent: { id: parentId }, content: { raw: body } }`

### Reply deduplication (timestamp-based)

The `getRepliesToReviewComments` method tracks the timestamp of the most recent agent reply
(`latestAgentReply`). Only human replies posted **after** the latest agent reply are returned.
This prevents re-answering the same questions on subsequent triggers.

A reply is "unanswered" if:
1. It is a child of one of our review comments (`parent.id` matches)
2. It was NOT posted by the agent (doesn't contain "Reply by Claude" marker)
3. It was posted AFTER the most recent agent reply (timestamp comparison)

### Agent replies in delta review context

When called with `includeAnswered=true` (delta reviews), the method also returns the
agent's own reply comments (marked with `"Reply by"`) alongside human replies. This ensures
the model sees its prior conclusions — e.g. findings it conceded as false positives — and
does not re-raise them in subsequent reviews.

### Reply footer

Responses use a lighter footer:
```
*Reply by Claude (claude-sonnet-4-6)*
```

No review number or commit hash — these are conversational replies, not reviews.

## Files Created/Modified

- **Modified** `src/vcs/adapter.ts` — added `CommentReply` interface and new methods
- **Modified** `src/vcs/bitbucket.ts` — implemented `getRepliesToReviewComments()` and `postReply()`
- **Modified** `src/vcs/github.ts` — added stub methods
- **Modified** `src/vcs/gitlab.ts` — added stub methods
- **Modified** `src/claude/client.ts` — added `runCommentResponse()` and `getReplyPrompt()`
- **Modified** `src/review/index.ts` — added reply-handling branch in commit-skip logic
- **Created** `src/prompt/reply-prompt.txt` — dedicated reply system prompt
- **Modified** `scripts/bundle.mjs` — embedded `__REPLY_PROMPT__` alongside `__BASE_PROMPT__`
- **Modified** `package.json` — updated `copy-assets` to include `reply-prompt.txt`

## Verification (All Passed)

1. Post a review on a PR, then add a reply question to the review comment
2. Re-run the agent (same commit) — detects the reply and responds ✅
3. Re-run again — skips (reply already answered, timestamp dedup) ✅
4. Push a new commit — does a full delta review (not reply mode) ✅
5. Dry-run mode works for replies (`--dry-run` prints but doesn't post) ✅
