import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { VCSAdapter } from '../../vcs/adapter.js'

vi.mock('../../config.js', async () => {
  const { tableContextWindow } = await vi.importActual<typeof import('../../llm/model-id.js')>('../../llm/model-id.js')
  return {
    config: {
      llmProvider: 'openrouter', vcsProvider: 'bitbucket', llmApiKey: 'k',
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1' },
      anthropic: { model: '', maxRetries: 1, maxInputTokens: 2_000_000, maxTokens: 32_000, modelContextTokens: 0 },
      judge: { model: '', maxRetries: 1, effort: '', policy: { keepMinor: false, keepUnverified: false }, fileContext: false },
      breadth: { enabled: true, model: '', effort: '', minFiles: 0, minUntouched: 0, benchmarkDeadlineSeconds: 840 },
      lenses: { enabled: true, list: 'security', model: '', recommend: false },
      agentIdentity: 'test-bot',
      reply: { maxComments: 3, model: '' },
      review: { maxFindings: 0, splitCheck: false, todoScan: false, effort: '', enableNitpicks: false, secondLook: true, secondLookBreadthTargets: false, lineNumbers: false },
      context: { maxFiles: 20, maxFileLines: 500 },
      skipSourceBranches: [], skipTargetBranches: [], onlyTargetBranches: [],
      trigger: { event: '', commentAuthor: '', ignoreCommentAuthors: [] },
      diffExcludePatterns: [],
      thresholds: { minChangedFiles: 0, maxChangedFiles: 0, minChangedLines: 0, maxChangedLines: 0 },
      bitbucket: { workspace: 'test' },
    },
    modelContextWindow: (model: string) => tableContextWindow(model) ?? 200_000,
  }
})
vi.mock('../client.js', () => ({ runReview: vi.fn(), runCommentResponse: vi.fn(), runJudge: vi.fn(), runBreadth: vi.fn(), runLens: vi.fn() }))
vi.mock('../../prompt/loader.js', () => ({ loadPrompt: vi.fn() }))
vi.mock('../../context/fetcher.js', () => ({ fetchContext: vi.fn() }))

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('axios', () => ({ default: { get } }))

const MODEL_LIST = { data: [{ id: 'openai/gpt-6-luna', canonical_slug: 'openai/gpt-6-luna-20260922', context_length: 1_050_000, top_provider: { context_length: 1_050_000 } }] }

const LUNA = 'openai/gpt-6-luna'
const CLAUDE = 'anthropic/claude-haiku-5.5'
const HAIKU_45 = 'anthropic/claude-haiku-4.5'
// Over the largest budget below (1,018,000 tokens at ~4 chars each), so every budget check that sees it skips and prints its budget.
const GIANT = 4_400_000

const diffOf = (body: string) => `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+${body}\n+x\n`

function adapter(diff: string): VCSAdapter {
  return {
    getPullRequestInfo: vi.fn().mockResolvedValue({ id: '1', title: 'T', description: '', author: 'dev', sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'a'.repeat(40) }),
    getDiff: vi.fn().mockResolvedValue(diff),
    getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/a.ts', status: 'modified' }]),
    getFileContent: vi.fn().mockResolvedValue(''),
    getRepoFileContent: vi.fn().mockResolvedValue(null),
    postComment: vi.fn(),
    getPreviousReviewComments: vi.fn().mockResolvedValue([]),
    getRepliesToReviewComments: vi.fn().mockResolvedValue({ replies: [], agentReplyCount: 0 }),
    postReply: vi.fn(),
    getCommitDiff: vi.fn().mockResolvedValue(''),
  }
}

const digits = (s: string) => Number(s.replace(/\D/g, ''))

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: MODEL_LIST })
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

// Runs what the CLI runs (resolveContextWindows, then review) and reads each stage's budget from its over-budget message.
async function budgets(reviewer: string, judge: string, override = 0) {
  vi.resetModules()
  const cfg = (await import('../../config.js')).config as unknown as { anthropic: { model: string; modelContextTokens: number }; judge: { model: string } }
  cfg.anthropic.model = reviewer
  cfg.judge.model = judge
  cfg.anthropic.modelContextTokens = override
  const client = await import('../client.js')
  vi.mocked((await import('../../prompt/loader.js')).loadPrompt).mockResolvedValue({ content: 'System prompt here', source: 'repo' })
  vi.mocked((await import('../../context/fetcher.js')).fetchContext).mockResolvedValue([])
  const { resolveContextWindows } = await import('../../llm/context-window.js')
  const { review } = await import('../index.js')
  await resolveContextWindows()

  const skipped = await review(adapter(diffOf('d'.repeat(GIANT))), '1', true)
  const main = digits(skipped!.skip_reason!.match(/input budget \(([^;]+);/)![1])

  const finding = { severity: 'MEDIUM' as const, title: 't'.repeat(GIANT), file: 'src/a.ts', lines: '1', body: 'b' }
  vi.mocked(client.runReview).mockResolvedValue({ text: '### Summary\nok', usage: { input_tokens: 1, output_tokens: 1 }, review: { summary: 'ok', findings: [finding], behavioral_diff: [], production_risk: [], unresolved_questions: [] } })
  vi.mocked(client.runJudge).mockRejectedValue(new Error('judge not under test'))
  log.mockClear()
  await review(adapter(diffOf('small')), '1', true).catch(() => null)
  const lines: string[] = log.mock.calls.map((c: unknown[]) => String(c[0]))
  const stage = (prefix: string) => {
    const line = lines.find(l => l.startsWith(prefix))
    return line ? { model: line.match(/exceeds the (\S+) budget/)![1], budget: digits(line.match(/budget \(([^)]+)\)$/)![1]) } : undefined
  }
  expect(client.runBreadth).not.toHaveBeenCalled()
  expect(client.runLens).not.toHaveBeenCalled()
  return { main, breadth: stage('  Breadth review skipped:'), secondLook: stage('  Second-look skipped:'), lens: stage('  Lens security skipped:'), lookups: get.mock.calls.length }
}

describe('input budgets per stage (MAX_INPUT_TOKENS 2,000,000, MAX_OUTPUT_TOKENS 32,000)', () => {
  it('(Claude, Claude): anthropic/claude-haiku-5.5 everywhere keeps 968,000 on every stage with no model-list call', async () => {
    expect(await budgets(CLAUDE, CLAUDE)).toEqual({
      main: 968_000, breadth: { model: CLAUDE, budget: 968_000 }, secondLook: { model: CLAUDE, budget: 968_000 }, lens: { model: CLAUDE, budget: 968_000 }, lookups: 0,
    })
  })

  it('(luna, luna): the listed 1,050,000 window lifts every stage from 168,000 to 1,018,000', async () => {
    expect(await budgets(LUNA, LUNA)).toEqual({
      main: 1_018_000, breadth: { model: LUNA, budget: 1_018_000 }, secondLook: { model: LUNA, budget: 1_018_000 }, lens: { model: LUNA, budget: 1_018_000 }, lookups: 1,
    })
  })

  it('(luna reviewer, Haiku 4.5 judge): the known 200K judge still caps the main and breadth budgets; reviewer-model stages get luna\'s window', async () => {
    expect(await budgets(LUNA, HAIKU_45)).toEqual({
      main: 168_000, breadth: { model: HAIKU_45, budget: 168_000 }, secondLook: { model: LUNA, budget: 1_018_000 }, lens: { model: LUNA, budget: 1_018_000 }, lookups: 1,
    })
  })

  it('MODEL_CONTEXT_TOKENS=1,000,000 with (luna, luna): one variable sets every stage, no model-list call', async () => {
    expect(await budgets(LUNA, LUNA, 1_000_000)).toEqual({
      main: 968_000, breadth: { model: LUNA, budget: 968_000 }, secondLook: { model: LUNA, budget: 968_000 }, lens: { model: LUNA, budget: 968_000 }, lookups: 0,
    })
  })

  it('MODEL_CONTEXT_TOKENS=1,000,000 with (luna, Haiku 4.5): the override cannot lift past the known judge window', async () => {
    expect(await budgets(LUNA, HAIKU_45, 1_000_000)).toEqual({
      main: 168_000, breadth: { model: HAIKU_45, budget: 168_000 }, secondLook: { model: LUNA, budget: 968_000 }, lens: { model: LUNA, budget: 968_000 }, lookups: 0,
    })
  })
})
