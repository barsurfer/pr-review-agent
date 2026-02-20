# Local Testing Guide

How to test the agent locally against a real Bitbucket PR before wiring up Jenkins.

---

## Prerequisites

- Node.js installed
- A Bitbucket app password with PR read + comment write permissions
- An open PR in a Bitbucket repo you have access to
- An Anthropic API key

---

## Steps

1. **Pick an open PR** in Bitbucket and note:
   - Workspace slug (e.g. `my-company`)
   - Repo slug (e.g. `backend-api`)
   - PR ID (e.g. `42`)

2. **Create `.env`** from `.env.example`:
   ```bash
   cp .env.example .env
   # Fill in your values
   ```

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Run the agent:**
   ```bash
   npx tsx src/index.ts \
     --workspace my-company \
     --repo-slug backend-api \
     --pr-id 42
   ```

5. **Check the PR** in Bitbucket — a review comment should appear within ~30 seconds.

---

## Iterating

- Edit `src/prompt/default-prompt.txt` or add a `.claude-review-prompt.md` to the target repo
- Re-run the agent against the same PR to test the updated prompt
- Check the comment footer to confirm which prompt source was used

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| `401 Unauthorized` | Verify `BITBUCKET_TOKEN` and `BITBUCKET_WORKSPACE` |
| `404 Not Found` | Verify `--repo-slug` and `--pr-id` |
| Comment not appearing | Check Bitbucket app password has comment write permission |
| Claude API error | Verify `ANTHROPIC_API_KEY` is valid and has quota |
| Very large payload warning | Lower `MAX_CONTEXT_FILES` or `MAX_FILE_LINES` |

---

## Useful Flags (Planned)

```bash
# Dry-run: print the assembled prompt without calling Claude or posting
npx tsx src/index.ts --workspace ws --repo-slug repo --pr-id 42 --dry-run

# Use a specific prompt file instead of auto-resolving
npx tsx src/index.ts --workspace ws --repo-slug repo --pr-id 42 --prompt ./my-prompt.md
```
