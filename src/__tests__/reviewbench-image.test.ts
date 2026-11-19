import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'

// A run reads its no-label config only from the image's ENV, so pin the Dockerfile against the names config.ts reads.

const DOCKERFILE = readFileSync(new URL('../../reviewbench/Dockerfile', import.meta.url), 'utf-8')

// ENV as a build with no --build-arg leaves it: each $ARG reference takes that ARG's default.
function bakedEnv(source: string): { env: Record<string, string>; undeclared: string[] } {
  const args: Record<string, string> = {}
  const env: Record<string, string> = {}
  const undeclared: string[] = []
  const lines = source.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
  // Only the last stage becomes the image: an ARG or ENV from an earlier stage is not in scope there.
  const lastStage = lines.slice(lines.reduce((start, line, i) => (/^FROM\s/i.test(line) ? i + 1 : start), 0))
  for (const line of lastStage) {
    const [, kind, rest] = line.match(/^(ARG|ENV)\s+(.+)$/) ?? []
    if (!kind) continue
    for (const pair of rest.trim().split(/\s+/)) {
      const eq = pair.indexOf('=')
      const name = eq < 0 ? pair : pair.slice(0, eq)
      const value = (eq < 0 ? '' : pair.slice(eq + 1)).replace(/\$\{?(\w+)\}?/g, (_, ref: string) => {
        if (!Object.hasOwn(args, ref)) undeclared.push(ref)
        return args[ref] ?? ''
      })
      if (kind === 'ARG') args[name] = value
      else env[name] = value
    }
  }
  return { env, undeclared }
}

describe('reviewbench/Dockerfile baked defaults', () => {
  const { env, undeclared } = bakedEnv(DOCKERFILE)

  afterEach(() => { vi.unstubAllEnvs() })

  it('declares every ARG its ENV references', () => {
    expect(undeclared).toEqual([])
  })

  it('reads only the last stage: an ARG or ENV declared before the last FROM does not count', () => {
    const twoStage = 'ARG LENSES=rel\nENV EARLY=1\nFROM node AS build\nARG EFFORT=high\nFROM node\nENV LENSES=$LENSES REVIEW_EFFORT=$EFFORT'

    expect(bakedEnv(twoStage)).toEqual({ env: { LENSES: '', REVIEW_EFFORT: '' }, undeclared: ['LENSES', 'EFFORT'] })
  })

  it('bakes the haiku-5-5 judge, high reviewer and judge effort, and the reliability lens', () => {
    expect(env).toMatchObject({ JUDGING_MODEL: 'claude-haiku-5-5', REVIEW_EFFORT: 'high', JUDGE_EFFORT: 'high', ENABLE_LENSES: 'true', LENSES: 'rel' })
  })

  it('leaves the test-gap policy and counterpart rows to their labels', () => {
    expect(env).not.toHaveProperty('ENABLE_JUDGE_KEEP_TEST_GAPS')
    expect(env).not.toHaveProperty('ENABLE_BENCHMARK_COUNTERPART_ROWS')
  })

  it('config.ts reads the baked env as that judge, those efforts and the reliability lens', async () => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.resetModules()
    const { config } = await import('../config.js')
    const { activeLenses } = await import('../review/lenses.js')

    expect([config.judge.model, config.review.effort, config.judge.effort]).toEqual(['claude-haiku-5-5', 'high', 'high'])
    expect(activeLenses(config.lenses).map(l => l.name)).toEqual(['reliability'])
  })

  it('bakes a 128k extra-pass cap and the pass deadline under the names config.ts reads, with reviewer and judge kept at 64k', async () => {
    expect(env).toMatchObject({ MAX_OUTPUT_TOKENS: '64000', EXTRA_PASS_MAX_OUTPUT_TOKENS: '128000', ENABLE_BENCHMARK_PASS_DEADLINE: 'true' })
    expect(env).not.toHaveProperty('ENABLE_FIRST_PASS_SITES')
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    vi.resetModules()
    const { config } = await import('../config.js')

    expect([config.anthropic.maxTokens, config.anthropic.extraPassMaxTokens, config.breadth.passDeadline, config.review.firstPassSites]).toEqual([64000, 128000, true, false])
  })
})
