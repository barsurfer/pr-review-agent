import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// loader.ts now imports config, which requires ANTHROPIC_API_KEY at load.
vi.hoisted(() => { process.env.ANTHROPIC_API_KEY ??= 'test-key' })

import { loadPrompt, getBaseTemplate, applyNitpickTransform, NITPICK_SENTINELS } from '../loader.js'
import { config } from '../../config.js'
import type { VCSAdapter, PRInfo, ChangedFile } from '../../vcs/adapter.js'

const RAW_BASE_PROMPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../base-prompt.txt'), 'utf-8')

// ---------------------------------------------------------------------------
// Module-dir fallback — PRs confined to one top-level directory (monorepo
// module) also probe <dir>/.agent-review-instructions.md and <dir>/docs/...
// ---------------------------------------------------------------------------

const PR: PRInfo = {
  id: '1', title: 'Test', description: '', author: 'dev',
  sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'abc123def456',
}

const MODULE_PROMPT = '## ROLE\nModule reviewer.'

function adapterWith(files: Record<string, string>): VCSAdapter {
  return {
    getRepoFileContent: vi.fn(async (path: string) => files[path] ?? null),
  } as unknown as VCSAdapter
}

function changed(...paths: string[]): ChangedFile[] {
  return paths.map(p => ({ path: p, status: 'modified' as const }))
}

describe('loadPrompt module-dir fallback', () => {
  it('finds instructions inside a single top-level module dir', async () => {
    const adapter = adapterWith({ 'web-app/docs/.agent-review-instructions.md': MODULE_PROMPT })

    const result = await loadPrompt(adapter, PR, undefined, changed('web-app/src/a.groovy', 'web-app/docs/x.md'))

    expect(result.source).toBe('repo')
    expect(result.content).toContain('Module reviewer.')
  })

  it('repo-root instructions win over module instructions', async () => {
    const adapter = adapterWith({
      '.agent-review-instructions.md': '## ROLE\nRoot reviewer.',
      'web-app/docs/.agent-review-instructions.md': MODULE_PROMPT,
    })

    const result = await loadPrompt(adapter, PR, undefined, changed('web-app/src/a.groovy'))

    expect(result.content).toContain('Root reviewer.')
    expect(result.content).not.toContain('Module reviewer.')
  })

  it('does not guess when changes span multiple top-level dirs', async () => {
    const adapter = adapterWith({ 'web-app/docs/.agent-review-instructions.md': MODULE_PROMPT })

    const result = await loadPrompt(adapter, PR, undefined, changed('web-app/src/a.groovy', 'api-app/src/b.groovy'))

    expect(result.source).toBe('default')
  })

  it('root-level changed files do not break single-module detection', async () => {
    const adapter = adapterWith({ 'web-app/docs/.agent-review-instructions.md': MODULE_PROMPT })

    const result = await loadPrompt(adapter, PR, undefined, changed('web-app/src/a.groovy', 'Jenkinsfile'))

    expect(result.source).toBe('repo')
  })

  it('falls back to defaults when nothing is found anywhere', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('web-app/src/a.groovy'))

    expect(result.source).toBe('default')
  })
})

describe('security baseline', () => {
  it('injects the generic OWASP baseline when no SECURITY section is provided', async () => {
    const result = await loadPrompt(adapterWith({}), PR)

    expect(result.content).toContain('## SECURITY')
    expect(result.content).toContain('SSRF')
  })

  it('still injects the baseline when a repo prompt omits SECURITY', async () => {
    const adapter = adapterWith({ '.agent-review-instructions.md': MODULE_PROMPT })

    const result = await loadPrompt(adapter, PR, undefined, changed('src/a.ts'))

    expect(result.source).toBe('repo')
    expect(result.content).toContain('SSRF')
  })

  it('a repo SECURITY section overrides the baseline', async () => {
    const adapter = adapterWith({
      '.agent-review-instructions.md': '## ROLE\nX\n\n## SECURITY\n- Only check our custom auth flow.',
    })

    const result = await loadPrompt(adapter, PR, undefined, changed('src/a.ts'))

    expect(result.content).toContain('Only check our custom auth flow.')
    expect(result.content).not.toContain('SSRF')
  })
})

describe('getBaseTemplate / ENABLE_NITPICKS transform', () => {
  afterEach(() => { config.review.enableNitpicks = false })

  it('off: getBaseTemplate returns the raw base-prompt bytes unchanged (file path)', () => {
    config.review.enableNitpicks = false
    expect(getBaseTemplate()).toBe(RAW_BASE_PROMPT)
  })

  it('off: the transform is the identity (the single gate for both the file and embed load paths)', () => {
    config.review.enableNitpicks = false
    expect(applyNitpickTransform(RAW_BASE_PROMPT)).toBe(RAW_BASE_PROMPT)
    const embedLike = 'arbitrary\nembedded\nbytes'
    expect(applyNitpickTransform(embedLike)).toBe(embedLike)
  })

  it('on: relaxes the low-severity certainty rule, keeps the anti-speculation clause, adds minor-issue guidance', () => {
    config.review.enableNitpicks = true
    const out = getBaseTemplate()
    expect(out).not.toContain(NITPICK_SENTINELS[0])
    expect(out).toContain('prefer not reporting over guessing')   // anti-speculation clause preserved
    expect(out).toContain('duplicated logic')   // relaxed-only phrase (absent from the raw template), so this proves the transform ran
    expect(out).toContain('dead code')
  })

  it('on: adds the non-code files rule as its own bullet; off: it is absent', () => {
    config.review.enableNitpicks = true
    expect(getBaseTemplate()).toMatch(/\n- Non-code files in the diff .*reviewed like code\./)
    config.review.enableNitpicks = false
    expect(getBaseTemplate()).not.toContain('Non-code files in the diff')
  })

  it('on: leaves the FORBIDDEN style/nitpick lines untouched', () => {
    config.review.enableNitpicks = true
    const out = getBaseTemplate()
    expect(out).toContain(NITPICK_SENTINELS[1])
    expect(out).toContain(NITPICK_SENTINELS[2])
  })

  it('on: composes through loadPrompt — nitpick guidance present and repo EXCEPTIONS still injected', async () => {
    config.review.enableNitpicks = true
    const adapter = adapterWith({ '.agent-review-instructions.md': '## ROLE\nX\n\n## EXCEPTIONS\n- Ignore generated files.' })
    const result = await loadPrompt(adapter, PR, undefined, changed('src/a.ts'))
    expect(result.content).toContain('duplicated logic')
    expect(result.content).toContain('Ignore generated files.')
    expect(result.content).not.toContain(NITPICK_SENTINELS[0])
  })

  it('sentinel: the 3 target sentences still exist verbatim in base-prompt.txt', () => {
    for (const sentence of NITPICK_SENTINELS) expect(RAW_BASE_PROMPT).toContain(sentence)
  })
})
