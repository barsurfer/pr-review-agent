# ReviewBench image

Runs pr-review-agent as a [ReviewBench](https://github.com/review-bench/ReviewBench) agent: one container per PR, no CLI args, findings written to `RB_OUT`.

## How it works

- `entrypoint.mjs` runs `pr-review-agent.cjs --benchmark`.
- `--benchmark` reads the PR from the contract mounts (`RB_DIFF`, `RB_PR_JSON`, `RB_REPO`, default `/work/repo`) through `src/vcs/reviewbench.ts`. It runs the normal pipeline as a first review: same prompt, structured reviewer output, and judge. Then it writes `{ pr, agent, findings[] }` to `RB_OUT` instead of posting.
- A finding is kept only if the judge kept it and it has a `file` plus a parseable `lines` range. `message` is `"<title>: <body>"`, and `agent`/`producer` are `RB_AGENT`.
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
| Image `ENV` defaults | `CLAUDE_MODEL=claude-sonnet-5`, `JUDGING_MODEL=claude-sonnet-5`, `MAX_OUTPUT_TOKENS=64000` |

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
