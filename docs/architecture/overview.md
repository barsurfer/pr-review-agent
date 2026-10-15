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
│   ├── benchmark.ts              # ReviewBench (--benchmark) mode: read RB_* env, write findings JSON
│   ├── review/
│   │   ├── index.ts              # FSM orchestrator: transition loop, public review() API
│   │   ├── types.ts              # State enum, ReviewContext interface
│   │   ├── parsers.ts            # Diff filtering, line counting, verdict/findings/delta parsing
│   │   ├── formatter.ts          # Structured review object → markdown, footer builders, hash extraction
│   │   ├── usage.ts              # UsageRecord type, cost estimation (MODEL_PRICING), record builder
│   │   ├── findings-output.ts    # Benchmark findings: judge-markdown + structured-recovery merge
│   │   ├── aggregate.ts          # Merge/dedupe findings across bundles
│   │   ├── bundler.ts            # Split an over-budget PR into directory bundles
│   │   └── bundled.ts            # Per-bundle reviewer+judge orchestration
│   ├── claude/
│   │   └── client.ts             # Review/judge/reply calls + REVIEW/JUDGE output schemas
│   ├── llm/
│   │   └── provider.ts           # LLMProvider seam over the Anthropic SDK (complete/completeStructured)
│   ├── vcs/
│   │   ├── adapter.ts            # VCSAdapter interface + provider selection
│   │   ├── bitbucket.ts          # Bitbucket Cloud implementation
│   │   ├── azure.ts              # Azure DevOps implementation (experimental, live on cloud)
│   │   ├── reviewbench.ts        # Filesystem adapter for --benchmark
│   │   ├── github.ts             # GitHub stub (backlog)
│   │   └── gitlab.ts             # GitLab stub (backlog)
│   ├── prompt/
│   │   ├── loader.ts             # Loads base template, parses repo sections, composes stacks, fills placeholders
│   │   ├── stack.ts              # Tech-stack detection (base-by-extension + framework overlays)
│   │   ├── base-prompt.txt       # Shared review template (SCOPE, SECURITY, RULES, structured OUTPUT)
│   │   ├── judge-prompt.txt      # System prompt for the judge model
│   │   ├── reply-prompt.txt      # System prompt for developer-reply responses
│   │   ├── defaults.ts           # Default ROLE, REVIEW PRIORITIES, SECURITY, MENTAL MODEL, EXCEPTIONS
│   │   └── stacks/               # ~26 composable stack rule sets (language bases + framework overlays)
│   └── context/
│       └── fetcher.ts            # Fetches full-file context beyond the diff
├── prompts/                      # Example repo-specific prompts
│   ├── angular-ionic.txt                  # Agent-only (Angular / Ionic)
│   ├── java-spring.txt                    # Agent-only (Java / Spring Boot)
│   ├── angular-ionic-copilot.prompt.md    # Copilot + Agent (Angular / Ionic)
│   ├── angular-copilot.prompt.md          # Copilot + Agent (Angular)
│   └── java-spring-copilot.prompt.md      # Copilot + Agent (Java / Spring Boot)
├── azure/                        # Azure DevOps pipelines (review + reply)
├── jenkins/                      # Jenkins pipeline
├── reviewbench/                  # ReviewBench Docker image + harness
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
| Runtime | Node.js 22+ (single-file esbuild bundle; `tsx` for dev) |
| Claude API | `@anthropic-ai/sdk` |
| HTTP client | `axios` |
| CLI args | `commander` |
| Model | reviewer `claude-haiku-4-5-20251001` (`CLAUDE_MODEL`), judge `claude-sonnet-5` (`JUDGING_MODEL`, on by default) |

---

## Review Flow (Finite State Machine)

The review orchestration in `src/review/index.ts` is implemented as an explicit finite state machine.
A `State` enum defines every node, a `ReviewContext` object carries accumulated data, and a
`transition(state, ctx)` function returns the next state. The runner loops until `DONE`.

The `FETCH_DIFF` state also produces a **filtered diff** (lock files stripped) which is
used for all Claude API calls and for size-threshold checks — excluded files don't count
toward `MIN/MAX_CHANGED_*`. The raw diff counts are kept for usage-record metrics.

```
FETCH_PR_INFO → CHECK_BRANCHES
                  ├─ [source/target match skip patterns] → SKIP → DONE
                  └─ FETCH_DIFF (+ filterDiff)
                                  ├─ [no reviewable changes after exclusions] → SKIP → DONE
                                  └─ CHECK_THRESHOLDS
                                  ├─ [fail] → SKIP → DONE
                                  └─ CHECK_PREVIOUS_REVIEWS
                                       ├─ [same commit] → CHECK_REPLIES
                                       │   ├─ [replies] → RESPOND_TO_REPLIES → DONE
                                       │   └─ [none] → SKIP → DONE
                                       ├─ [delta diff empty after filter] → CHECK_REPLIES
                                       │   ├─ [replies] → RESPOND_TO_REPLIES → DONE
                                       │   └─ [none] → SKIP → DONE
                                       └─ LOAD_PROMPT → FETCH_CONTEXT → CALL_CLAUDE
                                            → CHECK_NO_CHANGE
                                               ├─ [NO_CHANGE] → CHECK_REPLIES (reply if one is pending, else SKIP) → DONE
                                               └─ JUDGE_REVIEW
                                                    ├─ [JUDGING_MODEL set] → validate → POST_REVIEW → DONE
                                                    └─ [no judge] → POST_REVIEW → DONE
```

**17 states**, **10 possible outcomes**: skip (branch exclusion), skip (no reviewable changes),
skip (threshold), skip (same commit, no replies), skip (delta diff empty, no replies),
skip (reply limit reached), skip (no new findings), reply to developer, skip (NO_CHANGE), or post review. The optional `JUDGE_REVIEW` state sends the review output and diff to a
separate judge model (`JUDGING_MODEL`) that validates each finding against the actual code
before posting. When no judge is configured, this state is a no-op passthrough.

### POST_REVIEW Safety Guards

Before posting, `POST_REVIEW` applies three guards:

1. **Empty/NO_CHANGE guard** — cleanup strips prior footers, `DELTA_STATS`, and any leaked
   preamble before the first `### Summary` heading; if the remaining text is empty or
   contains a standalone `NO_CHANGE` line, the post is skipped. Prevents posting blank
   comments, stop-word leftovers, or model reasoning when `CHECK_NO_CHANGE` is bypassed
   or the model misbehaves.

2. **Cut guard** — a complete review ends with its final mandatory section (judge → `Merge
   Confidence`; reviewer-only → `Unresolved Questions`). A truncated response that slips past
   the `max_tokens` guard is rejected (run → `ERROR`, nothing posted, retried next trigger).

3. **Pre-post dedup** — on non-dry-run runs with `--force` off, the agent re-fetches the
   latest review comments immediately before posting and checks whether another concurrent
   run already reviewed the same commit. If a matching review is found, the post is skipped.
   Prevents duplicate reviews from parallel Jenkins triggers on the same PR update.

### Delta Diff Pre-Check

When a previous review exists with a different commit hash, the agent fetches the
commit-to-commit diff (last reviewed commit → current head) before proceeding. After
applying `DIFF_EXCLUDE_PATTERNS`, if zero lines remain, no review is produced — but the
agent still falls through to `CHECK_REPLIES` to answer any unanswered developer questions
before exiting. If there are no pending replies either, the run exits as `DEDUP_SKIP` with
no API call. This catches cases where new commits only touch excluded files (tests, lock
files, translations).

---

## Out of Scope (Explicitly)

- No local git checkout at any point — everything via API
- No storing PR content or diffs beyond the current request
- No modifying or approving PRs — comment only
- No persistent database — stateless per run
