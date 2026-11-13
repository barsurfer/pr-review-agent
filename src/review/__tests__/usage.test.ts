import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type { ReviewContext, LensRun } from '../types.js'
import type { KeptFinding } from '../findings-output.js'

// usage.ts pulls in config (required ANTHROPIC_API_KEY) at import — set it before the dynamic import.
let estimateCost: (tokens: { input: number; output: number }, model: string) => number
let buildUsageRecord: (typeof import('../usage.js'))['buildUsageRecord']
let config: (typeof import('../../config.js'))['config']
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;({ estimateCost, buildUsageRecord } = await import('../usage.js'))
  ;({ config } = await import('../../config.js'))
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

  describe('OpenRouter slugs', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
    afterEach(() => { warnSpy.mockRestore() })

    it('prices OpenRouter Anthropic slugs as their table entry', () => {
      expect(estimateCost({ input: 1_000_000, output: 0 }, 'anthropic/claude-sonnet-5.5')).toBe(2)
      expect(estimateCost({ input: 50_000, output: 0 }, 'anthropic/claude-haiku-5.5')).toBe(0.005)
      expect(estimateCost({ input: 200_000, output: 0 }, 'anthropic/claude-haiku-5.5')).toBe(0.1)
      expect(estimateCost({ input: 200_000, output: 0 }, 'anthropic/claude-haiku-5-5')).toBe(0.1)
      expect(estimateCost({ input: 50_000, output: 0 }, 'anthropic/claude-haiku-5.5:thinking')).toBe(0.005)
      expect(estimateCost({ input: 1_000_000, output: 0 }, 'anthropic/claude-opus-4.8')).toBe(5)
      expect(estimateCost({ input: 1_000_000, output: 0 }, 'anthropic/claude-sonnet-5.5:beta')).toBe(2)
      expect(estimateCost({ input: 1_000_000, output: 0 }, 'claude-haiku-4.5-20251001')).toBe(1)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('leaves every id that resolves today unchanged and silent, dated or not', () => {
      const rates: Record<string, number> = {
        'claude-fable-5-1': 10, 'claude-fable-5': 10, 'claude-mythos-5-1': 10, 'claude-mythos-5': 10,
        'claude-opus-5-5': 4, 'claude-opus-5': 5, 'claude-opus-4-8': 5, 'claude-opus-4-7': 5, 'claude-opus-4-6': 5, 'claude-opus-4-5': 5,
        'claude-sonnet-5-5': 2, 'claude-sonnet-5': 2, 'claude-sonnet-4-6': 3, 'claude-sonnet-4-5': 3, 'claude-haiku-4-5': 1,
        'claude-haiku-5-5': 0.5,
      }
      for (const [id, rate] of Object.entries(rates)) {
        for (const model of [id, `${id}-20260101`]) {
          expect(estimateCost({ input: 1_000_000, output: 0 }, model)).toBe(rate)
        }
      }
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('still falls back and warns for non-Anthropic or unmapped slugs', () => {
      for (const model of ['openai/gpt-x', 'google/gemini-2.5-pro', 'anthropic/claude-3.7-sonnet']) {
        warnSpy.mockClear()
        expect(estimateCost({ input: 1_000_000, output: 0 }, model)).toBe(3)
        expect(warnSpy).toHaveBeenCalledTimes(1)
      }
    })
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

  it('uses provider-reported cost_usd when present and the pricing estimate when absent (anthropic inert)', () => {
    const bigUsage = { input_tokens: 1_000_000, output_tokens: 0, cache_read: 0, cache_write: 0 }
    const actual = buildUsageRecord(baseCtx({ usage: { ...bigUsage, cost_usd: 0.42 } }), 1, null).cost_usd
    const estimate = buildUsageRecord(baseCtx({ usage: bigUsage }), 1, null).cost_usd
    expect(actual).toBe(0.42)
    expect(estimate).not.toBe(0.42)
    expect(estimate).toBeGreaterThan(0)
  })

  it('keeps top-level cost consistent with per-stage columns under mixed cost reporting', () => {
    // Reviewer reported an actual cost; judge did not → judge falls to the estimate, which must still
    // be included in the total so cost_usd stays consistent with judge_cost_usd.
    const r = buildUsageRecord(baseCtx({
      usage: { input_tokens: 100, output_tokens: 50, cache_read: 0, cache_write: 0, cost_usd: 1.0 },
      judgeUsage: { input_tokens: 1000, output_tokens: 500 },
      judgeStatus: 'succeeded',
    }), 1, null)
    expect(r.judge_cost_usd).toBeGreaterThan(0)
    expect(r.cost_usd).toBeCloseTo(1.0 + (r.judge_cost_usd ?? 0), 6)
  })

  it('prefers judge/breadth actual cost_usd for their breakdown fields', () => {
    const r = buildUsageRecord(baseCtx({
      usage: { input_tokens: 100, output_tokens: 50, cache_read: 0, cache_write: 0, cost_usd: 1.5 },
      judgeUsage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.3 },
      breadthModel: 'openai/gpt-x', breadthUsage: { input_tokens: 20, output_tokens: 10, cost_usd: 0.2 },
    }), 1, null)
    expect(r.cost_usd).toBe(1.5)
    expect(r.judge_cost_usd).toBe(0.3)
    expect(r.breadth_cost_usd).toBe(0.2)
  })

  it('zero-call run under an OpenRouter slug: cost_usd 0 and no fallback warning', () => {
    const saved = config.anthropic.model
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    config.anthropic.model = 'anthropic/claude-sonnet-5.5'
    try {
      const r = buildUsageRecord(baseCtx({ action: 'SKIP', usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 } }), 1, null)
      expect(r.cost_usd).toBe(0)
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('No pricing entry'))).toBe(false)
    } finally {
      config.anthropic.model = saved
      warnSpy.mockRestore()
    }
  })

  it('a provider-reported cost is used as is under a slug model', () => {
    const saved = config.anthropic.model
    config.anthropic.model = 'anthropic/claude-sonnet-5.5'
    try {
      const r = buildUsageRecord(baseCtx({ usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read: 0, cache_write: 0, cost_usd: 0.42 } }), 1, null)
      expect(r.cost_usd).toBe(0.42)
    } finally {
      config.anthropic.model = saved
    }
  })

  it('trigger: absent without ctx.trigger; raw values with null for a missing part, placed between jenkins and error', () => {
    expect('trigger' in buildUsageRecord(baseCtx(), 1, null)).toBe(false)
    const both = buildUsageRecord(baseCtx({ trigger: { event: 'pullrequest:comment_created', commentAuthor: '{A}' } }), 1, null)
    expect(both.trigger).toEqual({ event: 'pullrequest:comment_created', comment_author: '{A}' })
    expect(Object.keys(both).slice(-3)).toEqual(['jenkins', 'trigger', 'error'])
    expect(buildUsageRecord(baseCtx({ trigger: { event: '', commentAuthor: '{A}' } }), 1, null).trigger).toEqual({ event: null, comment_author: '{A}' })
    expect(buildUsageRecord(baseCtx({ trigger: { event: 'pullrequest:updated', commentAuthor: '' } }), 1, null).trigger).toEqual({ event: 'pullrequest:updated', comment_author: null })
  })

  it('U1 no mark → neither checked_commit nor dedup_source', () => {
    const r = buildUsageRecord(baseCtx({ prInfo: { sourceCommit: 'abcdef0123456789' } as never }), 1, null)
    expect('checked_commit' in r).toBe(false)
    expect('dedup_source' in r).toBe(false)
  })

  it('U2 checked_commit is the full sourceCommit when marked, and dropped when the run errored afterwards', () => {
    const ctx = baseCtx({ prInfo: { sourceCommit: 'abcdef0123456789' } as never, headChecked: true })
    expect(buildUsageRecord(ctx, 1, null).checked_commit).toBe('abcdef0123456789')
    expect('checked_commit' in buildUsageRecord(ctx, 1, { type: 'Error', message: 'boom', status: null })).toBe(false)
  })

  it('U3 dedup_source only with dedupHit, kept on an errored run', () => {
    expect(buildUsageRecord(baseCtx({ dedupHit: 'checked_commit' }), 1, null).dedup_source).toBe('checked_commit')
    expect(buildUsageRecord(baseCtx({ dedupHit: 'checked_commit' }), 1, { type: 'Error', message: 'boom', status: null }).dedup_source).toBe('checked_commit')
    expect('dedup_source' in buildUsageRecord(baseCtx({ headChecked: true, prInfo: { sourceCommit: 'abc' } as never }), 1, null)).toBe(false)
  })

  it('U4 checked_commit is emitted only for a 12-64 hex head, unchanged; an empty or odd head never gives a storable value', () => {
    const marked = (sourceCommit: string) => buildUsageRecord(baseCtx({ prInfo: { sourceCommit } as never, headChecked: true }), 1, null)
    for (const head of ['abcdef012345', 'abc123abc123abc', 'a'.repeat(40), 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', 'f'.repeat(64)]) {
      expect(marked(head).checked_commit, head).toBe(head)
    }
    for (const head of ['', 'HEAD', 'abc', 'abcdef01234', 'f'.repeat(65), 'g'.repeat(40), ' abcdef012345', 'abcdef012345\n']) {
      expect('checked_commit' in marked(head), JSON.stringify(head)).toBe(false)
    }
  })

  it('U5 workspace is the provider scope: Bitbucket workspace, Azure org, GitHub owner; other providers keep the Bitbucket value', () => {
    const saved = { vcs: config.vcsProvider, ws: config.bitbucket.workspace, org: config.azure.org, owner: config.github.owner }
    config.bitbucket.workspace = 'bb-ws'; config.azure.org = 'az-org'; config.github.owner = 'gh-owner'
    try {
      const record = (vcs: typeof config.vcsProvider) => { config.vcsProvider = vcs; return buildUsageRecord(baseCtx(), 1, null) }
      expect(record('bitbucket').workspace).toBe('bb-ws')
      expect(record('azure').workspace).toBe('az-org')
      expect(record('github').workspace).toBe('gh-owner')
      expect(record('gitlab').workspace).toBe('bb-ws')
      expect(record('reviewbench').workspace).toBe('bb-ws')
      expect(record('github').run_id).toBe('github-repo-7-unknown')
    } finally {
      config.vcsProvider = saved.vcs; config.bitbucket.workspace = saved.ws; config.azure.org = saved.org; config.github.owner = saved.owner
    }
  })

  it('U6 trigger.event_kind is added only when the kind was given', () => {
    const r = buildUsageRecord(baseCtx({ trigger: { event: 'relay:note', commentAuthor: '{A}', kind: 'comment' } }), 1, null)
    expect(r.trigger).toEqual({ event: 'relay:note', comment_author: '{A}', event_kind: 'comment' })
    expect(JSON.stringify(buildUsageRecord(baseCtx({ trigger: { event: 'e', commentAuthor: '' } }), 1, null).trigger)).toBe('{"event":"e","comment_author":null}')
  })

  it('a pre-FETCH_PR_INFO ctx builds a well-formed record', () => {
    const r = buildUsageRecord(baseCtx({ action: 'SKIP', reviewNumber: 0, estimatedInputTokens: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 } }), 1, null)
    expect(r.run_id).toBe(`${config.vcsProvider}-repo-7-unknown`)
    expect(r).toMatchObject({
      pr_author: 'unknown', source_commit: 'unknown', source_branch: 'unknown', target_branch: 'unknown',
      diff_size: null, changed_files: 0, cost_usd: 0, error: null, prompt_source: 'none', delta: null, touch_rate: null, verdict_score: null,
    })
  })

  it('logs and costs a REPLY run at the reply model (REPLY_MODEL), not the reviewer model', () => {
    config.reply.model = 'claude-haiku-5-5'
    try {
      const r = buildUsageRecord(baseCtx({ action: 'REPLY', usage: { input_tokens: 1000, output_tokens: 500, cache_read: 0, cache_write: 0 } }), 1, null)
      expect(r.model).toBe('claude-haiku-5-5')
      expect(r.cost_usd).toBe(estimateCost({ input: 1000, output: 500 }, 'claude-haiku-5-5'))
    } finally {
      config.reply.model = ''
    }
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

  it('adds keep_test_gaps: true to the policy only when ENABLE_JUDGE_KEEP_TEST_GAPS is on', () => {
    Object.assign(cfg.judge.policy, { keepTestGaps: true })
    expect(buildUsageRecord(judged(), 1, null).judge_policy).toStrictEqual({ keep_minor: false, keep_unverified: false, file_context: false, keep_test_gaps: true })
    Object.assign(cfg.judge.policy, { keepTestGaps: false })
    expect(buildUsageRecord(judged(), 1, null).judge_policy).toStrictEqual({ keep_minor: false, keep_unverified: false, file_context: false })
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

  it('adds proposal to a row only when the kept finding has one, and never touches recall_levers', () => {
    const withFix: KeptFinding[] = [{ ...judgedFindings[0], proposal: 'Lock get/put.' }, judgedFindings[2]]
    const ctx = baseCtx({ judgedFindings: withFix, changedFiles: [{ path: 'src/pool.ts', status: 'modified' }] } as Partial<ReviewContext>)
    const r = buildUsageRecord(ctx, 1, null)
    expect(r.anchored_findings![0]).toEqual({ anchor: 'src/pool.ts:2-3', severity: 'HIGH', type: 'correctness', description: 'get/put race.', proposal: 'Lock get/put.' })
    expect('proposal' in r.anchored_findings![1]).toBe(false)
    expect(Object.keys(r.recall_levers)).toEqual(['j_quality', 'sl_breadth', 'j_shown_anchor', 'b_priority'])
    expect(JSON.stringify(buildUsageRecord(baseCtx({ judgedFindings, changedFiles: [{ path: 'src/pool.ts', status: 'modified' }] } as Partial<ReviewContext>), 1, null))).not.toContain('proposal')
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

describe('buildUsageRecord lens fields', () => {
  const baseCtx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 3_000, output_tokens: 1_000, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)
  type Lenses = { enabled: boolean; list: string; model: string }
  let cfg: { anthropic: { model: string }; judge: { model: string }; lenses: Lenses }
  let saved: { model: string; judge: string; lenses: Lenses }
  beforeAll(async () => { cfg = (await import('../../config.js')).config as unknown as typeof cfg })
  beforeEach(() => {
    saved = { model: cfg.anthropic.model, judge: cfg.judge.model, lenses: { ...cfg.lenses } }
    cfg.anthropic.model = 'claude-sonnet-5-5'; cfg.judge.model = 'claude-haiku-5-5'
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })
  afterEach(() => {
    cfg.anthropic.model = saved.model; cfg.judge.model = saved.judge; cfg.lenses = saved.lenses
    vi.useRealTimers()
  })

  const finding = { severity: 'LOW' as const, title: 't', body: 'b' }
  const runs: LensRun[] = [
    { name: 'reliability', status: 'succeeded', model: 'claude-sonnet-5-5', findings: [finding, finding], promptHash: 'aaa111bbb222', usage: { input_tokens: 1_000, output_tokens: 200 } },
    { name: 'security', status: 'failed', model: 'claude-sonnet-5-5', findings: [], usage: { input_tokens: 500, output_tokens: 100 } },
    { name: 'testing', status: 'skipped_time', model: 'claude-sonnet-5-5', findings: [] },
  ]

  it('logs one row per lens and prices lens tokens at the lens model, outside the reviewer bucket', () => {
    cfg.lenses = { enabled: true, list: 'reliability+security+testing', model: '' }
    const r = buildUsageRecord(baseCtx({ judgeUsage: { input_tokens: 1_000, output_tokens: 200 }, lensRuns: runs }), 1, null)

    const relCost = estimateCost({ input: 1_000, output: 200 }, 'claude-sonnet-5-5')
    const secCost = estimateCost({ input: 500, output: 100 }, 'claude-sonnet-5-5')
    expect(r.lens_runs).toEqual([
      { name: 'reliability', status: 'succeeded', model: 'claude-sonnet-5-5', prompt_hash: 'aaa111bbb222', tokens: { input: 1_000, output: 200 }, cost_usd: relCost, findings: 2 },
      { name: 'security', status: 'failed', model: 'claude-sonnet-5-5', prompt_hash: null, tokens: { input: 500, output: 100 }, cost_usd: secCost, findings: 0 },
      { name: 'testing', status: 'skipped_time', model: 'claude-sonnet-5-5', prompt_hash: null, tokens: null, cost_usd: null, findings: 0 },
    ])
    const reviewer = estimateCost({ input: 3_000 - 1_000 - 1_000 - 500, output: 1_000 - 200 - 200 - 100 }, 'claude-sonnet-5-5')
    expect(r.cost_usd).toBeCloseTo(reviewer + r.judge_cost_usd! + relCost + secCost, 6)
  })

  it('subtracts a provider-reported lens cost from the all-calls actual, keeping the total equal to it', () => {
    cfg.lenses = { enabled: true, list: 'reliability', model: 'openai/gpt-x' }
    const r = buildUsageRecord(baseCtx({
      usage: { input_tokens: 100, output_tokens: 50, cache_read: 0, cache_write: 0, cost_usd: 1.5 },
      judgeUsage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.3 },
      lensRuns: [{ name: 'reliability', status: 'succeeded', model: 'openai/gpt-x', findings: [], usage: { input_tokens: 20, output_tokens: 10, cost_usd: 0.2 } }],
    }), 1, null)
    expect(r.lens_runs![0].cost_usd).toBe(0.2)
    expect(r.cost_usd).toBeCloseTo(1.5, 10)
  })

  it('infers skipped_bundled per lens for a bundled run, and is null when the stage was never reached', () => {
    cfg.lenses = { enabled: true, list: 'security+reliability', model: 'claude-haiku-5-5' }
    const skipped = (name: string) => ({ name, status: 'skipped_bundled', model: 'claude-haiku-5-5', prompt_hash: null, tokens: null, cost_usd: null, findings: 0 })
    expect(buildUsageRecord(baseCtx({ bundleCount: 2 }), 1, null).lens_runs).toEqual([skipped('security'), skipped('reliability')])
    expect(buildUsageRecord(baseCtx(), 1, null).lens_runs).toBeNull()
  })

  it('flag-off pin: no lens_runs key, pre-lens cost math, and lens fields are purely additive', () => {
    const ctx = baseCtx({
      judgeUsage: { input_tokens: 400, output_tokens: 100 }, judgeStatus: 'succeeded',
      breadthUsage: { input_tokens: 300, output_tokens: 90 }, breadthModel: 'claude-haiku-5-5', breadthStatus: 'succeeded',
      secondLookUsage: { input_tokens: 200, output_tokens: 80 }, secondLookStatus: 'succeeded',
    })
    for (const lenses of [{ enabled: false, list: '', model: '' }, { enabled: false, list: 'reliability', model: '' }, { enabled: true, list: '', model: '' }]) {
      cfg.lenses = lenses
      const off = buildUsageRecord(ctx, 1, null)
      expect('lens_runs' in off).toBe(false)
      expect(JSON.stringify(off)).not.toMatch(/lens/i)
      const reviewer = estimateCost({ input: 3_000 - 400 - 300 - 200, output: 1_000 - 100 - 90 - 80 }, 'claude-sonnet-5-5')
      expect(off.cost_usd).toBe(reviewer + off.judge_cost_usd! + off.breadth_cost_usd! + off.second_look_cost_usd!)
    }

    cfg.lenses = { enabled: true, list: 'reliability', model: '' }
    const { lens_runs, ...on } = buildUsageRecord(baseCtx({ ...ctx, lensRuns: [] }), 1, null)
    expect(lens_runs).toEqual([])
    cfg.lenses = { enabled: false, list: '', model: '' }
    expect(JSON.stringify(buildUsageRecord(ctx, 1, null))).toBe(JSON.stringify(on))
  })
})

describe('buildUsageRecord lens_recommendations', () => {
  const baseCtx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 3_000, output_tokens: 1_000, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)
  let saved: typeof config.lenses
  const setLenses = (recommend: boolean) => { config.lenses = { enabled: false, list: '', model: '', recommend } }
  beforeEach(() => { saved = config.lenses; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')) })
  afterEach(() => { config.lenses = saved; vi.useRealTimers() })
  const recs = [{ lens: 'security', reason: 'new /login endpoint' }]

  it('flag off: no key, even when the context carries recommendations', () => {
    setLenses(false)
    const r = buildUsageRecord(baseCtx({ lensRecommendations: recs }), 1, null)
    expect('lens_recommendations' in r).toBe(false)
    expect(JSON.stringify(r)).not.toContain('recommend')
  })

  it('flag on: null when not requested, [] when none recommended, else the list; the rest of the record is unchanged', () => {
    setLenses(false)
    const off = buildUsageRecord(baseCtx(), 1, null)
    setLenses(true)
    expect(buildUsageRecord(baseCtx(), 1, null).lens_recommendations).toBeNull()
    expect(buildUsageRecord(baseCtx({ lensRecommendations: [] }), 1, null).lens_recommendations).toEqual([])
    const { lens_recommendations, ...rest } = buildUsageRecord(baseCtx({ lensRecommendations: recs }), 1, null)
    expect(lens_recommendations).toEqual(recs)
    expect(JSON.stringify(rest)).toBe(JSON.stringify(off))
  })
})

describe('buildUsageRecord suggested_fixes', () => {
  const baseCtx = (over: Partial<ReviewContext> = {}): ReviewContext => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 3_000, output_tokens: 1_000, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1,
    ...over,
  } as unknown as ReviewContext)
  const stats = { rendered: 2, rejected: 1, skipped: 'size' as const }
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')) })
  afterEach(() => { config.judge.suggestedFixes = false; vi.useRealTimers() })

  it('flag off: no key, even when the context carries stats', () => {
    config.judge.suggestedFixes = false
    const r = buildUsageRecord(baseCtx({ suggestedFixes: stats }), 1, null)
    expect('suggested_fixes' in r).toBe(false)
    expect(JSON.stringify(r)).toBe(JSON.stringify(buildUsageRecord(baseCtx(), 1, null)))
  })

  it('flag on: null until POST_REVIEW composed, then the stats; the rest of the record is unchanged', () => {
    config.judge.suggestedFixes = false
    const off = buildUsageRecord(baseCtx(), 1, null)
    config.judge.suggestedFixes = true
    expect(buildUsageRecord(baseCtx(), 1, null).suggested_fixes).toBeNull()
    const { suggested_fixes, ...rest } = buildUsageRecord(baseCtx({ suggestedFixes: stats }), 1, null)
    expect(suggested_fixes).toEqual(stats)
    expect(JSON.stringify(rest)).toBe(JSON.stringify(off))
  })
})

describe('buildUsageRecord J_QUALITY fields', () => {
  type Judge = typeof import('../judge-decisions.js')
  let applyJudgeDecisions: Judge['applyJudgeDecisions']
  let cfg: { judge: { quality?: boolean } }
  let savedQuality: boolean | undefined
  beforeAll(async () => {
    ;({ applyJudgeDecisions } = await import('../judge-decisions.js'))
    cfg = (await import('../../config.js')).config as unknown as typeof cfg
  })
  beforeEach(() => { savedQuality = cfg.judge.quality; vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z')) })
  afterEach(() => { cfg.judge.quality = savedQuality; vi.useRealTimers() })

  const file = (path: string, lines: string[]) =>
    `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}\n`
  const diff = file('x.ts', ['const a = 1', 'run: shared call here']) + file('y.ts', ['const b = 2', 'run: shared call here']) + file('z.ts', ['const c = 3'])
  const candidates = [
    { severity: 'MEDIUM' as const, title: 'Shared call', file: 'x.ts', lines: '2', body: 'Call is wrong in x.ts and also in y.ts.' },
    { severity: 'LOW' as const, title: 'Same call', file: 'z.ts', lines: '1', body: 'Looks like the first.' },
  ]
  const judgeOutput = {
    decisions: [
      { candidate_id: 'c0', reason_category: 'validated' as const, evidence: 'x.ts:2', note: 'real', score: 8,
        additional_locations: [{ file: 'y.ts', lines: '2', anchor_quote: 'run: shared call here', candidate_excerpt: 'also in y.ts', body: 'Same call in y.ts.' }] },
      { candidate_id: 'c1', reason_category: 'duplicate' as const, evidence: '', note: 'dup', score: 4, duplicate_of: 'c0' },
    ],
    summary: 's', behavioral_diff: [], production_risk: [], unresolved_questions: [], merge_confidence: 70,
  }
  const reviewObject = { summary: 's', findings: candidates, behavioral_diff: [], production_risk: [], unresolved_questions: [] }
  const POLICY = { keepMinor: false, keepUnverified: false }

  const record = (quality: boolean | undefined) => {
    cfg.judge.quality = quality
    const judged = applyJudgeDecisions(candidates, judgeOutput, POLICY, [], diff, Infinity, quality ? { quality } : undefined)
    return buildUsageRecord({
      adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
      usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 0 },
      estimatedInputTokens: 10, action: 'REVIEW', reviewNumber: 1, reviewObject,
      judgeDecisions: judged.decisions, judgeAnomalies: judged.anomalies, judgeUsage: { input_tokens: 4, output_tokens: 2 }, judgeStatus: 'succeeded',
    } as unknown as ReviewContext, 1, null)
  }

  it('emits duplicate_of, invalid_duplicate and expansions only under quality', () => {
    const on = JSON.stringify(record(true).judge_decisions)
    expect(on).toContain('"duplicate_of":"c0"')
    expect(on).toContain('"invalid_duplicate":true')
    expect(on).toContain('"expansions":[{"file":"y.ts","accepted":true}]')
    expect(record(true).judge_anomalies).toMatchObject({ invalid_duplicate: 1 })

    const off = record(false)
    expect(JSON.stringify(off.judge_decisions)).not.toMatch(/duplicate_of|invalid_duplicate|expansions/)
    expect(off.judge_anomalies).not.toHaveProperty('invalid_duplicate')
  })

  it('never emits repair metadata in either flag state', () => {
    for (const quality of [false, true]) expect(JSON.stringify(record(quality))).not.toMatch(/repair/)
  })

  it('an unset and an explicitly false flag produce byte-identical records, with j_quality false', () => {
    const unset = record(undefined)
    expect(unset.recall_levers.j_quality).toBe(false)
    expect(JSON.stringify(record(false))).toBe(JSON.stringify(unset))
  })

  it('quality on changes only the quality-gated fields, preserving every other record field', () => {
    const { recall_levers: onLevers, judge_decisions: _d, judge_anomalies: _a, ...onRest } = record(true)
    const { recall_levers: offLevers, judge_decisions: _d2, judge_anomalies: _a2, ...offRest } = record(false)
    expect(onLevers).toEqual({ ...offLevers, j_quality: true })
    expect(JSON.stringify(onRest)).toBe(JSON.stringify(offRest))
  })
})

describe('buildUsageRecord reply authors', () => {
  const at = '2026-03-10T12:00:00Z'
  const human = (id: string, author: string, authorId?: string) => ({ id, parentId: '1', author, ...(authorId ? { authorId } : {}), body: 'q', createdOn: at })
  const agent = (id: string) => ({ id, parentId: '1', author: 'Agent (prior reply)', body: 'a', createdOn: at })
  const ctxWith = (replies: unknown[], reviewNumber = 2) => ({
    adapter: {}, prId: '7', dryRun: false, force: 'off', logUsage: false, repoSlug: 'repo',
    usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, cache_write: 0 },
    estimatedInputTokens: 10, action: 'RE_REVIEW', reviewNumber, reviewObject: { findings: [] }, replies,
  } as unknown as ReviewContext)

  it('splits developer_replies into human and agent counts that sum to it', () => {
    const r = buildUsageRecord(ctxWith([human('2', 'Ann'), agent('3'), human('4', 'Bob'), agent('5'), agent('6')]), 1, null)
    expect(r.delta).toMatchObject({ developer_replies: 5, human_replies: 2, agent_replies: 3 })
    expect(Object.keys(r.delta!).slice(0, 3)).toEqual(['developer_replies', 'human_replies', 'agent_replies'])
  })

  it('lists distinct authors in first-seen order, preferring the account id over the name', () => {
    const r = buildUsageRecord(ctxWith([human('2', 'Ann', '{u-1}'), human('3', 'Bob'), human('4', 'Ann', '{u-1}'), human('5', 'Bob')]), 1, null)
    expect(r.reply_authors).toEqual(['{u-1}', 'Bob'])
  })

  it('excludes agent replies from authors', () => {
    expect(buildUsageRecord(ctxWith([agent('2'), human('3', 'Ann')]), 1, null).reply_authors).toEqual(['Ann'])
  })

  it('omits reply_authors when there is no human reply, keeping counts where delta exists', () => {
    const onlyAgent = buildUsageRecord(ctxWith([agent('2')]), 1, null)
    expect('reply_authors' in onlyAgent).toBe(false)
    expect(onlyAgent.delta).toMatchObject({ developer_replies: 1, human_replies: 0, agent_replies: 1 })
    expect('reply_authors' in buildUsageRecord(ctxWith([]), 1, null)).toBe(false)
  })

  it('keeps delta null on a first review and still reports authors of a reply run', () => {
    const r = buildUsageRecord(ctxWith([human('2', 'Ann', 'acc-1')], 1), 1, null)
    expect(r.delta).toBeNull()
    expect(r.reply_authors).toEqual(['acc-1'])
  })

  it('places reply_authors right after delta, before jenkins', () => {
    const keys = Object.keys(buildUsageRecord(ctxWith([human('2', 'Ann')]), 1, null))
    expect(keys.slice(keys.indexOf('delta'), keys.indexOf('delta') + 3)).toEqual(['delta', 'reply_authors', 'jenkins'])
  })
})
