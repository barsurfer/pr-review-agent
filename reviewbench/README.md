# ReviewBench image

Runs pr-review-agent as a [ReviewBench](https://github.com/review-bench/ReviewBench) agent: one container per PR, no CLI args, findings written to `RB_OUT`.

## How it works

- `entrypoint.mjs` runs `pr-review-agent.cjs --benchmark`.
- `--benchmark` reads the PR from the contract mounts (`RB_DIFF`, `RB_PR_JSON`, `RB_REPO`, default `/work/repo`) through `src/vcs/reviewbench.ts`. It runs the normal pipeline as a first review: same prompt, structured reviewer output, and judge. Then it writes `{ pr, agent, findings[] }` to `RB_OUT` instead of posting.
- A finding is kept only if the judge kept it and it has a `file` plus a parseable `lines` range. On a single-pass judged run, a kept finding with a changed `file` but no usable line is placed on that file's first added line, or line 1 when the file has no added line but still exists at head, e.g. rename-only (`anchorSource: 'file'`, logged as "placed on the file's first changed line"); bundled reviews and the judge-failure fallback still drop such findings, as do findings on deleted files. This is safe because ReviewBench matches findings by meaning within a file and line ranges are only a hint. `message` is `"<title>: <body>"`, and `agent`/`producer` are `RB_AGENT`.
- Benchmark mode turns off the branch-skip patterns and the default `MAX_CHANGED_FILES`/`MAX_CHANGED_LINES` caps, because a skipped PR scores zero. Explicit env values still apply. It also turns off the split check, since `can_be_split` has no place in the findings file.

### Fail-safe

The run must always finish with exit 0 and a valid file. If a single PR fails, the whole 219-PR run fails.

1. Inside the agent: any error writes `"findings": []` and exits 0.
2. The entrypoint covers crashes before the agent's own fail-safe can run, such as a missing `ANTHROPIC_API_KEY`, which throws on import. It also stops the agent at `BENCHMARK_DEADLINE_SECONDS` (default `840`, one minute under the 15-minute limit). In both cases it writes empty findings and exits 0. A file whose `pr.head` ≠ `RB_HEAD` gets replaced.

If ReviewBench grants a longer time limit, raise `BENCHMARK_DEADLINE_SECONDS` to match.

## Configuration

| Source | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Required secret, declared in the manifest |
| `RB_MODEL_BASE_URL` | Anthropic SDK `baseURL`. Register `https://api.anthropic.com`; a trailing `/v1` is stripped. |
| `RB_CONFIG_MODEL` / `RB_CONFIG_EFFORT` | Reviewer model / effort. The image bakes `claude-haiku-5-5` at `high`, so set them only to deviate. An empty label is ignored, so no label unsets an effort; an image built with `--build-arg REVIEW_EFFORT=` (or `JUDGE_EFFORT=`) runs the model default. |
| `RB_CONFIG_JUDGE_MODEL` / `RB_CONFIG_JUDGE_EFFORT` | Judge model / effort. The image bakes `claude-haiku-5-5` at `high`, so set them only to deviate. Breadth uses them too, because `BREADTH_MODEL` is unset in the image. |
| `RB_CONFIG_NITS` / `RB_CONFIG_J_MINOR` / `RB_CONFIG_J_UNVER` / `RB_CONFIG_J_CTX` / `RB_CONFIG_LNUM` / `RB_CONFIG_BREADTH` / `RB_CONFIG_SECOND_LOOK` | `0` or `1`. Overrides `ENABLE_NITPICKS` / `ENABLE_JUDGE_KEEP_MINOR` / `ENABLE_JUDGE_KEEP_UNVERIFIED` / `ENABLE_JUDGE_FILE_CONTEXT` / `ENABLE_LINE_NUMBERS` / `ENABLE_BREADTH_REVIEW` / `ENABLE_SECOND_LOOK`; any other value is ignored with a warning. |
| `RB_CONFIG_J_QUALITY` / `RB_CONFIG_SL_BREADTH` / `RB_CONFIG_J_SHOWN_ANCHOR` / `RB_CONFIG_B_PRIORITY` / `RB_CONFIG_J_PROPOSAL` / `RB_CONFIG_LENS_REC` / `RB_CONFIG_J_TGAP` / `RB_CONFIG_XROWS` | `0` or `1`. Overrides `ENABLE_JUDGE_QUALITY` / `ENABLE_SECOND_LOOK_BREADTH_TARGETS` / `ENABLE_JUDGE_SHOWN_CONTEXT_ANCHORS` / `ENABLE_BREADTH_PRIORITY_TARGETS` / `ENABLE_JUDGE_PROPOSALS` / `ENABLE_LENS_RECOMMENDATION` / `ENABLE_JUDGE_KEEP_TEST_GAPS` / `ENABLE_BENCHMARK_COUNTERPART_ROWS`; any other value is ignored with a warning. `XROWS=1` appends, after every original row, a copy of a kept finding (without its `proposal`) at each other changed file its reviewer text cites with a line (at most 3 per finding). These rows exist to test how the benchmark scores a finding at a second location, and they are never posted to a PR. Benchmark records log the appended count as `counterpart_rows` and each candidate's reviewer `type` in `review_candidates`; neither field appears in production records. |
| `RB_CONFIG_HI` | `0` or `1`. Overrides `ENABLE_HIGH_IMPACT`: adds item 4 (real-scenario and cross-file contract checks) to the second-look prompt and asks breadth, second-look and every listed lens (never the first-pass reviewer) for `also_affects`, other changed files with the same defect. Each accepted entry becomes one extra row after the originals and any `XROWS` copies, with the parent's title and kept body plus `Same defect here: <where>.`, never a `proposal` (rules in `docs/context/vcs/adapter.md`). It selects no lens: list `imp` in `LENSES` for the impact lens. The record logs `recall_levers.high_impact`, a per-candidate `scenario` and `also_affects`, `also_affects_rows` and the per-entry `also_affects` log. Any other value is ignored with a warning. |
| `RB_CONFIG_FP_SITES` | `0` or `1`. Overrides `ENABLE_FIRST_PASS_SITES`: breadth and second-look see each first-pass finding with its judge id (`[c3]`) and may name other changed-file sites of its defect in a root `first_pass_sites` field. Each site of a first-pass finding the judge kept becomes one extra row after every other row (originals, `XROWS` copies, `HI` rows), with the parent's title and kept body plus `Same defect here: <where>.`; a site on lines any earlier row already covers in that file is dropped, whatever its title. Works with or without `HI`. The record logs `recall_levers.first_pass_sites`, `first_pass_sites_named`, `first_pass_site_rows`, the per-entry `first_pass_sites` log and `pass_calls`. Any other value is ignored with a warning. |
| `RB_CONFIG_CACHE` | `0` or `1`. Overrides `ENABLE_PROMPT_CACHE`: on a first single-pass review the reviewer request gets a 5-minute prompt-cache breakpoint, and breadth, second look and every listed lens reuse its system prompt, schema and PR context, adding their own instructions as a trailing system message. With `HI=1` or `FP_SITES=1` the reviewer's schema also carries the passes' optional fields, so its request differs from a `CACHE=0` run by more than the marker. In the image (Haiku reviewer and judge, both `high`, no `LENS_MODEL`/`BREADTH_MODEL`) every pass shares. Bundled PRs are unchanged. The record logs `prompt_cache`, per-stage `cache_read`/`cache_write` and per-call cache columns and `cost_usd` in `pass_calls`, so a run compares with earlier ones on cost. Any other value is ignored with a warning. |
| `RB_CONFIG_DX` | `0` or `1`. `DX=1` replaces `DIFF_EXCLUDE_PATTERNS` with generated files only (`*.lock,package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,go.sum,*.min.js,*.min.css,*.map,*.snap`), so manifests, configs and `*.spec.ts` files are reviewed. It changes the first-pass input, so never combine it with `HI`; no run uses it yet. Any other value is ignored with a warning. |
| `RB_CONFIG_B_FILES` / `RB_CONFIG_B_UNTCH` | Non-negative integer. Overrides `BREADTH_MIN_FILES` / `BREADTH_MIN_UNTOUCHED`. Breadth runs only when both thresholds pass, so lowering one alone rarely changes which PRs get a breadth pass. Any other value is ignored with a warning. |
| `RB_CONFIG_LENSES` | Lens list, comma or plus: `reliability`, `security`, `testing`, `performance`, `architecture`, `impact`, or the aliases `rel`, `sec`, `test`, `perf`, `arch`, `imp`. Lenses run in list order. One value label doubles as the switch: a value naming at least one known lens sets `LENSES` and turns lenses on, `0`/`off` turns them off, and an unknown-only value (e.g. a typo such as `rell`) turns them off too, including the baked `rel`, with a warning. The image bakes `rel`, so set the label only to change the list or to turn lenses off. The label replaces the baked list, so keep `rel` by listing it (`imp+rel`). Lenses use the reviewer model and effort, because `LENS_MODEL` is unset in the image. |
| Label limits | The manifest allows at most 6 configuration entries (key ≤ 32 chars, value ≤ 64). The platform builds the run's row id from the label values and rejects ids over 64 characters. Hence the short keys and lens aliases (`rel+perf`, not `reliability+performance`), and why a label that only repeats a baked default, such as `MODEL`, is better left out. Set only the labels you change. |
| Image `ENV` defaults | `CLAUDE_MODEL=claude-haiku-5-5`, `JUDGING_MODEL=claude-haiku-5-5`, `MAX_OUTPUT_TOKENS=64000` (reviewer and judge), `EXTRA_PASS_MAX_OUTPUT_TOKENS=128000` (breadth, second-look, lenses), `ENABLE_BENCHMARK_PASS_DEADLINE=true` (each extra-pass call stops at 570 s so the judge keeps 270 s; logged as `aborted_time`), `ENABLE_BUNDLED_REVIEW=true`, `MAX_BUNDLES=3`, `ENABLE_LENSES=true` (the `LENSES` list is the switch: empty runs no lens). The 128k extra-pass cap needs a model with 128k output: a label-selected older model (e.g. `MODEL=claude-haiku-4-5`, 64k output, 200k window) needs an image that bakes a lower `EXTRA_PASS_MAX_OUTPUT_TOKENS` (no label sets it), or its breadth, second-look and lens calls fail or skip on budget |
| Build args | `REVIEW_EFFORT=high`, `JUDGE_EFFORT=high`, `JUDGE_KEEP_MINOR=true`, `JUDGE_KEEP_UNVERIFIED=true`, `JUDGE_FILE_CONTEXT=false`, `NITPICKS=true`, `LINE_NUMBERS=true`, `BREADTH=true`, `BREADTH_FILES=1`, `BREADTH_UNTOUCHED=0`, `SECOND_LOOK=true`, `LENSES=rel`, baked into `REVIEW_EFFORT`, `JUDGE_EFFORT`, `ENABLE_JUDGE_KEEP_MINOR`, `ENABLE_JUDGE_KEEP_UNVERIFIED`, `ENABLE_JUDGE_FILE_CONTEXT`, `ENABLE_NITPICKS`, `ENABLE_LINE_NUMBERS`, `ENABLE_BREADTH_REVIEW`, `BREADTH_MIN_FILES`, `BREADTH_MIN_UNTOUCHED`, `ENABLE_SECOND_LOOK` and `LENSES` (see `docs/reference/env-vars.md`). The other label-controlled settings keep their agent defaults, all off, including `J_TGAP` and `XROWS`. An experiment image passes `--build-arg …=`; the release workflow passes none. The `RB_CONFIG_*` labels override them per run. |

Applied settings are printed as `Benchmark settings: model=… effort=… judge_model=… judge_effort=… nits= j_minor= j_unver= j_ctx= lnum= breadth= b_files= b_untch= second_look= j_quality= sl_breadth= j_shown_anchor= b_priority= sfx= j_proposal=` (flags as 0/1; `sfx` is `ENABLE_SUGGESTED_FIXES`, which has no label but switches the judge to the code-proposal contract and makes `findings.json` proposals code), followed by `lenses=<value as given>` when lenses are active, `lens_rec=1` when the recommendation is on, `j_tgap=1` when `ENABLE_JUDGE_KEEP_TEST_GAPS` is on, `xrows=1` when `ENABLE_BENCHMARK_COUNTERPART_ROWS` is on, `hi=1` when `ENABLE_HIGH_IMPACT` is on, `fp_sites=1` when `ENABLE_FIRST_PASS_SITES` is on, `xp_max=<n>` when `EXTRA_PASS_MAX_OUTPUT_TOKENS` is set, `pass_deadline=1` when `ENABLE_BENCHMARK_PASS_DEADLINE` is on, `dx=1` when the `DX` exclusion list is in effect and `cache=1` when `ENABLE_PROMPT_CACHE` is on, because the run flags any label whose value never appears in the output. Unsupported `RB_CONFIG_*` labels are logged as ignored, and their values are not echoed. All other agent env vars still work (see `docs/reference/env-vars.md`), for example `DIFF_EXCLUDE_PATTERNS`, `MAX_FINDINGS` and `MAX_CONTEXT_FILES`.

A run with no labels prints `model=claude-haiku-5-5 effort=high judge_model=claude-haiku-5-5 judge_effort=high … lenses=rel`. It is not comparable to a no-label run on images up to v0.0.53, which used a `claude-sonnet-5` judge, the model-default effort for both models and no lens.

Example label sets:

- Test-gap policy plus counterpart rows: `J_TGAP=1`, `XROWS=1`.
- High-impact baseline: `LENSES=imp+rel`, `HI=1`, `J_TGAP=1`, `XROWS=1` (`rel` must be listed, because the label replaces the baked `rel`). Impact goes first because lenses run in list order and, on the largest PRs, the half-deadline guard skips every lens after the first one that would start too late.
- First-pass sites on top of the high-impact baseline: add `FP_SITES=1` (5 labels; row id `pr-review-agent-1-1-1-imp+rel-1` in that order).
- Prompt cache on top of the high-impact baseline: `CACHE=1`, `J_TGAP=1`, `XROWS=1`, `HI=1`, `LENSES=imp+rel` (5 labels; row id `pr-review-agent-1-1-1-1-imp+rel` in that order).
- Previous Sonnet-judge behaviour: add `JUDGE_MODEL=claude-sonnet-5` and `LENSES=0`. Both efforts stay `high`; to get the model default too, build the image with `--build-arg REVIEW_EFFORT= --build-arg JUDGE_EFFORT=`.

Proxy: the benchmark sets `HTTP(S)_PROXY` and `NODE_USE_ENV_PROXY=1`. Node 24 honors these for the built-in `fetch` that the SDK uses.

## Build

From the repo root (the image builds the bundle from `src/`, so the committed `dist/` isn't used):

```sh
docker build --platform linux/amd64 -f reviewbench/Dockerfile -t pr-review-agent:reviewbench .
```

Push to `ghcr.io/<owner>/<name>` and register by digest (`@sha256:…`), never by tag.

## Run locally

Without Docker:

```sh
npm run bundle
RB_NWO=owner/repo RB_PR_NUMBER=1938 RB_BASE=<sha> RB_HEAD=<sha> RB_AGENT=pr-review-agent \
RB_REPO=/path/to/checkout RB_DIFF=/path/to/diff.patch RB_PR_JSON=/path/to/pr.json RB_OUT=./tmp/findings.json \
RB_CONFIG_MODEL=claude-sonnet-5 RB_CONFIG_EFFORT=high ANTHROPIC_API_KEY=sk-ant-... \
node dist/pr-review-agent.cjs --benchmark
```

`diff.patch` is `git -C <checkout> diff <base>...<head>`. `pr.json` is `{ repo, pr_number, base, head, nwo, title, body }`. A `.env` in the working directory is loaded too.

With the harness: `scripts/try-agent.sh pr-review-agent:reviewbench --pr 0 -e ANTHROPIC_API_KEY -e RB_CONFIG_MODEL=claude-sonnet-5`, run from a ReviewBench checkout. It applies the same output checks as the real run.
