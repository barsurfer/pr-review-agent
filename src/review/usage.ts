// ---------------------------------------------------------------------------
// Usage record — type, cost estimation, record builder, file logging
// ---------------------------------------------------------------------------

import { appendFileSync, readFileSync } from 'fs'
import { execSync, type ExecSyncOptions } from 'child_process'
import { createHash } from 'crypto'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'
import { parseVerdictScore, parseFindings, countDiffLines } from './parsers.js'
import { countFindings, normalizeIssueType } from './formatter.js'
import type { FindingScore, ReviewFinding, IssueType } from './formatter.js'
import { isAnchored, parseLineRange, normalizeFindingPath } from './findings-output.js'
import { candidateId, type AppliedDecision, type JudgeAnomalies } from './judge-decisions.js'
import { MAX_UNTOUCHED_LISTED, type BreadthStatus, type CandidateOrigin } from './breadth.js'
import type { ReviewContext } from './types.js'

// 12 hex chars of sha256 — enough to tell prompt/code versions apart across runs without bloating the record.
function hash12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

function firstSentence(body: string): string {
  const s = body.trim()
  return (s.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? s).trim()
}

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
  // PR size for slicing results: raw diff, and the reviewable part after DIFF_EXCLUDE_PATTERNS.
  diff_size: {
    files: { added: number; modified: number; deleted: number; renamed: number }
    lines_added: number
    lines_removed: number
    reviewable_files: number
    reviewable_lines_added: number
    reviewable_lines_removed: number
  } | null
  context_files_fetched: number
  degraded: boolean
  review_number: number
  action: string
  skip_reason: string | null
  model: string
  effort: string | null
  tokens: { input: number; output: number; cache_read: number; cache_write: number; estimated_input: number }
  cost_usd: number
  judge_model: string | null
  judge_effort: string | null
  judge_tokens: { input: number; output: number } | null
  judge_cost_usd: number | null
  duration_ms: number
  dry_run: boolean
  force: string
  prompt_source: string
  agent_commit: string
  prompt_hash: string | null
  judge_prompt_hash: string | null
  judge_status: 'disabled' | 'skipped_no_findings' | 'succeeded' | 'failed' | null
  verdict_score: number | null
  computed_score: number | null
  review_findings: { high: number; medium: number; low: number } | null
  findings: { high: number; medium: number; low: number } | null
  finding_scores: FindingScore[] | null
  min_finding_score: number | null
  // One compact read-only row per anchored kept finding; null when the structured judge didn't run.
  anchored_findings: Array<{ anchor: string; severity: ReviewFinding['severity']; type: IssueType; description: string }> | null
  // Candidates are stored once; judge_decisions join to them by candidate_id.
  review_candidates: Array<{ id: string; origin: CandidateOrigin; severity: ReviewFinding['severity']; title: string; file: string | null; lines: string | null; body: string }> | null
  judge_decisions: AppliedDecision[] | null
  judge_anomalies: JudgeAnomalies | null
  judge_policy: { keep_minor: boolean; keep_unverified: boolean; file_context: boolean } | null
  breadth_status: BreadthStatus | null
  breadth_model: string | null
  breadth_prompt_hash: string | null
  breadth_tokens: { input: number; output: number } | null
  breadth_cost_usd: number | null
  untouched_files: { count: number; paths: string[]; cut: number } | null
  touch_rate: number | null
  delta: { developer_replies: number; resolved: number; still_open: number; new_findings: number } | null
  jenkins: { job: string; build: string; url: string } | null
  error: { type: string; message: string; status: number | null } | null
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

// $/1M tokens (input·output) per Anthropic's published rates; unknown models fall back below.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10.0, output: 50.0 },
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'claude-mythos-5-1': { input: 10.0, output: 50.0 },
  'claude-mythos-5': { input: 10.0, output: 50.0 },
  'claude-opus-5-5': { input: 4.0, output: 20.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  'claude-opus-4-6': { input: 5.0, output: 25.0 },
  'claude-opus-4-5': { input: 5.0, output: 25.0 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
}

// Haiku 5.5 is the one model priced by prompt length — 5x higher once the input prompt passes 100k tokens.
function haiku55Pricing(inputTokens: number): { input: number; output: number } {
  return inputTokens > 100_000 ? { input: 0.5, output: 2.5 } : { input: 0.1, output: 0.5 }
}

export function estimateCost(tokens: { input: number; output: number }, model: string): number {
  // Dated IDs (claude-haiku-4-5-20251001) price as their alias
  const base = model.replace(/-\d{8}$/, '')
  let p = base === 'claude-haiku-5-5' ? haiku55Pricing(tokens.input) : (MODEL_PRICING[model] ?? MODEL_PRICING[base])
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
  // Final findings + verdict come from the posted text: the judge rewrites the reviewer's
  // markdown (dropping/downgrading findings, adding Merge Confidence), so its output is the
  // source. Reviewer-side metrics below read the typed object instead of regex.
  const verdictScore = reviewText ? parseVerdictScore(reviewText) : null
  const findings = reviewText ? parseFindings(reviewText) : null
  const reviewFindings = ctx.reviewObject ? countFindings(ctx.reviewObject) : null
  const deltaStats = ctx.reviewObject?.delta_stats ?? null
  const judgeScores = ctx.judgeScores ?? null
  const judgeModel = config.judge.model || null
  const judgeTokensRaw = ctx.judgeUsage ?? null
  const judgeTokens = judgeTokensRaw ? { input: judgeTokensRaw.input_tokens, output: judgeTokensRaw.output_tokens } : null
  const judgeCost = ctx.judgeUsage?.cost_usd ?? (judgeTokens && judgeModel ? estimateCost(judgeTokens, judgeModel) : null)
  const breadthTokens = ctx.breadthUsage ? { input: ctx.breadthUsage.input_tokens, output: ctx.breadthUsage.output_tokens } : null
  const breadthCost = ctx.breadthUsage?.cost_usd ?? (breadthTokens && ctx.breadthModel ? estimateCost(breadthTokens, ctx.breadthModel) : null)
  // The bundled path never enters BREADTH_REVIEW, so its status is inferred here.
  const breadthStatus = ctx.breadthStatus ?? (ctx.bundleCount ? (config.breadth.enabled ? 'skipped_bundled' : 'disabled') : null)

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
    diff_size: ctx.diff !== undefined ? (() => {
      const raw = countDiffLines(ctx.diff)
      const reviewable = countDiffLines(ctx.filteredDiff ?? '')
      const files = { added: 0, modified: 0, deleted: 0, renamed: 0 }
      for (const f of ctx.changedFiles ?? []) files[f.status]++
      return {
        files, lines_added: raw.added, lines_removed: raw.removed,
        reviewable_files: ctx.reviewableFileCount ?? 0,
        reviewable_lines_added: reviewable.added, reviewable_lines_removed: reviewable.removed,
      }
    })() : null,
    context_files_fetched: ctx.fileContexts?.length ?? 0,
    degraded: ctx.degraded ?? false,
    review_number: ctx.reviewNumber,
    action: ctx.action,
    skip_reason: ctx.skipReason ?? null,
    model: config.anthropic.model,
    effort: config.review.effort || null,
    tokens: {
      input: ctx.usage.input_tokens,
      output: ctx.usage.output_tokens,
      cache_read: ctx.usage.cache_read,
      cache_write: ctx.usage.cache_write,
      estimated_input: ctx.estimatedInputTokens,
    },
    // Provider-reported total (OpenRouter) when present — it already sums reviewer + judge + breadth;
    // otherwise estimate the reviewer portion from the pricing table and add the judge/breadth costs.
    cost_usd: ctx.usage.cost_usd ?? (estimateCost({
      input: ctx.usage.input_tokens - (judgeTokens?.input ?? 0) - (breadthTokens?.input ?? 0),
      output: ctx.usage.output_tokens - (judgeTokens?.output ?? 0) - (breadthTokens?.output ?? 0),
    }, config.anthropic.model) + (judgeCost ?? 0) + (breadthCost ?? 0)),
    judge_model: judgeModel,
    judge_effort: config.judge.effort || null,
    judge_tokens: judgeTokens,
    judge_cost_usd: judgeCost,
    duration_ms: durationMs,
    dry_run: ctx.dryRun,
    force: ctx.force,
    prompt_source: ctx.prompt?.source ?? 'none',
    agent_commit: getBuildCommit(),
    prompt_hash: ctx.prompt ? hash12(ctx.prompt.content) : null,
    judge_prompt_hash: ctx.judgePromptHash ?? null,
    judge_status: ctx.judgeStatus ?? null,
    verdict_score: verdictScore,
    computed_score: findings ? Math.max(0, 100 - findings.high * 12 - findings.medium * 4) : null,
    review_findings: reviewFindings,
    findings,
    finding_scores: judgeScores,
    min_finding_score: judgeScores?.length ? Math.min(...judgeScores.map(s => s.score)) : null,
    anchored_findings: ctx.judgedFindings
      ? ctx.judgedFindings.filter(isAnchored).map(k => {
          const r = parseLineRange(k.lines)!
          const file = normalizeFindingPath(k.file, ctx.changedFiles?.map(f => f.path) ?? [])
          return {
            anchor: r.start === r.end ? `${file}:${r.start}` : `${file}:${r.start}-${r.end}`,
            severity: k.severity, type: normalizeIssueType(k.type), description: firstSentence(k.body),
          }
        })
      : null,
    review_candidates: ctx.judgeDecisions && ctx.reviewObject
      ? (ctx.judgeCandidates ?? ctx.reviewObject.findings.map(f => ({ ...f, origin: 'review' as const })))
          .map((f, i) => ({ id: candidateId(i), origin: f.origin, severity: f.severity, title: f.title, file: f.file ?? null, lines: f.lines ?? null, body: f.body }))
      : null,
    judge_decisions: ctx.judgeDecisions ?? null,
    judge_anomalies: ctx.judgeAnomalies ?? null,
    judge_policy: judgeModel && judgeTokens
      ? { keep_minor: config.judge.policy.keepMinor, keep_unverified: config.judge.policy.keepUnverified, file_context: config.judge.fileContext }
      : null,
    breadth_status: breadthStatus,
    breadth_model: ctx.breadthModel ?? null,
    breadth_prompt_hash: ctx.breadthPromptHash ?? null,
    breadth_tokens: breadthTokens,
    breadth_cost_usd: breadthCost,
    untouched_files: ctx.untouchedFiles
      ? { count: ctx.untouchedFiles.length, paths: ctx.untouchedFiles.slice(0, MAX_UNTOUCHED_LISTED), cut: Math.max(0, ctx.untouchedFiles.length - MAX_UNTOUCHED_LISTED) }
      : null,
    touch_rate: ctx.reviewNumber > 1 && deltaStats ? (() => {
      const total = deltaStats.resolved + deltaStats.still_open
      return total > 0 ? Math.round((deltaStats.resolved / total) * 100) : null
    })() : null,
    delta: ctx.reviewNumber > 1 && ctx.reviewObject ? {
      developer_replies: ctx.replies?.length ?? 0,
      resolved: deltaStats?.resolved ?? 0,
      still_open: deltaStats?.still_open ?? 0,
      new_findings: deltaStats?.new_findings ?? 0,
    } : null,
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
