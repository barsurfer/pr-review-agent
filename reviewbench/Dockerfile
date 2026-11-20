# ReviewBench agent image: pr-review-agent in --benchmark mode (see reviewbench/README.md).
# Build from the repo root: docker build --platform linux/amd64 -f reviewbench/Dockerfile -t pr-review-agent:reviewbench .

FROM --platform=linux/amd64 node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY scripts ./scripts
COPY src ./src
RUN npm run bundle

# Node 24 honors NODE_USE_ENV_PROXY, which the benchmark sets so built-in fetch (the Anthropic SDK) uses its egress proxy.
FROM --platform=linux/amd64 node:24-bookworm-slim
WORKDIR /app
COPY --from=build /src/dist/pr-review-agent.cjs ./pr-review-agent.cjs
COPY reviewbench/entrypoint.mjs ./entrypoint.mjs

# Defaults only: the RB_CONFIG_MODEL / EFFORT / JUDGE_MODEL / JUDGE_EFFORT labels override per run. 64k output covers xhigh/max effort thinking.
# haiku-5-5 reviewer (1M context → big PRs review in one pass) and haiku-5-5 judge, both at high effort, so a run spends no label slot on them.
# Bundling salvages PRs still over budget, capped at 3 bundles so one giant PR can't run away on cost.
# Extra passes get 128k (breadth truncated at 64k on the largest PR) while reviewer and judge stay at 64k; the pass deadline stops them in time for the judge.
# Effort is a build arg because no label can unset it (empty labels are ignored); an empty value builds a model-default image.
ARG REVIEW_EFFORT=high
ARG JUDGE_EFFORT=high
ENV CLAUDE_MODEL=claude-haiku-5-5 \
    JUDGING_MODEL=claude-haiku-5-5 \
    REVIEW_EFFORT=$REVIEW_EFFORT \
    JUDGE_EFFORT=$JUDGE_EFFORT \
    MAX_OUTPUT_TOKENS=64000 \
    EXTRA_PASS_MAX_OUTPUT_TOKENS=128000 \
    ENABLE_BENCHMARK_PASS_DEADLINE=true \
    ENABLE_BUNDLED_REVIEW=true \
    MAX_BUNDLES=3

# Flags are baked per image so the digest pins the config; nits + lenient judge policy are on (best showcase config) to free label slots.
ARG JUDGE_KEEP_MINOR=true
ARG JUDGE_KEEP_UNVERIFIED=true
ARG JUDGE_FILE_CONTEXT=false
ARG NITPICKS=true
ARG LINE_NUMBERS=true
# Breadth baked on (best showcase config) so its three RB_CONFIG label slots stay free.
ARG BREADTH=true
ARG BREADTH_FILES=1
ARG BREADTH_UNTOUCHED=0
# Baked on for the bench image (recall lever under test); prod is unaffected (Jenkins sets its own env).
ARG SECOND_LOOK=true
# Reliability lens baked on to free its label slot; as with the LENSES label the list is the switch, so an empty value runs no lens.
ARG LENSES=rel
# Test-gap policy, counterpart rows and high-impact baked on (settled levers) to free three label slots; the J_TGAP / XROWS / HI labels still turn each off with 0.
ARG JUDGE_KEEP_TEST_GAPS=true
ARG COUNTERPART_ROWS=true
ARG HIGH_IMPACT=true
ENV ENABLE_JUDGE_KEEP_MINOR=$JUDGE_KEEP_MINOR \
    ENABLE_JUDGE_KEEP_UNVERIFIED=$JUDGE_KEEP_UNVERIFIED \
    ENABLE_JUDGE_FILE_CONTEXT=$JUDGE_FILE_CONTEXT \
    ENABLE_NITPICKS=$NITPICKS \
    ENABLE_LINE_NUMBERS=$LINE_NUMBERS \
    ENABLE_BREADTH_REVIEW=$BREADTH \
    BREADTH_MIN_FILES=$BREADTH_FILES \
    BREADTH_MIN_UNTOUCHED=$BREADTH_UNTOUCHED \
    ENABLE_SECOND_LOOK=$SECOND_LOOK \
    ENABLE_LENSES=true \
    LENSES=$LENSES \
    ENABLE_JUDGE_KEEP_TEST_GAPS=$JUDGE_KEEP_TEST_GAPS \
    ENABLE_BENCHMARK_COUNTERPART_ROWS=$COUNTERPART_ROWS \
    ENABLE_HIGH_IMPACT=$HIGH_IMPACT

# Runs as root like the reference agents: /work/out is a host mount whose owner we don't control.
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
