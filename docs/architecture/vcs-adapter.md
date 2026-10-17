# VCS Adapter Interface

## Design Intent

The adapter pattern decouples orchestration logic from VCS-specific API details.
All VCS implementations must satisfy the same interface. The adapter is selected by the
`VCS_PROVIDER` env var (the `--vcs` CLI flag overrides it for one-off runs).

> **Priority:** Bitbucket is the primary production target. Azure DevOps (experimental,
> validated live against a cloud project) and GitHub (experimental, same-repo PRs triggered
> via GitHub Actions) adapters are implemented, and a filesystem adapter backs `--benchmark`
> runs. The GitLab adapter remains a stub until Phase 3 is actively worked. The interface
> exists to avoid architectural lock-in, not to drive parallel implementation.

---

## Current Interface (Phase 1 + 1b)

```typescript
interface VCSAdapter {
  // Phase 1 — Core review
  getPullRequestInfo(prId: string): Promise<PRInfo>
  getDiff(prId: string): Promise<string>
  getFileContent(filePath: string, ref: string): Promise<string>
  getChangedFiles(prId: string): Promise<ChangedFile[]>
  getRepoFileContent(filePath: string, ref?: string): Promise<string | null>  // for .agent-review-instructions.md
  postComment(prId: string, body: string): Promise<void>
  getPreviousReviewComments(prId: string): Promise<ReviewComment[]>  // for delta reviews
  getCommitDiff(fromCommit: string, toCommit: string): Promise<string>  // commit-to-commit delta for re-reviews

  // Phase 1b — Comment replies
  getRepliesToReviewComments(prId: string, reviewCommentIds: string[], includeAnswered?: boolean): Promise<ReplyResult>  // ReplyResult = { replies: CommentReply[]; agentReplyCount: number }
  postReply(prId: string, parentId: string, body: string): Promise<void>
}
```

## Phase 4 Addition (Inline Comments)

```typescript
interface VCSAdapter {
  // ... all Phase 1 methods ...
  postInlineComment(prId: string, finding: Finding, position: DiffPositionEntry): Promise<void>
}
```

---

## Provider Selection

Set `VCS_PROVIDER` env var to one of:

| Value | Adapter | Status |
|-------|---------|--------|
| `bitbucket` | `BitbucketAdapter` | Phase 1 — fully implemented |
| `azure` | `AzureDevOpsAdapter` | Experimental — validated live on a cloud project |
| `github` | `GitHubAdapter` | Experimental — same-repo PRs, triggered via GitHub Actions (flat issue-comment model; no inline comments) |
| `gitlab` | `GitLabAdapter` | Phase 3 — stub only |

Default and primary production value: `bitbucket`. `--benchmark` runs use a filesystem
adapter selected by the flag, not `VCS_PROVIDER`.

---

## Inline Comment Position Formats (Phase 4)

Each VCS uses a different position format for inline comments. This is encapsulated in the adapter.

| Provider | API Endpoint | Key Fields | Phase |
|----------|-------------|------------|-------|
| Bitbucket | `POST /2.0/repositories/{ws}/{repo}/pullrequests/{id}/comments` | `inline.path` + `inline.to` (actual file line number on `ADDED` side) | Phase 4 |
| GitHub | `POST /repos/{owner}/{repo}/pulls/{id}/comments` | `path` + `position` (offset within diff, not file line number) | Phase 5 |
| GitLab | `POST /projects/{id}/merge_requests/{iid}/discussions` | `position` object with `new_path`, `new_line`, `base_sha`, `head_sha`, `start_sha` | Phase 5 |

---

## Supporting Types

```typescript
interface PRInfo {
  id: string
  title: string
  description: string
  author: string                // PR author display name / login
  sourceBranch: string
  targetBranch: string
  sourceCommit: string          // used for commit hash dedup in review footer
}

interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
}

interface ReviewComment {
  id: string
  body: string
  createdOn: string
}

interface CommentReply {
  id: string
  parentId: string             // ID of the review comment this replies to
  author: string               // display name of the reply author
  body: string
  createdOn: string            // ISO timestamp, used for dedup ordering
}

interface Finding {
  file: string
  line: number
  severity: 'critical' | 'warning' | 'suggestion'
  title: string
  comment: string
}

interface DiffPositionEntry {
  filePath: string
  newLineNumber: number      // actual line number in new file (for Bitbucket)
  diffPosition: number       // diff offset (for GitHub)
  lineType: 'added' | 'context'
}
```
