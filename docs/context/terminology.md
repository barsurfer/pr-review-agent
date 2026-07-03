---
type: core
---

# Domain Terminology

Focus on shared vocabulary used across code, docs, and prompts.

---

## Review Lifecycle

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **PR Review** | Structured comment posted by the agent on a pull request | AI comment, bot comment |
| **Delta Review** | Re-review after new commits; focuses only on code changed since the last review | Re-review, partial review |
| **NO_CHANGE** | Stop word returned by Claude when new commits are purely cosmetic — agent skips posting | Empty review |
| **Review Footer** | Structured metadata line appended to every review comment: model, prompt source, review #, commit hash | Signature, trailer |
| **Reply Comment** | Threaded agent reply to a review comment, answering developer questions — distinct from a full Review | Response, follow-up |

## Skip / Dedup

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Commit Hash Dedup** | Skip mechanism: agent parses the commit hash from the Review Footer and compares to current PR head; matching hash = skip | Hash check |
| **Delta Diff Pre-Check** | Deterministic check: fetches commit-to-commit diff (last reviewed → current head), applies exclusions; if zero lines remain, skip without any API call | Incremental diff |
| **Branch Exclusion** | Configurable glob patterns for source/target branches that skip review entirely (e.g. `release/*`, `main`) | Branch filter |

## Prompt System

| Term | Definition | Aliases to avoid |
|------|-----------|-----------------|
| **Base Template** | `src/prompt/base-prompt.txt` — shared SCOPE, FORBIDDEN, and OUTPUT FORMAT rules, not overridable by repos | System prompt |
| **Repo Prompt** | `.agent-review-instructions.md` fetched from the target repo via API; provides ROLE, REVIEW PRIORITIES, EXCEPTIONS, MENTAL MODEL | Custom prompt |
| **Repo Prompt Sections** | The four injectable sections: ROLE, REVIEW PRIORITIES, EXCEPTIONS, MENTAL MODEL | Prompt sections |
| **Generator-Verifier** | Two-model pattern: cheap model generates candidate findings, judge model validates them against the diff before posting | Judge pattern |
| **Judge Model** | Second Claude instance (`JUDGING_MODEL`) that validates MEDIUM/HIGH findings and produces a Merge Confidence score | Verifier, reviewer |
| **Merge Confidence** | Holistic merge-safety score (0–100%) produced by the judge model; not arithmetic — considers findings, scope, and critical path | Score, confidence |

## Relationships

- A **PR Review** belongs to exactly one PR and one commit (keyed by commit hash in the footer)
- A **Delta Review** builds on the most recent PR Review, which is included in context
- A **Reply Comment** is a child of a PR Review comment; can itself receive replies (recursive threading)
- A **NO_CHANGE** response produces no PR Review — the run exits silently
- The **Generator-Verifier** pattern requires both a `CLAUDE_MODEL` (reviewer) and a `JUDGING_MODEL` (judge); without the latter, the reviewer output posts directly

## Example dialogue

> **Dev:** "Why does the agent skip posting when it sees `NO_CHANGE`?"  
> **Agent:** "When a **Delta Review** is requested, if all new commits are cosmetic (formatting, typos), Claude returns the **NO_CHANGE** stop word. The orchestrator checks for this before calling the **Judge Model** — so no API cost and no duplicate **PR Review** is posted."
