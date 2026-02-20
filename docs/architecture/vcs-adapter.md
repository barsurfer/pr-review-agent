# VCS Adapter Interface

## Design Intent

The adapter pattern decouples orchestration logic from VCS-specific API details.
All VCS implementations must satisfy the same interface. Jenkins selects the adapter
via the `VCS_PROVIDER` env var.

> **Priority:** Bitbucket is the only production target. GitHub and GitLab adapters
> are stubs that throw `NotImplementedError` until Phase 3 is actively worked.
> The interface exists to avoid architectural lock-in, not to drive parallel implementation.

---

## Phase 1 Interface

```typescript
interface VCSAdapter {
  getPullRequestInfo(prId: string): Promise<PRInfo>
  getDiff(prId: string): Promise<string>
  getFileContent(filePath: string, ref: string): Promise<string>
  getChangedFiles(prId: string): Promise<ChangedFile[]>
  getRepoFileContent(filePath: string): Promise<string | null>  // for .claude-review-prompt.md
  postComment(prId: string, body: string): Promise<void>
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
| `github` | `GitHubAdapter` | Phase 3 — stub only |
| `gitlab` | `GitLabAdapter` | Phase 3 — stub only |

Default and only tested value: `bitbucket`.

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
  sourceBranch: string
  targetBranch: string
}

interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
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
