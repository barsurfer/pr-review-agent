# GitHub Copilot Prompt Integration

## Overview

The review agent's prompt file format (`.agent-review-instructions.md`) is compatible with
GitHub Copilot prompt files (`.prompt.md`). A single file can serve both tools — the review
agent extracts its four recognised sections, and Copilot uses the full file as context.

---

## Setup

### 1. Create the prompt file

Add `.agent-review-instructions.md` to the root or `docs/` directory of your repo with the
standard sections (`## ROLE`, `## REVIEW PRIORITIES`, `## EXCEPTIONS`, `## MENTAL MODEL`).

Optionally add YAML frontmatter for Copilot metadata — the review agent strips it automatically:

```markdown
---
description: "Code review and development guidelines for this Angular/Ionic project"
---

## ROLE
...
```

### 2. Symlink for Copilot

Copilot expects prompt files in `.github/prompts/` with a `.prompt.md` extension. Create a
symlink so both tools read the same file. Either direction works:

```bash
# Option A: agent file is the source, Copilot gets a symlink
mkdir -p .github/prompts
ln -s ../../.agent-review-instructions.md .github/prompts/review.prompt.md

# Option B: Copilot file is the source, agent gets a symlink
ln -s ../.github/prompts/review.prompt.md docs/.agent-review-instructions.md
```

The review agent follows git symlinks automatically — when it fetches `.agent-review-instructions.md`
and finds a symlink target path, it resolves and fetches the actual file.

On Windows (requires admin or Developer Mode):

```cmd
mklink .github\prompts\review.prompt.md ..\..\agent-review-instructions.md
```

### 3. Invoke in Copilot

In VS Code / JetBrains Copilot Chat, type `/review` to load the prompt file as context.
Copilot will use the full file including all sections as instructions.

---

## How Each Tool Reads the File

| Aspect | Review Agent | GitHub Copilot |
|--------|-------------|----------------|
| Reads from | VCS API (source commit / target branch) | Local filesystem |
| Parses | Only `## ROLE`, `## REVIEW PRIORITIES`, `## EXCEPTIONS`, `## MENTAL MODEL` | Full file as markdown instructions |
| Frontmatter | Stripped before parsing | Used for metadata (`description`, `agent`) |
| Other sections | Silently ignored | Included as context |
| Invocation | Automatic on PR event | Manual via `/review` in chat |

---

## Example Prompt Files

Ready-to-use Copilot-compatible prompt files are in the `prompts/` directory:

| File | Stack |
|------|-------|
| `prompts/angular-ionic-copilot.prompt.md` | Angular / Ionic / Capacitor |
| `prompts/angular-copilot.prompt.md` | Angular (web, no Ionic/Capacitor) |

These files include YAML frontmatter (`name`, `description`, `agent`, `argument-hint`, `tools`)
and a `## HOW TO REVIEW` section that tells Copilot how to run the review (get the diff,
scope rules, output structure, scoring). The review agent strips both when parsing — only
the four recognised sections are extracted.

Copy one of these files to your repo, rename to `.agent-review-instructions.md`, customise
the sections, then symlink for Copilot (see Setup above).

---

## Notes

- The symlink must be committed to the repo for Copilot to find it
- If `.agent-review-instructions.md` is in `docs/`, adjust the symlink path accordingly:
  `ln -s ../../docs/.agent-review-instructions.md .github/prompts/review.prompt.md`
- The review agent does not read from `.github/prompts/` directly — it checks root and `docs/`,
  but follows symlinks, so a symlink at `docs/.agent-review-instructions.md` pointing to
  `.github/prompts/review.prompt.md` works transparently
- Extra sections (e.g. `## TESTING GUIDELINES`) are ignored by the review agent but available
  to Copilot
