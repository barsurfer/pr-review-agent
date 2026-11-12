import { describe, it, expect } from 'vitest'
import { beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync } from 'fs'
import { readdirSync, rmSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

// index.ts runs main() on import, so its flag-to-review() wiring is only observable by running the real CLI.
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')
const INDEX = fileURLToPath(new URL('../index.ts', import.meta.url))
const TIMEOUT = 60_000

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [TSX_CLI, INDEX, '--repo-slug', 'r', '--pr-id', '1', '--dry-run', '--log-usage', 'false', ...args], {
    // A fresh cwd keeps the repo's .env away from dotenv; the unroutable base URL turns any VCS call into a fast exit 1.
    cwd: mkdtempSync(join(tmpdir(), 'pr-agent-cli-')),
    encoding: 'utf-8',
    env: {
      ...process.env,
      VCS_PROVIDER: 'bitbucket', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key',
      BITBUCKET_WORKSPACE: 'w', BITBUCKET_USERNAME: 'u', BITBUCKET_TOKEN: 'invalid', BITBUCKET_BASE_URL: 'http://127.0.0.1:9',
      TRIGGER_EVENT: '', TRIGGER_COMMENT_AUTHOR: '', IGNORE_COMMENT_AUTHORS: '',
      ...extraEnv,
    },
  })
  const stdout = result.stdout ?? ''
  const usage = stdout.slice(stdout.indexOf('=== Usage ==='))
  const record = usage ? JSON.parse(usage.slice(usage.indexOf('{'), usage.lastIndexOf('}') + 1)) : null
  return { status: result.status, stdout, stderr: result.stderr ?? '', record }
}

describe('CLI trigger wiring (src/index.ts)', () => {
  it('passes --event/--comment-author to review(): a listed comment author skips before any VCS call, exit 0', () => {
    const { status, stdout, record } = runCli(['--event', 'pullrequest:comment_created', '--comment-author', '{BOT}'], { IGNORE_COMMENT_AUTHORS: 'bot' })

    expect(status).toBe(0)
    expect(stdout).toContain('Trigger: pullrequest:comment_created by {BOT}')
    expect(stdout).toContain('Skipping: pullrequest:comment_created by "{BOT}" matches IGNORE_COMMENT_AUTHORS')
    expect(stdout).not.toContain('Fetching PR info')
    expect(record).toMatchObject({ action: 'SKIP', trigger: { event: 'pullrequest:comment_created', comment_author: '{BOT}' } })
  }, TIMEOUT)

  it('empty CLI values fall back to TRIGGER_EVENT / TRIGGER_COMMENT_AUTHOR', () => {
    const { status, record } = runCli(['--event', '', '--comment-author', ' '], {
      IGNORE_COMMENT_AUTHORS: 'bot', TRIGGER_EVENT: 'pullrequest:comment_created', TRIGGER_COMMENT_AUTHOR: '{bot}',
    })

    expect(status).toBe(0)
    expect(record).toMatchObject({ action: 'SKIP', trigger: { event: 'pullrequest:comment_created', comment_author: '{bot}' } })
  }, TIMEOUT)

  it('warns that the ignore list is inactive when no trigger was given, then proceeds to the VCS', () => {
    const { status, stdout, stderr, record } = runCli([], { IGNORE_COMMENT_AUTHORS: 'bot' })

    expect(stderr).toContain('IGNORE_COMMENT_AUTHORS is set but no --event/--comment-author (TRIGGER_EVENT/TRIGGER_COMMENT_AUTHOR) was given - the ignore list is inactive.')
    expect(stdout).toContain('Fetching PR info...')
    expect(status).toBe(1)
    expect(record.action).toBe('ERROR')
  }, TIMEOUT)

  it('nothing set: no warning, no Trigger line, no trigger key', () => {
    const { status, stdout, stderr, record } = runCli([])

    expect(stderr).not.toContain('IGNORE_COMMENT_AUTHORS')
    expect(stdout).not.toMatch(/^Trigger:/m)
    expect(stdout).toContain('Fetching PR info...')
    expect(status).toBe(1)
    expect('trigger' in record).toBe(false)
  }, TIMEOUT)
})

describe('CLI checked-commit wiring (src/index.ts)', () => {
  const warnings = (stderr: string) => stderr.split('\n').filter(l => l.includes('ignoring the checked commit')).length

  it('CLI1 a malformed LAST_CHECKED_COMMIT gives exactly one warning and the run proceeds', () => {
    const { status, stdout, stderr } = runCli([], { LAST_CHECKED_COMMIT: 'garbage' })

    expect(warnings(stderr)).toBe(1)
    expect(stderr).toContain('Warning: ignoring the checked commit "garbage" (--checked-commit/LAST_CHECKED_COMMIT) - expected 12 to 64 hex characters')
    expect(stdout).toContain('Fetching PR info...')
    expect(status).toBe(1)
  }, TIMEOUT)

  it('CLI2 an empty --checked-commit with no env passes commander with no warning', () => {
    const { status, stdout, stderr } = runCli(['--checked-commit', ''], { LAST_CHECKED_COMMIT: '' })

    expect(stderr).not.toContain('unknown option')
    expect(warnings(stderr)).toBe(0)
    expect(stdout).toContain('Fetching PR info...')
    expect(status).toBe(1)
  }, TIMEOUT)

  it('CLI3 a 40-hex --checked-commit is accepted', () => {
    const { status, stdout, stderr } = runCli(['--checked-commit', '0123456789abcdef0123456789abcdef01234567'], { LAST_CHECKED_COMMIT: '' })

    expect(stderr).not.toContain('unknown option')
    expect(warnings(stderr)).toBe(0)
    expect(stdout).toContain('Fetching PR info...')
    expect(status).toBe(1)
  }, TIMEOUT)

  it('CLI4 nothing set: no warning and neither new record key', () => {
    const { status, stderr, record } = runCli([], { LAST_CHECKED_COMMIT: '' })

    expect(warnings(stderr)).toBe(0)
    expect(status).toBe(1)
    expect(record.action).toBe('ERROR')
    expect('checked_commit' in record).toBe(false)
    expect('dedup_source' in record).toBe(false)
  }, TIMEOUT)
})

const CHILD_TIMEOUT = TIMEOUT - 10_000

// The unroutable-URL harness fails before CHECK_BRANCHES, so these runs get a local server that answers only the PR-info call: a branch skip exits 0, a pass reaches FETCH_DIFF and errors on the 500.
async function runAgainstPr(pr: { source: string; target: string }, args: string[], extraEnv: Record<string, string> = {}) {
  const server = createServer((req, res) => {
    if (req.url !== '/repositories/w/r/pullrequests/1') { res.writeHead(500); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 1, title: 'T', description: '', author: { display_name: 'dev' },
      source: { branch: { name: pr.source }, commit: { hash: 'abcdef1234567890' } },
      destination: { branch: { name: pr.target } },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const cwd = mkdtempSync(join(tmpdir(), 'pr-agent-cli-'))
  let child: ChildProcess | undefined
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      VCS_PROVIDER: 'bitbucket', LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-key',
      BITBUCKET_WORKSPACE: 'w', BITBUCKET_USERNAME: 'u', BITBUCKET_TOKEN: 'invalid',
      BITBUCKET_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      TRIGGER_EVENT: '', TRIGGER_COMMENT_AUTHOR: '', IGNORE_COMMENT_AUTHORS: '', LAST_CHECKED_COMMIT: '',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    }
    // axios honours proxy variables, which on a proxied runner would route the local call away from this server.
    for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete env[name]
    for (const name of ['SKIP_SOURCE_BRANCHES', 'SKIP_TARGET_BRANCHES', 'ONLY_TARGET_BRANCHES']) delete env[name]
    Object.assign(env, extraEnv)
    const proc = spawn(process.execPath, [TSX_CLI, INDEX, '--repo-slug', 'r', '--pr-id', '1', '--dry-run', '--log-usage', 'false', ...args], { cwd, env })
    child = proc
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const status = await new Promise<number | null>((resolve, reject) => {
      // A vitest timeout abandons this promise without stopping the child, so the run enforces its own shorter limit.
      const timer = setTimeout(() => reject(new Error(`CLI run exceeded ${CHILD_TIMEOUT} ms`)), CHILD_TIMEOUT)
      proc.on('close', code => { clearTimeout(timer); resolve(code) })
    })
    const usage = stdout.slice(stdout.indexOf('=== Usage ==='))
    const record = JSON.parse(usage.slice(usage.indexOf('{'), usage.lastIndexOf('}') + 1))
    return { status, stdout, stderr, record, passed: stdout.includes('Fetching diff...') }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    server.close()
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5 })
  }
}

// runCli predates temp-dir cleanup, so the dirs this file leaves behind are removed once it finishes.
const tempDirsBefore = new Set<string>()
beforeAll(() => { for (const d of readdirSync(tmpdir())) if (d.startsWith('pr-agent-cli-')) tempDirsBefore.add(d) })
afterAll(() => {
  for (const d of readdirSync(tmpdir())) {
    if (d.startsWith('pr-agent-cli-') && !tempDirsBefore.has(d)) rmSync(join(tmpdir(), d), { recursive: true, force: true, maxRetries: 5 })
  }
})

describe('CLI branch-list overrides (src/index.ts)', () => {
  const FEATURE_TO_MAIN = { source: 'feature/x', target: 'main' }
  const FEATURE_TO_DEVELOP = { source: 'feature/x', target: 'develop' }

  it('nothing passed: the defaults apply unchanged', async () => {
    const [develop, main, hotfix] = await Promise.all([
      runAgainstPr(FEATURE_TO_DEVELOP, []),
      runAgainstPr(FEATURE_TO_MAIN, []),
      runAgainstPr({ source: 'hotfix/x', target: 'develop' }, []),
    ])

    expect(develop.passed).toBe(true)
    expect(develop.status).toBe(1)
    expect(main.passed).toBe(false)
    expect(main.status).toBe(0)
    expect(main.record).toMatchObject({ action: 'SKIP', skip_reason: 'target branch "main" matches SKIP_TARGET_BRANCHES' })
    expect(hotfix.record).toMatchObject({ action: 'SKIP', skip_reason: 'source branch "hotfix/x" matches SKIP_SOURCE_BRANCHES' })
  }, TIMEOUT)

  it('--skip-target-branches= --only-target-branches=main: a PR into main passes CHECK_BRANCHES, a PR into develop is skipped', async () => {
    const args = ['--skip-target-branches=', '--only-target-branches=main']
    const [main, develop] = await Promise.all([runAgainstPr(FEATURE_TO_MAIN, args), runAgainstPr(FEATURE_TO_DEVELOP, args)])

    expect(main.passed).toBe(true)
    expect(main.stderr).not.toContain('unknown option')
    expect(develop.passed).toBe(false)
    expect(develop.status).toBe(0)
    expect(develop.record).toMatchObject({ action: 'SKIP', skip_reason: 'target branch "develop" is not in ONLY_TARGET_BRANCHES (main)' })
  }, TIMEOUT)

  it('a separate empty-string value ("") also disables the list, overriding the env var', async () => {
    const [skipEmpty, onlyEmpty] = await Promise.all([
      runAgainstPr(FEATURE_TO_MAIN, ['--skip-target-branches', ''], { SKIP_TARGET_BRANCHES: 'main,master' }),
      runAgainstPr({ source: 'feature/x', target: 'feature/base' }, ['--only-target-branches', ''], { ONLY_TARGET_BRANCHES: 'develop' }),
    ])

    expect(skipEmpty.passed).toBe(true)
    expect(onlyEmpty.passed).toBe(true)
  }, TIMEOUT)

  it('the main-only recipe in argument form reviews hotfix/* into main and skips a stacked PR', async () => {
    const args = ['--skip-target-branches=', '--only-target-branches=main', '--skip-source-branches=main,master']
    const [hotfix, stacked] = await Promise.all([
      runAgainstPr({ source: 'hotfix/x', target: 'main' }, args),
      runAgainstPr({ source: 'feature/y', target: 'feature/x' }, args),
    ])

    expect(hotfix.passed).toBe(true)
    expect(stacked.record.skip_reason).toBe('target branch "feature/x" is not in ONLY_TARGET_BRANCHES (main)')
  }, TIMEOUT)

  it('a non-empty flag replaces the env list and is parsed like it (trim, drop empty entries)', async () => {
    const args = ['--skip-target-branches= release/* , ,', '--only-target-branches', ' develop , release/* ,']
    const env = { SKIP_TARGET_BRANCHES: 'develop', ONLY_TARGET_BRANCHES: 'main' }
    const [develop, release] = await Promise.all([
      runAgainstPr(FEATURE_TO_DEVELOP, args, env),
      runAgainstPr({ source: 'feature/x', target: 'release/1.2' }, args, env),
    ])

    expect(develop.passed).toBe(true)
    expect(release.record.skip_reason).toBe('target branch "release/1.2" matches SKIP_TARGET_BRANCHES')
  }, TIMEOUT)

  it('an unquoted empty value lets the flag swallow the next argument (why docs use the = form)', async () => {
    const swallowed = await runAgainstPr(FEATURE_TO_DEVELOP, ['--skip-target-branches', '--only-target-branches=main'])

    expect(swallowed.passed).toBe(true)
  }, TIMEOUT)
})
