import { describe, it, expect, vi } from 'vitest'
import { detectStack } from '../stack.js'
import { loadPrompt } from '../loader.js'
import type { VCSAdapter, PRInfo, ChangedFile } from '../../vcs/adapter.js'

function changed(...paths: string[]): ChangedFile[] {
  return paths.map(p => ({ path: p, status: 'modified' as const }))
}

describe('detectStack', () => {
  it('classifies by extension', () => {
    expect(detectStack(changed('a/B.java', 'a/C.java'))).toBe('java-spring')
    expect(detectStack(changed('app/main.py', 'app/util.py'))).toBe('python')
    expect(detectStack(changed('src/a.ts', 'src/b.ts'))).toBe('typescript-node')
  })

  it('treats one Angular marker as claiming all ts and web-asset files', () => {
    const files = changed('src/app/x.component.ts', 'src/app/x.service.ts', 'src/app/x.component.html', 'src/app/x.component.scss')
    expect(detectStack(files)).toBe('angular-ionic')
  })

  it('does not call plain html/css Angular without a marker', () => {
    expect(detectStack(changed('public/index.html', 'public/site.css'))).toBeNull()
  })

  it('ignores config, docs, assets and deleted files in the vote', () => {
    const files: ChangedFile[] = [
      ...changed('pom.xml', 'README.md', 'package-lock.json', 'logo.png', 'Dockerfile', 'src/A.java'),
      { path: 'old/a.py', status: 'deleted' },
      { path: 'old/b.py', status: 'deleted' },
    ]
    expect(detectStack(files)).toBe('java-spring')
  })

  it('returns null when only neutral files changed', () => {
    expect(detectStack(changed('README.md', 'config.yml'))).toBeNull()
    expect(detectStack([])).toBeNull()
  })

  it('requires a strict majority — a tie falls through', () => {
    expect(detectStack(changed('A.java', 'b.py'))).toBeNull()
    expect(detectStack(changed('A.java', 'B.java', 'c.py'))).toBe('java-spring')
  })

  it('counts unsupported-language source against every stack', () => {
    expect(detectStack(changed('A.java', 'b.go', 'c.go'))).toBeNull()
  })
})

const PR: PRInfo = {
  id: '1', title: 'Test', description: '', author: 'dev',
  sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'abc123def456',
}

function adapterWith(files: Record<string, string>): VCSAdapter {
  return { getRepoFileContent: vi.fn(async (path: string) => files[path] ?? null) } as unknown as VCSAdapter
}

describe('loadPrompt stack selection', () => {
  it('uses the stack rule set when no repo prompt exists', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('src/A.java', 'src/B.java'))

    expect(result.source).toBe('stack:java-spring')
    expect(result.content).toContain('Senior Backend Architect')
    expect(result.content).not.toContain('{{')
  })

  it('falls back to the default prompt when no stack wins', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('A.java', 'b.py'))

    expect(result.source).toBe('default')
  })

  it('repo prompt wins over the stack rule set', async () => {
    const adapter = adapterWith({ '.agent-review-instructions.md': '## ROLE\nRepo reviewer.' })

    const result = await loadPrompt(adapter, PR, undefined, changed('src/A.java'))

    expect(result.source).toBe('repo')
    expect(result.content).toContain('Repo reviewer.')
    expect(result.content).not.toContain('Senior Backend Architect')
  })

  it('--prompt file wins over the stack rule set', async () => {
    const adapter = adapterWith({})

    const result = await loadPrompt(adapter, PR, 'prompts/angular-ionic.txt', changed('src/A.java'))

    expect(result.source).toBe('prompts/angular-ionic.txt')
    expect(adapter.getRepoFileContent).not.toHaveBeenCalled()
  })

  it('loads every bundled stack file', async () => {
    const samples: Record<string, string[]> = {
      'angular-ionic': ['a.component.ts', 'b.component.html'],
      'java-spring': ['A.java'],
      'typescript-node': ['a.ts'],
      python: ['a.py'],
    }
    for (const [stack, paths] of Object.entries(samples)) {
      const result = await loadPrompt(adapterWith({}), PR, undefined, changed(...paths))
      expect(result.source).toBe(`stack:${stack}`)
      expect(result.content).not.toContain('{{')
    }
  })
})
