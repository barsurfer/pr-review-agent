// ---------------------------------------------------------------------------
// Usage record — type, cost estimation, record builder, file logging
// ---------------------------------------------------------------------------

import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import { execSync, type ExecSyncOptions } from 'child_process'
import { createHash } from 'crypto'
import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { config } from '../config.js'
import { baseModelId } from '../llm/model-id.js'
import type { LLMUsage } from '../llm/shared.js'
import { parseVerdictScore, parseFindings, countDiffLines } from './parsers.js'
import { countFindings, normalizeIssueType } from './formatter.js'
import type { FindingScore, ReviewFinding, IssueType, Scenario, AlsoAffected } from './formatter.js'
import { isAnchored, parseLineRange, normalizeFindingPath, type AlsoAffectsLog, type FirstPassSite, type FirstPassSiteLog } from './findings-output.js'
import { candidateId, type AppliedDecision, type JudgeAnomalies } from './judge-decisions.js'
import { MAX_UNTOUCHED_LISTED, type BreadthStatus, type SecondLookStatus, type LensStatus, type CandidateOrigin } from './breadth.js'
import { activeLenses, type LensRecommendation } from './lenses.js'
import { isCheckedCommitHash } from './checked-commit.js'
import type { SuggestedFixStats } from './suggested-fix.js'
import type { ReviewContext, LensRun, EventKind, PassCall, PromptCacheLog, StageUsage } from './types.js'
import { isAgentReply } from '../vcs/adapter.js'

// 12 hex chars of sha256 — enough to tell prompt/code versions apart across runs without bloating the record.
function hash12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12)
}

function candidateRows(list: Array<ReviewFinding & { origin: CandidateOrigin }>, withType: boolean, withHi: { scenario: boolean; alsoAffects: boolean } = { scenario: false, alsoAffects: false }): NonNullable<UsageRecord['review_candidates']> {
  return list.map((f, i) => ({
    id: candidateId(i), origin: f.origin, severity: f.severity, ...(withType ? { type: f.type ? normalizeIssueType(f.type) : null } : {}), title: f.title, file: f.file ?? null, lines: f.lines ?? null, body: f.body,
    // The first-pass reviewer is never asked for these, so a value on its candidate is unsanitized model output.
    ...(withHi.scenario ? { scenario: f.origin !== 'review' ? f.scenario ?? null : null } : {}),
    ...(withHi.alsoAffects ? { also_affects: f.origin !== 'review' && Array.isArray(f.also_affects) ? f.also_affects : [] } : {}),
  }))
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
  tokens: { input: number; output: number; cache_read: number; cache_write: number; estimated_input: number; reasoning?: number }
  cost_usd: number
  judge_model: string | null
  judge_effort: string | null
  judge_tokens: StageTokens | null
  judge_cost_usd: number | null
  duration_ms: number
  dry_run: boolean
  force: string
  prompt_source: string
  prompt_lookup?: 'failed'
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
  anchored_findings: Array<{ anchor: string; severity: ReviewFinding['severity']; type: IssueType; description: string; proposal?: string; quality_action?: string }> | null
  // Candidates are stored once; judge_decisions join to them by candidate_id.
  review_candidates: Array<{ id: string; origin: CandidateOrigin; severity: ReviewFinding['severity']; type?: IssueType | null; title: string; file: string | null; lines: string | null; body: string; scenario?: Scenario | null; also_affects?: AlsoAffected[] }> | null
  unjudged_candidates?: NonNullable<UsageRecord['review_candidates']>
  judge_decisions: AppliedDecision[] | null
  judge_anomalies: JudgeAnomalies | null
  judge_policy: { keep_minor: boolean; keep_unverified: boolean; file_context: boolean; keep_test_gaps?: boolean } | null
  breadth_status: BreadthStatus | null
  breadth_model: string | null
  breadth_prompt_hash: string | null
  breadth_tokens: StageTokens | null
  breadth_cost_usd: number | null
  second_look_status: SecondLookStatus | null
  second_look_prompt_hash: string | null
  second_look_tokens: StageTokens | null
  second_look_cost_usd: number | null
  lens_runs?: Array<{ name: string; status: LensStatus; model: string; prompt_hash: string | null; tokens: StageTokens | null; cost_usd: number | null; findings: number }> | null
  lens_recommendations?: LensRecommendation[] | null
  suggested_fixes?: SuggestedFixStats | null
  counterpart_rows?: number
  also_affects_rows?: number
  also_affects?: AlsoAffectsLog[]
  pass_calls?: PassCall[]
  prompt_cache?: PromptCacheLog | null
  first_pass_sites_named?: FirstPassSite[] | null
  first_pass_sites_dropped?: ReviewContext['firstPassSitesDropped'] | null
  first_pass_site_rows?: number
  first_pass_sites?: FirstPassSiteLog[]
  untouched_files: { count: number; paths: string[]; cut: number; deprioritized?: number } | null
  recall_levers: { j_quality: boolean; sl_breadth: boolean; j_shown_anchor: boolean; b_priority: boolean; high_impact?: true; first_pass_sites?: true }
  touch_rate: number | null
  delta: { developer_replies: number; human_replies: number; agent_replies: number; resolved: number; still_open: number; new_findings: number } | null
  reply_authors?: string[]
  checked_commit?: string
  dedup_source?: 'checked_commit' | 'target_merge'
  reply_limit_note?: true
  jenkins: { job: string; build: string; url: string } | null
  trigger?: { event: string | null; comment_author: string | null; event_kind?: EventKind }
  error: { type: string; message: string; status: number | null } | null
}

// Cache fields appear only under ENABLE_PROMPT_CACHE, so every other record keeps its earlier shape.
export interface StageTokens { input: number; output: number; cache_read?: number; cache_write?: number }

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

// A cache read bills at this fraction of the input rate; a 5-minute cache write at 1.25x.
function cacheReadRate(base: string): number {
  if (/^claude-(fable|mythos)-(5-[1-9]|[6-9])/.test(base)) return 0.025
  if (base === 'claude-sonnet-5-5' || base === 'claude-opus-5-5') return 0.05
  return 0.1
}

export function estimateCost(tokens: StageTokens, model: string): number {
  return Math.round(unroundedCost(tokens, model) * 10000) / 10000 // 4 decimal places
}

// Haiku 5.5's tier is per request, so each attempt is priced alone; one that reported a cost keeps it.
export function estimateAttemptsCost(attempts: readonly LLMUsage[], model: string): number {
  const cost = attempts.reduce((sum, a) => sum + (a.cost_usd ?? unroundedCost({ input: a.input_tokens, output: a.output_tokens, cache_read: a.cache_read_input_tokens ?? 0, cache_write: a.cache_creation_input_tokens ?? 0 }, model)), 0)
  return Math.round(cost * 10000) / 10000
}

function unroundedCost(tokens: StageTokens, model: string): number {
  const base = baseModelId(model)
  const read = tokens.cache_read ?? 0
  const write = tokens.cache_write ?? 0
  // Haiku 5.5's tier counts the whole prompt, cached tokens included.
  let p = base === 'claude-haiku-5-5' ? haiku55Pricing(tokens.input + read + write) : (MODEL_PRICING[model] ?? MODEL_PRICING[base])
  if (!p) {
    console.warn(`No pricing entry for model "${model}" — estimating with claude-sonnet-4-6 rates`)
    p = MODEL_PRICING['claude-sonnet-4-6']
  }
  return read || write
    ? (tokens.input / 1_000_000) * p.input + (write / 1_000_000) * p.input * 1.25 + (read / 1_000_000) * p.input * cacheReadRate(base) + (tokens.output / 1_000_000) * p.output
    : (tokens.input / 1_000_000) * p.input + (tokens.output / 1_000_000) * p.output
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
  // This runs outside review()'s try, so a malformed object must not throw and lose the record of the run's real error.
  const reviewFindings = ctx.reviewObject && Array.isArray(ctx.reviewObject.findings) ? countFindings(ctx.reviewObject) : null
  const deltaStats = ctx.reviewObject?.delta_stats ?? null
  const judgeScores = ctx.judgeScores ?? null
  const judgeModel = config.judge.model || null
  const cache = !!config.review.promptCache
  const tok = (u: StageUsage): StageTokens => ({ input: u.input_tokens, output: u.output_tokens, ...(cache ? { cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0 } : {}) })
  const priced = (u: StageUsage, tokens: StageTokens, model: string): number => (u.attempts ? estimateAttemptsCost(u.attempts, model) : estimateCost(tokens, model))
  const judgeTokensRaw = ctx.judgeUsage ?? null
  const judgeTokens = judgeTokensRaw ? tok(judgeTokensRaw) : null
  const judgeCost = ctx.judgeUsage?.cost_usd ?? (judgeTokensRaw && judgeTokens && judgeModel ? priced(judgeTokensRaw, judgeTokens, judgeModel) : null)
  const breadthTokens = ctx.breadthUsage ? tok(ctx.breadthUsage) : null
  const breadthCost = ctx.breadthUsage?.cost_usd ?? (ctx.breadthUsage && breadthTokens && ctx.breadthModel ? priced(ctx.breadthUsage, breadthTokens, ctx.breadthModel) : null)
  // Second-look runs on the reviewer model, so its missing-actual cost is estimated at that model.
  const secondLookTokens = ctx.secondLookUsage ? tok(ctx.secondLookUsage) : null
  const secondLookCost = ctx.secondLookUsage?.cost_usd ?? (ctx.secondLookUsage && secondLookTokens ? priced(ctx.secondLookUsage, secondLookTokens, config.anthropic.model) : null)
  const lenses = activeLenses(config.lenses)
  // The bundled path never enters LENS_REVIEW, so its runs are inferred here, as breadth/second-look statuses are.
  const lensSource: LensRun[] | undefined = ctx.lensRuns ?? (ctx.bundleCount && lenses.length
    ? lenses.map(l => ({ name: l.name, status: 'skipped_bundled' as const, model: config.lenses.model || config.anthropic.model, findings: [] }))
    : undefined)
  const lensRuns = lensSource?.map(r => {
    const tokens = r.usage ? tok(r.usage) : null
    return { name: r.name, status: r.status, model: r.model, prompt_hash: r.promptHash ?? null, tokens, cost_usd: r.usage?.cost_usd ?? (r.usage && tokens ? priced(r.usage, tokens, r.model) : null), findings: r.findings.length }
  }) ?? null
  const lensUsage = (ctx.lensRuns ?? []).reduce((sum, r) => ({
    input: sum.input + (r.usage?.input_tokens ?? 0), output: sum.output + (r.usage?.output_tokens ?? 0), cost: sum.cost + (r.usage?.cost_usd ?? 0),
    cache_read: sum.cache_read + (r.usage?.cache_read_input_tokens ?? 0), cache_write: sum.cache_write + (r.usage?.cache_creation_input_tokens ?? 0),
  }), { input: 0, output: 0, cost: 0, cache_read: 0, cache_write: 0 })
  const lensCost = (lensRuns ?? []).reduce((sum, r) => sum + (r.cost_usd ?? 0), 0)
  // A reply-only run uses the reply model (REPLY_MODEL), so log + cost it at that model, not the reviewer's.
  const recordModel = ctx.action === 'REPLY' && config.reply.model ? config.reply.model : config.anthropic.model
  // Reviewer-only cost: subtract the per-stage actuals from the all-calls actual aggregate when present,
  // else estimate from the reviewer's own tokens. Summing the stages keeps the total consistent
  // with the per-stage columns even when only some calls reported an actual cost (mixed-vendor runs).
  const reviewerTokens: StageTokens = {
        input: ctx.usage.input_tokens - (judgeTokens?.input ?? 0) - (breadthTokens?.input ?? 0) - (secondLookTokens?.input ?? 0) - lensUsage.input,
        output: ctx.usage.output_tokens - (judgeTokens?.output ?? 0) - (breadthTokens?.output ?? 0) - (secondLookTokens?.output ?? 0) - lensUsage.output,
        ...(cache ? {
          cache_read: ctx.usage.cache_read - (judgeTokens?.cache_read ?? 0) - (breadthTokens?.cache_read ?? 0) - (secondLookTokens?.cache_read ?? 0) - lensUsage.cache_read,
          cache_write: ctx.usage.cache_write - (judgeTokens?.cache_write ?? 0) - (breadthTokens?.cache_write ?? 0) - (secondLookTokens?.cache_write ?? 0) - lensUsage.cache_write,
        } : {}),
      }
  const reviewCall = cache ? ctx.reviewUsage : undefined
  const reviewerCost = ctx.usage.cost_usd !== undefined
    ? ctx.usage.cost_usd - (ctx.judgeUsage?.cost_usd ?? 0) - (ctx.breadthUsage?.cost_usd ?? 0) - (ctx.secondLookUsage?.cost_usd ?? 0) - lensUsage.cost
    : reviewCall?.attempts
      ? estimateAttemptsCost(reviewCall.attempts, recordModel) + estimateCost({
          input: reviewerTokens.input - reviewCall.input_tokens, output: reviewerTokens.output - reviewCall.output_tokens,
          cache_read: (reviewerTokens.cache_read ?? 0) - (reviewCall.cache_read_input_tokens ?? 0), cache_write: (reviewerTokens.cache_write ?? 0) - (reviewCall.cache_creation_input_tokens ?? 0),
        }, recordModel)
      : estimateCost(reviewerTokens, recordModel)
  // The bundled path never enters BREADTH_REVIEW, so its status is inferred here.
  const breadthStatus = ctx.breadthStatus ?? (ctx.bundleCount ? (config.breadth.enabled ? 'skipped_bundled' : 'disabled') : null)
  const secondLookStatus = ctx.secondLookStatus ?? (ctx.bundleCount ? (config.review.secondLook ? 'skipped_bundled' : 'disabled') : null)

  const hi = !!config.review.highImpact
  const withHi = { scenario: hi, alsoAffects: hi && !!ctx.outcomeSink }
  const fpSites = !!config.review.firstPassSites

  const humanReplies = (ctx.replies ?? []).filter(r => !isAgentReply(r))
  // Id when the platform gave one, else the display name; first-seen order, distinct.
  const replyAuthors = [...new Set(humanReplies.map(r => r.authorId ?? r.author))]

  return {
    run_id: `${config.vcsProvider}-${ctx.repoSlug}-${ctx.prId}-${commitShort}`,
    timestamp: new Date().toISOString(),
    agent_version: getAgentVersion(),
    vcs: config.vcsProvider,
    workspace: config.vcsProvider === 'azure' ? config.azure.org : config.vcsProvider === 'github' ? config.github.owner : config.bitbucket.workspace,
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
    model: recordModel,
    effort: config.review.effort || null,
    tokens: {
      input: ctx.usage.input_tokens,
      output: ctx.usage.output_tokens,
      cache_read: ctx.usage.cache_read,
      cache_write: ctx.usage.cache_write,
      estimated_input: ctx.estimatedInputTokens,
      ...(ctx.usage.reasoning ? { reasoning: ctx.usage.reasoning } : {}),
    },
    cost_usd: reviewerCost + (judgeCost ?? 0) + (breadthCost ?? 0) + (secondLookCost ?? 0) + lensCost,
    judge_model: judgeModel,
    judge_effort: config.judge.effort || null,
    judge_tokens: judgeTokens,
    judge_cost_usd: judgeCost,
    duration_ms: durationMs,
    dry_run: ctx.dryRun,
    force: ctx.force,
    prompt_source: ctx.prompt?.source ?? 'none',
    ...(ctx.prompt?.lookupFailed ? { prompt_lookup: 'failed' as const } : {}),
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
            ...(k.proposal ? { proposal: k.proposal } : {}),
            ...(k.quality_action ? { quality_action: k.quality_action } : {}),
          }
        })
      : null,
    review_candidates: ctx.judgeDecisions && ctx.reviewObject
      ? candidateRows(ctx.judgeCandidates ?? ctx.reviewObject.findings.map(f => ({ ...f, origin: 'review' as const })), !!ctx.outcomeSink, withHi)
      : null,
    // Only when the judge threw and the run failed, so findings that were never judged or posted stay diagnosable.
    ...(error && ctx.judgeStatus === 'failed' && ctx.judgeCandidates ? { unjudged_candidates: candidateRows(ctx.judgeCandidates, !!ctx.outcomeSink, withHi) } : {}),
    judge_decisions: ctx.judgeDecisions ?? null,
    judge_anomalies: ctx.judgeAnomalies ?? null,
    judge_policy: judgeModel && judgeTokens
      ? { keep_minor: config.judge.policy.keepMinor, keep_unverified: config.judge.policy.keepUnverified, file_context: config.judge.fileContext, ...(config.judge.policy.keepTestGaps ? { keep_test_gaps: true } : {}) }
      : null,
    breadth_status: breadthStatus,
    breadth_model: ctx.breadthModel ?? null,
    breadth_prompt_hash: ctx.breadthPromptHash ?? null,
    breadth_tokens: breadthTokens,
    breadth_cost_usd: breadthCost,
    second_look_status: secondLookStatus,
    second_look_prompt_hash: ctx.secondLookPromptHash ?? null,
    second_look_tokens: secondLookTokens,
    second_look_cost_usd: secondLookCost,
    // Absent, not null, when lenses are off, so a lens-off record serializes byte-identical to one from before lenses existed.
    ...(lenses.length ? { lens_runs: lensRuns } : {}),
    ...(config.lenses.recommend ? { lens_recommendations: ctx.lensRecommendations ?? null } : {}),
    ...(config.judge.suggestedFixes ? { suggested_fixes: ctx.suggestedFixes ?? null } : {}),
    ...(ctx.counterpartRows !== undefined ? { counterpart_rows: ctx.counterpartRows } : {}),
    ...(ctx.alsoAffectsRows !== undefined ? { also_affects_rows: ctx.alsoAffectsRows } : {}),
    ...(ctx.alsoAffectsLog ? { also_affects: ctx.alsoAffectsLog } : {}),
    // Benchmark-only and present only with one of these settings on, so every other record keeps its earlier shape.
    ...((ctx.outcomeSink && (config.breadth.passDeadline || fpSites)) || cache ? { pass_calls: ctx.passCalls ?? [] } : {}),
    ...(cache ? { prompt_cache: ctx.promptCache ? settledPromptCache(ctx, ctx.promptCache) : null } : {}),
    ...(ctx.outcomeSink && fpSites ? { first_pass_sites_named: ctx.firstPassSitesNamed ?? null, first_pass_sites_dropped: ctx.firstPassSitesDropped ?? null } : {}),
    ...(ctx.firstPassSiteRows !== undefined ? { first_pass_site_rows: ctx.firstPassSiteRows } : {}),
    ...(ctx.firstPassSitesLog ? { first_pass_sites: ctx.firstPassSitesLog } : {}),
    untouched_files: ctx.untouchedFiles
      ? ctx.breadthPlan
        ? { count: ctx.untouchedFiles.length, paths: ctx.breadthPlan.selected, cut: ctx.breadthPlan.omitted, deprioritized: ctx.breadthPlan.deprioritizedReleaseEntries }
        : { count: ctx.untouchedFiles.length, paths: ctx.untouchedFiles.slice(0, MAX_UNTOUCHED_LISTED), cut: Math.max(0, ctx.untouchedFiles.length - MAX_UNTOUCHED_LISTED) }
      : null,
    recall_levers: { j_quality: !!config.judge.quality, sl_breadth: !!config.review.secondLookBreadthTargets, j_shown_anchor: !!config.judge.shownAnchors, b_priority: !!config.breadth.priorityTargets, ...(hi ? { high_impact: true as const } : {}), ...(ctx.outcomeSink && fpSites ? { first_pass_sites: true as const } : {}) },
    touch_rate: ctx.reviewNumber > 1 && deltaStats ? (() => {
      const total = deltaStats.resolved + deltaStats.still_open
      return total > 0 ? Math.round((deltaStats.resolved / total) * 100) : null
    })() : null,
    delta: ctx.reviewNumber > 1 && ctx.reviewObject ? {
      developer_replies: ctx.replies?.length ?? 0,
      human_replies: humanReplies.length,
      agent_replies: (ctx.replies?.length ?? 0) - humanReplies.length,
      resolved: deltaStats?.resolved ?? 0,
      still_open: deltaStats?.still_open ?? 0,
      new_findings: deltaStats?.new_findings ?? 0,
    } : null,
    // Absent when no human replied, so records without discussion keep their current shape.
    ...(replyAuthors.length ? { reply_authors: replyAuthors } : {}),
    // Present only when the head was really checked and the run did not fail afterwards; CI stores exactly this value, so it must pass the LAST_CHECKED_COMMIT rule too, whatever head the adapter reported.
    ...(ctx.headChecked && !error && isCheckedCommitHash(ctx.prInfo!.sourceCommit) ? { checked_commit: ctx.prInfo!.sourceCommit } : {}),
    ...(ctx.dedupHit ? { dedup_source: ctx.dedupHit } : {}),
    ...(ctx.replyLimitNote ? { reply_limit_note: true as const } : {}),
    jenkins: getJenkinsMeta(),
    // Absent when CI passed no trigger, so those records serialize exactly as before.
    ...(ctx.trigger ? { trigger: { event: ctx.trigger.event || null, comment_author: ctx.trigger.commentAuthor || null, ...(ctx.trigger.kind ? { event_kind: ctx.trigger.kind } : {}) } } : {}),
    error,
  }
}

// Findings-dependent gates run after the reviewer wrote the cache, so a planned pass that then skipped (or was never reached) is moved out of shared_stages.
function settledPromptCache(ctx: ReviewContext, log: PromptCacheLog): PromptCacheLog {
  const statusOf = (stage: string): string | undefined =>
    stage === 'breadth' ? ctx.breadthStatus : stage === 'second_look' ? ctx.secondLookStatus : ctx.lensRuns?.find(r => `lens:${r.name}` === stage)?.status
  const skipped = log.shared_stages.map(stage => ({ stage, status: statusOf(stage) ?? 'not_reached' })).filter(s => s.status === 'not_reached' || s.status.startsWith('skipped_'))
  if (!skipped.length) return log
  return {
    ...log,
    shared_stages: log.shared_stages.filter(stage => !skipped.some(s => s.stage === stage)),
    uncached: [...log.uncached, ...skipped.map(s => ({ stage: s.stage, reason: `skipped_after_plan: ${s.status}` as const }))],
  }
}

// ---------------------------------------------------------------------------
// File logger
// ---------------------------------------------------------------------------

export function logUsageRecord(record: UsageRecord): void {
  const line = JSON.stringify(record) + '\n'
  appendFileSync('results.jsonl', line)
  console.log('Usage appended to results.jsonl')
  if (!config.usageRecordFile) return
  // Overwritten, not appended, so CI reads this run's record alone without matching on Jenkins env vars.
  try {
    writeFileSync(config.usageRecordFile, line)
  } catch (err: unknown) {
    console.warn(`Warning: could not write USAGE_RECORD_FILE "${config.usageRecordFile}": ${(err as Error).message}`)
  }
}
