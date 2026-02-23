# Phase 1b — Comment Reply Handling

**Status:** 🔧 In progress

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
4. Post Claude's response as a threaded reply under each question
5. If no unanswered replies, skip as before

## Design

### New types in `src/vcs/adapter.ts`

```ts
export interface CommentReply {
  id: string
  parentId: string
  author: string
  body: string
  createdOn: string
}
```

### New methods on `VCSAdapter`

```ts
/** Fetch replies to a specific comment (non-agent replies only). */
getRepliesToReviewComments(prId: string, reviewCommentIds: string[]): Promise<CommentReply[]>

/** Post a threaded reply to an existing comment. */
postReply(prId: string, parentId: string, body: string): Promise<void>
```

### New function in `src/claude/client.ts`

```ts
export async function runCommentResponse(
  apiKey: string,
  model: string,
  diff: string,
  originalReview: string,
  replies: CommentReply[]
): Promise<string>
```

Uses a focused system prompt:
- You are the same reviewer who posted the review
- Answer the team's questions concisely based on the diff and your analysis
- If you lack context to answer, say so explicitly
- Keep answers short and direct — this is a conversation, not a review
- Do not repeat the full review structure

### Updated flow in `src/review.ts`

The commit-hash-match branch changes from:
```ts
// Old: return immediately
console.log('Skipping: source commit already reviewed.')
return
```

To:
```ts
// New: check for unanswered replies before skipping
const replies = await adapter.getRepliesToReviewComments(prId, reviewCommentIds)
if (replies.length > 0) {
  // Send to Claude and post threaded responses
} else {
  console.log('Skipping: no new commits and no unanswered questions.')
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
- `created_on` — timestamp

Reply posting: `POST /repositories/{workspace}/{repo}/pullrequests/{pr_id}/comments`
with body: `{ parent: { id: parentId }, content: { raw: body } }`

### Reply detection

A reply is "unanswered" if:
1. It is a child of one of our review comments (`parent.id` matches)
2. It was NOT posted by the agent (doesn't contain "Reviewed by Claude")
3. There is no agent reply that was posted AFTER it

### Reply footer

Responses use a lighter footer:
```
*Reply by Claude (claude-sonnet-4-6)*
```

No review number or commit hash — these are conversational replies, not reviews.

## Files to Create/Modify

- **Modify** `src/vcs/adapter.ts` — add `CommentReply` interface and new methods
- **Modify** `src/vcs/bitbucket.ts` — implement `getRepliesToReviewComments()` and `postReply()`
- **Modify** `src/claude/client.ts` — add `runCommentResponse()` with reply prompt
- **Modify** `src/review.ts` — add reply-handling branch in commit-skip logic

## Verification

1. Post a review on a PR, then add a reply question to the review comment
2. Re-run the agent (same commit) — should detect the reply and respond
3. Re-run again — should skip (reply already answered)
4. Push a new commit — should do a full delta review (not reply mode)
