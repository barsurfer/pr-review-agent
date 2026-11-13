import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')
const INDEX = fileURLToPath(new URL('../index.ts', import.meta.url))
const TIMEOUT = 60_000

const MODEL_LIST = { data: [{ id: 'openai/gpt-6-luna', canonical_slug: 'openai/gpt-6-luna-20260922', context_length: 1_050_000, top_provider: { context_length: 1_050_000 } }] }

// One local server plays both OpenRouter (/api/v1/models) and a failing Bitbucket, so the run ends right after the window lookup would have happened.
async function runCli(models: { reviewer: string; judge: string }) {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.url === '/api/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(MODEL_LIST))
      return
    }
    res.writeHead(500); res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const cwd = mkdtempSync(join(tmpdir(), 'pr-agent-ctxwin-'))
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      VCS_PROVIDER: 'bitbucket', BITBUCKET_WORKSPACE: 'w', BITBUCKET_USERNAME: 'u', BITBUCKET_TOKEN: 'invalid', BITBUCKET_BASE_URL: `${base}/bb`,
      LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: `${base}/api/v1`,
      CLAUDE_MODEL: models.reviewer, JUDGING_MODEL: models.judge, MODEL_CONTEXT_TOKENS: '',
      ENABLE_BREADTH_REVIEW: '', ENABLE_LENSES: '',
      TRIGGER_EVENT: '', TRIGGER_COMMENT_AUTHOR: '', IGNORE_COMMENT_AUTHORS: '', LAST_CHECKED_COMMIT: '', TRIGGER_EVENT_KIND: '', USAGE_RECORD_FILE: '',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }
    for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete env[name]
    const proc = spawn(process.execPath, [TSX_CLI, INDEX, '--repo-slug', 'r', '--pr-id', '1', '--dry-run', '--log-usage', 'false'], { cwd, env })
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const status = await new Promise<number | null>(resolve => proc.on('close', resolve))
    return { status, stdout, stderr, modelListRequests: requests.filter(u => u.endsWith('/models')).length }
  } finally {
    server.close()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5 })
  }
}

describe('CLI context-window lookup (src/index.ts)', () => {
  it('production ids (anthropic/claude-haiku-5.5 reviewer + judge) make no model-list request and print no window line', async () => {
    const { stdout, stderr, modelListRequests } = await runCli({ reviewer: 'anthropic/claude-haiku-5.5', judge: 'anthropic/claude-haiku-5.5' })
    expect(stdout).toContain('Fetching PR info...')
    expect(modelListRequests).toBe(0)
    expect(stdout + stderr).not.toMatch(/context window/i)
  }, TIMEOUT)

  it('an unknown slug is looked up once before the review starts', async () => {
    const { stdout, modelListRequests } = await runCli({ reviewer: 'openai/gpt-6-luna', judge: 'openai/gpt-6-luna' })
    const line = `Context window from the OpenRouter model list: openai/gpt-6-luna ${(1_050_000).toLocaleString()}`
    expect(modelListRequests).toBe(1)
    expect(stdout).toContain(line)
    expect(stdout.indexOf(line)).toBeLessThan(stdout.indexOf('Starting review for PR #1'))
  }, TIMEOUT)
})
