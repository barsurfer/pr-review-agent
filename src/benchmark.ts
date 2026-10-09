// ReviewBench benchmark mode. Never throws: any failure still writes an empty findings file, because one failed PR fails the whole run.

import { config } from './config.js'
import { review } from './review/index.js'
import { ReviewBenchAdapter, readReviewBenchEnv, readPrJson } from './vcs/reviewbench.js'
import { mergeJudgedFindings, mapFindings, buildFindingsReport, writeFindingsReport, countFindingBullets, type ReportFinding } from './review/findings-output.js'
import type { ReviewOutcome } from './review/types.js'

const CONFIG_LABELS: Record<string, (value: string) => void> = {
  MODEL: v => { config.anthropic.model = v },
  EFFORT: v => { config.review.effort = v },
  JUDGE_MODEL: v => { config.judge.model = v },
  JUDGE_EFFORT: v => { config.judge.effort = v },
}

export function applyConfigLabels(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    const key = name.match(/^RB_CONFIG_(.+)$/)?.[1]?.toUpperCase()
    if (!key || !value) continue
    const apply = CONFIG_LABELS[key]
    if (apply) apply(value)
    else console.warn(`  Ignoring unsupported config label ${name}`)
  }
}

function applyBenchmarkConfig(env: NodeJS.ProcessEnv): void {
  config.vcsProvider = 'reviewbench'
  // Branch names are placeholders and a skipped PR scores zero, so only explicit size caps apply.
  config.skipSourceBranches = []
  config.skipTargetBranches = []
  if (!env.MAX_CHANGED_FILES) config.thresholds.maxChangedFiles = 0
  if (!env.MAX_CHANGED_LINES) config.thresholds.maxChangedLines = 0
  config.review.splitCheck = false   // can_be_split has no place in the findings file
  applyConfigLabels(env)
  // The harness flags any config label whose value never appears in the agent's output.
  console.log(`Benchmark settings: model=${config.anthropic.model} effort=${config.review.effort || 'default'} judge_model=${config.judge.model || 'off'} judge_effort=${config.judge.effort || 'default'}`)
}

export async function runBenchmark(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rb = readReviewBenchEnv(env)
  const pr = readPrJson(rb.prJsonPath)
  const prNumber = rb.prNumber || String(pr.pr_number ?? '')
  let findings: ReportFinding[] = []

  try {
    applyBenchmarkConfig(env)
    const adapter = new ReviewBenchAdapter(rb)
    const outcomes: ReviewOutcome[] = []
    await review(adapter, prNumber, false, undefined, 'off', false, rb.nwo, o => { outcomes.push(o) })

    const outcome = outcomes[0]
    if (outcome) {
      const changedPaths = (await adapter.getChangedFiles(prNumber)).map(f => f.path)
      // Judged: the judge's own cited anchors plus structured recoveries for the ones it located as
      // prose (which the markdown alone drops silently). Unjudged: map the reviewer's findings.
      findings = outcome.judged
        ? mergeJudgedFindings(outcome.reviewText, outcome.review.findings, outcome.judgeScores, rb.agent, changedPaths)
        : mapFindings(outcome.review.findings, rb.agent, changedPaths)
      console.log(`Benchmark findings: reviewer ${outcome.review.findings.length}, judge kept ${outcome.judgeScores?.length ?? '—'}, line-anchored ${findings.length}`)
      if (outcome.judged) {
        // Shortfall vs both signals of intent (scored + bulleted) — findings with no usable file:line.
        const kept = Math.max(outcome.judgeScores?.length ?? 0, countFindingBullets(outcome.reviewText))
        if (kept > findings.length) console.warn(`  Parse check: judge kept ~${kept}, only ${findings.length} anchored — ${kept - findings.length} finding(s) without a usable file:line`)
      }
    } else {
      console.log('Benchmark: review skipped — writing empty findings')
    }
  } catch (err: unknown) {
    findings = []
    console.error(`Benchmark review failed — writing empty findings: ${(err as Error).message}`)
  }

  try {
    const report = buildFindingsReport({
      repo: pr.repo || `https://github.com/${rb.nwo}`,
      prNumber,
      base: rb.base || (pr.base ?? ''),
      head: rb.head || (pr.head ?? ''),
    }, rb.agent, findings)
    writeFindingsReport(rb.outPath, report)
    console.log(`Wrote ${findings.length} finding(s) to ${rb.outPath}`)
  } catch (err: unknown) {
    console.error(`Could not write findings to ${rb.outPath}: ${(err as Error).message}`)
  }
}
