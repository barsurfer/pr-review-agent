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

# Defaults only: the RB_CONFIG_MODEL / RB_CONFIG_EFFORT labels override per run. 64k output covers xhigh/max effort thinking.
ENV CLAUDE_MODEL=claude-sonnet-5 \
    JUDGING_MODEL=claude-sonnet-5 \
    MAX_OUTPUT_TOKENS=64000

# Runs as root like the reference agents: /work/out is a host mount whose owner we don't control.
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
