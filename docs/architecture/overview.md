# Architecture Overview

## Purpose

The PR Review Agent is a stateless CLI tool that:

1. Is triggered by Jenkins when a PR is opened or updated
2. Fetches the diff and relevant file context from Bitbucket (or later: GitHub/GitLab)
3. Assembles a structured prompt and sends it to Claude
4. Posts the review as a comment on the PR

No code is checked out. No data is stored. One run = one review.

---

## Repository Structure

```
pr-review-agent/
├── src/
│   ├── index.ts                  # Entry point, CLI arg parsing
│   ├── config.ts                 # Config loading, env vars
│   ├── review.ts                 # Orchestration logic
│   ├── claude/
│   │   └── client.ts             # Anthropic API wrapper
│   ├── vcs/
│   │   ├── adapter.ts            # VCS interface (abstract)
│   │   ├── bitbucket.ts          # Bitbucket implementation
│   │   ├── github.ts             # GitHub implementation (stub — Phase 3)
│   │   └── gitlab.ts             # GitLab implementation (stub — Phase 3)
│   ├── prompt/
│   │   ├── loader.ts             # Loads system prompt (repo-specific or default)
│   │   └── default-prompt.txt    # Fallback prompt
│   └── context/
│       ├── fetcher.ts            # Fetches additional context files beyond diff
│       └── diffParser.ts         # Unified diff parser for line mapping (Phase 4)
├── prompts/                      # Optional: versioned prompts per tech stack
│   ├── java-spring.txt
│   ├── groovy-grails.txt
│   ├── angular-typescript.txt
│   └── dotnet.txt
├── docs/                         # This directory
├── package.json
├── tsconfig.json
├── .env.example
└── Jenkinsfile.shared            # Reference pipeline snippet
```

---

## Tech Stack

| Concern | Choice |
|---------|--------|
| Language | TypeScript |
| Runtime | Node.js via `tsx` / `ts-node` |
| Claude API | `@anthropic-ai/sdk` |
| HTTP client | `axios` |
| CLI args | `commander` |
| Model | `claude-sonnet-4-6` (configurable via `CLAUDE_MODEL` env var) |

---

## Out of Scope (Explicitly)

- No local git checkout at any point — everything via API
- No storing PR content or diffs beyond the current request
- No modifying or approving PRs — comment only
- No persistent database — stateless per run
