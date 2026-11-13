---
type: domain
topic: VCS adapter interface, Bitbucket/Azure/GitHub implementations, supporting types
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
  getRepliesToReviewComments(prId: string, reviewCommentIds: string[], includeAnswered?: boolean): Promise<ReplyResult>  // ReplyResult = { replies: CommentReply[]; agentReplyCount: number }
  postReply(prId: string, parentId: string, body: string): Promise<void>
  filterAddressedToAgent?(replies: CommentReply[], agentIds: ReadonlySet<string>): Promise<CommentReply[]>  // optional capability — Bitbucket only

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
| `azure` | `AzureDevOpsAdapter` | **Experimental / WIP** — all 10 methods implemented; validated end-to-end against a live cloud Services org (read / write / footer dedup, pipeline `System.AccessToken` auth, delta, reply flow). Not yet on-prem Server |
| `github` | `GitHubAdapter` | **Experimental** — fully implemented for **same-repo** PRs, triggered via GitHub Actions (`.github/workflows/pr-review.yml`). Fork PRs out of scope (read-only token). Flat issue-comment review/reply model; no inline comments yet |
| `gitlab` | `GitLabAdapter` | Stub — throws `not implemented`; rejected at startup (exit 1) from 0.0.46 |

`--vcs azure` (or `VCS_PROVIDER=azure`) selects it. Prints a one-line WIP warning on construction.

`ReviewBenchAdapter` (`src/vcs/reviewbench.ts`) is not a `--vcs` value. `--benchmark` selects it (see below).

---

## ReviewBench Adapter (benchmark mode)

`--benchmark` (`src/benchmark.ts`) runs the normal FSM against mounted files instead of a VCS API, then writes ReviewBench findings JSON to `RB_OUT` (see [`reviewbench/README.md`](../../../reviewbench/README.md)). The adapter:
- **Input:** `getDiff` reads `RB_DIFF`. `getChangedFiles` parses it with `parseChangedFiles`. File and repo-prompt reads come from the `RB_REPO` checkout (default `/work/repo`), pinned at `RB_HEAD`, so `ref` is ignored. Reads are refused outside the checkout (`../`, symlinks) and for binary files.
- **PR info:** comes from `pr.json`; `sourceCommit = RB_HEAD`. Author and branch names don't exist there, so they're placeholders (`unknown`, `head@<sha12>`/`base@<sha12>`). A missing or partial `pr.json` doesn't crash.
- **Single-shot:** no prior reviews or replies, so every run is a first review. `postComment`/`postReply` are no-ops. `getCommitDiff` throws because there is no delta.
- **Output:** the FSM hands the structured review to an outcome sink in `POST_REVIEW` (see [review/fsm.md](../review/fsm.md)). A single-pass judged run uses the structured kept findings (`judgedFindings` → `keptToReportFindings`); a kept finding with a changed file but no usable line is placed on that file's first added line, or line 1 when the file has no added line but still exists at head, e.g. rename-only (`anchorToFile`, `anchorSource: 'file'`), since ReviewBench matches by meaning within a file. Each `findings.json` entry carries an extra optional `proposal` key only when `RB_CONFIG_J_PROPOSAL=1` (or `ENABLE_JUDGE_PROPOSALS`) is on and the judge supplied one; the default shape stays the five required keys, and `J_PROPOSAL` is echoed as `j_proposal=0/1` on the settings line. `ENABLE_SUGGESTED_FIXES` (no label) also turns proposals on, as dedented code, and is echoed as `sfx=0/1`. The prose merge described next applies only to bundled reviews. When judged, the runner **merges two sources** (`mergeJudgedFindingsWithStats`, which also returns a `MergeStats` tally the benchmark logs): the judge's own `(file:lines)` citations parsed from `review_markdown` (`parseJudgedBullets`, one row per cited file, passed through untouched so multi-file and same-file multi-line rows all survive), plus structured recoveries from the judge's kept scores (`resolveKeptFindings` → `keptToReportFindings`) that re-anchor a finding the judge located as prose by matching it back to the reviewer's structured findings (kept-set-driven, so a title reframe never drops it; anchor taken atomically from the reviewer finding — else the judge's own, else none — with `anchorSource` recording which). Each kept score is paired to its markdown bullet by exact title (consuming one bullet apiece for duplicates); a recovery is dropped only when its bullet was already located in the markdown, so a prose-located finding is recovered even when a distinct finding sits on the same lines, and a finding never yields two rows. With no judge scores the markdown rows stand alone. Unjudged, it maps the reviewer's findings. Findings without a `file` + parseable `lines` are dropped, cited paths are snapped to the diff's exact path, and it writes `{pr, agent, findings[]}`. A judge failure falls back to the unjudged reviewer findings; any other error still writes `findings: []` and exits 0.
- **Lenses label:** `RB_CONFIG_LENSES` is one value label doubling as the switch, because the manifest caps labels at 6: the bare value is the lens list (`reliability+security`, comma or plus; aliases `rel`/`sec`/`test`/`perf`/`arch` exist because the platform builds a run's row id from label values and rejects ids over 64 chars, so `rel+perf` fits where `reliability+performance` does not), and a value naming ≥1 known lens turns lenses on; `0`/`off` turns them off (overriding a baked `ENABLE_LENSES`), an unknown-only value warns and leaves them off, and an empty value is ignored like every label. Active lenses are echoed as `lenses=<value as given>` at the end of the settings line (absent when off), and the `Benchmark findings:` line adds `lens N` (lens candidates before judging). Lens findings reach `findings.json` only through the judge, so its shape is unchanged.
- **Lens recommendation label:** `RB_CONFIG_LENS_REC` (0/1) sets `ENABLE_LENS_RECOMMENDATION`, independent of `LENSES`. On, it is echoed as `lens_rec=1` at the end of the settings line (absent when off) and the reviewer's picks land only in the usage record (`lens_recommendations`), never in `findings.json` or the judge input.

---

## Bitbucket Implementation Details

- **Auth:** HTTP Basic Auth — `BITBUCKET_USERNAME` (email) + `BITBUCKET_TOKEN` (Atlassian API token, starts with `ATATT3x...`)
- **Diff endpoint:** Returns a 302 redirect. The adapter handles the redirect manually, preserving auth headers (axios default strips them on redirect).
- **API token scopes required:** `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`
- **Cloud only:** the adapter targets Bitbucket Cloud API 2.0 response shapes (`values` pagination, `content.raw`, diffstat redirects). Bitbucket Server/DC exposes a different v1 REST API — pointing `BITBUCKET_BASE_URL` at it fails on the first call; Server support would need its own adapter.
- **Agent comment detection:** the agent's own comments are recognized by their exact footer line (`hasReviewFooter`/`hasReplyFooter` from `review/formatter.ts`), not by author — a comment quoting a full agent footer would still match (rare, accepted).
- **Reply threads:** `getRepliesToReviewComments` returns every live comment whose `parent.id` chain reaches a review comment, at any depth and whatever the API order (deleted, missing or looping links end the chain), oldest first, each with its direct parent as `parentId`; `postReply` posts under that id. A human reply to a human comment that does not `@`-mention the agent (`mentionsAgent`, same ids and names as below) carries `contextOnly: true`; the FSM never answers it. See [review/replies.md](../review/replies.md#detection-algorithm).
- **`filterAddressedToAgent` (optional capability, Bitbucket only):** of the unanswered replies, keeps only those addressed to the agent and drops ones a dev `@`-directed solely at another person/team (`SKIP_DIRECTED_REPLIES`, default off). GitHub/Azure/GitLab/ReviewBench omit it → unchanged by construction. The agent **id-set is derived, never fetched** (`/2.0/user` would double the `/2.0` path and likely lacks the scope): during `getRepliesToReviewComments` the adapter records `user.account_id` + brace-stripped `user.uuid` (and `display_name`/`nickname` for the plain-text `@name` check) of the review comments and the agent-reply footer comments into a private set. Derivation only ever *adds* ids, so it fails safe; an empty set keeps everything + warns. The method is valid only right after a `getRepliesToReviewComments` call (true at both orchestrator sites). The pure drop rule lives in `src/vcs/mention-filter.ts`. **Mentions match `account_id`, not `uuid`** — every real `content.raw` mention is `@{account_id}` (legacy 24-hex or `NNN:uuid`); matching uuid would drop every genuine agent-directed reply. Over-drop-averse: a reply is dropped only when its code-stripped body **starts with** an id-shaped `@{…}`, **no** id-shaped token anywhere is an agent id, and **no** plain-text `@<agent name>` appears — so `@{vm.name}` code, mid-sentence mentions, and picker-less agent mentions are all kept.

---

## Azure DevOps Implementation Details (WIP)

`src/vcs/azure.ts` — experimental. Purely additive: no existing adapter, the interface, or `review/*` was touched. **Validated end-to-end against a live Azure DevOps Services (cloud) org** — `getPullRequestInfo`, diff reconstruction, `getChangedFiles`, `getFileContent` context, `getRepoFileContent`, `postComment`, and footer dedup (`getPreviousReviewComments`) all confirmed on a real PR (dry-run → post → dedup-skip). Still WIP: on-prem **Server** only — cloud Services is validated live end-to-end, including `System.AccessToken` pipeline auth, the `getCommitDiff` delta path, and the reply flow.

- **Auth (dual, config-selected):** the auth header is computed **once** in the constructor by precedence — if `AZURE_ACCESS_TOKEN` is set it wins as `Authorization: Bearer {token}` (OAuth, e.g. an Azure Pipelines `System.AccessToken` — zero-PAT); otherwise `AZURE_PAT` is used as HTTP Basic with an empty username, `Authorization: Basic base64(":{PAT}")`. `validateAzureConfig()` requires `AZURE_ORG`, `AZURE_PROJECT`, and **at least one** of `AZURE_PAT` / `AZURE_ACCESS_TOKEN`. `?api-version=7.1` is sent on every call (axios instance default param).
- **Config / base URL:** `AZURE_BASE_URL` (default `https://dev.azure.com`, point at an on-prem Server collection URL for self-hosted) + `AZURE_ORG` + `AZURE_PROJECT` + `AZURE_PAT`/`AZURE_ACCESS_TOKEN`; repo via `--repo-slug`. `--workspace` aliases `AZURE_ORG`. Base URL is built as `{baseUrl}/{org}/{project}/_apis/git`. Mirrors the Bitbucket config pattern (`optional()` defaults + `validateAzureConfig()`).
- **CI integration:** [`azure/azure-pipelines.yml`](../../../azure/azure-pipelines.yml) is a build-validation pipeline. Gotchas: the YAML `pr:` trigger is ignored for Azure Repos — wire it via **Branch Policies → Build Validation** (set Optional so agent failure never blocks the PR); enable **"Allow scripts to access the OAuth token"** so `System.AccessToken` is exposed; grant the **"{Project} Build Service"** identity **"Contribute to Pull Requests"** so it can post threads. Org + base URL are derived by splitting `System.CollectionUri`; `AZURE_PROJECT=$(System.TeamProject)`, repo=`$(Build.Repository.Name)`, PR=`$(System.PullRequest.PullRequestId)`; `ANTHROPIC_API_KEY` is a secret var mapped explicitly into the step env. **Verified live** (cloud Services, PR #1 on a test org): create/update trigger → zero-PAT `System.AccessToken` auth → the Build Service identity posts the review → re-queues on push (delta review #2 confirmed). Both sample pipelines include the shared variables template [`azure/pr-review-settings.yml`](../../../azure/pr-review-settings.yml) (`AGENT_TAG` = v0.0.45, branch policy, ignore list), so reviews and replies apply the same branch policy. The branch lists are pipeline variables named like the agent's env vars, which Azure exports to the script step; the template defines none, so the agent defaults apply (unset, not `''`, which would turn a list off), with the trunk recipe commented as the alternative. The ignore list reaches the step env through compile-time `${{ variables.x }}`, so a missing entry is `''`, never a literal `$(x)`. They also use `checkout: none` (the agent reads only through the API; a checkout put the reviewed repo's git state into the footer's `Build:` and its `.env` into the config), `rm -f results.jsonl` before the run, and map `JOB_NAME`/`BUILD_NUMBER`/`BUILD_URL` from `Build.DefinitionName`/`Build.BuildId`/the run URL so the record's `jenkins` field and the footer build link work. These 0.0.43+ settings are not yet run live. Build validation resolves the YAML and the template from the PR **source branch**, so that branch must contain both. CI repo-prompt = a committed `.agent-review-instructions.md` (the `getRepoFileContent` fix makes this work on Azure); `--prompt` is unusable in CI because the pipeline only downloads the bundle, not `prompts/`.
- **Reply-on-comment trigger (validated live, WIP):** build validation fires on PR create/update but **not** on comments, so the reply flow needs a second trigger. The FSM already decides review-vs-reply in one entrypoint, so this is trigger wiring, not agent code — captured in [azure-devops.md](../../reference/azure-devops.md) + [`azure/azure-reply-pipeline.yml`](../../../azure/azure-reply-pipeline.yml): Service Hook on `ms.vss-code.git-pullrequest-comment-event` → Azure Pipelines **Incoming Webhook** (`resources.webhooks`) → a reply pipeline reading `resource.pullRequest.pullRequestId` from the payload (`System.PullRequest.*` is unset on webhook runs). **Validated end-to-end on an Azure DevOps Services test org**: comment → Service Hook → Incoming Webhook → reply pipeline → agent posts a reply, confirmed. The Incoming Webhook secret can be left **blank** (no HMAC needed) and still fires — resolves what was the biggest open question. Agent-authored comments self-fire a run that posts nothing (FSM dedups by footer/timestamp — no loop) but still reconstructs the PR diff first (no model tokens, ~2 REST calls per changed file); the sample passes `TRIGGER_EVENT`/`TRIGGER_COMMENT_AUTHOR` (`resource.comment.author.id`) so listing the Build Service GUID in `IGNORE_COMMENT_AUTHORS` skips them before any Azure call. A comment on an in-policy PR with no review yet gets a first review. Hybrid (build-validation reviews + webhook replies) kept, not unified. Comment-command triggers (`/azp run`) are GitHub-only, not usable for Azure Repos. **Review-vs-reply priority:** the FSM handles new commits before comments — a comment on a PR with unreviewed new commits triggers a delta review, not a reply; a reply posts only when the current commit is already reviewed and a human question is unanswered in a review thread. **Throttling:** none native (every comment = one pipeline run); skip agent-authored comments with `IGNORE_COMMENT_AUTHORS` (or a pipeline condition). No lock is needed for correctness; an exclusive lock must use `lockBehavior: sequential` (the default `runLatest` cancels waiting runs).
- **Diff reconstruction (the crux):** Azure has **no unified-diff REST endpoint** — verified against the [Diffs - Get reference](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/diffs/get?view=azure-devops-rest-7.1): `diffs/commits` returns only a file-level change list (`changeType` + path + blob object IDs, **no hunks, no line content**). The PR web UI renders its +/- view client-side via an internal, undocumented `_api/_versioncontrol/fileDiff` endpoint (outside the versioned `_apis` surface — unsafe to depend on); Microsoft's own [azure-devops-mcp](https://github.com/microsoft/azure-devops-mcp/issues/664) reconstructs file diffs the same way. So `getDiff`/`getCommitDiff` rebuild one: `GET diffs/commits` yields a file-level change list (filtered to `gitObjectType: 'blob'`, folders/trees dropped); for each changed blob the old + new content is fetched via the Items API; `diff` (jsdiff) `structuredPatch` produces hunks which are formatted into `diff --git a/… b/…` + `--- a/…` / `+++ b/…` (`/dev/null` for the missing side of an add/delete) + `@@` headers — **byte-compatible** with `filterDiff` / `countChangedLines` / `scanTodos`. add → all `+`; delete → all `-`; rename uses `originalPath`; `changeType` is a comma-separated flag list matched by whole token (`edit, rename` → rename; `delete, sourceRename` → delete, never a rename of the vacated old path); binaries (NUL byte) and files over `MAX_DIFF_FILE_CHARS` are skipped. `getDiff` uses `diffCommonCommit=true` (three-dot, PR semantics); `getCommitDiff` uses two-dot. Costs ~2 content fetches per changed blob.
- **Delta base resolution (`getCommitDiff`):** `diffs/commits` needs full SHAs but the footer carries 12 chars. The prefix is matched against the 200 newest commits reachable from the head (`GET commits`, the only extra call on the common path); when it is not there (rebase / force-push, or >200 newer commits) the adapter (from 0.0.46) tries the PR's pushed heads (`GET pullRequests/{id}/iterations` → `sourceRefCommit.commitId`), with the PR id remembered from `getPullRequestInfo` (the interface passes none). Not found, or the iterations call fails → throws → the FSM's full-diff fallback (`deltaFetchFailed`, no `checked_commit`). Unverified: whether Azure diffs a commit that is retained for an iteration but unreachable from any branch; if not, the delta still fails the same way. Known limit: the delta is two-dot, so after a rebase onto a moved target it can be empty while the PR diff changed (the target deleted a line the rebase kept: same tree, `DEDUP_SKIP` + `checked_commit`, yet the PR diff now adds the line); see [azure-devops.md](../../reference/azure-devops.md#checked-commit-on-azure-optional).
- **Strict delta blobs (from 0.0.46):** in `getCommitDiff` a 404 on a side the change entry says exists (edit: both; add: new; delete: old; rename: both when the original path differs) throws, because a silently dropped file could let the run mark the head checked. `getDiff` keeps skipping such a file. Binary and oversized blobs are skipped in both.
- **Comments are threads:** `postComment` = `POST …/pullRequests/{id}/threads` (new thread, `commentType:1`, `status:1`); `postReply` = `POST …/threads/{threadId}/comments` with `{content, parentCommentId, commentType:1}`; reads = `GET …/threads` with nested `comments[]`. Replies live in the **same** thread as the review they answer.
- **Composite IDs:** the interface uses single-string IDs but Azure identifies a comment by `(threadId, commentId)`. Encoded as `"{threadId}:{commentId}"` in `ReviewComment.id`/`CommentReply.parentId` and split back apart in `postReply`. Contained to the adapter.
- **Agent comment detection:** same footer matching as Bitbucket (`hasReviewFooter`/`hasReplyFooter` on comment `content`) — imported and reused, not reimplemented.
- **PR info:** `sourceRefName`/`targetRefName` strip `refs/heads/`; source commit = `lastMergeSourceCommit.commitId` (the source head, not the merge commit build validation builds); from 0.0.46 a PR without it throws rather than returning an empty head, which would post a footer no run can dedup against; PR-diff base/target = `lastMergeTargetCommit`/`lastMergeSourceCommit`.
- **Repo file lookup (prompt/instructions):** `getRepoFileContent(path, ref)` picks the Items API `versionDescriptor.versionType` **by ref shape** — a 7–40-char hex ref → `commit`; anything else (e.g. a branch name like `main`, which `loadPrompt` passes as a fallback ref) → `branch`. A hardcoded `commit` here 400s on a branch name — the original WIP bug that killed the run instead of falling back. A missing file returns `null` (catches **404 and 400**) so the loader cleanly defaults. `getFileContent` (diff/context path) always receives commit SHAs, so it stays `versionType: 'commit'`.
- **Dependency:** adds `diff` (jsdiff) + `@types/diff`; esbuild bundles it automatically.

---

## GitHub Implementation Details (experimental)

`src/vcs/github.ts` — fully implemented for **same-repo** PRs; triggered via GitHub Actions (see below). Purely additive: the `VCSAdapter` interface was unchanged (it already had `getCommitDiff`).

- **Auth / config:** `Authorization: Bearer {GITHUB_TOKEN}`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`. `GITHUB_OWNER` (aliased by `--workspace`) + `--repo-slug` → repo; `GITHUB_BASE_URL` defaults to `https://api.github.com`, point it at `<host>/api/v3` for GitHub Enterprise. `validateGitHubConfig()` requires `GITHUB_OWNER` and `GITHUB_TOKEN`. Every request has a 30s timeout, except the `/compare` requests (406 fallback and delta), which get 120s.
- **REST mapping:** PR info from `GET /repos/{owner}/{repo}/pulls/{id}`; changed files from `…/pulls/{id}/files`; file content from `…/contents/{path}` with `Accept: application/vnd.github.raw` (`getRepoFileContent` omits `ref` to hit the default branch and maps 404 → `null`); diff from the PR endpoint with `Accept: application/vnd.github.diff`. File-status mapping normalizes GitHub's `removed` → `deleted` (added/renamed pass through, everything else → `modified`).
- **Flat issue-comment review/reply model:** reviews and replies are both plain **issue comments** (`POST …/issues/{id}/comments`) — GitHub issue comments have no `parent.id`, so there is no threading. The agent treats the whole PR as one thread: a "reply" is any non-agent comment posted **after the agent's latest comment** (review or reply), detected by footer (`hasReviewFooter`/`hasReplyFooter`). From 0.0.46, comments from `user.type === 'Bot'` accounts (coverage bots, other workflows) are never replies, on the unanswered and the `includeAnswered` path; the footer checks run first, so an agent posting through a bot identity (`github-actions[bot]`, an App token) still counts as the agent. `postReply` ignores `parentId` and posts a new issue comment; `parentId` on returned replies is just the latest review's id so the FSM has an anchor. Contrast Bitbucket (follows `parent.id` chains) and Azure (thread membership), whose models are threaded (see [review/replies.md](../review/replies.md)).
- **Pagination:** list endpoints (`/files`, `/issues/{id}/comments`) page via the `Link` header `rel="next"`, not a body field — `getPaginated` walks it with `per_page=100`.
- **Large-PR diff fallback:** the PR diff endpoint returns **406** past GitHub's render limits (~300 files / 20k lines / 1 MB). On 406 only (every other error re-throws), `getDiff` falls back to the `/compare/{base}...{head}` endpoint, which has no diff-size ceiling and returns a byte-identical git diff. The anchor is `base.ref` for an open PR (reproduces GitHub's merge-base diff) or the recorded `base.sha` for a closed one. The fallback is bounded: **>3000 changed files** → `PrTooLargeError` before download, and a compare body over **25 MB** aborts the stream → `PrTooLargeError`. The FSM turns `PrTooLargeError` into a clean **SKIP**, never an ERROR (consistent with "AI review never gates a merge"); a non-size compare failure surfaces as a real error. `getCommitDiff` (delta reviews) hits the same `/compare/{from}...{to}` endpoint for the commit-to-commit delta, with the same 120s timeout; any failure there, a timeout included, sends the FSM to the full-diff fallback.

### GitHub Actions deployment

`.github/workflows/pr-review.yml` is the GitHub-native trigger (the equivalent of the Jenkins/Azure pipelines). Full wiring, rationale and unverified items: [github-actions.md](../../reference/github-actions.md).
- **Triggers:** `pull_request` (opened, synchronize, reopened, and `edited` only when the base changed, i.e. a retarget) for reviews + `issue_comment` (created) for replies.
- **Guards (job `if:`):** `pull_request` only for same-repo heads (fork PR runs get a read-only token and no secrets) whose PR author's `author_association` is `OWNER`/`MEMBER`/`COLLABORATOR` (any reader can open a PR between existing branches), so PRs from Apps/bots or non-collaborators wait for a trusted comment. `issue_comment` only on an **open** PR, from a non-`Bot` commenter whose `author_association` is `OWNER`/`MEMBER`/`COLLABORATOR`; the comment payload has no head repo, so a first step checks it via the API and skips the remaining steps on a fork PR (fails closed). Both paths skip PRs **authored** by `dependabot[bot]` (PR author, not actor: a human pushing to a Dependabot PR would otherwise run its dependency tree with the LLM key; comments are excluded because `@dependabot` commands would each start a paid run).
- **Permissions:** `pull-requests: write`, `contents: read`. **Job-level** `concurrency` per PR with `cancel-in-progress: false`: a job skipped by `if:` never joins the group, and a paid review is never cancelled mid-run.
- **Env:** `LLM_PROVIDER: openrouter` + `OPENROUTER_API_KEY` and the workflow-provided `GITHUB_TOKEN` as secrets; `CLAUDE_MODEL`/`JUDGING_MODEL`/`REPLY_MODEL` all `anthropic/claude-haiku-5.5`; `AGENT_IDENTITY: github-actions[bot]` (the footer display name); `SKIP_TARGET_BRANCHES: ""` because the GitHub flow targets `main` directly and the `main,master` default would skip every PR. The job runs `npm ci && npm run bundle` then invokes the agent with `--vcs github --workspace {owner} --repo-slug {repo} --pr-id {number}`.

The agent's own comments don't re-trigger it: a comment posted with `GITHUB_TOKEN` starts no workflow run. The `Bot` guard also covers an App token; with a PAT the agent posts as a `User` and its comment starts a run (a `DEDUP_SKIP` when the footer names the head). The adapter recognizes the agent's comments by footer, not author.

---

## Supporting Types

```typescript
interface PRInfo {
  id: string
  title: string
  description: string
  author: string         // PR author display name (logged, not used for dedup)
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
  resolved?: boolean     // a human-resolved review is excluded from the supersede boundary
}

interface CommentReply {
  id: string
  parentId: string       // Bitbucket: the direct parent comment's id; Azure/GitHub: the review's id. RESPOND_TO_REPLIES posts under the last reply's parentId
  author: string         // display name of the reply author (`Agent (prior reply)` for the agent's own earlier replies)
  authorId?: string      // stable account id for usage records only, never in model input: Bitbucket `user.uuid` (else `account_id`), Azure comment author `id`; absent when the payload lacks it and always on GitHub, where `author` is already the `login`
  contextOnly?: true     // Bitbucket only: a reply to a human that doesn't @-mention the agent; its body stays reviewer context, it is never answered, and the flag itself never reaches a model
  body: string
  createdOn: string      // ISO timestamp, used for reply dedup
}

interface ReplyResult {
  replies: CommentReply[]
  agentReplyCount: number   // agent replies already on the PR (for MAX_REPLY_COMMENTS)
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
