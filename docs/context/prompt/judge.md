---
type: domain
topic: Judge model — finding validation, calibration rules, Merge Confidence score
---

# Judge Model

The optional second-pass validation model (`JUDGING_MODEL`). Related: [prompt/composition.md](composition.md) | [review/fsm.md](../review/fsm.md)

---

## Purpose

Implements the **generator-verifier** pattern: the reviewer model generates candidate findings; the judge model validates each MEDIUM/HIGH finding against the actual diff before posting. Invalid or fabricated findings are dropped.

**Why:** Cheap reviewer models (Haiku) produce many candidate findings with variable accuracy. A stronger judge (Sonnet) filters noise cheaply compared to using a strong model for generation. The combination improves precision without proportionally increasing cost.

---

## When the Judge Runs

- `JUDGING_MODEL` env var is set to a valid Claude model ID
- The reviewer model produced at least one finding (judge is auto-skipped on zero findings)
- `JUDGE_REVIEW` state in the FSM (see [review/fsm.md](../review/fsm.md))

---

## What the Judge Receives

```
[SYSTEM: judge-prompt.txt]

[USER]
## Diff:
{filtered diff}

## Review to validate:
{reviewer output}
```

---

## Calibration Rules (Applied by Judge)

| Rule | Effect |
|------|--------|
| Style/formatting findings | Dropped |
| LOW findings with no runtime impact (style preference, configurability opinion) | Dropped |
| HIGH without confirmed runtime failure in diff | Downgraded to MEDIUM |
| Findings requiring 3+ chained hypotheticals | Downgraded to LOW |
| Framework/library uncertainty | Moved to Unresolved Questions |

These rules are cherry-picked from the reviewer's FORBIDDEN section to ensure the judge applies the same calibration. If a finding survives after calibration, it's included in the output.

---

## Judge Output

The judge produces a clean final comment with:
- Only validated findings (LOW/MEDIUM/HIGH after calibration)
- A **Merge Confidence** score — holistic merge-safety percentage (0–100%)

The prompt instructs the judge to validate **silently** — the response must start directly
at `### Summary`. As a code-side guard, `POST_REVIEW` runs `stripPreamble()` to drop any
leaked validation reasoning before the first `### Summary` heading, so judge deliberation
never reaches the posted comment.

**Merge Confidence is NOT arithmetic.** The judge considers:
- Number and severity of findings
- Code scope and criticality
- Unresolved questions
- Critical path impact

The `computed_score` field in `results.jsonl` provides a separate arithmetic score (`100 − HIGHs×12 − MEDIUMs×4`) from parsed findings, regardless of whether a judge was used. The two scores are independently useful.

---

## Judge Prompt (`src/prompt/judge-prompt.txt`)

Standalone file — not derived from the base review template. Includes its own SCOPE LOCK to resist prompt injection from reviewer output that might contain adversarial content.
