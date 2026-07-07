# Knowhere Map

Hierarchical index of project documentation for AI agents.

Rule: Each entry has a 1-sentence summary: key concepts, keywords, tech; ends with "read for X" to indicate when to consult.

---

## Core

- [summary.md](summary.md) — One-paragraph snapshot of the agent: what it does, stack, VCS support, model; read for orientation.
- [terminology.md](terminology.md) — Domain glossary: PR Review, Delta Review, NO_CHANGE, commit hash dedup, generator-verifier, repo prompt sections; read when vocabulary is ambiguous.
- [practices.md](practices.md) — Project-wide patterns: stateless design, FSM orchestration, API-only, footer-based dedup, generator-verifier, VCS adapter, reply bundling, FORBIDDEN rules, bundle/deploy, versioning/releases (raw-URL by tag), CI test gate; read before making architectural decisions.

---

## Domain Specs

- [review/](review/)
  - [review/fsm.md](review/fsm.md) — 15-state FSM: all states, transitions, 9 skip/review outcomes, ReviewContext interface, POST_REVIEW safety guards; read when changing orchestration logic.
  - [review/skip-logic.md](review/skip-logic.md) — All skip mechanisms: commit hash dedup, delta diff pre-check, branch exclusion, size thresholds, reply limit; read when debugging unexpected skips.
  - [review/replies.md](review/replies.md) — Reply detection algorithm, recursive parent tracking, PR 712 stale-reply fix, bundled response, reply footer, reply limit; read when working on comment threading.

- [prompt/](prompt/)
  - [prompt/composition.md](prompt/composition.md) — Prompt assembly: base template vs repo sections, resolution order incl. monorepo module-dir fallback, FORBIDDEN rules with rationale, delta review rules, developer trust rules, SCOPE LOCK, reply prompt; read when changing prompt logic or adding FORBIDDEN rules.
  - [prompt/judge.md](prompt/judge.md) — Judge model: when it runs, what it validates, calibration rules, Merge Confidence score vs computed_score, judge prompt; read when configuring or modifying the generator-verifier pass.

- [vcs/](vcs/)
  - [vcs/adapter.md](vcs/adapter.md) — VCSAdapter interface, Bitbucket implementation (auth, redirect handling, required scopes), provider selection, supporting types, Phase 4 inline comment extension; read when changing VCS behavior or adding a new adapter.

- [fetching/](fetching/)
  - [fetching/strategy.md](fetching/strategy.md) — Two-form diff (raw vs filtered), full file context exclusion rules, high-churn priority, MAX_CONTEXT_FILES/MAX_FILE_LINES, full payload format for review and reply; read when changing what context is sent to Claude.


## Session greeting (read-proof)

When you finish loading this map, open your first reply of the session with the
greeting below, verbatim. It is the proof that you actually read the map - it lives
nowhere else, so reciting it confirms the gate was honored.

> Just another day at the office, lets do it!
