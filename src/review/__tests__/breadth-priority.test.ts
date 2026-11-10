import { describe, it, expect } from 'vitest'
import { prioritizeUntouched, breadthBriefing, breadthSystemPrompt, secondLookSystemPrompt, BREADTH_LENS, SECOND_LOOK_LENS, MAX_UNTOUCHED_LISTED } from '../breadth.js'
import type { ReviewFinding } from '../formatter.js'

const section = (path: string, added: number) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${added} @@\n${Array.from({ length: added }, (_, i) => `+line ${i}`).join('\n')}\n`

const finding = (file: string): ReviewFinding => ({ severity: 'MEDIUM', title: 'Bug', file, lines: '1', body: 'b' })
const shuffle = <T,>(xs: T[]): T[] => [...xs].sort((a, b) => (String(a).split('').reverse().join('') < String(b).split('').reverse().join('') ? -1 : 1))
const diffOf = (paths: string[], size = 2) => paths.map(p => section(p, size)).join('')

describe('prioritizeUntouched', () => {
  const changesets = Array.from({ length: 300 }, (_, i) => `.changeset/entry-${String(i).padStart(3, '0')}.md`)
  const substantive = [
    ...Array.from({ length: 30 }, (_, i) => `packages/core/src/m${i}.ts`),
    ...Array.from({ length: 30 }, (_, i) => `packages/ui/src/c${i}.ts`),
    '.github/workflows/release.yml', 'migrations/001.sql', 'README.md', 'docs/guide.md',
  ]

  it('promotes substantive paths past an early block of release entries and fills exactly the cap', () => {
    const untouched = [...changesets, ...substantive]
    const plan = prioritizeUntouched(untouched, diffOf(untouched), [])
    expect(plan.selected).toHaveLength(MAX_UNTOUCHED_LISTED)
    expect(plan.selected.some(p => p.startsWith('.changeset/entry-'))).toBe(false)
    expect(plan.deprioritizedReleaseEntries).toBe(300)
    expect(plan.omitted).toBe(substantive.length - MAX_UNTOUCHED_LISTED)
    expect(plan.selected).toEqual(expect.arrayContaining(['.github/workflows/release.yml', 'migrations/001.sql', 'README.md']))
  })

  it('keeps .changeset/README.md eligible and other markdown out of the release-entry exclusion', () => {
    const plan = prioritizeUntouched(['.changeset/README.md', '.changeset/config.json', '.changeset/a.md', 'docs/a.md'], '', [])
    expect(plan.selected).toEqual(expect.arrayContaining(['.changeset/README.md', '.changeset/config.json', 'docs/a.md']))
    expect(plan.selected).not.toContain('.changeset/a.md')
    expect(plan.deprioritizedReleaseEntries).toBe(1)
  })

  it('a docs-only PR still receives up to 40 substantive doc targets', () => {
    const docs = Array.from({ length: 80 }, (_, i) => `docs/page-${i}.md`)
    expect(prioritizeUntouched(docs, diffOf(docs), []).selected).toHaveLength(40)
  })

  it('caps docs at 8 slots when code is plentiful, and backfills unused code slots with docs', () => {
    const code = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`)
    const docs = Array.from({ length: 50 }, (_, i) => `docs/d${i}.md`)
    const full = prioritizeUntouched([...code, ...docs], diffOf([...code, ...docs]), []).selected
    expect(full.filter(p => p.endsWith('.md'))).toHaveLength(8)
    expect(full).toHaveLength(40)
    const fewCode = prioritizeUntouched([...code.slice(0, 5), ...docs], diffOf([...code.slice(0, 5), ...docs]), []).selected
    expect(fewCode.filter(p => p.endsWith('.md'))).toHaveLength(35)
  })

  it('round-robins subsystems so one package cannot take every slot', () => {
    const a = Array.from({ length: 40 }, (_, i) => `packages/a/f${i}.ts`)
    const b = ['packages/b/x.ts', 'packages/c/y.ts', 'apps/web/z.ts', 'root.ts']
    const plan = prioritizeUntouched([...a, ...b], diffOf([...a, ...b]), [])
    expect(plan.selected.slice(0, 5)).toEqual(expect.arrayContaining(b))
    expect(plan.selected).toHaveLength(40)
  })

  it('ranks by nearness to a finding, then larger change, then path', () => {
    const paths = ['lib/big.ts', 'src/near.ts', 'lib/small.ts']
    const diff = section('lib/big.ts', 9) + section('src/near.ts', 1) + section('lib/small.ts', 2)
    const byGroup = prioritizeUntouched(paths, diff, [finding('src/seen.ts')]).selected
    expect(byGroup[0]).toBe('src/near.ts')
    const sameGroup = prioritizeUntouched(['lib/small.ts', 'lib/big.ts'], diff, []).selected
    expect(sameGroup).toEqual(['lib/big.ts', 'lib/small.ts'])
  })

  it('resolves b/-prefixed and unique-basename finding paths so the sibling of a flagged file is promoted', () => {
    const untouched = ['lib/big.ts', 'packages/target/sibling.ts']
    const diff = section('lib/big.ts', 9) + section('packages/target/sibling.ts', 1) + section('packages/target/seen.ts', 1)
    for (const file of ['b/packages/target/seen.ts', 'seen.ts']) {
      expect(prioritizeUntouched(untouched, diff, [finding(file)]).selected[0]).toBe('packages/target/sibling.ts')
    }
  })

  it('is deterministic under shuffled input', () => {
    const paths = [...substantive, ...changesets.slice(0, 20)]
    const diff = diffOf(paths)
    expect(prioritizeUntouched(shuffle(paths), diff, []).selected).toEqual(prioritizeUntouched(paths, diff, []).selected)
  })
})

describe('breadthBriefing — prioritized form', () => {
  it('flag-off call is byte-identical to the legacy first-N briefing', () => {
    const untouched = Array.from({ length: 45 }, (_, i) => `f${i}.ts`)
    const legacy = breadthBriefing([], untouched)
    expect(legacy).toContain('## Files with no finding yet:\n')
    expect(legacy).toContain('…and 5 more')
    expect(breadthBriefing([], untouched, undefined)).toBe(legacy)
  })

  it('labels the list as prioritized targets, keeps unlisted files in scope, and accounts for omissions', () => {
    const text = breadthBriefing([], ['a.ts'], { selected: ['b.ts', 'c.ts'], deprioritizedReleaseEntries: 3, omitted: 7 })
    expect(text).toContain('prioritized targets; unlisted files remain in the supplied diff')
    expect(text).toContain('- b.ts\n- c.ts')
    expect(text).toContain('…and 7 more eligible file(s) not listed')
    expect(text).not.toContain('- a.ts')
  })
})

describe('lens wording with shown-context anchors', () => {
  it('defaults to the unchanged lens and only adds the shown-line allowance when asked', () => {
    expect(breadthSystemPrompt('P', 0)).toBe(`P\n\n${BREADTH_LENS}`)
    expect(secondLookSystemPrompt('P', 0)).toBe(`P\n\n${SECOND_LOOK_LENS}`)
    for (const text of [breadthSystemPrompt('P', 0, true), secondLookSystemPrompt('P', 0, true)]) {
      expect(text).toContain('or on an unchanged line you were shown when it explains a defect this change introduces')
      expect(text).toContain('numeric line on an added or modified line')
    }
  })
})
