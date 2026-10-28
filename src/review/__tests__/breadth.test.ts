import { describe, it, expect } from 'vitest'
import { fileCoverage, breadthBriefing, breadthSystemPrompt, BREADTH_LENS, MAX_UNTOUCHED_LISTED } from '../breadth.js'
import type { ReviewFinding } from '../formatter.js'

const section = (path: string, body: string, header = '') =>
  `diff --git a/${path} b/${path}\n${header}--- a/${path}\n+++ b/${path}\n${body}\n`

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({ severity: 'MEDIUM', title: 'Bug', file: 'src/a.ts', lines: '1', body: 'b', ...over })

describe('fileCoverage', () => {
  const DIFF = [
    section('src/a.ts', '@@ -1 +1 @@\n-x\n+y'),
    section('src/b.ts', '@@ -1 +1,2 @@\n x\n+z'),
    section('src/gone.ts', '@@ -1 +0,0 @@\n-x', 'deleted file mode 100644\n'),
    section('yarn.lock', '@@ -1 +1 @@\n-a\n+b'),
    'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n',
    'diff --git a/old.ts b/moved.ts\nsimilarity index 100%\nrename from old.ts\nrename to moved.ts\n',
  ].join('')

  it('counts only non-deleted, non-generated files with a +/- line as reviewable', () => {
    expect(fileCoverage(DIFF, []).reviewable).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('treats a file as covered by any finding on it, with or without a line, matching by normalized path', () => {
    expect(fileCoverage(DIFF, [finding({ file: 'a.ts', lines: undefined })]).untouched).toEqual(['src/b.ts'])
    expect(fileCoverage(DIFF, [finding({ file: undefined })]).untouched).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('breadthBriefing', () => {
  it('lists first-pass findings as anchor + title only, and the untouched files', () => {
    const out = breadthBriefing([finding({ body: 'LONG BODY' }), finding({ file: undefined, title: 'PR-level' })], ['src/b.ts'])
    expect(out).toContain('- src/a.ts:1 — Bug')
    expect(out).toContain('- (no file) — PR-level')
    expect(out).not.toContain('LONG BODY')
    expect(out).toContain('## Files with no finding yet:\n- src/b.ts')
  })

  it('caps the untouched list and says how many were cut', () => {
    const many = Array.from({ length: MAX_UNTOUCHED_LISTED + 3 }, (_, i) => `f${i}.ts`)
    const out = breadthBriefing([], many)
    expect(out).toContain('First-pass findings (already reported — do not repeat):\nNone.')
    expect(out).toContain(`- f${MAX_UNTOUCHED_LISTED - 1}.ts`)
    expect(out).not.toContain(`- f${MAX_UNTOUCHED_LISTED}.ts`)
    expect(out).toContain('- …and 3 more')
  })

  it('says None. when every file already has a finding', () => {
    expect(breadthBriefing([finding()], [])).toContain('## Files with no finding yet:\nNone.')
  })
})

describe('breadthSystemPrompt', () => {
  it('appends the lens to the reviewer prompt, plus the findings limit only when set', () => {
    expect(breadthSystemPrompt('BASE', 0)).toBe(`BASE\n\n${BREADTH_LENS}`)
    expect(breadthSystemPrompt('BASE', 7)).toContain('## FINDINGS LIMIT\nReport at most 7 findings')
  })

})

describe('fileCoverage filters', () => {
  it('counts migrations as reviewable but not lockfiles or generated code', () => {
    const diff = [
      section('db/migrate/001_add.rb', '@@ -0,0 +1 @@\n+add_column', 'new file mode 100644\n'),
      section('go.sum', '@@ -1 +1 @@\n-a\n+b'),
      section('api/v1/svc.pb.go', '@@ -1 +1 @@\n-a\n+b'),
      section('proto/svc_pb2.py', '@@ -1 +1 @@\n-a\n+b'),
    ].join('')
    expect(fileCoverage(diff, []).reviewable).toEqual(['db/migrate/001_add.rb'])
  })

  it('treats an ambiguous basename finding as covering every file it could mean', () => {
    const diff = [section('a/index.ts', '@@ -1 +1 @@\n-x\n+y'), section('b/index.ts', '@@ -1 +1 @@\n-x\n+y'), section('c/other.ts', '@@ -1 +1 @@\n-x\n+y')].join('')
    expect(fileCoverage(diff, [finding({ file: 'index.ts' })]).untouched).toEqual(['c/other.ts'])
  })
})
