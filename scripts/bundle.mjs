import { build } from 'esbuild'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { parseArgs } from 'util'
import { execSync } from 'child_process'

const { values: args } = parseArgs({
  options: {
    outfile: { type: 'string', default: 'dist/pr-review-agent.cjs' },
    'prompt-dir': { type: 'string', default: 'src/prompt' },
  },
})
const promptDir = args['prompt-dir']

// A Windows checkout (core.autocrlf) holds CRLF prompts; embed LF so the model gets the same bytes as from a Linux build.
const readPrompt = file => readFileSync(join(promptDir, file), 'utf-8').replace(/\r\n?/g, '\n')

const basePrompt = readPrompt('base-prompt.txt')
const replyPrompt = readPrompt('reply-prompt.txt')
const judgePrompt = readPrompt('judge-prompt.txt')
const stackPrompts = Object.fromEntries(
  readdirSync(join(promptDir, 'stacks')).filter(f => f.endsWith('.txt'))
    .map(f => [f.replace(/\.txt$/, ''), readPrompt(join('stacks', f))]),
)
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'))

// Fallback only — at runtime the agent prefers `git rev-parse` in its own checkout,
// because the bundle is committed together with the source (this hash is one behind)
let buildCommit = 'unknown'
try { buildCommit = execSync('git rev-parse --short HEAD').toString().trim() } catch {}

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: args.outfile,
  minify: false,          // keep readable for debugging
  sourcemap: false,
  define: {
    __BASE_PROMPT__: JSON.stringify(basePrompt),
    __REPLY_PROMPT__: JSON.stringify(replyPrompt),
    __JUDGE_PROMPT__: JSON.stringify(judgePrompt),
    __STACK_PROMPTS__: JSON.stringify(stackPrompts),
    __AGENT_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
  // dotenv reads .env from cwd at runtime — don't bundle .env itself
  external: [],
})

console.log(`Bundled → ${args.outfile}`)
