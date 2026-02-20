# Phase 3 — Multi-VCS Support

## Goal

Drop-in support for GitHub and GitLab without changing orchestration logic.
The adapter pattern established in Phase 1 makes this straightforward.

## Status: ⏸ Deferred

> **Do not start this phase until Phase 2 (Jenkins integration) is stable in production
> with Bitbucket.** GitHub and GitLab adapters should exist as empty stubs implementing
> the interface — throwing `NotImplementedError` — until this phase is actively worked.

---

## Tasks

- [ ] Implement `src/vcs/github.ts` — `GitHubAdapter` using GitHub REST API v3
- [ ] Implement `src/vcs/gitlab.ts` — `GitLabAdapter` using GitLab REST API v4
- [ ] Verify interface compliance (TypeScript enforces this at compile time)
- [ ] Document env vars per provider (see [reference/env-vars.md](../reference/env-vars.md))
- [ ] Test each adapter against a real PR on the respective platform

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
| GitHub | `GET /repos/{owner}/{repo}/pulls/{id}` (accept: `application/vnd.github.v3.diff`) | `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` | `POST /repos/{owner}/{repo}/issues/{id}/comments` |
| GitLab | `GET /projects/{id}/merge_requests/{iid}/changes` | `GET /projects/{id}/repository/files/{path}?ref={branch}` | `POST /projects/{id}/merge_requests/{iid}/notes` |

---

## Completion Criteria

- All three adapters pass the same integration test suite against real PRs
- `VCS_PROVIDER` switching works without code changes
- TypeScript compilation confirms interface compliance
