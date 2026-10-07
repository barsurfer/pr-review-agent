// ---------------------------------------------------------------------------
// Bundled review — map (reviewer + judge per bundle) then reduce (merge + dedupe)
// ---------------------------------------------------------------------------

import { config } from '../config.js'
import { fetchContext, type FileContext } from '../context/fetcher.js'
import { runReview, runJudge } from '../claude/client.js'
import { planBundles, splitDiffByFile, estimateTokens as tok } from './bundler.js'
import { parseReviewMarkdown, mergeReviews, type BundleReview } from './aggregate.js'
import { countFindings, isNoChange } from './formatter.js'
import type { ReviewContext } from './types.js'

// The chars/4 estimate under-counts code-heavy diffs; packing to 85% keeps real usage under the cap.
const FIT_RATIO = 0.85
// Below this share of the budget a bundle would hold almost no diff, so the fixed overhead (prompt, history) is the problem.
const MIN_DIFF_SHARE = 0.1
const BUNDLE_NOTE_RESERVE_CHARS = 1500

export type BundledOutcome = { ok: true } | { ok: false; reason: string }

export async function runBundledReview(ctx: ReviewContext, maxInputTokens: number): Promise<BundledOutcome> {
  const prInfo = ctx.prInfo!
  const hist = [...(ctx.previousReviews ?? []), ...(ctx.replies ?? [])].reduce((n, r) => n + r.body.length, 0)
  const fixed = tok(ctx.prompt!.content.length + BUNDLE_NOTE_RESERVE_CHARS + prInfo.title.length + (prInfo.description?.length ?? 0) + hist)
  const target = Math.floor(maxInputTokens * FIT_RATIO)
  const diffBudget = target - fixed
  if (diffBudget < maxInputTokens * MIN_DIFF_SHARE) {
    return { ok: false, reason: `Fixed prompt/history overhead (~${fixed.toLocaleString()} tokens) leaves no room for diff within the input budget (${maxInputTokens.toLocaleString()})` }
  }

  const diffByFile = splitDiffByFile(ctx.filteredDiff!)
  const deltaByFile = ctx.deltaDiff ? splitDiffByFile(ctx.deltaDiff) : new Map<string, string>()
  const units = [...diffByFile].map(([path, text]) => ({ path, tokens: tok(text.length + (deltaByFile.get(path)?.length ?? 0)) }))
  const plan = planBundles(units, diffBudget)

  if (!plan.bundles.length) return { ok: false, reason: 'No file fits a single bundle within the input budget' }
  const maxBundles = config.review.maxBundles
  if (maxBundles > 0 && plan.bundles.length > maxBundles) {
    return { ok: false, reason: `Needs ${plan.bundles.length} bundles, exceeds MAX_BUNDLES (${maxBundles})` }
  }
  console.log(`  Bundled review: ${plan.bundles.length} bundle(s), ${plan.oversized.length} oversized file(s) unreviewed (budget ~${diffBudget.toLocaleString()} tokens of diff each)`)

  const reviews: BundleReview[] = []
  const judgeScores: NonNullable<ReviewContext['judgeScores']> = []
  const judgeUsage = { input_tokens: 0, output_tokens: 0 }
  let judged = false
  const deltaStats = { resolved: 0, still_open: 0, new_findings: 0 }
  let sawDelta = false

  for (const [i, bundle] of plan.bundles.entries()) {
    console.log(`\nBundle ${i + 1}/${plan.bundles.length}: ${bundle.label} (~${bundle.tokens.toLocaleString()} tokens)`)
    const inBundle = new Set(bundle.files)
    const diff = bundle.files.map(f => diffByFile.get(f)).join('')
    const delta = ctx.deltaDiff ? bundle.files.map(f => deltaByFile.get(f) ?? '').join('') : ''

    let room = target - fixed - bundle.tokens
    const contexts: FileContext[] = []
    if (room > 0) {
      const fetched = await fetchContext(ctx.adapter, ctx.changedFiles!.filter(f => inBundle.has(f.path)), prInfo.sourceCommit, diff, config.context.maxFiles, config.context.maxFileLines)
      for (const c of fetched) {
        const t = tok(c.content.length)
        if (t > room) continue
        contexts.push(c)
        room -= t
      }
    }

    let content = ctx.prompt!.content
    if (config.review.maxFindings > 0) {
      content += `\n\n## FINDINGS LIMIT\nReport at most ${config.review.maxFindings} findings, prioritized by severity and impact. If more exist, include only the most important and omit the rest.`
    }
    content += `\n\n## BUNDLED REVIEW\nThis PR is too large for one pass. You are reviewing bundle ${i + 1} of ${plan.bundles.length}; the diff contains only: ${bundle.files.slice(0, 40).join(', ')}${bundle.files.length > 40 ? ', ...' : ''}. Review only these files and do not flag code you cannot see. Leave \`can_be_split\` empty.`

    const result = await runReview(
      config.anthropic.apiKey, config.anthropic.model, config.anthropic.maxRetries, config.anthropic.maxTokens, config.review.effort,
      prInfo, diff, contexts, { ...ctx.prompt!, content }, ctx.previousReviews ?? [], ctx.replies ?? [], delta,
    )
    addUsage(ctx, result.usage)
    if (result.review?.no_change || isNoChange(result.text)) {
      console.log('  Reviewer: NO_CHANGE for this bundle')
      continue
    }
    if (result.review?.delta_stats) {
      sawDelta = true
      deltaStats.resolved += result.review.delta_stats.resolved
      deltaStats.still_open += result.review.delta_stats.still_open
      deltaStats.new_findings += result.review.delta_stats.new_findings
    }

    let text = result.text
    const found = result.review ? countFindings(result.review) : { high: 0, medium: 0, low: 0 }
    console.log(`  Reviewer findings: ${found.high}H / ${found.medium}M / ${found.low}L`)
    if (config.judge.model && found.high + found.medium + found.low > 0) {
      const verdict = await runJudge(config.anthropic.apiKey, config.judge.model, config.judge.maxRetries, config.anthropic.maxTokens, config.judge.effort, diff, text)
      addUsage(ctx, verdict.usage)
      judgeUsage.input_tokens += verdict.usage.input_tokens
      judgeUsage.output_tokens += verdict.usage.output_tokens
      judgeScores.push(...(verdict.scores ?? []))
      text = verdict.text
      judged = true
    }
    reviews.push({ label: bundle.label, parsed: parseReviewMarkdown(text) })
  }

  if (!reviews.length) {
    ctx.reviewText = 'NO_CHANGE'
    return { ok: true }
  }

  const merged = mergeReviews(reviews, plan.oversized.map(u => u.path))
  ctx.reviewText = merged.markdown
  ctx.reviewObject = sawDelta ? { ...merged.object, delta_stats: deltaStats } : merged.object
  ctx.bundleCount = plan.bundles.length
  if (judged) {
    ctx.judgeUsage = judgeUsage
    ctx.judgeScores = judgeScores
  }
  console.log(`\nMerged ${reviews.length} bundle review(s): ${merged.object.findings.length} finding(s) after dedupe`)
  return { ok: true }
}

function addUsage(ctx: ReviewContext, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): void {
  ctx.usage.input_tokens += u.input_tokens
  ctx.usage.output_tokens += u.output_tokens
  ctx.usage.cache_read += u.cache_read_input_tokens ?? 0
  ctx.usage.cache_write += u.cache_creation_input_tokens ?? 0
}
