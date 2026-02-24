import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { VCSAdapter, PRInfo } from '../vcs/adapter.js'
import { DEFAULT_ROLE, DEFAULT_REVIEW_PRIORITIES, DEFAULT_MENTAL_MODEL } from './defaults.js'

const REPO_PROMPT_FILE = '.agent-review-instructions.md'

// Load base template — works both from source (tsc) and bundle (esbuild)
function getBaseTemplate(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url))
    return readFileSync(join(__dir, 'base-prompt.txt'), 'utf-8')
  } catch {
    // When running as a single-file bundle, fall back to the embedded copy.
    // esbuild replaces __BASE_PROMPT__ at build time via --define.
    // @ts-ignore — injected at bundle time
    if (typeof __BASE_PROMPT__ !== 'undefined') return __BASE_PROMPT__ as string
    throw new Error('Cannot load base prompt: file not found and no embedded copy')
  }
}

interface RepoPromptSections {
  role?: string
  reviewPriorities?: string
  mentalModel?: string
}

/**
 * Parse a repo-specific prompt into sections.
 * Looks for ## ROLE, ## REVIEW PRIORITIES, and ## MENTAL MODEL headers.
 * Content between headers belongs to the preceding section.
 */
function parseRepoPrompt(content: string): RepoPromptSections {
  const sections: RepoPromptSections = {}

  // Split on ## headers, keeping the header text
  const sectionPattern = /^## (.+)/gm
  const headers: { name: string; start: number }[] = []
  let match: RegExpExecArray | null

  while ((match = sectionPattern.exec(content)) !== null) {
    headers.push({ name: match[1].trim().toUpperCase(), start: match.index + match[0].length })
  }

  for (let i = 0; i < headers.length; i++) {
    const end = i + 1 < headers.length ? headers[i + 1].start - headers[i + 1].name.length - 3 : content.length
    const body = content.slice(headers[i].start, end).trim()
    if (!body) continue

    const name = headers[i].name
    if (name === 'ROLE') {
      sections.role = body
    } else if (name.startsWith('REVIEW PRIORITIES')) {
      sections.reviewPriorities = body
    } else if (name.startsWith('MENTAL MODEL')) {
      sections.mentalModel = body
    }
  }

  return sections
}

function fillTemplate(template: string, sections: RepoPromptSections): string {
  return template
    .replace('{{ROLE}}', sections.role ?? DEFAULT_ROLE)
    .replace('{{REVIEW_PRIORITIES}}', sections.reviewPriorities ?? DEFAULT_REVIEW_PRIORITIES)
    .replace('{{MENTAL_MODEL}}', sections.mentalModel ?? DEFAULT_MENTAL_MODEL)
}

export type PromptSource = 'repo' | 'default' | string

export interface LoadedPrompt {
  content: string
  source: PromptSource
}

export async function loadPrompt(adapter: VCSAdapter, prInfo: PRInfo, localPromptPath?: string): Promise<LoadedPrompt> {
  const template = getBaseTemplate()

  // 1. If a local prompt file was provided via --prompt, use it
  if (localPromptPath) {
    const content = readFileSync(localPromptPath, 'utf-8')
    console.log(`Using local prompt from ${localPromptPath}`)
    const sections = parseRepoPrompt(content)
    const filled = fillTemplate(template, sections)
    return { content: filled, source: localPromptPath }
  }

  // 2. Try source branch, then target branch; check root and docs/ in each
  const paths = [REPO_PROMPT_FILE, `docs/${REPO_PROMPT_FILE}`]
  for (const branch of [prInfo.sourceBranch, prInfo.targetBranch]) {
    for (const path of paths) {
      const repoPrompt = await adapter.getRepoFileContent(path, branch)
      if (repoPrompt) {
        console.log(`Using repo-specific prompt from ${path} (${branch})`)
        const sections = parseRepoPrompt(repoPrompt)
        const filled = fillTemplate(template, sections)
        return { content: filled, source: 'repo' }
      }
    }
  }

  // 3. Fall back to all defaults
  console.log(`No ${REPO_PROMPT_FILE} found in source or target branch — using default prompt`)
  const filled = fillTemplate(template, {})
  return { content: filled, source: 'default' }
}
