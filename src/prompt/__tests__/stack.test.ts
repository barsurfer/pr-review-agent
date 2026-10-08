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
    const files = changed('A.java', 'a.scala', 'b.scala', 'c.scala', 'd.scala', 'e.scala')
    expect(detectStacks(files).bases).toEqual([])
  })

  it('classifies C#, Go, and Rust', () => {
    expect(detectStacks(changed('src/A.cs', 'src/B.cs')).bases).toEqual(['csharp'])
    expect(detectStacks(changed('cmd/main.go', 'util.go')).bases).toEqual(['go'])
    expect(detectStacks(changed('src/lib.rs')).bases).toEqual(['rust'])
  })

  it('counts .razor/.cshtml/.xaml toward the csharp base', () => {
    expect(detectStacks(changed('Pages/Index.razor', 'App.xaml', 'Program.cs')).bases).toEqual(['csharp'])
  })

  it('a Go-dominant PR with a stray web file stays go, not frontend (mis-vote fix)', () => {
    expect(detectStacks(changed('main.go', 'a.go', 'b.go', 'c.go', 'd.go', 'ui/App.tsx')).bases).toEqual(['go'])
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

describe('detectStacks .NET overlays', () => {
  it('adds aspnet from an AspNetCore/EF import or a .cshtml path', () => {
    expect(detectStacks(changed('Api.cs'), addLines('using Microsoft.AspNetCore.Mvc;')).overlays).toEqual(['aspnet'])
    expect(detectStacks(changed('Views/Home.cshtml', 'HomeController.cs')).overlays).toContain('aspnet')
  })

  it('adds blazor from a .razor file', () => {
    expect(detectStacks(changed('Pages/Counter.razor', 'App.cs')).overlays).toContain('blazor')
  })

  it('adds maui from a Microsoft.Maui import', () => {
    expect(detectStacks(changed('MainPage.xaml.cs'), addLines('using Microsoft.Maui.Controls;')).overlays).toContain('maui')
  })

  it('adds winforms from System.Windows.Forms', () => {
    expect(detectStacks(changed('Form1.cs'), addLines('using System.Windows.Forms;')).overlays).toContain('winforms')
  })

  it('does not add a .NET overlay without a csharp base', () => {
    expect(detectStacks(changed('a.py'), addLines('using Microsoft.AspNetCore.Mvc;')).overlays).toEqual([])
  })
})

describe('detectStacks round-2 bases', () => {
  it('classifies each new language by extension', () => {
    expect(detectStacks(changed('run.sh', 'lib.bash', 't.bats')).bases).toEqual(['shell'])
    expect(detectStacks(changed('a.php', 'b.phpt')).bases).toEqual(['php'])
    expect(detectStacks(changed('a.c', 'b.cc', 'c.cpp', 'd.cxx', 'e.h', 'f.hpp', 'g.hh')).bases).toEqual(['cpp'])
    expect(detectStacks(changed('A.swift')).bases).toEqual(['swift'])
    expect(detectStacks(changed('main.tf', 'prod.tfvars')).bases).toEqual(['terraform'])
    expect(detectStacks(changed('a.rb')).bases).toEqual(['ruby'])
    expect(detectStacks(changed('lib/main.dart')).bases).toEqual(['dart'])
    expect(detectStacks(changed('x.ps1', 'M.psm1')).bases).toEqual(['powershell'])
  })

  it('counts Jupyter notebooks as python', () => {
    expect(detectStacks(changed('analysis.ipynb')).bases).toEqual(['python'])
  })

  it('classifies an extensionless script as shell from its shebang', () => {
    const diff = ['diff --git a/bin/deploy b/bin/deploy', '--- a/bin/deploy', '+++ b/bin/deploy', '@@ -1 +1,2 @@', '+#!/usr/bin/env bash', '+echo hi'].join('\n')
    expect(detectStacks(changed('bin/deploy'), diff).bases).toEqual(['shell'])
    expect(detectStacks(changed('bin/deploy'), diff.replace('env bash', 'bin/sh')).bases).toEqual(['shell'])
  })

  it('ignores extensionless files without a shell shebang', () => {
    const diff = ['diff --git a/Makefile b/Makefile', '+all:', '+\techo hi'].join('\n')
    expect(detectStacks(changed('Makefile'), diff).bases).toEqual([])
  })

  it('does not attribute a shebang from one file to another', () => {
    const diff = ['diff --git a/run b/run', '+#!/bin/bash', 'diff --git a/LICENSE b/LICENSE', '+text'].join('\n')
    expect(detectStacks(changed('run', 'LICENSE', 'a.py', 'b.py', 'c.py'), diff).bases).toEqual(['python', 'shell'])
  })
})

describe('detectStacks round-2 overlays', () => {
  it('adds laravel from Illuminate import, Model subclass, composer.json or artisan', () => {
    expect(detectStacks(changed('A.php'), addLines('use Illuminate\\Http\\Request;')).overlays).toEqual(['laravel'])
    expect(detectStacks(changed('User.php'), addLines('class User extends Model')).overlays).toEqual(['laravel'])
    expect(detectStacks(changed('a.php', 'composer.json'), addLines('"laravel/framework": "^11.0"')).overlays).toEqual(['laravel'])
    expect(detectStacks(changed('a.php', 'artisan')).overlays).toEqual(['laravel'])
  })

  it('plain php stays generic and laravel needs a php base', () => {
    expect(detectStacks(changed('a.php'), addLines('echo 1;')).overlays).toEqual([])
    expect(detectStacks(changed('a.py'), addLines('use Illuminate\\Http\\Request;')).overlays).toEqual([])
  })

  it('adds rails from controller/record superclass, Rails., routes.rb or Gemfile', () => {
    expect(detectStacks(changed('a.rb'), addLines('class A < ApplicationController')).overlays).toEqual(['rails'])
    expect(detectStacks(changed('a.rb'), addLines('class A < ApplicationRecord')).overlays).toEqual(['rails'])
    expect(detectStacks(changed('a.rb'), addLines('Rails.logger.info(1)')).overlays).toEqual(['rails'])
    expect(detectStacks(changed('a.rb', 'config/routes.rb')).overlays).toEqual(['rails'])
    expect(detectStacks(changed('a.rb', 'Gemfile'), addLines("gem 'rails', '~> 7.1'")).overlays).toEqual(['rails'])
  })

  it('plain ruby stays generic', () => {
    expect(detectStacks(changed('a.rb'), addLines('puts 1')).overlays).toEqual([])
  })

  it('adds android on kotlin or java from manifest, android imports, or gradle plugin', () => {
    expect(detectStacks(changed('A.kt'), addLines('import androidx.fragment.app.Fragment')).overlays).toEqual(['android'])
    expect(detectStacks(changed('A.java'), addLines('import android.os.Bundle;')).overlays).toEqual(['android'])
    expect(detectStacks(changed('A.kt', 'app/src/main/AndroidManifest.xml')).overlays).toEqual(['android'])
    expect(detectStacks(changed('A.java', 'app/build.gradle'), addLines('applicationId "com.x.y"')).overlays).toEqual(['android'])
    expect(detectStacks(changed('A.kt', 'build.gradle.kts'), addLines('id("com.android.application")')).overlays).toEqual(['android'])
  })

  it('does not add android without a jvm base', () => {
    expect(detectStacks(changed('a.py', 'AndroidManifest.xml')).overlays).toEqual([])
    expect(detectStacks(changed('A.java'), addLines('import java.util.List;')).overlays).toEqual([])
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
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('README.md', 'a.scala'))

    expect(result.source).toBe('default')
  })

  it('layers the aspnet overlay on the csharp base', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('HomeController.cs'), addLines('using Microsoft.AspNetCore.Mvc;'))

    expect(result.source).toBe('stack:csharp+aspnet')
    expect(result.content).toContain('Senior .NET Engineer')
    expect(result.content).toContain('ASP.NET Core / EF Core Specifics')
    expect(result.content).not.toContain('{{')
  })

  it('loads every bundled overlay fragment', async () => {
    const cases: [string, string, string][] = [
      ['A.php', 'use Illuminate\\Http\\Request;', 'php+laravel'],
      ['a.rb', 'class A < ApplicationRecord', 'ruby+rails'],
      ['A.kt', 'import androidx.fragment.app.Fragment', 'kotlin+android'],
    ]
    for (const [path, line, source] of cases) {
      const result = await loadPrompt(adapterWith({}), PR, undefined, changed(path), addLines(line))
      expect(result.source).toBe(`stack:${source}`)
      expect(result.content).not.toContain('{{')
    }
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
      [['A.cs'], 'csharp'], [['main.go'], 'go'], [['lib.rs'], 'rust'],
      [['a.sh'], 'shell'], [['a.php'], 'php'], [['a.c'], 'cpp'], [['A.swift'], 'swift'],
      [['main.tf'], 'terraform'], [['a.rb'], 'ruby'], [['a.dart'], 'dart'], [['a.ps1'], 'powershell'],
    ]
    for (const [paths, source] of cases) {
      const result = await loadPrompt(adapterWith({}), PR, undefined, changed(...paths))
      expect(result.source).toBe(`stack:${source}`)
      expect(result.content).not.toContain('{{')
    }
  })
})
