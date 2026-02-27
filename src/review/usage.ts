// ---------------------------------------------------------------------------
// Usage record — type, cost estimation, record builder, file logging
// ---------------------------------------------------------------------------

import { appendFileSync, readFileSync } from 'fs'
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
  review_number: number
  action: string
  skip_reason: string | null
  model: string
  tokens: { input: number; output: number; cache_read: number; cache_write: number; estimated_input: number }
  cost_usd: number
  duration_ms: number
  dry_run: boolean
  force: boolean
  prompt_source: string
  verdict_score: number | null
  findings: { high: number; medium: number; low: number } | null
  delta: { developer_replies: number; resolved: number; still_open: number; new_findings: number } | null
  error: { type: string; message: string; status: number | null } | null
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
}

export function estimateCost(tokens: { input: number; output: number }, model: string): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING['claude-sonnet-4-6']
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
  const verdictScore = reviewText ? parseVerdictScore(reviewText) : null
  const findings = reviewText ? parseFindings(reviewText) : null

  return {
    run_id: `${config.vcsProvider}-${ctx.repoSlug}-${ctx.prId}-${commitShort}`,
    timestamp: new Date().toISOString(),
    agent_version: getAgentVersion(),
    vcs: config.vcsProvider,
    workspace: config.bitbucket.workspace,
    repo_slug: ctx.repoSlug,
    pr_id: ctx.prId,
    pr_author: ctx.prInfo?.author ?? 'unknown',
    source_commit: ctx.prInfo?.sourceCommit ?? 'unknown',
    source_branch: ctx.prInfo?.sourceBranch ?? 'unknown',
    target_branch: ctx.prInfo?.targetBranch ?? 'unknown',
    changed_files: ctx.changedFiles?.length ?? 0,
    changed_lines: ctx.lineCount ?? 0,
    context_files_fetched: ctx.fileContexts?.length ?? 0,
    review_number: ctx.reviewNumber,
    action: ctx.action,
    skip_reason: ctx.skipReason ?? null,
    model: config.anthropic.model,
    tokens: {
      input: ctx.usage.input_tokens,
      output: ctx.usage.output_tokens,
      cache_read: 0,
      cache_write: 0,
      estimated_input: ctx.estimatedInputTokens,
    },
    cost_usd: estimateCost({ input: ctx.usage.input_tokens, output: ctx.usage.output_tokens }, config.anthropic.model),
    duration_ms: durationMs,
    dry_run: ctx.dryRun,
    force: ctx.force,
    prompt_source: ctx.prompt?.source ?? 'none',
    verdict_score: verdictScore,
    findings,
    delta: ctx.reviewNumber > 1 && reviewText ? (() => {
      const stats = parseDeltaStats(reviewText)
      return {
        developer_replies: ctx.replies?.length ?? 0,
        resolved: stats?.resolved ?? 0,
        still_open: stats?.still_open ?? 0,
        new_findings: stats?.new_findings ?? 0,
      }
    })() : null,
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
