import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'

// config.ts calls required('ANTHROPIC_API_KEY') at import, so set it before the dynamic import.
let modelContextWindow: (model: string) => number
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  ;({ modelContextWindow } = await import('../config.js'))
})

describe('modelContextWindow', () => {
  it('maps 4.5-generation reviewers to 200K', () => {
    expect(modelContextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(modelContextWindow('claude-sonnet-4-5-20250929')).toBe(200_000)
    expect(modelContextWindow('claude-opus-4-5')).toBe(200_000)
  })

  it('maps 4.6+/5.x reviewers (incl. Haiku 5.5) to 1M', () => {
    expect(modelContextWindow('claude-haiku-5-5')).toBe(1_000_000)
    expect(modelContextWindow('claude-sonnet-4-6')).toBe(1_000_000)
    expect(modelContextWindow('claude-sonnet-5')).toBe(1_000_000)
    expect(modelContextWindow('claude-sonnet-5-5')).toBe(1_000_000)
    expect(modelContextWindow('claude-opus-4-8')).toBe(1_000_000)
    expect(modelContextWindow('claude-opus-5-5')).toBe(1_000_000)
  })

  it('falls back to a conservative 200K for an unmapped model', () => {
    expect(modelContextWindow('claude-something-7')).toBe(200_000)
  })
})

describe('breadth settings', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const load = async (env: Record<string, string>) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.resetModules()
    return (await import('../config.js')).config.breadth
  }

  it('falls back to the default thresholds when the parameter is empty or not a number', async () => {
    expect(await load({ BREADTH_MIN_FILES: '', BREADTH_MIN_UNTOUCHED: '' })).toMatchObject({ minFiles: 5, minUntouched: 3 })
    expect(await load({ BREADTH_MIN_FILES: 'many', BREADTH_MIN_UNTOUCHED: 'few' })).toMatchObject({ minFiles: 5, minUntouched: 3 })
  })

  it('honors explicit thresholds, including 0', async () => {
    expect(await load({ BREADTH_MIN_FILES: '8', BREADTH_MIN_UNTOUCHED: '0' })).toMatchObject({ minFiles: 8, minUntouched: 0 })
  })

  it('reads the benchmark deadline with the entrypoint fallback for empty, malformed or non-positive values', async () => {
    expect((await load({ BENCHMARK_DEADLINE_SECONDS: '600' })).benchmarkDeadlineSeconds).toBe(600)
    for (const bad of ['', '15m', '0', '-5']) {
      expect((await load({ BENCHMARK_DEADLINE_SECONDS: bad })).benchmarkDeadlineSeconds).toBe(840)
    }
  })
})

describe('lens settings', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const load = async (env: Record<string, string>) => {
    vi.unstubAllEnvs()
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.resetModules()
    return (await import('../config.js')).config.lenses
  }

  it('defaults to off with an empty list and model', async () => {
    expect(await load({})).toEqual({ enabled: false, list: '', model: '', recommend: false })
  })

  it('turns on only from the exact string true and keeps LENSES unparsed', async () => {
    expect(await load({ ENABLE_LENSES: 'true', LENSES: 'reliability+security', LENS_MODEL: 'claude-haiku-5-5' }))
      .toEqual({ enabled: true, list: 'reliability+security', model: 'claude-haiku-5-5', recommend: false })
    expect((await load({ ENABLE_LENSES: '1' })).enabled).toBe(false)
  })

  it('ENABLE_LENS_RECOMMENDATION turns on only from the exact string true, independent of ENABLE_LENSES', async () => {
    expect(await load({ ENABLE_LENS_RECOMMENDATION: 'true' })).toEqual({ enabled: false, list: '', model: '', recommend: true })
    for (const value of ['false', '1', '']) expect((await load({ ENABLE_LENS_RECOMMENDATION: value })).recommend).toBe(false)
  })
})

describe('branch and trigger settings', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const load = async (env: Record<string, string>) => {
    vi.unstubAllEnvs()
    for (const name of ['SKIP_SOURCE_BRANCHES', 'SKIP_TARGET_BRANCHES', 'ONLY_TARGET_BRANCHES', 'TRIGGER_EVENT', 'TRIGGER_COMMENT_AUTHOR', 'IGNORE_COMMENT_AUTHORS']) {
      vi.stubEnv(name, env[name] as string)
    }
    vi.resetModules()
    return (await import('../config.js')).config
  }

  it('ONLY_TARGET_BRANCHES defaults to [] and stays [] for empty, whitespace and bare commas; parses and trims a list', async () => {
    expect((await load({})).onlyTargetBranches).toEqual([])
    for (const value of ['', ' ', ',', ' , ']) expect((await load({ ONLY_TARGET_BRANCHES: value })).onlyTargetBranches).toEqual([])
    expect((await load({ ONLY_TARGET_BRANCHES: ' develop , release/* ,' })).onlyTargetBranches).toEqual(['develop', 'release/*'])
  })

  it('skip-list defaults are unchanged', async () => {
    const c = await load({})
    expect(c.skipSourceBranches).toEqual(['main', 'master', 'release/*', 'hotfix/*'])
    expect(c.skipTargetBranches).toEqual(['main', 'master'])
  })

  it('trigger settings default to empty, trim values, and split/trim/filter IGNORE_COMMENT_AUTHORS', async () => {
    expect((await load({})).trigger).toEqual({ event: '', commentAuthor: '', ignoreCommentAuthors: [] })
    expect((await load({ TRIGGER_EVENT: ' pullrequest:comment_created ', TRIGGER_COMMENT_AUTHOR: ' {abc} ', IGNORE_COMMENT_AUTHORS: ' {a} ,, b ,' })).trigger)
      .toEqual({ event: 'pullrequest:comment_created', commentAuthor: '{abc}', ignoreCommentAuthors: ['{a}', 'b'] })
    expect((await load({ IGNORE_COMMENT_AUTHORS: ' , ' })).trigger.ignoreCommentAuthors).toEqual([])
  })
})

describe('parseBranchList (branch-list env vars and their CLI overrides)', () => {
  it('trims entries and drops empty ones; an empty or blank value is an empty list', async () => {
    const { parseBranchList } = await import('../config.js')
    expect(parseBranchList('')).toEqual([])
    for (const blank of [' ', ',', ' , , ']) expect(parseBranchList(blank)).toEqual([])
    expect(parseBranchList('main')).toEqual(['main'])
    expect(parseBranchList(' main , ,release/* ,')).toEqual(['main', 'release/*'])
  })

  it('is exactly what the env values get', async () => {
    vi.unstubAllEnvs()
    vi.stubEnv('SKIP_SOURCE_BRANCHES', ' a ,, b/* ')
    vi.stubEnv('SKIP_TARGET_BRANCHES', ' , ')
    vi.stubEnv('ONLY_TARGET_BRANCHES', 'main,')
    vi.resetModules()
    try {
      const { config, parseBranchList } = await import('../config.js')
      expect(config.skipSourceBranches).toEqual(parseBranchList(' a ,, b/* '))
      expect(config.skipTargetBranches).toEqual(parseBranchList(' , '))
      expect(config.onlyTargetBranches).toEqual(parseBranchList('main,'))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('checked commit setting', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const load = async (value: string | undefined) => {
    vi.unstubAllEnvs()
    vi.stubEnv('LAST_CHECKED_COMMIT', value as string)
    vi.resetModules()
    return (await import('../config.js')).config.lastCheckedCommit
  }

  it('C1 LAST_CHECKED_COMMIT defaults to empty and is trimmed, otherwise unparsed', async () => {
    expect(await load(undefined)).toBe('')
    expect(await load('')).toBe('')
    expect(await load('  ')).toBe('')
    expect(await load(' 0123456789AB ')).toBe('0123456789AB')
    expect(await load('garbage')).toBe('garbage')
  })
})

describe('llmApiKey — conditional required key per provider', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('keeps the exact ANTHROPIC_API_KEY throw for the default anthropic provider', async () => {
    vi.stubEnv('LLM_PROVIDER', 'anthropic'); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', 'or-key')
    vi.resetModules()
    await expect(import('../config.js')).rejects.toThrow('Missing required environment variable: ANTHROPIC_API_KEY')
  })

  it('requires only OPENROUTER_API_KEY when LLM_PROVIDER=openrouter', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter'); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', 'or-key')
    vi.resetModules()
    const { config } = await import('../config.js')
    expect(config.llmProvider).toBe('openrouter')
    expect(config.llmApiKey).toBe('or-key')
  })

  it('falls back to the ANTHROPIC_API_KEY slot for openrouter when OPENROUTER_API_KEY is unset', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter'); vi.stubEnv('ANTHROPIC_API_KEY', 'anth-key'); vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.resetModules()
    const { config } = await import('../config.js')
    expect(config.llmApiKey).toBe('anth-key')
  })

  it('throws for openrouter when neither key is set', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openrouter'); vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.resetModules()
    await expect(import('../config.js')).rejects.toThrow(/OPENROUTER_API_KEY/)
  })
})

describe('recall-lever flags', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  const load = async (env: Record<string, string>) => {
    vi.unstubAllEnvs()
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.resetModules()
    return (await import('../config.js')).config
  }

  it('all four default to off', async () => {
    const c = await load({})
    expect([c.judge.quality, c.judge.shownAnchors, c.review.secondLookBreadthTargets, c.breadth.priorityTargets]).toEqual([false, false, false, false])
  })

  it('ENABLE_JUDGE_PROPOSALS defaults off and turns on only from the exact string true', async () => {
    expect((await load({})).judge.proposals).toBe(false)
    expect((await load({ ENABLE_JUDGE_PROPOSALS: 'true' })).judge.proposals).toBe(true)
    expect((await load({ ENABLE_JUDGE_PROPOSALS: '1' })).judge.proposals).toBe(false)
  })

  it('each turns on only from the exact string true, independently', async () => {
    expect((await load({ ENABLE_JUDGE_QUALITY: 'true' })).judge).toMatchObject({ quality: true, shownAnchors: false })
    expect((await load({ ENABLE_JUDGE_SHOWN_CONTEXT_ANCHORS: 'true' })).judge).toMatchObject({ quality: false, shownAnchors: true })
    expect((await load({ ENABLE_SECOND_LOOK_BREADTH_TARGETS: 'true' })).review.secondLookBreadthTargets).toBe(true)
    expect((await load({ ENABLE_BREADTH_PRIORITY_TARGETS: 'true' })).breadth.priorityTargets).toBe(true)
    expect((await load({ ENABLE_JUDGE_QUALITY: '1' })).judge.quality).toBe(false)
  })

  it('ENABLE_JUDGE_QUALITY unset and explicitly false yield identical judge and review config', async () => {
    const unset = await load({})
    const snapshot = JSON.stringify([unset.judge, unset.review, unset.breadth])
    const explicit = await load({ ENABLE_JUDGE_QUALITY: 'false' })
    expect(explicit.judge.quality).toBe(false)
    expect(JSON.stringify([explicit.judge, explicit.review, explicit.breadth])).toBe(snapshot)
  })
})
