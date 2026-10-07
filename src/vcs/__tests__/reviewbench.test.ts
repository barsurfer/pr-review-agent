import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ReviewBenchAdapter, readReviewBenchEnv } from '../reviewbench.js'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1',
  '+const b = 2',
  ' export { a }',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+export const n = 1',
  '',
].join('\n')

function setup(prJson: unknown = { repo: 'https://github.com/owner/repo', pr_number: 1938, base: BASE, head: HEAD, nwo: 'owner/repo', title: 'Fix pool race', body: 'Guards conns with the mutex.' }): ReviewBenchAdapter {
  const dir = mkdtempSync(join(tmpdir(), 'rb-adapter-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'app.ts'), 'const a = 1\nconst b = 2\nexport { a }\n')
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x50, 0x00, 0x51]))
  writeFileSync(join(dir, 'secret.txt'), 'outside the checkout')
  writeFileSync(join(dir, 'diff.patch'), DIFF)
  if (prJson !== null) writeFileSync(join(dir, 'pr.json'), typeof prJson === 'string' ? prJson : JSON.stringify(prJson))
  return new ReviewBenchAdapter(readReviewBenchEnv({
    RB_DIFF: join(dir, 'diff.patch'), RB_PR_JSON: join(dir, 'pr.json'), RB_REPO: repo, RB_OUT: join(dir, 'out', 'findings.json'),
    RB_NWO: 'owner/repo', RB_PR_NUMBER: '1938', RB_BASE: BASE, RB_HEAD: HEAD, RB_AGENT: 'my-agent',
  }))
}

describe('readReviewBenchEnv', () => {
  it('defaults to the contract mount points when the path vars are unset', () => {
    expect(readReviewBenchEnv({})).toMatchObject({
      diffPath: '/work/pr/diff.patch', prJsonPath: '/work/pr/pr.json', repoDir: '/work/repo', outPath: '/work/out/findings.json', agent: 'pr-review-agent',
    })
  })
})

describe('ReviewBenchAdapter', () => {
  it('maps pr.json → PRInfo with sourceCommit = RB_HEAD and branch placeholders', async () => {
    const info = await setup().getPullRequestInfo('1938')
    expect(info).toEqual({
      id: '1938', title: 'Fix pool race', description: 'Guards conns with the mutex.', author: 'unknown',
      sourceBranch: `head@${HEAD.slice(0, 12)}`, targetBranch: `base@${BASE.slice(0, 12)}`, sourceCommit: HEAD,
    })
  })

  it.each([
    ['missing', null],
    ['malformed', '{not json'],
    ['sparse', { pr_number: 1938 }],
  ])('does not crash on a %s pr.json', async (_label, prJson) => {
    const info = await setup(prJson).getPullRequestInfo('1938')
    expect(info).toMatchObject({ id: '1938', title: '', description: '', author: 'unknown', sourceCommit: HEAD })
  })

  it('reads the diff file as-is', async () => {
    expect(await setup().getDiff('1938')).toBe(DIFF)
  })

  it('derives changed files from the diff', async () => {
    expect(await setup().getChangedFiles('1938')).toEqual([
      { path: 'src/app.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'added' },
    ])
  })

  it('reads file content from the checkout regardless of ref', async () => {
    const adapter = setup()
    expect(await adapter.getFileContent('src/app.ts', HEAD)).toContain('const b = 2')
    expect(await adapter.getRepoFileContent('src/app.ts', 'main')).toContain('const b = 2')
  })

  it('refuses paths that escape the checkout and binary files', async () => {
    const adapter = setup()
    await expect(adapter.getFileContent('../secret.txt', HEAD)).rejects.toThrow(/outside the repository/)
    await expect(adapter.getFileContent('bin.dat', HEAD)).rejects.toThrow(/binary/)
    expect(await adapter.getRepoFileContent('../secret.txt')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink that points outside the checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-sym-'))
    const repo = join(dir, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(dir, 'secret.txt'), 'outside')
    writeFileSync(join(dir, 'diff.patch'), DIFF)
    writeFileSync(join(dir, 'pr.json'), JSON.stringify({ pr_number: 1938 }))
    symlinkSync(join(dir, 'secret.txt'), join(repo, 'src', 'leak.ts'))
    const adapter = new ReviewBenchAdapter(readReviewBenchEnv({
      RB_DIFF: join(dir, 'diff.patch'), RB_PR_JSON: join(dir, 'pr.json'), RB_REPO: repo, RB_OUT: join(dir, 'out', 'findings.json'),
      RB_NWO: 'owner/repo', RB_PR_NUMBER: '1938', RB_BASE: BASE, RB_HEAD: HEAD, RB_AGENT: 'my-agent',
    }))
    await expect(adapter.getFileContent('src/leak.ts', HEAD)).rejects.toThrow(/outside the repository/)
  })

  it('returns null for a missing repo file (prompt loader falls back to defaults)', async () => {
    expect(await setup().getRepoFileContent('.agent-review-instructions.md', HEAD)).toBeNull()
  })

  it('is single-shot: no prior reviews or replies, posting is a no-op', async () => {
    const adapter = setup()
    expect(await adapter.getPreviousReviewComments('1938')).toEqual([])
    expect(await adapter.getRepliesToReviewComments('1938', ['1'], true)).toEqual({ replies: [], agentReplyCount: 0 })
    await expect(adapter.postComment('1938', 'body')).resolves.toBeUndefined()
    await expect(adapter.postReply('1938', '1', 'body')).resolves.toBeUndefined()
    await expect(adapter.getCommitDiff(BASE, HEAD)).rejects.toThrow(/single-shot/)
  })
})
