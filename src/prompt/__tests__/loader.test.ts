import { describe, it, expect, vi } from 'vitest'
import { loadPrompt } from '../loader.js'
import type { VCSAdapter, PRInfo, ChangedFile } from '../../vcs/adapter.js'

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
    const adapter = adapterWith({ 'alice-web/docs/.agent-review-instructions.md': MODULE_PROMPT })

    const result = await loadPrompt(adapter, PR, undefined, changed('alice-web/src/a.groovy', 'alice-web/docs/x.md'))

    expect(result.source).toBe('repo')
    expect(result.content).toContain('Module reviewer.')
  })

  it('repo-root instructions win over module instructions', async () => {
    const adapter = adapterWith({
      '.agent-review-instructions.md': '## ROLE\nRoot reviewer.',
      'alice-web/docs/.agent-review-instructions.md': MODULE_PROMPT,
    })

    const result = await loadPrompt(adapter, PR, undefined, changed('alice-web/src/a.groovy'))

    expect(result.content).toContain('Root reviewer.')
    expect(result.content).not.toContain('Module reviewer.')
  })

  it('does not guess when changes span multiple top-level dirs', async () => {
    const adapter = adapterWith({ 'alice-web/docs/.agent-review-instructions.md': MODULE_PROMPT })

    const result = await loadPrompt(adapter, PR, undefined, changed('alice-web/src/a.groovy', 'alice-api/src/b.groovy'))

    expect(result.source).toBe('default')
  })

  it('root-level changed files do not break single-module detection', async () => {
    const adapter = adapterWith({ 'alice-web/docs/.agent-review-instructions.md': MODULE_PROMPT })

    const result = await loadPrompt(adapter, PR, undefined, changed('alice-web/src/a.groovy', 'Jenkinsfile'))

    expect(result.source).toBe('repo')
  })

  it('falls back to defaults when nothing is found anywhere', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('alice-web/src/a.groovy'))

    expect(result.source).toBe('default')
  })
})
