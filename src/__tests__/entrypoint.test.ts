import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

// The container entrypoint is the last line of defense: whatever the agent does, the PR must end with exit 0 + a valid file.

const ENTRYPOINT = fileURLToPath(new URL('../../reviewbench/entrypoint.mjs', import.meta.url))
const HEAD = 'd'.repeat(40)

function runEntrypoint(agentSource: string, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rb-entry-'))
  const agent = join(dir, 'agent.cjs')
  writeFileSync(agent, agentSource)
  writeFileSync(join(dir, 'pr.json'), JSON.stringify({ repo: 'https://github.com/owner/repo', pr_number: 7 }))
  const out = join(dir, 'out', 'findings.json')
  const result = spawnSync(process.execPath, [ENTRYPOINT], {
    encoding: 'utf-8',
    env: {
      ...process.env, AGENT_BUNDLE: agent,
      RB_OUT: out, RB_PR_JSON: join(dir, 'pr.json'), RB_NWO: 'owner/repo', RB_PR_NUMBER: '7',
      RB_BASE: 'e'.repeat(40), RB_HEAD: HEAD, RB_AGENT: 'my-agent',
      ...extraEnv,
    },
  })
  return { status: result.status, out: JSON.parse(readFileSync(out, 'utf-8')) }
}

const EMPTY = {
  pr: { repo: 'https://github.com/owner/repo', pr_number: 7, base: 'e'.repeat(40), head: HEAD },
  agent: 'my-agent',
  findings: [],
}

describe('reviewbench entrypoint', () => {
  it('writes empty findings and exits 0 when the agent crashes before writing anything', () => {
    const { status, out } = runEntrypoint('throw new Error("Missing required environment variable: ANTHROPIC_API_KEY")')
    expect(status).toBe(0)
    expect(out).toEqual(EMPTY)
  })

  it('keeps a valid findings file the agent wrote', () => {
    const written = { ...EMPTY, findings: [{ file: 'a.ts', start_line: 1, end_line: 1, message: 'm', producer: 'my-agent' }] }
    const agent = `require('fs').mkdirSync(require('path').dirname(process.env.RB_OUT), { recursive: true }); require('fs').writeFileSync(process.env.RB_OUT, ${JSON.stringify(JSON.stringify(written))})`
    const { status, out } = runEntrypoint(agent)
    expect(status).toBe(0)
    expect(out).toEqual(written)
  })

  it('replaces a findings file whose head does not match RB_HEAD', () => {
    const stale = { ...EMPTY, pr: { ...EMPTY.pr, head: 'f'.repeat(40) }, findings: [{ file: 'a.ts' }] }
    const agent = `require('fs').mkdirSync(require('path').dirname(process.env.RB_OUT), { recursive: true }); require('fs').writeFileSync(process.env.RB_OUT, ${JSON.stringify(JSON.stringify(stale))}); process.exit(3)`
    const { status, out } = runEntrypoint(agent)
    expect(status).toBe(0)
    expect(out).toEqual(EMPTY)
  })

  it('stops a hung agent at the deadline and still writes empty findings', () => {
    const started = Date.now()
    const { status, out } = runEntrypoint('setTimeout(() => {}, 60_000)', { BENCHMARK_DEADLINE_SECONDS: '1' })
    expect(status).toBe(0)
    expect(out).toEqual(EMPTY)
    expect(Date.now() - started).toBeLessThan(30_000)
  })
})
