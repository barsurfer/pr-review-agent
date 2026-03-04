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
│   ├── review/
│   │   ├── index.ts             # FSM orchestrator: transition loop, public review() API
│   │   ├── types.ts             # State enum, ReviewContext interface
│   │   ├── parsers.ts           # Diff filtering, line counting, verdict/findings/delta parsing
│   │   ├── formatter.ts         # Comment footer builders, commit hash extraction
│   │   └── usage.ts             # UsageRecord type, cost estimation, record builder
│   ├── claude/
│   │   └── client.ts             # Anthropic API wrapper (review + judge + reply endpoints)
│   ├── vcs/
│   │   ├── adapter.ts            # VCS interface (abstract)
│   │   ├── bitbucket.ts          # Bitbucket implementation
│   │   ├── github.ts             # GitHub stub (backlog)
│   │   └── gitlab.ts             # GitLab stub (backlog)
│   ├── prompt/
│   │   ├── loader.ts             # Loads base template, parses repo sections, fills placeholders
│   │   ├── base-prompt.txt       # Shared review template (SCOPE, RULES, OUTPUT FORMAT)
│   │   ├── judge-prompt.txt      # System prompt for judge model (finding validation)
│   │   ├── reply-prompt.txt      # System prompt for conversational replies to developer questions
│   │   └── defaults.ts           # Default values for ROLE, REVIEW PRIORITIES, MENTAL MODEL
│   └── context/
│       ├── fetcher.ts            # Fetches additional context files beyond diff
│       └── diffParser.ts         # Unified diff parser for line mapping (Phase 4)
├── prompts/                      # Example repo-specific prompts
│   ├── java-spring.txt           # Agent-only (Java / Spring Boot)
│   ├── angular-ionic.txt         # Agent-only (Angular / Ionic)
│   ├── angular-copilot.prompt.md          # Copilot + Agent (Angular)
│   └── angular-ionic-copilot.prompt.md    # Copilot + Agent (Angular / Ionic)
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

## Review Flow (Finite State Machine)

The review orchestration in `src/review/index.ts` is implemented as an explicit finite state machine.
A `State` enum defines every node, a `ReviewContext` object carries accumulated data, and a
`transition(state, ctx)` function returns the next state. The runner loops until `DONE`.

The `FETCH_DIFF` state also produces a **filtered diff** (lock files stripped) which is
used for all Claude API calls. The raw diff is kept for line counting and threshold checks.

```
FETCH_PR_INFO → FETCH_DIFF (+ filterDiff) → CHECK_THRESHOLDS
                                  ├─ [fail] → SKIP → DONE
                                  └─ CHECK_PREVIOUS_REVIEWS
                                       ├─ [same commit] → CHECK_REPLIES
                                       │   ├─ [replies] → RESPOND_TO_REPLIES → DONE
                                       │   └─ [none] → SKIP → DONE
                                       └─ LOAD_PROMPT → FETCH_CONTEXT → CALL_CLAUDE
                                            → CHECK_NO_CHANGE
                                               ├─ [NO_CHANGE] → SKIP → DONE
                                               └─ JUDGE_REVIEW
                                                    ├─ [JUDGING_MODEL set] → validate → POST_REVIEW → DONE
                                                    └─ [no judge] → POST_REVIEW → DONE
```

**14 states**, **5 possible outcomes**: skip (threshold), skip (same commit, no replies),
reply to developer, skip (NO_CHANGE), or post review. The optional `JUDGE_REVIEW` state
sends the review output and diff to a separate judge model (`JUDGING_MODEL`) that validates
each finding against the actual code before posting. When no judge is configured, this state
is a no-op passthrough.

---

## Out of Scope (Explicitly)

- No local git checkout at any point — everything via API
- No storing PR content or diffs beyond the current request
- No modifying or approving PRs — comment only
- No persistent database — stateless per run
