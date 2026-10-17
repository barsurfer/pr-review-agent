# Phase 3 — Multi-VCS Support

## Goal

Drop-in support for GitHub and GitLab without changing orchestration logic.
The adapter pattern established in Phase 1 makes this straightforward.

## Status: 🚧 Partially shipped

> **GitHub** is implemented (experimental) for **same-repo** PRs, triggered via GitHub
> Actions ([`.github/workflows/pr-review.yml`](../../.github/workflows/pr-review.yml)) —
> flat issue-comment review/reply model, 406→`/compare` diff fallback, fork PRs out of
> scope. **GitLab** is still an empty stub implementing the interface. (Azure DevOps was
> added separately as an experimental adapter, validated live on a cloud project — see
> [architecture/vcs-adapter.md](../architecture/vcs-adapter.md).)
> Revisit GitLab when there's a concrete need; GitHub follow-ups are inline comments and
> fork-PR support.

---

## Tasks

- [x] Implement `src/vcs/github.ts` — `GitHubAdapter` using the GitHub REST API (same-repo PRs)
- [ ] Implement `src/vcs/gitlab.ts` — `GitLabAdapter` using GitLab REST API v4
- [x] Verify interface compliance (TypeScript enforces this at compile time)
- [x] Document env vars per provider (see [reference/env-vars.md](../reference/env-vars.md))
- [x] Test the GitHub adapter against a real same-repo PR (via GitHub Actions); GitLab still pending
- [ ] GitHub follow-ups: inline comments, fork-PR support

---

## Environment Variables

### GitHub

```env
VCS_PROVIDER=github
GITHUB_BASE_URL=https://api.github.com
GITHUB_TOKEN=your-personal-access-token
GITHUB_OWNER=your-org-or-username
```

### GitLab

```env
VCS_PROVIDER=gitlab
GITLAB_BASE_URL=https://gitlab.com/api/v4
GITLAB_TOKEN=your-personal-access-token
GITLAB_PROJECT_ID=12345
```

---

## API Reference

| Provider | Diff endpoint | File content endpoint | Post comment endpoint |
|----------|--------------|----------------------|----------------------|
| GitHub | `GET /repos/{owner}/{repo}/pulls/{id}` (accept: `application/vnd.github.diff`) | `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` (accept: `application/vnd.github.raw`) | `POST /repos/{owner}/{repo}/issues/{id}/comments` |
| GitLab | `GET /projects/{id}/merge_requests/{iid}/changes` | `GET /projects/{id}/repository/files/{path}?ref={branch}` | `POST /projects/{id}/merge_requests/{iid}/notes` |

**GitHub diff fallback:** the PR diff endpoint returns **406** past GitHub's render limits
(~300 files / 20k lines / 1 MB). `GitHubAdapter.getDiff` then falls back to
`GET /repos/{owner}/{repo}/compare/{base}...{head}` (no size ceiling, byte-identical git diff);
over 3000 changed files or a 25 MB diff it throws `PrTooLargeError`, which the FSM turns into a
clean SKIP. Replies/reviews are flat issue comments (`postReply` posts a new issue comment —
GitHub issue comments have no `parent.id`). List endpoints page via the `Link` header.

---

## Completion Criteria

- All three adapters pass the same integration test suite against real PRs
- `VCS_PROVIDER` switching works without code changes
- TypeScript compilation confirms interface compliance
