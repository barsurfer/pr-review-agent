# Prompt Convention — Base + Repo Composition

## How It Works

The agent composes the final system prompt from two parts:

1. **Base template** (`src/prompt/base-prompt.txt`) — shared rules that apply to every review:
   SCOPE, MANDATORY RULES, FORBIDDEN, re-review instructions, OUTPUT STRUCTURE.

2. **Repo-specific sections** (`.claude-review-prompt.md` in the target repo) — customisable
   per technology stack. Three sections can be overridden:

| Section | Header in file | Default if missing |
|---------|---------------|-------------------|
| Role | `## ROLE` | "Senior Architect and Production Gatekeeper" |
| Review Priorities | `## REVIEW PRIORITIES` | Generic priorities (logic, safety, correctness) |
| Mental Model | `## MENTAL MODEL` | Production load, real users, large dataset, 3am |

The base template has `{{ROLE}}`, `{{REVIEW_PRIORITIES}}`, and `{{MENTAL_MODEL}}` placeholders.
The loader parses the repo prompt for these sections and injects them. Missing sections fall
back to the defaults in `src/prompt/defaults.ts`.

---

## Resolution Order

1. `.claude-review-prompt.md` in root of the PR's target repo (fetched via VCS API)
2. If not found, all three sections use defaults

---

## Repo Prompt Format

Add `.claude-review-prompt.md` to the root of the repo being reviewed. Include any
combination of these sections — omitted sections use defaults:

```markdown
## ROLE
You are a Senior Frontend Architect and Production Gatekeeper.

## REVIEW PRIORITIES (STRICT ORDER)

### 1. Behavioral Differences (Highest Priority)
- Component logic changes
- Signal behavior (signal, computed, effect)
- Routing behavior changes

### 2. Production Safety
- Change detection explosions
- Memory leaks (subscriptions, DOM listeners)
- Bundle size growth

### 3. Correctness
- Async race conditions
- Null / undefined handling

## MENTAL MODEL
- Low-end Android device
- Poor network
- Real users
- It is 3am
```

A file with only `## REVIEW PRIORITIES` is valid — default role and mental model apply.

---

## What Repos Do NOT Need to Write

These sections are always provided by the base template and cannot be overridden:

- **SCOPE** — "Review only added or modified code in the diff"
- **MANDATORY RULES** — concise, bullets, runtime focus, no assumptions, developer trust
- **FORBIDDEN** — no formatting reviews, no praise, no refactoring, no self-contradiction,
  no hallucinated footers, no recommending fixes for non-existent features, no re-raising
  findings after developer addressed them
- **Re-review / delta instructions** — delta review behavior for follow-up reviews,
  including the `NO_CHANGE` stop word for cosmetic-only updates
- **Developer discussion trust rules** — developer replies are final authority on codebase
  state outside the diff
- **OUTPUT FORMAT RULES** — bullets on new lines, proper markdown structure
- **OUTPUT STRUCTURE** — Summary, Findings, Behavioral Diff, Production Risk, Unresolved Questions

This prevents teams from accidentally breaking the review output format or omitting
critical behavioral rules.

### FORBIDDEN Rules (Hardened)

The base template includes strict consistency rules learned from production testing:

| Rule | Why |
|------|-----|
| Do not mark a finding as resolved if you still have doubts | Prevents false "resolved" on uncertain items |
| Never contradict yourself (Unresolved Questions vs Findings) | Opus was observed marking an item resolved in Findings but questioning it in Unresolved Questions |
| Do not add a footer or signature | The system appends its own footer with model, prompt source, review number, and commit hash |
| Do not recommend fixes for non-existent features | Model was suggesting "track open conversation ID" when developers said conversation view doesn't exist yet |
| Do not re-raise findings after developer addressed them | If developer acknowledges a limitation as a known trade-off, that's not an open question |

### Delta Review Rules (Re-reviews)

When previous reviews are included, the delta review instructions enforce noise reduction:

| Rule | Effect |
|------|--------|
| Findings = new findings only | Old findings are already on record — not re-listed |
| Unresolved Questions = new questions only | Previous questions not repeated |
| Summary references old findings briefly | "Still open" or "fixed" — one line each, no detail |
| No re-analysis of untouched findings | If previous finding wasn't touched by new commits, just note as "still open" |

### Developer Discussion Trust Rules

When developer replies are included in the review context, the prompt enforces strict trust:

| Rule | Effect |
|------|--------|
| Developer replies are FINAL | On any claim about codebase state outside the diff, the developer is right |
| Drop resolved findings entirely | If developer says it's handled elsewhere — not a finding, not an unresolved question, not a production risk |
| No hedging or caveats | Accept design decisions without re-raising in other sections |
| "Not in diff" ≠ "not in codebase" | Absence from the diff tells the model nothing about whether something exists |
| Only push back with diff evidence | The model may only challenge a developer reply if the diff itself contains a direct contradiction |

### NO_CHANGE Stop Word (Delta Reviews)

When previous reviews are included (re-review after new commits), the base prompt instructs
Claude to respond with **only** `NO_CHANGE` if ALL of these conditions are met:

1. No previous findings have been resolved by the new commits
2. No new findings (LOW, MEDIUM, or HIGH) are introduced
3. The new commits only contain cosmetic changes (typos, formatting, comments, renames)

The orchestrator in `review.ts` checks for this stop word and skips posting a comment.
This prevents near-duplicate review comments on cosmetic-only pushes.

---

## Example Prompts

Full example prompts are in the [`prompts/`](../../prompts/) directory:

| File | Stack |
|------|-------|
| `prompts/java-spring.txt` | Java / Spring Boot / Hibernate |
| `prompts/angular-ionic.txt` | Angular / Ionic / Capacitor |

These can be used as templates for creating new `.claude-review-prompt.md` files.

---

## Reply Prompt (`src/prompt/reply-prompt.txt`)

A separate system prompt is used for **conversational replies** — when a developer replies
to a review comment with a question and the agent responds. This prompt is NOT composed
from the base template; it is a standalone file.

Key rules in the reply prompt:

- Answer questions concisely based on the diff and original analysis
- Acknowledge when developer context changes the assessment
- Give definitive recommendations — no open-ended questions (automated agent, not chat partner)
- No review structure (no Summary, Findings, etc.)
- No footer — the system adds one automatically

The reply prompt is loaded at runtime from `src/prompt/reply-prompt.txt` with a fallback
to `__REPLY_PROMPT__` (embedded at bundle time by esbuild), matching the same pattern used
for the base review prompt.

See [Phase 1b](../phases/phase-1b-comment-replies.md) for the full comment reply design.

---

## Optional Metadata Header (Phase 3+)

The `.claude-review-prompt.md` file can include a YAML-style header to override agent settings:

```markdown
mode: inline
model: claude-sonnet-4-6
```

| Key | Values | Effect |
|-----|--------|--------|
| `mode` | `summary` \| `inline` \| `both` | Override `REVIEW_MODE` env var |
| `model` | any Claude model ID | Override `CLAUDE_MODEL` env var |
