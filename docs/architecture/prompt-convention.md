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
- **MANDATORY RULES** — concise, bullets, runtime focus, no assumptions
- **FORBIDDEN** — no formatting reviews, no praise, no refactoring
- **Re-review instructions** — delta review behavior for follow-up reviews
- **OUTPUT STRUCTURE** — Summary, Findings, Behavioral Diff, Production Risk, Unresolved Questions

This prevents teams from accidentally breaking the review output format or omitting
critical behavioral rules.

---

## Example Prompts

Full example prompts are in the [`prompts/`](../../prompts/) directory:

| File | Stack |
|------|-------|
| `prompts/java-spring.txt` | Java / Spring Boot / Hibernate |
| `prompts/angular-ionic.txt` | Angular / Ionic / Capacitor |

These can be used as templates for creating new `.claude-review-prompt.md` files.

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
