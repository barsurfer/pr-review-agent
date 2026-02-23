import { build } from 'esbuild'
import { readFileSync } from 'fs'

const basePrompt = readFileSync('src/prompt/base-prompt.txt', 'utf-8')

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
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
  // dotenv reads .env from cwd at runtime — don't bundle .env itself
  external: [],
})

console.log('Bundled → dist/pr-review-agent.cjs')
