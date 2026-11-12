import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const PROMPTS: Record<string, string> = {
  'base-prompt.txt': 'base line one\nbase line two\n',
  'judge-prompt.txt': 'judge line one\njudge line two\n',
  'reply-prompt.txt': 'reply line one\nreply line two\n',
  'stacks/java.txt': '## REVIEW PRIORITIES\n\n- stack rule\n',
}

function bundleFrom(dir: string, eol: '\n' | '\r\n'): string {
  const promptDir = join(dir, `prompt-${eol === '\n' ? 'lf' : 'crlf'}`)
  mkdirSync(join(promptDir, 'stacks'), { recursive: true })
  for (const [file, text] of Object.entries(PROMPTS)) writeFileSync(join(promptDir, file), text.replace(/\n/g, eol))
  const outfile = join(dir, `${eol === '\n' ? 'lf' : 'crlf'}.cjs`)
  const result = spawnSync(process.execPath, ['scripts/bundle.mjs', '--outfile', outfile, '--prompt-dir', promptDir], { cwd: ROOT, encoding: 'utf-8' })
  expect(result.status, result.stderr).toBe(0)
  return readFileSync(outfile, 'utf-8')
}

describe('bundle', () => {
  it('embeds LF prompt text from a CRLF checkout, byte-identical to an LF build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-agent-bundle-'))
    try {
      const fromLf = bundleFrom(dir, '\n')
      const fromCrlf = bundleFrom(dir, '\r\n')
      // Booleans, not string matchers: a failure would otherwise print the whole 1.8 MB bundle.
      expect(/["'`]base line one\\nbase line two\\n["'`]/.test(fromLf), 'LF build embeds the fixture prompts').toBe(true)
      expect(fromCrlf.includes('base line one\\r'), 'CRLF build embeds a CR').toBe(false)
      expect(fromCrlf === fromLf, 'CRLF and LF builds differ').toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})
