// ---------------------------------------------------------------------------
// Usage record — type, cost estimation, record builder, file logging
// ---------------------------------------------------------------------------

import { appendFileSync, readFileSync } from 'fs'
import { execSync, type ExecSyncOptions } from 'child_process'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'
import { parseVerdictScore, parseFindings, parseDeltaStats } from './parsers.js'
import type { ReviewContext } from './types.js'

export interface UsageRecord {
  run_id: string
  timestamp: string
  agent_version: string
  vcs: string
  workspace: string
  repo_slug: string
  pr_id: string
  pr_author: string
  source_commit: string
  source_branch: string
  target_branch: string
  changed_files: number
  changed_lines: number
  context_files_fetched: number
  degraded: boolean
  review_number: number
  action: string
  skip_reason: string | null
  model: string
  tokens: { input: number; output: number; cache_read: number; cache_write: number; estimated_input: number }
  cost_usd: number
  judge_model: string | null
  judge_tokens: { input: number; output: number } | null
  judge_cost_usd: number | null
  duration_ms: number
  dry_run: boolean
  force: string
  prompt_source: string
  verdict_score: number | null
  computed_score: number | null
  review_findings: { high: number; medium: number; low: number } | null
  findings: { high: number; medium: number; low: number } | null
  touch_rate: number | null
  delta: { developer_replies: number; resolved: number; still_open: number; new_findings: number } | null
  jenkins: { job: string; build: string; url: string } | null
  error: { type: string; message: string; status: number | null } | null
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
}

export function estimateCost(tokens: { input: number; output: number }, model: string): number {
  // Dated IDs (claude-haiku-4-5-20251001) price as their alias
  let p = MODEL_PRICING[model] ?? MODEL_PRICING[model.replace(/-\d{8}$/, '')]
  if (!p) {
    console.warn(`No pricing entry for model "${model}" — estimating with claude-sonnet-4-6 rates`)
    p = MODEL_PRICING['claude-sonnet-4-6']
  }
  const cost = (tokens.input / 1_000_000) * p.input + (tokens.output / 1_000_000) * p.output
  return Math.round(cost * 10000) / 10000 // 4 decimal places
}

// ---------------------------------------------------------------------------
// Agent version
// ---------------------------------------------------------------------------

export function getAgentVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.version
  } catch {
    // @ts-ignore — injected at bundle time by esbuild
    if (typeof __AGENT_VERSION__ !== 'undefined') return __AGENT_VERSION__ as string
    return 'unknown'
  }
}

/** Commit hash of the agent deployment, for the review footer.
 *  Runtime git wins — Jenkins runs the bundle from a clean checkout, so this is the
 *  exact deployed commit. The bundle-time fallback is one commit behind by nature
 *  (the bundle is committed together with the source that produced it). */
export function getBuildCommit(): string {
  try {
    const cwd = dirname(process.argv[1] ?? '.')
    const opts: ExecSyncOptions = { cwd, stdio: ['ignore', 'pipe', 'ignore'] }
    const hash = execSync('git rev-parse --short HEAD', opts).toString().trim()
    const dirty = execSync('git status --porcelain', opts).toString().trim() ? '-dirty' : ''
    return hash + dirty
  } catch {
    // @ts-ignore — injected at bundle time by esbuild
    if (typeof __BUILD_COMMIT__ !== 'undefined') return __BUILD_COMMIT__ as string
    return 'unknown'
  }
}

/** Jenkins build metadata for comment ↔ run ↔ artifact traceability. Jenkins injects
 *  these into the build env; the node process inherits them. Null off-CI. */
export function getJenkinsMeta(): { job: string; build: string; url: string } | null {
  const job = process.env.JOB_NAME ?? ''
  const build = process.env.BUILD_NUMBER ?? ''
  const url = process.env.BUILD_URL ?? ''
  if (!job && !build && !url) return null
  return { job, build, url }
}

/** CI job URL for linking the footer's "Review #N" / "Reply by" to the build that posted it.
 *  Null off-CI or when no build URL is exposed (non-Jenkins pipelines get a plain footer). */
export function getJobUrl(): string | undefined {
  return getJenkinsMeta()?.url || undefined
}

// ---------------------------------------------------------------------------
// Record builder
// ---------------------------------------------------------------------------

export function buildUsageRecord(
  ctx: ReviewContext,
  durationMs: number,
  error: { type: string; message: string; status: number | null } | null
): UsageRecord {
  const commitShort = ctx.prInfo?.sourceCommit?.slice(0, 12) ?? 'unknown'
  const reviewText = ctx.reviewText ?? ''
  const reviewTextBeforeJudge = ctx.reviewTextBeforeJudge ?? ''
  const verdictScore = reviewText ? parseVerdictScore(reviewText) : null
  const findings = reviewText ? parseFindings(reviewText) : null
  const reviewFindings = reviewTextBeforeJudge ? parseFindings(reviewTextBeforeJudge) : null
  const judgeModel = config.judge.model || null
  const judgeTokensRaw = ctx.judgeUsage ?? null
  const judgeTokens = judgeTokensRaw ? { input: judgeTokensRaw.input_tokens, output: judgeTokensRaw.output_tokens } : null
  const judgeCost = judgeTokens && judgeModel ? estimateCost(judgeTokens, judgeModel) : null

  return {
    run_id: `${config.vcsProvider}-${ctx.repoSlug}-${ctx.prId}-${commitShort}`,
    timestamp: new Date().toISOString(),
    agent_version: getAgentVersion(),
    vcs: config.vcsProvider,
    workspace: config.vcsProvider === 'azure' ? config.azure.org : config.bitbucket.workspace,
    repo_slug: ctx.repoSlug,
    pr_id: ctx.prId,
    pr_author: ctx.prInfo?.author ?? 'unknown',
    source_commit: ctx.prInfo?.sourceCommit ?? 'unknown',
    source_branch: ctx.prInfo?.sourceBranch ?? 'unknown',
    target_branch: ctx.prInfo?.targetBranch ?? 'unknown',
    changed_files: ctx.changedFiles?.length ?? 0,
    changed_lines: ctx.lineCount ?? 0,
    context_files_fetched: ctx.fileContexts?.length ?? 0,
    degraded: ctx.degraded ?? false,
    review_number: ctx.reviewNumber,
    action: ctx.action,
    skip_reason: ctx.skipReason ?? null,
    model: config.anthropic.model,
    tokens: {
      input: ctx.usage.input_tokens,
      output: ctx.usage.output_tokens,
      cache_read: ctx.usage.cache_read,
      cache_write: ctx.usage.cache_write,
      estimated_input: ctx.estimatedInputTokens,
    },
    cost_usd: estimateCost({
      input: ctx.usage.input_tokens - (judgeTokens?.input ?? 0),
      output: ctx.usage.output_tokens - (judgeTokens?.output ?? 0),
    }, config.anthropic.model) + (judgeCost ?? 0),
    judge_model: judgeModel,
    judge_tokens: judgeTokens,
    judge_cost_usd: judgeCost,
    duration_ms: durationMs,
    dry_run: ctx.dryRun,
    force: ctx.force,
    prompt_source: ctx.prompt?.source ?? 'none',
    verdict_score: verdictScore,
    computed_score: findings ? Math.max(0, 100 - findings.high * 12 - findings.medium * 4) : null,
    review_findings: reviewFindings,
    findings,
    touch_rate: ctx.reviewNumber > 1 && reviewText ? (() => {
      const stats = parseDeltaStats(reviewTextBeforeJudge || reviewText)
      const resolved = stats?.resolved ?? 0
      const stillOpen = stats?.still_open ?? 0
      const total = resolved + stillOpen
      return total > 0 ? Math.round((resolved / total) * 100) : null
    })() : null,
    delta: ctx.reviewNumber > 1 && reviewText ? (() => {
      const stats = parseDeltaStats(reviewTextBeforeJudge || reviewText)
      return {
        developer_replies: ctx.replies?.length ?? 0,
        resolved: stats?.resolved ?? 0,
        still_open: stats?.still_open ?? 0,
        new_findings: stats?.new_findings ?? 0,
      }
    })() : null,
    jenkins: getJenkinsMeta(),
    error,
  }
}

// ---------------------------------------------------------------------------
// File logger
// ---------------------------------------------------------------------------

export function logUsageRecord(record: UsageRecord): void {
  appendFileSync('results.jsonl', JSON.stringify(record) + '\n')
  console.log('Usage appended to results.jsonl')
}
