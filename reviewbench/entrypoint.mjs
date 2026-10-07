// Guarantees exit 0 + a findings file even when the agent crashes at startup (before its own fail-safe) or hits the time limit — either fails the whole ReviewBench run.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const env = process.env
const out = env.RB_OUT || '/work/out/findings.json'
const bundle = env.AGENT_BUNDLE || '/app/pr-review-agent.cjs'
// Default leaves a minute under ReviewBench's 15-minute per-PR limit to write the fallback.
// A finite, positive seconds value or 840 — a bad operator-set value must not make spawnSync throw.
const secs = Number(env.BENCHMARK_DEADLINE_SECONDS)
const deadlineMs = (Number.isFinite(secs) && secs > 0 ? secs : 840) * 1000

try {
  const run = spawnSync(process.execPath, [bundle, '--benchmark'], { stdio: 'inherit', timeout: deadlineMs })
  if (run.error || run.status !== 0) {
    console.error(`entrypoint: agent ${run.error ? `failed: ${run.error.message}` : `exited with ${run.status ?? run.signal}`}`)
  }
} catch (err) {
  console.error(`entrypoint: could not run agent: ${err.message}`)
}

if (!hasValidFindings()) {
  console.error('entrypoint: no valid findings file — writing empty findings')
  writeEmptyFindings()
}
process.exit(0)

function hasValidFindings() {
  try {
    const data = JSON.parse(readFileSync(out, 'utf8'))
    return Array.isArray(data?.findings) && (!env.RB_HEAD || data.pr?.head === env.RB_HEAD)
  } catch {
    return false
  }
}

function writeEmptyFindings() {
  let pr = {}
  try { pr = JSON.parse(readFileSync(env.RB_PR_JSON || '/work/pr/pr.json', 'utf8')) ?? {} } catch {}
  const output = {
    pr: {
      repo: pr.repo || `https://github.com/${env.RB_NWO ?? ''}`,
      pr_number: Number(env.RB_PR_NUMBER || pr.pr_number),
      base: env.RB_BASE || pr.base || '',
      head: env.RB_HEAD || pr.head || '',
    },
    agent: env.RB_AGENT || 'pr-review-agent',
    findings: [],
  }
  try {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(output, null, 2) + '\n')
  } catch (err) {
    console.error(`entrypoint: could not write ${out}: ${err.message}`)
  }
}
