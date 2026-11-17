import { describe, it, expect } from 'vitest'
import { outsideSections, changedPrFiles, narrowDelta, readableDiff, sameHead } from '../target-merge.js'

const file = (path: string, index: string | null, ...body: string[]) =>
  [`diff --git a/${path} b/${path}`, ...(index ? [`index ${index}`] : []), `--- a/${path}`, `+++ b/${path}`, ...body].join('\n') + '\n'

const sorted = (r: { changed: Set<string>; baseChanged: Set<string> }) => ({ changed: [...r.changed].sort(), baseChanged: [...r.baseChanged].sort() })

// Both sides append to the same enum tail: the PR turns `C;` into `C,` + `NEW;`; after the merge it turns the target's `TARGET;` into `TARGET,` + `NEW;`.
const ENUM_BEFORE = (base: string) => file('src/Flags.java', `${base}..8888888 100644`,
  '@@ -3,4 +3,5 @@ enum Flags {', '   A,', '   B,', '-  C;', '+  C,', '+  NEW;', ' }')
const ENUM_AFTER = (base: string) => file('src/Flags.java', `${base}..7777777 100644`,
  '@@ -4,4 +4,5 @@ enum Flags {', '   B,', '   C,', '-  TARGET;', '+  TARGET,', '+  NEW;', ' }')
const FEATURE = file('src/Feature.java', '5555555..6666666 100644', '@@ -1,2 +1,3 @@', ' class Feature {', '+  void run() {}', ' }')

const BODY = ['@@ -1,2 +1,3 @@', ' x', '+y', ' z']
const withMode = (path: string, index: string, ...body: string[]) =>
  [`diff --git a/${path} b/${path}`, 'old mode 100644', 'new mode 100755', `index ${index}`, `--- a/${path}`, `+++ b/${path}`, ...body].join('\n') + '\n'
const bin = (b: string) => `diff --git a/img.png b/img.png\nindex 1111111..${b} 100644\nBinary files a/img.png and b/img.png differ\n`

describe('changedPrFiles', () => {
  it('1 identical diffs → nothing changed', () => {
    const diff = FEATURE + ENUM_BEFORE('1111111')
    expect(sorted(changedPrFiles(diff, diff))).toEqual({ changed: [], baseChanged: [] })
  })

  it('2 base blob unchanged and the section identical → unchanged (text, binary, mode-only and pure rename)', () => {
    const mode = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'
    const rename = 'diff --git a/old/A.java b/new/A.java\nsimilarity index 100%\nrename from old/A.java\nrename to new/A.java\n'
    for (const s of [file('a.ts', '1111111..3333333 100644', ...BODY), bin('2222222'), mode, rename]) {
      expect(sorted(changedPrFiles(s, s))).toEqual({ changed: [], baseChanged: [] })
    }
  })

  it('3 index abbreviations of 11 vs 12 or 7 vs 9 characters alone, content identical → unchanged; a different blob behind them → changed', () => {
    const at = (index: string) => file('a.ts', index, ...BODY)
    expect(sorted(changedPrFiles(at('0a1b2c3d4e5..9f8e7d6c5b4 100644'), at('0a1b2c3d4e5f..9f8e7d6c5b4a 100644')))).toEqual({ changed: [], baseChanged: [] })
    expect(sorted(changedPrFiles(at('1111111..c885cab 100644'), at('111111122..c885cab51 100644')))).toEqual({ changed: [], baseChanged: [] })
    expect(sorted(changedPrFiles(at('0a1b2c3d4e5..9f8e7d6c5b4 100644'), at('0a1b2c3d4e5f..9f8e7d6c5b5a 100644')))).toEqual({ changed: ['a.ts'], baseChanged: [] })
  })

  it('4 a hunk-less section needs a string-identical index line: binary blobs `c885cab` vs `c885cab5` → changed', () => {
    expect(sorted(changedPrFiles(bin('c885cab'), bin('c885cab5')))).toEqual({ changed: ['img.png'], baseChanged: [] })
    expect(sorted(changedPrFiles(bin('c885cab'), bin('c885cab')))).toEqual({ changed: [], baseChanged: [] })
  })

  it('5 blob ids shorter than 7 characters never match by prefix → changed', () => {
    const at = (index: string) => file('a.ts', index, ...BODY)
    expect(sorted(changedPrFiles(at('111111..333333 100644'), at('1111111..3333333 100644')))).toEqual({ changed: ['a.ts'], baseChanged: [] })
  })

  it('6 base blob changed (the target edited the file), change lines identical → changed and baseChanged', () => {
    const prev = file('a.ts', '1111111..3333333 100644', '@@ -10,3 +10,4 @@', ' a', '+added()', ' b')
    const same = file('a.ts', '2222222..4444444 100644', '@@ -10,3 +10,4 @@', ' a', '+added()', ' b')
    const shifted = file('a.ts', '2222222..4444444 100644', '@@ -12,3 +12,4 @@ fn', ' x', '+added()', ' b')
    expect(sorted(changedPrFiles(prev, same))).toEqual({ changed: ['a.ts'], baseChanged: ['a.ts'] })
    expect(sorted(changedPrFiles(prev, shifted))).toEqual({ changed: ['a.ts'], baseChanged: ['a.ts'] })
  })

  it('7 the enum tail both sides appended to → changed and baseChanged; with equal base blobs → changed only', () => {
    expect(sorted(changedPrFiles(ENUM_BEFORE('1111111'), ENUM_AFTER('2222222')))).toEqual({ changed: ['src/Flags.java'], baseChanged: ['src/Flags.java'] })
    expect(sorted(changedPrFiles(ENUM_BEFORE('1111111'), ENUM_AFTER('1111111')))).toEqual({ changed: ['src/Flags.java'], baseChanged: [] })
  })

  // Text rows keep the whole index line equal, so only the text comparison can catch them.
  const plain = (...body: string[]) => file('a.ts', '1111111..3333333 100644', '@@ -1,3 +1,4 @@', ...body)
  it.each([
    ['indentation', plain(' f() {', '+  call();', ' }'), plain(' f() {', '+    call();', ' }'), ['a.ts']],
    ['`a,` → `a;`', plain(' x', '+  a,', ' y'), plain(' x', '+  a;', ' y'), ['a.ts']],
    ['CRLF', plain(' x', '+value\r', ' y'), plain(' x', '+value', ' y'), ['a.ts']],
    ['a moved line', plain(' a', '+moved()', ' b', ' c'), plain(' a', ' b', '+moved()', ' c'), ['a.ts']],
    ['a mode suffix on the index line', file('run.sh', '1111111..3333333 100644', ...BODY), file('run.sh', '1111111..3333333 100755', ...BODY), ['run.sh']],
    ['a mode change added', file('run.sh', '1111111..3333333 100644', ...BODY), withMode('run.sh', '1111111..3333333', ...BODY), ['run.sh']],
    ['a modification turned into a rename', file('run.sh', '1111111..3333333 100644', ...BODY),
      ['diff --git a/old.sh b/run.sh', 'similarity index 90%', 'rename from old.sh', 'rename to run.sh', 'index 1111111..3333333 100644', '--- a/old.sh', '+++ b/run.sh', ...BODY].join('\n') + '\n', ['old.sh', 'run.sh']],
    ['a binary blob change', bin('2222222'), bin('3333333'), ['img.png']],
    ['a `\\ No newline` marker', plain(' x', '-a', '+b', '\\ No newline at end of file'), plain(' x', '-a', '+b'), ['a.ts']],
  ])('8 base blob unchanged, %s → changed, not baseChanged', (_name, prev, curr, changed) => {
    expect(sorted(changedPrFiles(prev, curr))).toEqual({ changed, baseChanged: [] })
  })

  it('9 a file on the old side only (reverted out of the PR) or the new side only → changed', () => {
    expect(sorted(changedPrFiles(FEATURE + ENUM_BEFORE('1111111'), ENUM_BEFORE('1111111')))).toEqual({ changed: ['src/Feature.java'], baseChanged: [] })
    expect(sorted(changedPrFiles(ENUM_BEFORE('1111111'), FEATURE + ENUM_BEFORE('1111111')))).toEqual({ changed: ['src/Feature.java'], baseChanged: [] })
  })

  it('10 the same rename on both sides → unchanged; a rename against add + delete, or with other content → both paths changed and a later delta section under the new name is kept', () => {
    const rename = 'diff --git a/old/A.java b/new/A.java\nsimilarity index 100%\nrename from old/A.java\nrename to new/A.java\n'
    const add = 'diff --git a/new/A.java b/new/A.java\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/new/A.java\n@@ -0,0 +1 @@\n+class A {}\n'
    const del = 'diff --git a/old/A.java b/old/A.java\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/old/A.java\n+++ /dev/null\n@@ -1 +0,0 @@\n-class A {}\n'
    const edited = (line: string) => `diff --git a/old/A.java b/new/A.java\nsimilarity index 90%\nrename from old/A.java\nrename to new/A.java\nindex 1111111..2222222 100644\n--- a/old/A.java\n+++ b/new/A.java\n@@ -1 +1 @@\n-a\n+${line}\n`
    expect(sorted(changedPrFiles(rename, rename)).changed).toEqual([])
    expect(sorted(changedPrFiles(rename, add + del)).changed).toEqual(['new/A.java', 'old/A.java'])
    const { changed } = changedPrFiles(edited('b'), edited('c'))
    expect([...changed].sort()).toEqual(['new/A.java', 'old/A.java'])
    expect(narrowDelta(file('new/A.java', '2222222..3333333 100644', '@@ -1 +1 @@', '-b', '+c'), changed).kept).toEqual(['new/A.java'])
  })

  it('11 a rename whose old name holds " b/" is mis-keyed by the splitter, yet `rename to` still marks the real destination', () => {
    const odd = (line: string) => `diff --git a/old b/name b/new\nsimilarity index 90%\nrename from old b/name\nrename to new\nindex 1111111..2222222 100644\n--- a/old b/name\n+++ b/new\n@@ -1 +1 @@\n-a\n+${line}\n`
    const { changed } = changedPrFiles(odd('b'), odd('c'))
    expect(changed.has('new')).toBe(true)
    expect(changed.has('old b/name')).toBe(true)
    expect(narrowDelta(file('new', '2222222..3333333 100644', '@@ -1 +1 @@', '-b', '+c'), changed).kept).toEqual(['new'])
  })

  const prevAt = (...body: string[]) => file('a.ts', '1111111..3333333 100644', ...body)
  const currAt = (...body: string[]) => file('a.ts', '2222222..4444444 100644', ...body)
  it.each([
    ['`return a,` vs `return a;`', prevAt('@@ -1,2 +1,3 @@', ' f() {', '+  return a,', ' }'), currAt('@@ -1,2 +1,3 @@', ' f() {', '+  return a;', ' }')],
    ['a reordering that reduces to the same leftover lines',
      prevAt('@@ -1,3 +1,4 @@', ' x', '-f();', '-g();', '+g(),', '+f(),', '+h();', ' y'), currAt('@@ -1,2 +1,3 @@', ' x', '-g();', '+g(),', '+h();', ' y')],
    ['identical hunks plus an added mode change', prevAt(...BODY), withMode('a.ts', '2222222..4444444', ...BODY)],
    ['`+value\\r` vs `+value`', prevAt('@@ -1 +1,2 @@', ' x', '+value\r'), currAt('@@ -1 +1,2 @@', ' x', '+value')],
    ['a call moved out of the condition',
      prevAt('@@ -1,3 +1,5 @@', ' function check() {', '+  audit();', '   if (allowed) {', '+    grant();', '   }'),
      currAt('@@ -1,3 +1,5 @@', ' function check() {', '+  audit();', '   if (allowed) {', '   }', '+    grant();')],
    ['a second hunk only on the current side',
      prevAt(...BODY), currAt(...BODY, '@@ -9,3 +10,3 @@', ' fn() {', '-return value,', '+return value;', ' }')],
    ['the end-of-file marker on the other line',
      prevAt('@@ -1 +1 @@', '-value;', '\\ No newline at end of file', '+value,'), currAt('@@ -1 +1 @@', '-value;', '+value,', '\\ No newline at end of file')],
  ])('12 regression, base blob changed: %s → changed', (_name, prev, curr) => {
    expect(sorted(changedPrFiles(prev, curr))).toEqual({ changed: ['a.ts'], baseChanged: ['a.ts'] })
  })
})

describe('readableDiff', () => {
  it('13 plain sections → readable; a quoted header, a header with two " b/", or two headers under one key → unreadable', () => {
    const quoted = 'diff --git "a/a\\tb" "b/a\\tb"\nindex 1111111..2222222 100644\n--- "a/a\\tb"\n+++ "b/a\\tb"\n@@ -1 +1 @@\n-x\n+y\n'
    const twoB = 'diff --git a/old b/name b/new\nsimilarity index 90%\nrename from old b/name\nrename to new\n'
    const typeChange = 'diff --git a/link b/link\ndeleted file mode 120000\nindex 1234567..0000000\n--- a/link\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n'
      + 'diff --git a/link b/link\nnew file mode 100644\nindex 0000000..89abcde\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+text\n'
    expect(readableDiff(FEATURE + ENUM_BEFORE('1111111'))).toBe(true)
    expect(readableDiff(FEATURE + quoted)).toBe(false)
    expect(readableDiff(FEATURE + twoB)).toBe(false)
    expect(readableDiff(typeChange)).toBe(false)
  })

  it('14 content lines that start with "diff " behind their sign (`+diff --cc x`) stay readable', () => {
    expect(readableDiff(FEATURE + file('a.ts', '1111111..2222222 100644', '@@ -1,2 +1,3 @@', ' diff --combined z', '+diff --cc x', '-diff --git a/y b/y'))).toBe(true)
  })

  const combined = (header: string) => `${header} src/Flags.java\nindex 1111111,2222222..3333333\n--- a/src/Flags.java\n+++ b/src/Flags.java\n@@@ -1,2 -1,2 +1,3 @@@\n  enum Flags {\n+ NEW,\n  }\n`
  it.each([['diff --cc'], ['diff --combined']])('15 a `%s` section → unreadable', (header) => {
    expect(readableDiff(FEATURE + combined(header))).toBe(false)
    expect(readableDiff(combined(header))).toBe(false)
  })
})

describe('outsideSections', () => {
  it('16 a rename whose new or old path is a PR path is inside; a file reverted out of the PR is outside', () => {
    const rename = 'diff --git a/src/Old.java b/src/New.java\nsimilarity index 90%\nrename from src/Old.java\nrename to src/New.java\nindex 1111111..2222222\n--- a/src/Old.java\n+++ b/src/New.java\n@@ -1 +1 @@\n-a\n+b\n'
    const reverted = file('src/Reverted.java', '3333333..4444444', '@@ -1,2 +1 @@', ' a', '-b')
    expect(outsideSections(rename + reverted, ['src/New.java'])).toEqual(['src/Reverted.java'])
    expect(outsideSections(rename + reverted, ['src/Old.java'])).toEqual(['src/Reverted.java'])
    expect(outsideSections(rename, ['src/Feature.java'])).toEqual(['src/New.java'])
  })
})

describe('narrowDelta', () => {
  it('17 nothing dropped returns the very same string; otherwise the kept sections in order', () => {
    const delta = FEATURE + ENUM_BEFORE('1111111')
    const all = narrowDelta(delta, new Set(['src/Feature.java', 'src/Flags.java']))
    expect(all.diff).toBe(delta)
    expect(all.dropped).toEqual([])

    const other = file('src/Other.java', '9999999..aaaaaaa', '@@ -1 +1,2 @@', ' x', '+y')
    const some = narrowDelta(other + delta, new Set(['src/Flags.java']))
    expect(some.diff).toBe(ENUM_BEFORE('1111111'))
    expect(some.kept).toEqual(['src/Flags.java'])
    expect(some.dropped).toEqual(['src/Other.java', 'src/Feature.java'])

    expect(narrowDelta(other, new Set())).toEqual({ diff: '', kept: [], dropped: ['src/Other.java'] })
  })
})

describe('sameHead', () => {
  const deltaFlags = file('src/Flags.java', '8888888..7777777 100644', '@@ -1 +1,2 @@', ' A,', '+B,')
  const mode = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'

  const runContent = file('run.sh', '1111111..2222222 100755', '@@ -1 +1 @@', '-x', '+y')

  it('18 the same post-image blob (abbreviations 7 vs 9 included), delta files absent from the PR diff, or no index line on either side → same head', () => {
    expect(sameHead(FEATURE + deltaFlags, ENUM_AFTER('2222222'))).toBe(true)
    expect(sameHead(deltaFlags, file('src/Flags.java', '222222222..777777799 100644', '@@ -1 +1 @@', '-x', '+y'))).toBe(true)
    expect(sameHead(FEATURE, ENUM_AFTER('2222222'))).toBe(true)
    expect(sameHead(mode, mode)).toBe(true)
  })

  it('19 a post-image blob that differs from the PR diff\'s (a stale PR diff), ids shorter than 7 characters, or an index line on one side only → not the same head', () => {
    expect(sameHead(FEATURE + deltaFlags, ENUM_BEFORE('1111111'))).toBe(false)
    expect(sameHead(file('a.ts', '111111..777777', '@@ -1 +1 @@', '-x', '+y'), file('a.ts', '2222222..7777777', '@@ -1 +1 @@', '-x', '+y'))).toBe(false)
    expect(sameHead(mode, runContent)).toBe(false)
    expect(sameHead(runContent, mode)).toBe(false)
  })
})

describe('changedPrFiles: target-touched files and renames', () => {
  const renameEdit = (from: string, to: string, index: string, line: string) =>
    `diff --git a/${from} b/${to}\nsimilarity index 90%\nrename from ${from}\nrename to ${to}\nindex ${index} 100644\n--- a/${from}\n+++ b/${to}\n@@ -1 +1 @@\n-x\n+${line}\n`

  it('20 a key whose sections rename different source files (A.ts → B.ts before, C.ts → B.ts after) → all paths changed, none target-touched', () => {
    const prev = renameEdit('A.ts', 'B.ts', 'aaaaaaa..bbbbbbb', 'b') + 'diff --git a/C.ts b/C.ts\ndeleted file mode 100644\nindex ccccccc..0000000\n--- a/C.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-c\n'
    const curr = file('A.ts', 'aaaaaaa..ddddddd 100644', '@@ -1 +1 @@', '-a', '+a2') + renameEdit('C.ts', 'B.ts', 'eeeeeee..bbbbbbc', 'b')
    expect(sorted(changedPrFiles(prev, curr))).toEqual({ changed: ['A.ts', 'B.ts', 'C.ts'], baseChanged: [] })
  })

  it('21 a changed base blob counts as target-touched only for one unrenamed path: a plain file → baseChanged, the same rename on both sides → changed only', () => {
    expect(sorted(changedPrFiles(file('a.ts', '1111111..3333333 100644', ...BODY), file('a.ts', '2222222..4444444 100644', ...BODY)))).toEqual({ changed: ['a.ts'], baseChanged: ['a.ts'] })
    expect(sorted(changedPrFiles(renameEdit('old.ts', 'new.ts', '1111111..3333333', 'y'), renameEdit('old.ts', 'new.ts', '2222222..4444444', 'y')))).toEqual({ changed: ['new.ts', 'old.ts'], baseChanged: [] })
  })
})
