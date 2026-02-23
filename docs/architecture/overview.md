# Architecture Overview

## Purpose

The PR Review Agent is a stateless CLI tool that:

1. Is triggered by Jenkins when a PR is opened or updated
2. Fetches the diff and relevant file context from Bitbucket (or later: GitHub/GitLab)
3. Assembles a structured prompt and sends it to Claude
4. Posts the review as a comment on the PR
5. On re-triggers: skips if already reviewed (commit hash dedup), responds to developer
   questions (comment replies), or produces a delta review (new commits)

No code is checked out. No data is stored. One run = one review (or one reply).

---

## Repository Structure

```
pr-review-agent/
├── src/
│   ├── index.ts                  # Entry point, CLI arg parsing
│   ├── config.ts                 # Config loading, env vars, thresholds
│   ├── review.ts                 # Orchestration: review, delta review, reply, skip logic
│   ├── claude/
│   │   └── client.ts             # Anthropic API wrapper (review + reply endpoints)
│   ├── vcs/
│   │   ├── adapter.ts            # VCS interface (abstract)
│   │   ├── bitbucket.ts          # Bitbucket implementation
│   │   ├── github.ts             # GitHub stub (backlog)
│   │   └── gitlab.ts             # GitLab stub (backlog)
│   ├── prompt/
│   │   ├── loader.ts             # Loads base template, parses repo sections, fills placeholders
│   │   ├── base-prompt.txt       # Shared review template (SCOPE, RULES, OUTPUT FORMAT)
│   │   ├── reply-prompt.txt      # System prompt for conversational replies to developer questions
│   │   └── defaults.ts           # Default values for ROLE, REVIEW PRIORITIES, MENTAL MODEL
│   └── context/
│       ├── fetcher.ts            # Fetches additional context files beyond diff
│       └── diffParser.ts         # Unified diff parser for line mapping (Phase 4)
├── prompts/                      # Example repo-specific prompts (ROLE + PRIORITIES + MENTAL MODEL)
│   ├── java-spring.txt
│   └── angular-ionic.txt
├── scripts/
│   └── bundle.mjs                # esbuild config — single-file CJS bundle
├── dist/
│   └── pr-review-agent.cjs       # Pre-built bundle (committed, no npm install needed)
├── docs/                         # This directory
├── package.json
├── tsconfig.json
└── .env.example
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
