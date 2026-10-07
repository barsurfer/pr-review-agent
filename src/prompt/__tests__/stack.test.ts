import { describe, it, expect, vi } from 'vitest'
import { detectStacks } from '../stack.js'
import { loadPrompt } from '../loader.js'
import type { VCSAdapter, PRInfo, ChangedFile } from '../../vcs/adapter.js'

function changed(...paths: string[]): ChangedFile[] {
  return paths.map(p => ({ path: p, status: 'modified' as const }))
}

const addLines = (...lines: string[]) => lines.map(l => `+${l}`).join('\n')

describe('detectStacks bases', () => {
  it('classifies by extension', () => {
    expect(detectStacks(changed('a/B.java', 'a/C.java')).bases).toEqual(['java'])
    expect(detectStacks(changed('A.kt', 'B.kts')).bases).toEqual(['kotlin'])
    expect(detectStacks(changed('app/main.py')).bases).toEqual(['python'])
    expect(detectStacks(changed('src/a.ts', 'src/b.js')).bases).toEqual(['typescript-node'])
    expect(detectStacks(changed('src/App.tsx', 'src/a.ts')).bases).toEqual(['frontend'])
  })

  it('claims plain ts for frontend on a React import in the diff', () => {
    const sel = detectStacks(changed('src/hook.ts', 'src/util.ts'), addLines("import { useState } from 'react'"))
    expect(sel.bases).toEqual(['frontend'])
  })

  it('ignores config, docs, assets and deleted files', () => {
    const files: ChangedFile[] = [
      ...changed('pom.xml', 'README.md', 'package-lock.json', 'logo.png', 'Dockerfile', 'src/A.java'),
      { path: 'old/a.py', status: 'deleted' },
    ]
    expect(detectStacks(files).bases).toEqual(['java'])
  })

  it('returns nothing when nothing classifiable changed', () => {
    expect(detectStacks(changed('README.md', 'config.yml'))).toEqual({ bases: [], overlays: [] })
    expect(detectStacks([])).toEqual({ bases: [], overlays: [] })
  })

  it('injects every base above the floor, largest first', () => {
    const sel = detectStacks(changed('a.py', 'b.py', 'c.py', 'A.java', 'B.java'))
    expect(sel.bases).toEqual(['python', 'java'])
  })

  it('drops bases below the floor and counts unsupported languages against them', () => {
    const files = changed('A.java', 'a.go', 'b.go', 'c.go', 'd.go', 'e.go')
    expect(detectStacks(files).bases).toEqual([])
  })
})

describe('detectStacks overlays', () => {
  it('plain java without a spring marker stays generic', () => {
    expect(detectStacks(changed('src/A.java'), addLines('import java.util.List;', '@Service')).overlays).toEqual([])
  })

  it('adds spring from an org.springframework import (java and kotlin)', () => {
    const diff = addLines('import org.springframework.stereotype.Service')
    expect(detectStacks(changed('A.java'), diff)).toEqual({ bases: ['java'], overlays: ['spring'] })
    expect(detectStacks(changed('A.kt'), diff)).toEqual({ bases: ['kotlin'], overlays: ['spring'] })
  })

  it('adds spring from an unambiguous annotation when the import block is outside the hunk', () => {
    expect(detectStacks(changed('A.java'), ' @RestController\n+public class A {}').overlays).toEqual(['spring'])
  })

  it('does not add spring without a jvm base', () => {
    expect(detectStacks(changed('a.py'), addLines('import org.springframework.x')).overlays).toEqual([])
  })

  it('adds angular from a component path, with the frontend base', () => {
    const sel = detectStacks(changed('x.component.ts', 'x.service.ts', 'x.component.html'))
    expect(sel).toEqual({ bases: ['frontend'], overlays: ['angular'] })
  })

  it('adds angular from an @angular import in the diff', () => {
    const sel = detectStacks(changed('x.service.ts'), addLines("import { Injectable } from '@angular/core'"))
    expect(sel).toEqual({ bases: ['frontend'], overlays: ['angular'] })
  })

  it('does not treat NestJS-style .module.ts as angular', () => {
    expect(detectStacks(changed('app.module.ts', 'app.service.ts'))).toEqual({ bases: ['typescript-node'], overlays: [] })
  })

  it('adds ionic from capacitor/ionic imports alongside angular', () => {
    const diff = addLines("import { Camera } from '@capacitor/camera'", "import { Component } from '@angular/core'")
    expect(detectStacks(changed('a.component.ts'), diff).overlays).toEqual(['angular', 'ionic'])
  })

  it('does not add an overlay whose base is below the floor', () => {
    const files = changed('x.component.ts', 'a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'f.py', 'g.py')
    expect(detectStacks(files).overlays).toEqual([])
  })
})

const PR: PRInfo = {
  id: '1', title: 'Test', description: '', author: 'dev',
  sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'abc123def456',
}

function adapterWith(files: Record<string, string>): VCSAdapter {
  return { getRepoFileContent: vi.fn(async (path: string) => files[path] ?? null) } as unknown as VCSAdapter
}

describe('loadPrompt stack composition', () => {
  it('uses the generic java base for plain java', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('src/A.java'), addLines('import java.util.List;'))

    expect(result.source).toBe('stack:java')
    expect(result.content).toContain('Senior Backend Architect')
    expect(result.content).not.toContain('Spring / JPA Specifics')
  })

  it('layers the spring overlay on the java base', async () => {
    const diff = addLines('import org.springframework.stereotype.Service')

    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('src/A.java'), diff)

    expect(result.source).toBe('stack:java+spring')
    expect(result.content).toContain('Senior Backend Architect')
    expect(result.content).toContain('Spring / JPA Specifics')
    expect(result.content).toContain('@MockBean')
  })

  it('composes multiple bases with one role and de-duplicated shared lines', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('a.py', 'b.py', 'A.java'))

    expect(result.source).toBe('stack:python+java')
    expect(result.content).toContain('Senior Python Engineer')
    expect(result.content).not.toContain('Senior Backend Architect')
    expect(result.content).toContain('Ignore System.out')
    const todoLine = 'Do not flag new methods/functions with no callers in the diff if they have a TODO/FIXME comment indicating upcoming work'
    expect(result.content.split(todoLine).length - 1).toBe(1)
  })

  it('composes frontend + angular + ionic', async () => {
    const diff = addLines("import { Camera } from '@capacitor/camera'")

    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('a.component.ts'), diff)

    expect(result.source).toBe('stack:frontend+angular+ionic')
    expect(result.content).toContain('Senior Frontend Architect')
    expect(result.content).toContain('Angular Specifics')
    expect(result.content).toContain('Ionic / Mobile Specifics')
    expect(result.content).not.toContain('{{')
  })

  it('falls back to the default prompt when nothing is detected', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('README.md', 'a.go'))

    expect(result.source).toBe('default')
  })

  it('repo prompt wins over the stacks', async () => {
    const adapter = adapterWith({ '.agent-review-instructions.md': '## ROLE\nRepo reviewer.' })

    const result = await loadPrompt(adapter, PR, undefined, changed('src/A.java'))

    expect(result.source).toBe('repo')
    expect(result.content).toContain('Repo reviewer.')
    expect(result.content).not.toContain('Senior Backend Architect')
  })

  it('--prompt file wins over the stacks', async () => {
    const adapter = adapterWith({})

    const result = await loadPrompt(adapter, PR, 'prompts/angular-ionic.txt', changed('src/A.java'))

    expect(result.source).toBe('prompts/angular-ionic.txt')
    expect(adapter.getRepoFileContent).not.toHaveBeenCalled()
  })

  it('loads every bundled fragment', async () => {
    const cases: [string[], string][] = [
      [['A.java'], 'java'], [['A.kt'], 'kotlin'], [['a.py'], 'python'],
      [['a.ts'], 'typescript-node'], [['App.tsx'], 'frontend'],
    ]
    for (const [paths, source] of cases) {
      const result = await loadPrompt(adapterWith({}), PR, undefined, changed(...paths))
      expect(result.source).toBe(`stack:${source}`)
      expect(result.content).not.toContain('{{')
    }
  })
})
