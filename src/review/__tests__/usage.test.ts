import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import type { ReviewContext } from '../types.js'
import type { KeptFinding } from '../findings-output.js'

// usage.ts pulls in config (required ANTHROPIC_API_KEY) at import — set it before the dynamic import.
let estimateCost: (tokens: { input: number; output: number }, model: string) => number
let buildUsageRecord: (typeof import('../usage.js'))['buildUsageRecord']
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;({ estimateCost, buildUsageRecord } = await import('../usage.js'))
})

describe('estimateCost', () => {
  it('prices current models per published $/MTok rates', () => {
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'claude-opus-5-5')).toBe(4)
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'claude-sonnet-5-5')).toBe(2)
    expect(estimateCost({ input: 0, output: 1_000_000 }, 'claude-sonnet-5')).toBe(10)
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'claude-fable-5-1')).toBe(10)
  })

  it('prices a dated model id as its alias', () => {
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'claude-haiku-4-5-20251001')).toBe(1)
  })

  it('prices Haiku 5.5 by prompt length (5x over 100k input tokens)', () => {
    expect(estimateCost({ input: 50_000, output: 0 }, 'claude-haiku-5-5')).toBe(0.005)  // ≤100k → $0.10/MTok
    expect(estimateCost({ input: 200_000, output: 0 }, 'claude-haiku-5-5')).toBe(0.1)   // >100k → $0.50/MTok
    expect(estimateCost({ input: 0, output: 1_000_000 }, 'claude-haiku-5-5')).toBe(0.5) // ≤100k output rate
  })

  it('falls back to sonnet-4-6 rates for an unknown model', () => {
    expect(estimateCost({ input: 1_000_000, output: 0 }, 'mystery-model')).toBe(3)
  })
})

describe('buildUsageRecord provenance fields', () => {
  const baseCtx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)

  it('records PR size: files by status and raw vs reviewable added/removed lines; null before the diff is fetched', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-x\n+y\n+z\ndiff --git a/l.json b/l.json\n--- a/l.json\n+++ b/l.json\n@@ -1 +1 @@\n-1\n+2'
    const r = buildUsageRecord(baseCtx({
      diff, filteredDiff: diff.split('diff --git a/l.json')[0], reviewableFileCount: 1,
      changedFiles: [{ path: 'a.ts', status: 'modified' }, { path: 'l.json', status: 'added' }],
    }), 1, null)
    expect(r.diff_size).toEqual({
      files: { added: 1, modified: 1, deleted: 0, renamed: 0 },
      lines_added: 3, lines_removed: 2, reviewable_files: 1, reviewable_lines_added: 2, reviewable_lines_removed: 1,
    })
    expect(buildUsageRecord(baseCtx(), 1, null).diff_size).toBeNull()
  })

  it('stamps agent_commit + a 12-hex prompt_hash and passes judge_prompt_hash from ctx', () => {
    const r = buildUsageRecord(baseCtx({ prompt: { content: 'SYS', source: 'repo' } as never, judgePromptHash: 'abc123def456' }), 100, null)
    expect(r.agent_commit).toBeTruthy()
    expect(r.prompt_hash).toMatch(/^[0-9a-f]{12}$/)
    expect(r.judge_prompt_hash).toBe('abc123def456')
  })

  it('judge_prompt_hash is null when the judge did not run', () => {
    expect(buildUsageRecord(baseCtx(), 1, null).judge_prompt_hash).toBeNull()
  })

  it('prompt_hash is null without a loaded prompt and stable for identical content', () => {
    expect(buildUsageRecord(baseCtx(), 1, null).prompt_hash).toBeNull()
    const p = { content: 'X', source: 'repo' } as never
    expect(buildUsageRecord(baseCtx({ prompt: p }), 1, null).prompt_hash)
      .toBe(buildUsageRecord(baseCtx({ prompt: p }), 1, null).prompt_hash)
  })

  it('passes judge_status through, null when the judge stage was not reached', () => {
    expect(buildUsageRecord(baseCtx({ judgeStatus: 'succeeded' }), 1, null).judge_status).toBe('succeeded')
    expect(buildUsageRecord(baseCtx(), 1, null).judge_status).toBeNull()
  })
})

describe('buildUsageRecord judge decision fields', () => {
  const baseCtx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)

  const reviewObject = {
    summary: 's',
    findings: [
      { severity: 'HIGH', title: 'Race', file: 'a.ts', lines: '3-4', body: 'racy' },
      { severity: 'LOW', title: 'Naming', body: 'rename' },
    ],
    behavioral_diff: [], production_risk: [], unresolved_questions: [],
  }
  const judgeDecisions = [
    { candidate_id: 'c0', reason_category: 'unconfirmed_high', reclassified_from: null, action: 'downgrade', original_severity: 'HIGH', final_severity: 'MEDIUM', score: 7, evidence: 'a.ts:3', note: 'n', rewritten: false, anchor_source: 'reviewer', anchor_file: 'a.ts', anchor_lines: '3-4' },
    { candidate_id: 'c1', reason_category: 'style_only', reclassified_from: null, action: 'drop', original_severity: 'LOW', final_severity: null, score: 2, evidence: '', note: 'n', rewritten: false, anchor_source: null, anchor_file: null, anchor_lines: null },
  ]
  const judgeAnomalies = { unknown_ids: 0, undecided: 1, duplicate_ids: 0, drop_without_evidence: 2 }
  const judged = (over: Partial<ReviewContext> = {}) => baseCtx({
    reviewObject, judgeDecisions, judgeAnomalies, judgeUsage: { input_tokens: 4, output_tokens: 2 }, judgeStatus: 'succeeded', ...over,
  } as Partial<ReviewContext>)

  let cfg: { judge: { model: string; policy: { keepMinor: boolean; keepUnverified: boolean }; fileContext: boolean } }
  let saved: typeof cfg.judge
  beforeAll(async () => { cfg = (await import('../../config.js')).config as unknown as typeof cfg })
  beforeEach(() => { saved = { ...cfg.judge, policy: { ...cfg.judge.policy } }; cfg.judge.model = 'claude-sonnet-5' })
  afterEach(() => { Object.assign(cfg.judge, saved) })

  it('logs candidates once with ids, and the decisions, anomalies and policy that produced the posted review', () => {
    cfg.judge.policy = { keepMinor: true, keepUnverified: false }
    cfg.judge.fileContext = true

    const r = buildUsageRecord(judged(), 1, null)

    expect(r.review_candidates).toEqual([
      { id: 'c0', origin: 'review', severity: 'HIGH', title: 'Race', file: 'a.ts', lines: '3-4', body: 'racy' },
      { id: 'c1', origin: 'review', severity: 'LOW', title: 'Naming', file: null, lines: null, body: 'rename' },
    ])
    expect(r.judge_decisions).toEqual(judgeDecisions)
    expect(r.judge_anomalies).toEqual(judgeAnomalies)
    expect(r.judge_policy).toEqual({ keep_minor: true, keep_unverified: false, file_context: true })
  })

  it('leaves every decision field null when the judge never ran or failed', () => {
    for (const judgeStatus of ['disabled', 'skipped_no_findings', 'failed'] as const) {
      const r = buildUsageRecord(baseCtx({ reviewObject, judgeStatus } as Partial<ReviewContext>), 1, null)
      expect([r.review_candidates, r.judge_decisions, r.judge_anomalies, r.judge_policy]).toEqual([null, null, null, null])
    }
  })

  it('logs no policy when the judge is configured off', () => {
    cfg.judge.model = ''
    expect(buildUsageRecord(judged(), 1, null).judge_policy).toBeNull()
  })

  it('logs the policy but no per-candidate decisions for a bundled run, which does not persist them', () => {
    const r = buildUsageRecord(baseCtx({ reviewObject, judgeUsage: { input_tokens: 4, output_tokens: 2 } } as Partial<ReviewContext>), 1, null)
    expect([r.review_candidates, r.judge_decisions, r.judge_anomalies]).toEqual([null, null, null])
    expect(r.judge_policy).toEqual({ keep_minor: false, keep_unverified: false, file_context: false })
  })
})

describe('buildUsageRecord anchored_findings', () => {
  const baseCtx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)

  const judgedFindings: KeptFinding[] = [
    { severity: 'HIGH', title: 'Race', body: 'get/put race. Also more detail.', file: 'pool.ts', lines: '2-3', score: 9, type: 'correctness', anchorSource: 'reviewer' },
    { severity: 'LOW', title: 'Naming', body: 'rename x', anchorSource: 'none' },
    { severity: 'MEDIUM', title: 'Slow', body: 'O(n^2) scan on each put', file: 'src/pool.ts', lines: '4', score: 6, anchorSource: 'diff' },
  ]

  it('projects one normalized row per anchored kept finding and drops the unanchored one', () => {
    const r = buildUsageRecord(baseCtx({ judgedFindings, changedFiles: [{ path: 'src/pool.ts', status: 'modified' }] } as Partial<ReviewContext>), 1, null)
    expect(r.anchored_findings).toEqual([
      { anchor: 'src/pool.ts:2-3', severity: 'HIGH', type: 'correctness', description: 'get/put race.' },
      { anchor: 'src/pool.ts:4', severity: 'MEDIUM', type: 'other', description: 'O(n^2) scan on each put' },
    ])
  })

  it('is null when the structured judge produced no kept findings (bundled or no judge)', () => {
    expect(buildUsageRecord(baseCtx(), 1, null).anchored_findings).toBeNull()
  })
})

describe('buildUsageRecord breadth fields', () => {
  const baseCtx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 3_000, output_tokens: 1_000, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)
  let cfg: { anthropic: { model: string }; judge: { model: string }; breadth: { enabled: boolean } }
  let saved: { model: string; judge: string; enabled: boolean }
  beforeAll(async () => { cfg = (await import('../../config.js')).config as unknown as typeof cfg })
  beforeEach(() => {
    saved = { model: cfg.anthropic.model, judge: cfg.judge.model, enabled: cfg.breadth.enabled }
    cfg.anthropic.model = 'claude-sonnet-5-5'; cfg.judge.model = 'claude-haiku-5-5'
  })
  afterEach(() => { cfg.anthropic.model = saved.model; cfg.judge.model = saved.judge; cfg.breadth.enabled = saved.enabled })

  it('prices breadth tokens at the breadth model and keeps them out of the reviewer bucket', () => {
    const r = buildUsageRecord(baseCtx({
      judgeUsage: { input_tokens: 1_000, output_tokens: 200 },
      breadthUsage: { input_tokens: 1_000, output_tokens: 300 }, breadthModel: 'claude-haiku-5-5', breadthStatus: 'succeeded',
    }), 1, null)
    const reviewer = estimateCost({ input: 1_000, output: 500 }, 'claude-sonnet-5-5')
    expect(r.breadth_cost_usd).toBe(estimateCost({ input: 1_000, output: 300 }, 'claude-haiku-5-5'))
    expect(r.cost_usd).toBeCloseTo(reviewer + r.judge_cost_usd! + r.breadth_cost_usd!, 4)
    expect(r.breadth_tokens).toEqual({ input: 1_000, output: 300 })
  })

  it('infers skipped_bundled / disabled for a bundled run, and is null when the stage was never reached', () => {
    cfg.breadth.enabled = true
    expect(buildUsageRecord(baseCtx({ bundleCount: 2 }), 1, null).breadth_status).toBe('skipped_bundled')
    cfg.breadth.enabled = false
    expect(buildUsageRecord(baseCtx({ bundleCount: 2 }), 1, null).breadth_status).toBe('disabled')
    expect(buildUsageRecord(baseCtx(), 1, null).breadth_status).toBeNull()
  })
})
