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
  getRepoFileContent(filePath: string, ref?: string): Promise<string | null>  // for .agent-review-instructions.md
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
| `azure` | `AzureDevOpsAdapter` | **Experimental / WIP** — all 10 methods implemented; validated end-to-end against a live cloud Services org (read / write / footer dedup). Not yet Server/on-prem or a live pipeline-OAuth run |
| `github` | `GitHubAdapter` | Stub — throws `NotImplementedError` |
| `gitlab` | `GitLabAdapter` | Stub — throws `NotImplementedError` |

`--vcs azure` (or `VCS_PROVIDER=azure`) selects it. Prints a one-line WIP warning on construction.

---

## Bitbucket Implementation Details

- **Auth:** HTTP Basic Auth — `BITBUCKET_USERNAME` (email) + `BITBUCKET_TOKEN` (Atlassian API token, starts with `ATATT3x...`)
- **Diff endpoint:** Returns a 302 redirect. The adapter handles the redirect manually, preserving auth headers (axios default strips them on redirect).
- **API token scopes required:** `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`
- **Cloud only:** the adapter targets Bitbucket Cloud API 2.0 response shapes (`values` pagination, `content.raw`, diffstat redirects). Bitbucket Server/DC exposes a different v1 REST API — pointing `BITBUCKET_BASE_URL` at it fails on the first call; Server support would need its own adapter.
- **Agent comment detection:** the agent's own comments are recognized by their exact footer line (`hasReviewFooter`/`hasReplyFooter` from `review/formatter.ts`), not by author — a comment quoting a full agent footer would still match (rare, accepted).

---

## Azure DevOps Implementation Details (WIP)

`src/vcs/azure.ts` — experimental. Purely additive: no existing adapter, the interface, or `review/*` was touched. **Validated end-to-end against a live Azure DevOps Services (cloud) org** — `getPullRequestInfo`, diff reconstruction, `getChangedFiles`, `getFileContent` context, `getRepoFileContent`, `postComment`, and footer dedup (`getPreviousReviewComments`) all confirmed on a real PR (dry-run → post → dedup-skip). Still WIP: on-prem **Server**, a real pipeline `System.AccessToken` run, and the live reply / `getCommitDiff`-delta paths are unverified.

- **Auth (dual, config-selected):** the auth header is computed **once** in the constructor by precedence — if `AZURE_ACCESS_TOKEN` is set it wins as `Authorization: Bearer {token}` (OAuth, e.g. an Azure Pipelines `System.AccessToken` — zero-PAT); otherwise `AZURE_PAT` is used as HTTP Basic with an empty username, `Authorization: Basic base64(":{PAT}")`. `validateAzureConfig()` requires `AZURE_ORG`, `AZURE_PROJECT`, and **at least one** of `AZURE_PAT` / `AZURE_ACCESS_TOKEN`. `?api-version=7.1` is sent on every call (axios instance default param).
- **Config / base URL:** `AZURE_BASE_URL` (default `https://dev.azure.com`, point at an on-prem Server collection URL for self-hosted) + `AZURE_ORG` + `AZURE_PROJECT` + `AZURE_PAT`/`AZURE_ACCESS_TOKEN`; repo via `--repo-slug`. `--workspace` aliases `AZURE_ORG`. Base URL is built as `{baseUrl}/{org}/{project}/_apis/git`. Mirrors the Bitbucket config pattern (`optional()` defaults + `validateAzureConfig()`).
- **CI integration:** [`azure/azure-pipelines.yml`](../../../azure/azure-pipelines.yml) is a build-validation pipeline. Gotchas: the YAML `pr:` trigger is ignored for Azure Repos — wire it via **Branch Policies → Build Validation** (set Optional so agent failure never blocks the PR); enable **"Allow scripts to access the OAuth token"** so `System.AccessToken` is exposed; grant the **"{Project} Build Service"** identity **"Contribute to Pull Requests"** so it can post threads. Org + base URL are derived by splitting `System.CollectionUri`; `AZURE_PROJECT=$(System.TeamProject)`, repo=`$(Build.Repository.Name)`, PR=`$(System.PullRequest.PullRequestId)`; `ANTHROPIC_API_KEY` is a secret var mapped explicitly into the step env. **Verified live** (cloud Services, PR #1 on a test org): create/update trigger → zero-PAT `System.AccessToken` auth → the Build Service identity posts the review → re-queues on push (delta review #2 confirmed). Extra first-setup gotchas found live: the pinned release tag can predate the adapter (point `AGENT_TAG` at the adapter branch until a release ships; verify `grep -c AzureDevOpsAdapter` on the raw bundle > 0); `SKIP_TARGET_BRANCHES` defaults to `main,master` so set it `''` to review PRs into main; build validation resolves the YAML from the PR **source branch**, so that branch must contain `azure-pipelines.yml`. CI repo-prompt = a committed `.agent-review-instructions.md` (the `getRepoFileContent` fix makes this work on Azure); `--prompt` is unusable in CI because the pipeline only downloads the bundle, not `prompts/`.
- **Reply-on-comment trigger (DESIGNED — pending live validation):** build validation fires on PR create/update but **not** on comments, so the reply flow isn't triggered in CI. The FSM already decides review-vs-reply in one entrypoint, so this is trigger wiring, not agent code — captured in [azure-reply-flow-runbook.md](../../reference/azure-reply-flow-runbook.md) + [`azure/azure-reply-pipeline.yml`](../../../azure/azure-reply-pipeline.yml): Service Hook on `ms.vss-code.git-pullrequest-comment-event` → Azure Pipelines **Incoming Webhook** (`resources.webhooks`) → a reply pipeline reading `resource.pullRequest.pullRequestId` from the payload (`System.PullRequest.*` is unset on webhook runs). Agent-authored comments self-fire a cheap no-op run (FSM dedups by footer/timestamp — no loop); hybrid (build-validation reviews + webhook replies) kept, not unified. Comment-command triggers (`/azp run`) are GitHub-only, not usable for Azure Repos. Still unverified before shipping: the HMAC handshake between the Web Hooks service hook and the Incoming Webhook connection, and the exact payload paths — both gated behind a live-payload capture (runbook Phase 0).
- **Diff reconstruction (the crux):** Azure has **no unified-diff REST endpoint** — verified against the [Diffs - Get reference](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/diffs/get?view=azure-devops-rest-7.1): `diffs/commits` returns only a file-level change list (`changeType` + path + blob object IDs, **no hunks, no line content**). The PR web UI renders its +/- view client-side via an internal, undocumented `_api/_versioncontrol/fileDiff` endpoint (outside the versioned `_apis` surface — unsafe to depend on); Microsoft's own [azure-devops-mcp](https://github.com/microsoft/azure-devops-mcp/issues/664) reconstructs file diffs the same way. So `getDiff`/`getCommitDiff` rebuild one: `GET diffs/commits` yields a file-level change list (filtered to `gitObjectType: 'blob'`, folders/trees dropped); for each changed blob the old + new content is fetched via the Items API; `diff` (jsdiff) `structuredPatch` produces hunks which are formatted into `diff --git a/… b/…` + `--- a/…` / `+++ b/…` (`/dev/null` for the missing side of an add/delete) + `@@` headers — **byte-compatible** with `filterDiff` / `countChangedLines` / `scanTodos`. add → all `+`; delete → all `-`; rename uses `originalPath`; binaries (NUL byte) and files over `MAX_DIFF_FILE_CHARS` are skipped. `getDiff` uses `diffCommonCommit=true` (three-dot, PR semantics); `getCommitDiff` uses two-dot. Costs ~2 content fetches per changed blob.
- **Comments are threads:** `postComment` = `POST …/pullRequests/{id}/threads` (new thread, `commentType:1`, `status:1`); `postReply` = `POST …/threads/{threadId}/comments` with `{content, parentCommentId, commentType:1}`; reads = `GET …/threads` with nested `comments[]`. Replies live in the **same** thread as the review they answer.
- **Composite IDs:** the interface uses single-string IDs but Azure identifies a comment by `(threadId, commentId)`. Encoded as `"{threadId}:{commentId}"` in `ReviewComment.id`/`CommentReply.parentId` and split back apart in `postReply`. Contained to the adapter.
- **Agent comment detection:** same footer matching as Bitbucket (`hasReviewFooter`/`hasReplyFooter` on comment `content`) — imported and reused, not reimplemented.
- **PR info:** `sourceRefName`/`targetRefName` strip `refs/heads/`; source commit = `lastMergeSourceCommit.commitId`; PR-diff base/target = `lastMergeTargetCommit`/`lastMergeSourceCommit`.
- **Repo file lookup (prompt/instructions):** `getRepoFileContent(path, ref)` picks the Items API `versionDescriptor.versionType` **by ref shape** — a 7–40-char hex ref → `commit`; anything else (e.g. a branch name like `main`, which `loadPrompt` passes as a fallback ref) → `branch`. A hardcoded `commit` here 400s on a branch name — the original WIP bug that killed the run instead of falling back. A missing file returns `null` (catches **404 and 400**) so the loader cleanly defaults. `getFileContent` (diff/context path) always receives commit SHAs, so it stays `versionType: 'commit'`.
- **Dependency:** adds `diff` (jsdiff) + `@types/diff`; esbuild bundles it automatically.

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
