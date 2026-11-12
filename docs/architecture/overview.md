# Architecture Overview

## Purpose

The PR Review Agent is a stateless CLI tool that:

1. Is triggered when a PR is opened or updated — by Jenkins for Bitbucket, or by GitHub Actions for GitHub
2. Fetches the diff and relevant file context from Bitbucket, Azure DevOps, or GitHub (GitLab later)
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
│   │   ├── breadth.ts            # Breadth + second-look prompts, file coverage, stage statuses
│   │   ├── lenses.ts             # Lens registry + aliases, lens prompts, lens recommendations
│   │   ├── judge-decisions.ts    # Judge decision contract: policy table, anchors, kept findings
│   │   ├── judge-quality.ts      # ENABLE_JUDGE_QUALITY / proposals prompt and schema additions
│   │   ├── shown-anchors.ts      # What each pass was shown, for ENABLE_JUDGE_SHOWN_CONTEXT_ANCHORS
│   │   ├── trigger.ts            # Trigger context (--event/--comment-author) and IGNORE_COMMENT_AUTHORS matching
│   │   ├── checked-commit.ts     # Checked commit from CI (--checked-commit/LAST_CHECKED_COMMIT): validation, head match
│   │   ├── cli-value.ts          # cliOrEnv: trimmed CLI value, else the env value (CI passes unset parameters as '')
│   │   ├── aggregate.ts          # Merge/dedupe findings across bundles
│   │   ├── bundler.ts            # Split an over-budget PR into directory bundles
│   │   ├── bundled.ts            # Per-bundle reviewer+judge orchestration
│   │   └── client.ts             # Review/judge/reply calls + REVIEW/JUDGE output schemas
│   ├── llm/
│   │   ├── provider.ts           # Stable facade + createProvider factory (LLM_PROVIDER); re-exports shared surface
│   │   ├── shared.ts             # LLMProvider/LLMUsage/LLMOptions contracts, TruncatedResponseError, missingRequired
│   │   ├── model-id.ts           # baseModelId: OpenRouter/dated id → bare id, for pricing and context-window lookup
│   │   ├── anthropic-provider.ts # AnthropicProvider: Anthropic SDK, streamed
│   │   └── openrouter-provider.ts # OpenRouterProvider: OpenAI-compatible via axios
│   ├── vcs/
│   │   ├── adapter.ts            # VCSAdapter interface + provider selection
│   │   ├── bitbucket.ts          # Bitbucket Cloud implementation
│   │   ├── azure.ts              # Azure DevOps implementation (experimental, live on cloud)
│   │   ├── reviewbench.ts        # Filesystem adapter for --benchmark
│   │   ├── github.ts             # GitHub implementation (experimental, same-repo PRs via Actions)
│   │   ├── mention-filter.ts     # Drop rule for replies @-directed at someone else (SKIP_DIRECTED_REPLIES)
│   │   └── gitlab.ts             # GitLab stub (backlog; --vcs gitlab exits 1)
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
├── .github/workflows/
│   ├── ci.yml                    # Typecheck + tests + bundle build (the release gate)
│   ├── pr-review.yml             # GitHub Actions trigger: review on PR events, reply on PR comments
│   └── reviewbench-image.yml     # Builds/publishes the ReviewBench GHCR image on v* tags
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
| Model SDK | `@anthropic-ai/sdk` (default); OpenRouter via `axios` (`LLM_PROVIDER=openrouter`) |
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
CHECK_TRIGGER ├─ [comment event by an IGNORE_COMMENT_AUTHORS id, no --force] → SKIP → DONE
              └─ FETCH_PR_INFO (no trigger, or not a listed comment author, or --force)
FETCH_PR_INFO → CHECK_BRANCHES
                  ├─ [source/target match skip patterns, or target not in ONLY_TARGET_BRANCHES] → SKIP → DONE
                  └─ FETCH_DIFF (+ filterDiff)
                                  ├─ [no reviewable changes after exclusions] → SKIP → DONE
                                  └─ CHECK_THRESHOLDS
                                  ├─ [fail] → SKIP → DONE
                                  └─ CHECK_PREVIOUS_REVIEWS
                                       ├─ [same commit, or head = checked commit from CI] → CHECK_REPLIES
                                       │   ├─ [replies] → RESPOND_TO_REPLIES → DONE
                                       │   └─ [none] → SKIP → DONE
                                       ├─ [delta diff empty after filter] → CHECK_REPLIES
                                       │   ├─ [replies] → RESPOND_TO_REPLIES → DONE
                                       │   └─ [none] → SKIP → DONE
                                       └─ LOAD_PROMPT → FETCH_CONTEXT → CALL_MODEL
                                            → CHECK_NO_CHANGE
                                               ├─ [NO_CHANGE] → CHECK_REPLIES (reply if one is pending, else SKIP) → DONE
                                               └─ BREADTH_REVIEW (no-op unless enabled + enough untouched files) → SECOND_LOOK (no-op unless enabled)
                                                    → [LENS_REVIEW, only with ENABLE_LENSES + a known lens] → JUDGE_REVIEW
                                                    ├─ [JUDGING_MODEL set] → validate → POST_REVIEW → DONE
                                                    └─ [no judge] → POST_REVIEW → DONE
```

**21 states**, **11 possible outcomes**: skip (ignored comment author), skip (branch exclusion), skip (no reviewable changes),
skip (threshold), skip (same commit, no replies), skip (delta diff empty, no replies),
skip (reply limit reached), skip (no new findings), reply to developer, skip (NO_CHANGE), or post review. The optional `JUDGE_REVIEW` state sends the review output and diff to a
separate judge model (`JUDGING_MODEL`) that validates each finding against the actual code
before posting. When no judge is configured, this state is a no-op passthrough. The optional
`BREADTH_REVIEW` state (`ENABLE_BREADTH_REVIEW`) runs a second reviewer pass focused on files
the first pass left without findings and appends its findings to the judge's candidates.
The optional `SECOND_LOOK` state (`ENABLE_SECOND_LOOK`) re-reads only the files that already
have a finding, looking for what the first pass missed there, and appends to the same candidates.
The optional `LENS_REVIEW` state (`ENABLE_LENSES` + `LENSES`) runs one concern-specific
reviewer pass per listed lens (reliability, security, testing, performance, architecture)
over the full diff and appends their findings to the same judge call.

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
