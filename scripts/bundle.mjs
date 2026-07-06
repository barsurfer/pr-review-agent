import { build } from 'esbuild'
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const basePrompt = readFileSync('src/prompt/base-prompt.txt', 'utf-8')
const replyPrompt = readFileSync('src/prompt/reply-prompt.txt', 'utf-8')
const judgePrompt = readFileSync('src/prompt/judge-prompt.txt', 'utf-8')
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))

// Fallback only — at runtime the agent prefers `git rev-parse` in its own checkout,
// because the bundle is committed together with the source (this hash is one behind)
let buildCommit = 'unknown'
try { buildCommit = execSync('git rev-parse --short HEAD').toString().trim() } catch {}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/pr-review-agent.cjs',
  minify: false,          // keep readable for debugging
  sourcemap: false,
  define: {
    __BASE_PROMPT__: JSON.stringify(basePrompt),
    __REPLY_PROMPT__: JSON.stringify(replyPrompt),
    __JUDGE_PROMPT__: JSON.stringify(judgePrompt),
    __AGENT_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
  // dotenv reads .env from cwd at runtime — don't bundle .env itself
  external: [],
})

console.log('Bundled → dist/pr-review-agent.cjs')
