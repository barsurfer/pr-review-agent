<!-- GENERATED from AGENTS.md — do not edit CLAUDE.md directly; edit AGENTS.md (this hook re-syncs it). -->

- In all interactions, be concise. Be honest and direct.
- Activate Knowhere skill.
- First action of every session, before responding to or acting on any request: **Read `docs/context/context-map.md`** into context. It is the Knowhere index - a one-line-per-doc map of which `docs/context/` file covers what. This is a mandatory gate, not advisory background; do not skip it because it "looks short."
- Then, for any task, Read the specific `docs/context/` doc(s) the task touches (per the map) before writing or reviewing code.
- Read-proof: the map ends with a "Session greeting" section. Once you have loaded the map, open your first reply of the session with that greeting, verbatim. Reciting it confirms you actually read the map; if you cannot, you have not loaded it — go back and do so.

## Comments

- Comment the WHY, not the WHAT. Self-explanatory code needs no comment; a well-named function or variable already says what it does. Comment only what the code cannot say for itself: a non-obvious constraint or invariant, a workaround, or library/API behavior that would surprise a reader (for example the SDK requiring streaming above a `max_tokens` threshold, or a footer regex that must stay byte-compatible with the builder it parses).
- One line, not a poem. No multi-line TSDoc that restates the signature, no per-field interface/type comments, no section banners (`// ===== HELPERS =====`). If a comment needs a paragraph, the code probably needs refactoring instead.
- No ticket numbers in comments. Never write `// INT-XXXX`, `// per code review`, or `// fix for <ticket>`. Git blame already ties every line to its commit and ticket. Put the durable reason in prose and let version control carry the provenance.
- No breadcrumbs. No "removed X" or "TODO: figure out Y" leftovers and no commented-out code; delete it, history keeps it. Track real follow-up work as a ticket, not an in-code TODO.

`/deslop` reads this file, so these rules apply when it cleans a branch diff.

## Commits

- Stop at the edit. Finish the change, run what needs running, then report and wait. The user reviews the diff before anything becomes a commit; committing unprompted skips that review.
- Asking for an edit is not asking for a commit. Neither is a long task, a green test run, nor the rhythm of the work so far.
- Stage only the files you touched, by path. Never `git add -A` or `git add .`.
- The message is a single line: `<KEY> -> <type>(<scope>): <imperative summary>`, with `<KEY>` taken from a Jira-style key in the branch name (e.g. `AL-20587 -> fix(csv-parser): preserve block positions, bound trailer mapping`). No key prefix on branches without one (main, develop, feature/*). Match recent `git log --oneline`.
- No multi-line body unless explicitly asked, and no `Co-Authored-By` or "Generated with" trailer.