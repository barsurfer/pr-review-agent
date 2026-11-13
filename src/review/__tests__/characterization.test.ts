import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VCSAdapter, PRInfo, ReviewComment, CommentReply } from '../../vcs/adapter.js'
import type { TriggerInfo } from '../types.js'

// Pins the observable behaviour of runs with no checked commit (VCS calls, model inputs, console, record).
vi.mock('../../config.js', () => ({
  config: {
    llmApiKey: 'test-key',
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', maxRetries: 1, maxInputTokens: 150000, maxTokens: 32000, modelContextTokens: 0 },
    judge: { model: '', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false, quality: false, shownAnchors: false, proposals: false },
    breadth: { enabled: false, model: '', effort: '', minFiles: 5, minUntouched: 3, benchmarkDeadlineSeconds: 840, priorityTargets: false },
    lenses: { enabled: false, list: '', model: '', recommend: false },
    agentIdentity: 'test-bot',
    reply: { maxComments: 3, model: '', skipDirectedElsewhere: false },
    review: { maxFindings: 0, splitCheck: false, todoScan: true, effort: '', enableNitpicks: false, secondLook: false, secondLookBreadthTargets: false, bundledReview: false, maxBundles: 8, lineNumbers: false },
    context: { maxFiles: 20, maxFileLines: 500 },
    skipSourceBranches: ['main', 'master', 'release/*', 'hotfix/*'],
    skipTargetBranches: ['main', 'master'],
    onlyTargetBranches: [],
    trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
    diffExcludePatterns: ['*.lock', 'package-lock.json', '*.spec.ts'],
    thresholds: { minChangedFiles: 0, maxChangedFiles: 200, minChangedLines: 0, maxChangedLines: 3000 },
    vcsProvider: 'bitbucket',
    bitbucket: { workspace: 'test', baseUrl: '', username: 'bot', token: 'x' },
  },
  modelContextWindow: vi.fn(() => 200_000),
}))

vi.mock('../client.js', () => ({ runReview: vi.fn(), runCommentResponse: vi.fn(), runJudge: vi.fn(), runBreadth: vi.fn(), runLens: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))
vi.mock('../usage.js', async (importOriginal) => ({ ...(await importOriginal() as any), getBuildCommit: () => 'testbuild', logUsageRecord: vi.fn() }))

import { review } from '../index.js'
import { config } from '../../config.js'
import { runReview, runCommentResponse, runJudge, runBreadth } from '../client.js'
import { loadPrompt } from '../../prompt/loader.js'
import { fetchContext } from '../../context/fetcher.js'
import { renderReview, buildReplyFooter, type ReviewObject } from '../formatter.js'
import { logUsageRecord } from '../usage.js'

const cfg = config as any
const DEFAULTS = structuredClone(cfg)

const HEAD = 'aaa111222333'.padEnd(40, 'f')
const HEAD12 = HEAD.slice(0, 12)
const PRIOR = 'aabbcc112233'
const PRIOR_AT = '2026-03-09T10:00:00Z'

const DIFF = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -10,3 +10,5 @@\n+import { foo } from \'./foo\'\n+foo()\n'
const LOCK_ONLY = 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-"a"\n+"b"\n'
const HUGE_DELTA = 'diff --git a/src/other.ts b/src/other.ts\n--- a/src/other.ts\n+++ b/src/other.ts\n@@ -1,1 +1,80 @@\n' + Array.from({ length: 80 }, (_, i) => `+export const merged${i} = ${i}`).join('\n') + '\n'
const section = (path: string, lines: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+const line${i} = ${i}`).join('\n')}\n`
const BUNDLE_FILES = ['a/one.ts', 'a/two.ts', 'b/one.ts', 'b/two.ts']
const BIG_DIFF = BUNDLE_FILES.map(p => section(p, 120)).join('')
const SMALL_DELTA = section('a/one.ts', 2)

const footer = (n: number, commit: string) => `\n\n---\n*Reviewed by test-bot (claude-haiku-4-5-20251001) | Prompt: repo | Review #${n} | Commit: ${commit}*`
const CLEAN_PRIOR = '### Summary\nAll good.\n\n### Findings\nNo findings.\n\n### Unresolved Questions\nNone.'
const FLAGGED_PRIOR = '### Summary\nOne issue.\n\n### Findings\n- **MEDIUM – Prior issue** (`src/app.ts:11`)\n  desc\n\n### Unresolved Questions\nNone.'
const prior = (body: string, commit = PRIOR, n = 1): ReviewComment => ({ id: String(199 + n), body: body + footer(n, commit), createdOn: PRIOR_AT })

const FINDING: ReviewObject['findings'][number] = { severity: 'MEDIUM', title: 'New issue', file: 'src/app.ts', lines: '11', body: 'desc' }
const reviewWith = (findings: ReviewObject['findings'] = [], extra: Partial<ReviewObject> = {}): ReviewObject =>
  ({ summary: 'ok', findings, behavioral_diff: [], production_risk: [], unresolved_questions: [], ...extra })
const ZERO_DELTA = { delta_stats: { resolved: 0, still_open: 0, new_findings: 0 } }
const NO_CHANGE_OBJ = reviewWith([], { summary: '', no_change: true })
const usage = { input_tokens: 1000, output_tokens: 200 }

const devReply = (createdOn: string): CommentReply => ({ id: `dev-${createdOn}`, parentId: '200', author: 'Fernando', body: 'Fixed in d4f2b43e.', createdOn })
const agentReply = (createdOn: string): CommentReply =>
  ({ id: `agent-${createdOn}`, parentId: '200', author: 'Agent', body: 'Confirmed.' + buildReplyFooter('test-bot', 'claude-haiku-4-5-20251001'), createdOn })

function pr(sourceCommit = HEAD): PRInfo {
  return { id: '100', title: 'Test PR', description: 'A test PR', author: 'dev', sourceBranch: 'feature/test', targetBranch: 'develop', sourceCommit }
}

type Impl = Partial<Record<keyof VCSAdapter, (...args: any[]) => unknown>>
type Call = [string, unknown]

function baseAdapter(): Impl {
  return {
    getPullRequestInfo: async () => pr(),
    getDiff: async () => DIFF,
    getChangedFiles: async () => [{ path: 'src/app.ts', status: 'modified' }],
    getFileContent: async () => '',
    getRepoFileContent: async () => null,
    postComment: async () => undefined,
    getPreviousReviewComments: async () => [],
    getRepliesToReviewComments: async () => ({ replies: [], agentReplyCount: 0 }),
    postReply: async () => undefined,
    getCommitDiff: async () => '',
  }
}

const reReview = (body: string, replies: CommentReply[] = [], agentReplyCount = 0, over: Impl = {}): Impl => ({
  getPreviousReviewComments: async () => [prior(body)],
  getRepliesToReviewComments: async () => ({ replies, agentReplyCount }),
  getCommitDiff: async () => DIFF,
  ...over,
})

function reviewer(obj: ReviewObject, text = renderReview(obj)) {
  vi.mocked(runReview).mockImplementation(async () => ({ text, usage, review: obj }))
}

function bundleSetup(perBundle: (diff: string) => ReviewObject) {
  cfg.review.bundledReview = true
  cfg.anthropic.maxInputTokens = 2000
  vi.mocked(runReview).mockImplementation(async (...args: unknown[]) => {
    const o = perBundle(args[6] as string)
    return { text: renderReview(o), usage, review: o }
  })
}

const judgeText = (obj: ReviewObject) => renderReview(obj) + '\n\n### Merge Confidence: 80%'

interface Scenario {
  setup?: () => void
  adapter?: () => Impl
  dryRun?: boolean
  force?: 'off' | 'clean' | 're-review'
  trigger?: TriggerInfo
}

const SCENARIOS: Record<string, Scenario> = {
  'K1 first review posted': {
    setup: () => reviewer(reviewWith([FINDING])),
  },
  'K2 re-review with delta, posted, judge set': {
    setup: () => {
      cfg.judge.model = 'claude-sonnet-5'
      const obj = reviewWith([FINDING], { delta_stats: { resolved: 1, still_open: 0, new_findings: 1 } })
      reviewer(obj)
      vi.mocked(runJudge).mockImplementation(async () => ({ text: judgeText(obj), usage: { input_tokens: 800, output_tokens: 300 }, scores: [{ title: 'New issue', severity: 'MEDIUM', score: 8 }], promptHash: 'judgehash123' }) as never)
    },
    adapter: () => reReview(FLAGGED_PRIOR, [devReply('2026-03-09T12:00:00Z')]),
  },
  'K3 same-head dedup': {
    adapter: () => ({ getPreviousReviewComments: async () => [prior(CLEAN_PRIOR, HEAD12)] }),
  },
  'K4 zero-reviewable delta': {
    adapter: () => reReview(CLEAN_PRIOR, [], 0, { getCommitDiff: async () => LOCK_ONLY }),
  },
  'K5 NO_NEW_FINDINGS': {
    setup: () => reviewer(reviewWith([], ZERO_DELTA)),
    adapter: () => reReview(CLEAN_PRIOR),
  },
  'K6 NO_CHANGE + reply': {
    setup: () => reviewer(NO_CHANGE_OBJ),
    adapter: () => reReview(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')]),
  },
  'K7 NO_CHANGE': {
    setup: () => reviewer(NO_CHANGE_OBJ),
    adapter: () => reReview(CLEAN_PRIOR),
  },
  'K8 NO_CHANGE + reply limit': {
    setup: () => reviewer(NO_CHANGE_OBJ),
    adapter: () => reReview(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')], 3),
  },
  'K9 CHECK_REPLIES reply limit': {
    adapter: () => ({
      getPreviousReviewComments: async () => [prior(CLEAN_PRIOR, HEAD12)],
      getRepliesToReviewComments: async () => ({ replies: [devReply('2026-03-09T12:00:00Z')], agentReplyCount: 3 }),
    }),
  },
  'K10 JUDGE-gate reply limit': {
    setup: () => { cfg.reply.maxComments = 1; reviewer(reviewWith([], ZERO_DELTA)) },
    adapter: () => reReview(CLEAN_PRIOR, [agentReply('2026-03-09T11:00:00Z'), devReply('2026-03-09T12:00:00Z')]),
  },
  'K11 quiet 0-finding + reply': {
    setup: () => reviewer(reviewWith([], ZERO_DELTA)),
    adapter: () => reReview(CLEAN_PRIOR, [devReply('2026-03-09T12:00:00Z')]),
  },
  'K12 confirmation post': {
    setup: () => reviewer(reviewWith([], { delta_stats: { resolved: 1, still_open: 0, new_findings: 0 } })),
    adapter: () => reReview(FLAGGED_PRIOR),
  },
  'K13 pre-post race': {
    setup: () => reviewer(reviewWith([FINDING])),
    adapter: () => {
      let n = 0
      return { getPreviousReviewComments: async () => (n++ === 0 ? [] : [prior(CLEAN_PRIOR, HEAD12)]) }
    },
  },
  'K14 delta fetch failure': {
    setup: () => reviewer(reviewWith([], ZERO_DELTA)),
    adapter: () => reReview(CLEAN_PRIOR, [], 0, { getCommitDiff: async () => { throw new Error('Request failed with status code 404') } }),
  },
  'K15 delta > diff': {
    setup: () => reviewer(reviewWith([], ZERO_DELTA)),
    adapter: () => reReview(CLEAN_PRIOR, [], 0, { getCommitDiff: async () => HUGE_DELTA }),
  },
  'K16 bundled NO_NEW_FINDINGS': {
    setup: () => bundleSetup(() => reviewWith([], ZERO_DELTA)),
    adapter: () => reReview(CLEAN_PRIOR, [], 0, {
      getDiff: async () => BIG_DIFF,
      getChangedFiles: async () => BUNDLE_FILES.map(path => ({ path, status: 'modified' })),
      getCommitDiff: async () => SMALL_DELTA,
    }),
  },
  'K17 bundled all-NO_CHANGE': {
    setup: () => bundleSetup(() => NO_CHANGE_OBJ),
    adapter: () => reReview(CLEAN_PRIOR, [], 0, {
      getDiff: async () => BIG_DIFF,
      getChangedFiles: async () => BUNDLE_FILES.map(path => ({ path, status: 'modified' })),
      getCommitDiff: async () => SMALL_DELTA,
    }),
  },
  'K18 bundled post': {
    setup: () => {
      cfg.judge.model = 'judge-model'
      bundleSetup(diff => reviewWith([{ ...FINDING, title: diff.includes('a/one.ts') ? 'Alpha problem' : 'Beta problem', file: diff.includes('a/one.ts') ? 'a/one.ts' : 'b/one.ts', lines: '5' }]))
      vi.mocked(runJudge).mockImplementation(async (...args: unknown[]) => ({ text: judgeText(args[6] as ReviewObject), usage: { input_tokens: 100, output_tokens: 10 }, scores: [{ title: 't', severity: 'MEDIUM', score: 8 }] }) as never)
    },
    adapter: () => ({
      getDiff: async () => BIG_DIFF,
      getChangedFiles: async () => BUNDLE_FILES.map(path => ({ path, status: 'modified' })),
    }),
  },
  'K19 dry-run': {
    setup: () => reviewer(reviewWith([FINDING])),
    dryRun: true,
  },
  'K20 --force re-review': {
    setup: () => reviewer(reviewWith([FINDING])),
    adapter: () => ({ getPreviousReviewComments: async () => [prior(FLAGGED_PRIOR, HEAD12)] }),
    force: 're-review',
  },
  'K21 --force clean': {
    setup: () => reviewer(reviewWith([FINDING])),
    adapter: () => ({ getPreviousReviewComments: async () => [prior(FLAGGED_PRIOR, HEAD12)] }),
    force: 'clean',
  },
  'K22 force empty string': {
    setup: () => reviewer(reviewWith([FINDING])),
    adapter: () => reReview(CLEAN_PRIOR),
    force: '' as never,
  },
  'K23 bare NO_CHANGE line in a finding body': {
    setup: () => reviewer(reviewWith([{ ...FINDING, body: 'desc\nNO_CHANGE\nmore' }])),
    adapter: () => reReview(CLEAN_PRIOR),
  },
  'K24 trigger passed': {
    setup: () => reviewer(reviewWith([FINDING])),
    trigger: { event: 'pullrequest:updated', commentAuthor: '{dev}' },
  },
}

const MODEL_FNS = { runReview, runJudge, runCommentResponse, runBreadth } as const

async function runScenario(s: Scenario, checkedCommitArg = false) {
  vi.clearAllMocks()
  for (const k of Object.keys(cfg)) delete cfg[k]
  Object.assign(cfg, structuredClone(DEFAULTS))
  vi.mocked(loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  vi.mocked(fetchContext).mockResolvedValue([])
  vi.mocked(runReview).mockImplementation(async () => ({ text: renderReview(reviewWith()), usage, review: reviewWith() }))
  vi.mocked(runCommentResponse).mockResolvedValue({ text: 'Thanks for clarifying.', usage: { input_tokens: 500, output_tokens: 100 } })
  vi.mocked(runJudge).mockReset()
  vi.mocked(runBreadth).mockReset()
  s.setup?.()

  const model: Call[] = []
  for (const [name, fn] of Object.entries(MODEL_FNS)) {
    const impl = vi.mocked(fn).getMockImplementation() as ((...a: unknown[]) => unknown) | undefined
    vi.mocked(fn).mockImplementation((async (...args: unknown[]) => {
      model.push([name, structuredClone(args)])
      return impl?.(...args)
    }) as never)
  }

  const vcs: Call[] = []
  const impl: Impl = { ...baseAdapter(), ...s.adapter?.() }
  const adapter = Object.fromEntries(Object.entries(impl).map(([name, fn]) => [name, async (...args: unknown[]) => {
    vcs.push([name, structuredClone(args)])
    return fn!(...args)
  }])) as unknown as VCSAdapter

  const console_: string[] = []
  const spies = (['log', 'warn', 'error'] as const).map(level => vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
    const text = a.map(String).join(' ')
    if (!text.startsWith('\n=== Usage ===')) console_.push(`${level}: ${text}`)
  }))
  let record: Record<string, unknown> | null = null
  let thrown: string | null = null
  try {
    record = await (checkedCommitArg
      ? review(adapter, '100', s.dryRun ?? false, undefined, s.force ?? 'off', true, 'repo', undefined, s.trigger, undefined)
      : review(adapter, '100', s.dryRun ?? false, undefined, s.force ?? 'off', true, 'repo', undefined, s.trigger)) as unknown as Record<string, unknown>
  } catch (err: unknown) {
    thrown = (err as Error).message
  } finally {
    for (const spy of spies) spy.mockRestore()
  }

  const { timestamp, duration_ms, agent_commit, agent_version, checked_commit, dedup_source, reply_authors, ...stable } = (record ?? {}) as Record<string, unknown>
  // Reply-author counts are additive record fields pinned in usage.test.ts, not part of this characterization.
  if (stable.delta) { const { human_replies, agent_replies, ...delta } = stable.delta as Record<string, unknown>; stable.delta = delta }
  return { vcs, model, console: console_, record: record ? stable : null, thrown }
}

beforeEach(() => {
  vi.stubEnv('JOB_NAME', '')
  vi.stubEnv('BUILD_NUMBER', '')
  vi.stubEnv('BUILD_URL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('characterization: review() with no checked commit', () => {
  it.each(Object.keys(SCENARIOS))('%s', async (name) => {
    expect(await runScenario(SCENARIOS[name])).toMatchSnapshot()
  })
})

describe('characterization: record key order (not snapshotted, which sorts keys)', () => {
  const KEYS = [
    'run_id', 'timestamp', 'agent_version', 'vcs', 'workspace', 'repo_slug', 'pr_id', 'pr_author', 'source_commit', 'source_branch', 'target_branch',
    'changed_files', 'changed_lines', 'diff_size', 'context_files_fetched', 'degraded', 'review_number', 'action', 'skip_reason', 'model', 'effort',
    'tokens', 'cost_usd', 'judge_model', 'judge_effort', 'judge_tokens', 'judge_cost_usd', 'duration_ms', 'dry_run', 'force', 'prompt_source',
    'agent_commit', 'prompt_hash', 'judge_prompt_hash', 'judge_status', 'verdict_score', 'computed_score', 'review_findings', 'findings',
    'finding_scores', 'min_finding_score', 'anchored_findings', 'review_candidates', 'judge_decisions', 'judge_anomalies', 'judge_policy',
    'breadth_status', 'breadth_model', 'breadth_prompt_hash', 'breadth_tokens', 'breadth_cost_usd', 'second_look_status', 'second_look_prompt_hash',
    'second_look_tokens', 'second_look_cost_usd', 'untouched_files', 'recall_levers', 'touch_rate', 'delta', 'jenkins', 'error',
  ]
  const loggedKeys = () => Object.keys(vi.mocked(logUsageRecord).mock.calls[0][0])

  it('a run that marks nothing keeps exactly the pre-change keys, in order', async () => {
    await runScenario(SCENARIOS['K19 dry-run'])
    expect(loggedKeys()).toEqual(KEYS)
  })

  it('a checked run only adds checked_commit, right before jenkins; trigger keeps its place', async () => {
    await runScenario(SCENARIOS['K1 first review posted'])
    const keys = loggedKeys()
    expect(keys.filter(k => k !== 'checked_commit')).toEqual(KEYS)
    expect(keys[keys.indexOf('jenkins') - 1]).toBe('checked_commit')

    await runScenario(SCENARIOS['K24 trigger passed'])
    expect(loggedKeys().filter(k => k !== 'checked_commit')).toEqual([...KEYS.slice(0, -1), 'trigger', 'error'])
  })
})

describe('characterization: an explicit undefined checked commit is the same run', () => {
  it.each(Object.keys(SCENARIOS))('%s', async (name) => {
    const nineArgs = await runScenario(SCENARIOS[name])
    expect(await runScenario(SCENARIOS[name], true)).toEqual(nineArgs)
  })
})
