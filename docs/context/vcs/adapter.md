---
type: domain
topic: VCS adapter interface, Bitbucket implementation, supporting types
---

# VCS Adapter

The adapter pattern that decouples review orchestration from VCS-specific API details. Related: [review/fsm.md](../review/fsm.md) | [practices.md](../practices.md)

---

## Interface (`src/vcs/adapter.ts`)

```typescript
interface VCSAdapter {
  // Core review
  getPullRequestInfo(prId: string): Promise<PRInfo>
  getDiff(prId: string): Promise<string>
  getFileContent(filePath: string, ref: string): Promise<string>
  getChangedFiles(prId: string): Promise<ChangedFile[]>
  getRepoFileContent(filePath: string): Promise<string | null>  // for .agent-review-instructions.md
  postComment(prId: string, body: string): Promise<void>
  getPreviousReviewComments(prId: string): Promise<ReviewComment[]>

  // Comment replies
  getRepliesToReviewComments(prId: string, reviewCommentIds: string[]): Promise<CommentReply[]>
  postReply(prId: string, parentId: string, body: string): Promise<void>

  // Commit diff (for delta diff pre-check)
  getCommitDiff(fromCommit: string, toCommit: string): Promise<string>
}
```

**Invariant:** All orchestration logic uses only this interface. Never call Bitbucket APIs directly from `src/review/` or `src/context/`.

---

## Provider Selection

`VCS_PROVIDER` env var selects the adapter:

| Value | Class | Status |
|-------|-------|--------|
| `bitbucket` | `BitbucketAdapter` | Production — fully implemented |
| `github` | `GitHubAdapter` | Stub — throws `NotImplementedError` |
| `gitlab` | `GitLabAdapter` | Stub — throws `NotImplementedError` |

---

## Bitbucket Implementation Details

- **Auth:** HTTP Basic Auth — `BITBUCKET_USERNAME` (email) + `BITBUCKET_TOKEN` (Atlassian API token, starts with `ATATT3x...`)
- **Diff endpoint:** Returns a 302 redirect. The adapter handles the redirect manually, preserving auth headers (axios default strips them on redirect).
- **API token scopes required:** `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`
- **Cloud vs self-hosted:** `BITBUCKET_BASE_URL` — `https://api.bitbucket.org/2.0` for cloud, custom URL for self-hosted (Bitbucket Server/DC)

---

## Supporting Types

```typescript
interface PRInfo {
  id: string
  title: string
  description: string
  sourceBranch: string
  targetBranch: string
  sourceCommit: string   // commit hash used for dedup
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
  parentId: string       // ID of the review comment this replies to
  author: string         // display name of the reply author
  body: string
  createdOn: string      // ISO timestamp, used for reply dedup
}
```

---

## Phase 4: Inline Comment Extension (Deferred)

```typescript
// Additional method for inline comments
postInlineComment(prId: string, finding: Finding, position: DiffPositionEntry): Promise<void>
```

Each VCS uses a different position format for inline comments:

| Provider | Key fields | Note |
|----------|-----------|------|
| Bitbucket | `inline.path` + `inline.to` (actual file line number) | Phase 4 |
| GitHub | `path` + `position` (diff offset, not file line number) | Backlog |
| GitLab | `position` object with `new_path`, `new_line`, SHA fields | Backlog |
