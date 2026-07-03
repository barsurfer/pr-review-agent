# PR Review Agent — Agent Guide

Automated PR code reviewer powered by Claude. Fetches diffs and file context from Bitbucket,
sends them to Claude, and posts structured review comments directly on the PR.

---

## Repo Structure

```
src/
  index.ts          # CLI entry point (commander)
  config.ts         # Environment variable loading and validation
  claude/           # Anthropic API client, judge model
  context/          # Context fetching: diff, full file content, PR metadata
  prompt/           # Prompt assembly: base template + repo instructions
  review/           # Review parsing, dedup, delta logic, reply handling
  vcs/              # VCS adapter interface + Bitbucket implementation
prompts/            # Example review instruction files for target repos
docs/               # Architecture, phase plans, reference docs
jenkins/            # Pipeline scripts for CI integration
dist/               # Pre-built bundle (pr-review-agent.cjs)
tmp/                # Scratch space for local dev (gitignored)
```

## Build & Run

```bash
npm install           # install deps
npm run bundle        # build dist/pr-review-agent.cjs
npm run dev -- --repo-slug <slug> --pr-id <id>   # run from source
node dist/pr-review-agent.cjs --repo-slug <slug> --pr-id <id>  # run bundle
```

Add `--dry-run` to print the review to stdout instead of posting.  
Add `--prompt prompts/angular-ionic.txt` to override the repo's own instructions.

## Key CLI Flags

| Flag | Description |
|------|-------------|
| `--repo-slug` | Bitbucket repo slug (required) |
| `--pr-id` | PR ID to review (required) |
| `--dry-run` | Print review, do not post |
| `--force` | Ignore previous reviews, produce fresh review |
| `--prompt <path>` | Use local prompt file instead of repo's `.agent-review-instructions.md` |
| `--model <id>` | Claude model override |
| `--judge-model <id>` | Judge model override (generator-verifier) |

## Environment Variables

Loaded from `.env` (see `.env.example`). Never commit `.env`.

Required: `ANTHROPIC_API_KEY`, `BITBUCKET_USERNAME`, `BITBUCKET_TOKEN`, `BITBUCKET_WORKSPACE`  
Key optional: `CLAUDE_MODEL` (default: `claude-sonnet-4-6`), `JUDGING_MODEL`, `BITBUCKET_BASE_URL`

Full list: [docs/reference/env-vars.md](docs/reference/env-vars.md)

## What the Agent Does NOT Do

- Does not check out code — everything via Bitbucket REST API
- Does not approve, merge, or modify PRs — posts comments only
- Does not store state — stateless per run

## Review Customisation

Target repos add `.agent-review-instructions.md` to their root or `docs/` directory.
Sections: `## ROLE`, `## REVIEW PRIORITIES`, `## EXCEPTIONS`, `## MENTAL MODEL`.  
Details: [docs/architecture/prompt-convention.md](docs/architecture/prompt-convention.md)

## Important Rules for Agents

- **Do NOT use `--force` unless explicitly asked** — it bypasses dedup and re-reviews already-reviewed commits
- Save PR analysis outputs (diffs, comments) to `tmp/` only — it is gitignored
- Commit style: single-line conventional commits (e.g. `feat:`, `fix:`, `docs:`) — no body, no trailers
- Rebuild the bundle (`npm run bundle`) after any source changes before testing with `node dist/`
- The `results.jsonl` file logs usage records — do not delete it
