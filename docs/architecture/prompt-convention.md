# Repo-Specific Prompt Convention

Each target repository can contain a file at its root:

```
.claude-review-prompt.md
```

This file is fetched via the VCS API (no checkout needed) and used as Claude's system prompt.
It should describe the tech stack, team conventions, and review priorities for that repo.

---

## Resolution Order

1. `.claude-review-prompt.md` in root of the PR's target repo (fetched via API)
2. Matched prompt from `prompts/` directory based on detected stack (heuristic fallback)
3. `src/prompt/default-prompt.txt` as final fallback

---

## Optional Metadata Header (Phase 4+)

The `.claude-review-prompt.md` file can include a YAML-style header to override agent settings:

```markdown
mode: inline
model: claude-sonnet-4-6
```

| Key | Values | Effect |
|-----|--------|--------|
| `mode` | `summary` \| `inline` \| `both` | Override `REVIEW_MODE` env var |
| `model` | any Claude model ID | Override `CLAUDE_MODEL` env var |

---

## Example Prompts

### Java / Spring Boot

```markdown
You are a senior backend engineer reviewing Java + Spring Boot pull requests.

Focus on:
- Correctness of business logic and edge cases
- Transaction boundaries and data consistency
- Security: input validation, auth checks, SQL injection surface
- Performance: N+1 queries, missing indexes, unbounded queries
- Production safety: no debug code, proper error handling, logging hygiene
- Spring idioms: proper use of @Transactional, bean scopes, event handling
- Test coverage: are new behaviors tested, are mocks realistic

Do not nitpick formatting or variable naming unless it causes ambiguity.
Output a structured review with sections: Summary, Critical Issues, Warnings, Suggestions.
```

### Angular / TypeScript

```markdown
You are a senior frontend engineer reviewing Angular + TypeScript pull requests.

Focus on:
- Component lifecycle correctness (OnDestroy, subscription cleanup)
- RxJS misuse: nested subscribes, missing unsubscribe, error handling
- Type safety: avoid `any`, proper interface definitions
- Change detection: OnPush strategy usage, unnecessary triggers
- Security: XSS via innerHTML, unsafe template bindings
- Bundle size: unnecessary imports, lazy loading opportunities
- Test coverage: component, service, and pipe unit tests
```

---

## Bundled Stack Prompts (`prompts/` directory)

| File | Used when |
|------|-----------|
| `prompts/java-spring.txt` | Heuristic detects `.java` files + Spring annotations |
| `prompts/groovy-grails.txt` | Heuristic detects `.groovy` files |
| `prompts/angular-typescript.txt` | Heuristic detects Angular-specific imports |
| `prompts/dotnet.txt` | Heuristic detects `.cs` / `.csproj` files |
