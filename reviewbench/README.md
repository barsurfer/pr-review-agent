# ReviewBench image

Runs pr-review-agent as a [ReviewBench](https://github.com/review-bench/ReviewBench) agent: one container per PR, no CLI args, findings written to `RB_OUT`.

## How it works

- `entrypoint.mjs` runs `pr-review-agent.cjs --benchmark`.
- `--benchmark` reads the PR from the contract mounts (`RB_DIFF`, `RB_PR_JSON`, `RB_REPO`, default `/work/repo`) through `src/vcs/reviewbench.ts`. It runs the normal pipeline as a first review: same prompt, structured reviewer output, and judge. Then it writes `{ pr, agent, findings[] }` to `RB_OUT` instead of posting.
- A finding is kept only if the judge kept it and it has a `file` plus a parseable `lines` range. On a single-pass judged run, a kept finding with a changed `file` but no usable line is placed on that file's first added line, or line 1 when the file has no added line but still exists at head, e.g. rename-only (`anchorSource: 'file'`, logged as "placed on the file's first changed line"); bundled reviews and the judge-failure fallback still drop such findings, as do findings on deleted files. This is safe because ReviewBench matches findings by meaning within a file and line ranges are only a hint. `message` is `"<title>: <body>"`, and `agent`/`producer` are `RB_AGENT`.
- Benchmark mode turns off the branch-skip patterns and the default `MAX_CHANGED_FILES`/`MAX_CHANGED_LINES` caps, because a skipped PR scores zero. Explicit env values still apply.

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
| `RB_CONFIG_MODEL` / `RB_CONFIG_EFFORT` | Reviewer model / effort |
| `RB_CONFIG_JUDGE_MODEL` / `RB_CONFIG_JUDGE_EFFORT` | Judge model / effort |
| `RB_CONFIG_NITS` / `RB_CONFIG_J_MINOR` / `RB_CONFIG_J_UNVER` / `RB_CONFIG_J_CTX` / `RB_CONFIG_LNUM` / `RB_CONFIG_BREADTH` | `0` or `1`. Overrides `ENABLE_NITPICKS` / `ENABLE_JUDGE_KEEP_MINOR` / `ENABLE_JUDGE_KEEP_UNVERIFIED` / `ENABLE_JUDGE_FILE_CONTEXT` / `ENABLE_LINE_NUMBERS` / `ENABLE_BREADTH_REVIEW` (breadth uses the judge model); any other value is ignored with a warning. Keys are short because the manifest allows at most 6 configuration entries (key ≤ 32 chars, value ≤ 64); the flags default off except `LNUM` (on), so set only the ones you change. |
| Image `ENV` defaults | `CLAUDE_MODEL=claude-haiku-5-5`, `JUDGING_MODEL=claude-sonnet-5`, `MAX_OUTPUT_TOKENS=64000`, `ENABLE_BUNDLED_REVIEW=true`, `MAX_BUNDLES=3` |
| Build args `JUDGE_KEEP_MINOR` / `JUDGE_KEEP_UNVERIFIED` / `JUDGE_FILE_CONTEXT` | Default `false`. Baked into `ENABLE_JUDGE_*` (see `docs/reference/env-vars.md`). An experiment image passes `--build-arg …=true`; the release workflow passes none. The `RB_CONFIG_*` flag labels override them per run. The values in effect are echoed in the `Benchmark settings:` line as `nits= j_minor= j_unver= j_ctx= lnum= breadth=` (0/1). |
| Build arg `NITPICKS` | Default `false`. Baked into `ENABLE_NITPICKS` (see `docs/reference/env-vars.md`); same experiment-vs-release handling as the three above. |
| Build arg `LINE_NUMBERS` | Default `true` (numbering is on unless a run sets `LNUM=0`). Baked into `ENABLE_LINE_NUMBERS`. |

Applied settings are printed as `Benchmark settings: model=… effort=…`, because the run flags any label whose value never appears in the output. Unsupported `RB_CONFIG_*` labels are logged as ignored, and their values are not echoed. All other agent env vars still work (see `docs/reference/env-vars.md`), for example `DIFF_EXCLUDE_PATTERNS`, `MAX_FINDINGS` and `MAX_CONTEXT_FILES`.

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
