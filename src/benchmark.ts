// ReviewBench benchmark mode. Never throws: any failure still writes an empty findings file, because one failed PR fails the whole run.

import { config } from './config.js'
import { review } from './review/index.js'
import { ReviewBenchAdapter, readReviewBenchEnv, readPrJson } from './vcs/reviewbench.js'
import { mergeJudgedFindingsWithStats, mapFindings, keptToReportFindings, isAnchored, anchorToFile, firstAddedLines, withCounterparts, buildFindingsReport, writeFindingsReport, countFindingBullets, type ReportFinding } from './review/findings-output.js'
import { activeLenses, parseLensList } from './review/lenses.js'
import type { ReviewOutcome, SinkResult } from './review/types.js'

// Strict 0/1: a typo like "ture" must not silently leave a flag off for a whole paid run.
const flag = (set: (on: boolean) => void) => (v: string, name: string) => {
  if (v === '0' || v === '1') set(v === '1')
  else console.warn(`  Ignoring config label ${name}=${v}: expected 0 or 1`)
}

const count = (set: (n: number) => void) => (v: string, name: string) => {
  if (/^\d+$/.test(v)) set(Number(v))
  else console.warn(`  Ignoring config label ${name}=${v}: expected a non-negative integer`)
}

// Short keys because the manifest allows only 6 configuration entries; set only labels that change the image's baked defaults (reviewbench/Dockerfile).
const CONFIG_LABELS: Record<string, (value: string, name: string) => void> = {
  MODEL: v => { config.anthropic.model = v },
  EFFORT: v => { config.review.effort = v },
  JUDGE_MODEL: v => { config.judge.model = v },
  JUDGE_EFFORT: v => { config.judge.effort = v },
  NITS: flag(on => { config.review.enableNitpicks = on }),
  J_MINOR: flag(on => { config.judge.policy.keepMinor = on }),
  J_UNVER: flag(on => { config.judge.policy.keepUnverified = on }),
  J_TGAP: flag(on => { config.judge.policy.keepTestGaps = on }),
  J_CTX: flag(on => { config.judge.fileContext = on }),
  LNUM: flag(on => { config.review.lineNumbers = on }),
  BREADTH: flag(on => { config.breadth.enabled = on }),
  B_FILES: count(n => { config.breadth.minFiles = n }),
  B_UNTCH: count(n => { config.breadth.minUntouched = n }),
  SECOND_LOOK: flag(on => { config.review.secondLook = on }),
  J_QUALITY: flag(on => { config.judge.quality = on }),
  SL_BREADTH: flag(on => { config.review.secondLookBreadthTargets = on }),
  J_SHOWN_ANCHOR: flag(on => { config.judge.shownAnchors = on }),
  B_PRIORITY: flag(on => { config.breadth.priorityTargets = on }),
  J_PROPOSAL: flag(on => { config.judge.proposals = on }),
  LENS_REC: flag(on => { config.lenses.recommend = on }),
  XROWS: flag(on => { config.benchmarkCounterpartRows = on }),
  // One value label doubles as the on/off switch because the manifest caps labels at 6.
  LENSES: (v, name) => {
    const on = parseLensList(v).lenses.length > 0
    if (!on && !/^(0|off)$/i.test(v.trim())) console.warn(`  Config label ${name}=${v} names no known lens - lenses stay off`)
    config.lenses.list = v
    config.lenses.enabled = on
  },
}

const bit = (on: boolean): string => (on ? '1' : '0')

export function applyConfigLabels(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    const key = name.match(/^RB_CONFIG_(.+)$/)?.[1]?.toUpperCase()
    if (!key || !value) continue
    const apply = CONFIG_LABELS[key]
    if (apply) apply(value, name)
    else console.warn(`  Ignoring unsupported config label ${name}`)
  }
}

function applyBenchmarkConfig(env: NodeJS.ProcessEnv): void {
  config.vcsProvider = 'reviewbench'
  // Branch names are placeholders and a skipped PR scores zero, so only explicit size caps apply.
  config.skipSourceBranches = []
  config.skipTargetBranches = []
  config.onlyTargetBranches = []
  if (!env.MAX_CHANGED_FILES) config.thresholds.maxChangedFiles = 0
  if (!env.MAX_CHANGED_LINES) config.thresholds.maxChangedLines = 0
  config.review.splitCheck = false   // can_be_split has no place in the findings file
  applyConfigLabels(env)
  // The harness flags any config label whose value never appears in the agent's output.
  // Flags print under their label keys and 0/1 values, so a label set in the UI and a baked ENABLE_* value both show up here.
  console.log(`Benchmark settings: model=${config.anthropic.model} effort=${config.review.effort || 'default'} judge_model=${config.judge.model || 'off'} judge_effort=${config.judge.effort || 'default'} nits=${bit(config.review.enableNitpicks)} j_minor=${bit(config.judge.policy.keepMinor)} j_unver=${bit(config.judge.policy.keepUnverified)} j_ctx=${bit(config.judge.fileContext)} lnum=${bit(config.review.lineNumbers)} breadth=${bit(config.breadth.enabled)} b_files=${config.breadth.minFiles} b_untch=${config.breadth.minUntouched} second_look=${bit(config.review.secondLook)} j_quality=${bit(config.judge.quality)} sl_breadth=${bit(config.review.secondLookBreadthTargets)} j_shown_anchor=${bit(config.judge.shownAnchors)} b_priority=${bit(config.breadth.priorityTargets)} sfx=${bit(config.judge.suggestedFixes)} j_proposal=${bit(config.judge.proposals)}${activeLenses(config.lenses).length ? ` lenses=${config.lenses.list}` : ''}${config.lenses.recommend ? ' lens_rec=1' : ''}${config.judge.policy.keepTestGaps ? ' j_tgap=1' : ''}${config.benchmarkCounterpartRows ? ' xrows=1' : ''}`)
  if (config.judge.proposals && !config.judge.model) console.warn('  J_PROPOSAL=1 but the judge is off - no proposals will be produced.')
  // Nitpicks emit but the default policy drops minor, so without keepMinor nothing new posts.
  if (config.review.enableNitpicks && !config.judge.policy.keepMinor) {
    console.warn('  NITS=1 but J_MINOR=0 — nitpicks are logged for offline scoring only; set J_MINOR=1 to post them.')
  }
}

export async function runBenchmark(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const rb = readReviewBenchEnv(env)
  const pr = readPrJson(rb.prJsonPath)
  const prNumber = rb.prNumber || String(pr.pr_number ?? '')
  let findings: ReportFinding[] = []

  try {
    applyBenchmarkConfig(env)
    const adapter = new ReviewBenchAdapter(rb)
    let reviewed = false
    await review(adapter, prNumber, false, undefined, 'off', false, rb.nwo, async (outcome: ReviewOutcome): Promise<SinkResult | void> => {
      reviewed = true
      const changedFiles = await adapter.getChangedFiles(prNumber)
      const changedPaths = changedFiles.map(f => f.path)
      if (outcome.judgedFindings) {
        const diff = await adapter.getDiff(prNumber)
        const placed = anchorToFile(outcome.judgedFindings, firstAddedLines(diff), changedFiles)
        let extra: { findings: ReportFinding[]; added: number } | undefined
        if (config.benchmarkCounterpartRows) {
          try {
            extra = withCounterparts(placed, changedFiles, diff, rb.agent, changedPaths)
          } catch (err: unknown) {
            console.warn(`  Counterpart rows skipped, original rows kept: ${(err as Error).message}`)
            extra = { findings: keptToReportFindings(placed, rb.agent, changedPaths), added: 0 }
          }
        }
        findings = extra ? extra.findings : keptToReportFindings(placed, rb.agent, changedPaths)
        const fileLevel = placed.filter(k => k.anchorSource === 'file')
        console.log(`Benchmark findings: reviewer ${outcome.review.findings.length}, breadth ${outcome.breadthFindings?.length ?? 0}, second-look ${outcome.secondLookFindings?.length ?? 0}${outcome.lensFindings ? `, lens ${outcome.lensFindings.length}` : ''}, judge kept ${outcome.judgedFindings.length}, line-anchored ${findings.length} (${fileLevel.length} placed on the file's first changed line)`)
        if (fileLevel.length > 0) console.log(`  File-level findings: ${fileLevel.map(k => `${k.file}:${k.lines} ${k.title}`).join(' | ')}`)
        // A kept finding without a usable file:line scores zero, so surface it instead of losing it silently.
        const unanchored = placed.filter(k => !isAnchored(k))
        if (unanchored.length > 0) console.warn(`  Parse check: ${unanchored.length} kept finding(s) with no usable file:line, dropped from findings.json: ${unanchored.map(k => k.title).join(' | ')}`)
        if (extra) return { counterpartRows: extra.added }
      } else if (outcome.judged) {
        // Bundled review re-parses each bundle's judged markdown, so it alone still needs the prose merge.
        const { findings: judged, stats: s } = mergeJudgedFindingsWithStats(outcome.reviewText, outcome.review.findings, outcome.judgeScores, rb.agent, changedPaths)
        findings = judged
        console.log(`Merge: bullets ${s.bullets} (located ${s.located}, prose ${s.prose}) | scores ${s.scores} | rows ${findings.length} = markdown ${s.rowsMarkdown} + recovered ${s.rowsRecovered} | paired-located ${s.dupOfLocated} | borrowed-text ${s.borrowed} | unpaired-scores ${s.unpairedScoreTitles.length}`)
        // A kept finding that reached no row is a silent drop — warn when it's certain, note when it's possible.
        const certain = s.unanchoredPaired + s.unscoredProse
        if (certain > 0) console.warn(`  Parse check: ${certain} kept finding(s) with no usable file:line (unanchored prose ${s.unanchoredPaired}, unscored prose ${s.unscoredProse})`)
        if (s.unanchoredUnpaired > 0) console.log(`  Note: ${s.unanchoredUnpaired} kept score(s) with no bullet and no anchor`)
        // The eye-check for the reframe double-count: an unpaired score next to an unconsumed prose bullet.
        if (s.unpairedScoreTitles.length) console.log(`  Unpaired scores: ${s.unpairedScoreTitles.join(' | ')}`)
        if (s.unconsumedBullets.length) console.log(`  Unconsumed bullets: ${s.unconsumedBullets.join(' | ')}`)
        if (countFindingBullets(outcome.reviewText) > s.bullets) console.warn(`  Parse check: judge bullets unreadable by the parser (format drift)`)
      } else {
        findings = mapFindings(outcome.review.findings, rb.agent, changedPaths)
        console.log(`Benchmark findings: reviewer ${outcome.review.findings.length}, judge skipped, line-anchored ${findings.length}`)
      }
    })
    if (!reviewed) console.log('Benchmark: review skipped — writing empty findings')
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
