import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { VCSAdapter } from '../vcs/adapter.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const REPO_PROMPT_FILE = '.claude-review-prompt.md'

export type PromptSource = 'repo' | 'default'

export interface LoadedPrompt {
  content: string
  source: PromptSource
}

export async function loadPrompt(adapter: VCSAdapter): Promise<LoadedPrompt> {
  // 1. Try repo-specific prompt via VCS API
  const repoPrompt = await adapter.getRepoFileContent(REPO_PROMPT_FILE)
  if (repoPrompt) {
    console.log(`Using repo-specific prompt from ${REPO_PROMPT_FILE}`)
    return { content: repoPrompt, source: 'repo' }
  }

  // 2. Fall back to default prompt
  console.log(`No ${REPO_PROMPT_FILE} found in target repo — using default prompt`)
  const defaultPrompt = readFileSync(join(__dirname, 'default-prompt.txt'), 'utf-8')
  return { content: defaultPrompt, source: 'default' }
}
