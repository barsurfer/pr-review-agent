import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { VCSAdapter, PRInfo } from '../vcs/adapter.js'
import { DEFAULT_ROLE, DEFAULT_REVIEW_PRIORITIES, DEFAULT_MENTAL_MODEL, DEFAULT_EXCEPTIONS } from './defaults.js'

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
  exceptions?: string
}

/**
 * Parse a repo-specific prompt into sections.
 * Looks for ## ROLE, ## REVIEW PRIORITIES, and ## MENTAL MODEL headers.
 * Content between headers belongs to the preceding section.
 */
function stripFrontmatter(content: string): string {
  return content.startsWith('---') ? content.replace(/^---[\s\S]*?---\n*/, '') : content
}

function parseRepoPrompt(raw: string): RepoPromptSections {
  const content = stripFrontmatter(raw)
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
    } else if (name.startsWith('EXCEPTION')) {
      sections.exceptions = body
    }
  }

  return sections
}

const SECTION_NAMES: (keyof RepoPromptSections)[] = ['role', 'reviewPriorities', 'mentalModel', 'exceptions']
const SECTION_LABELS: Record<keyof RepoPromptSections, string> = {
  role: 'ROLE',
  reviewPriorities: 'REVIEW PRIORITIES',
  mentalModel: 'MENTAL MODEL',
  exceptions: 'EXCEPTIONS',
}

function logSections(sections: RepoPromptSections): void {
  const parsed = SECTION_NAMES.filter(k => sections[k])
  const defaulted = SECTION_NAMES.filter(k => !sections[k])
  if (parsed.length) console.log(`  Sections from prompt: ${parsed.map(k => SECTION_LABELS[k]).join(', ')}`)
  if (defaulted.length) console.log(`  Sections using defaults: ${defaulted.map(k => SECTION_LABELS[k]).join(', ')}`)
}

function fillTemplate(template: string, sections: RepoPromptSections): string {
  return template
    .replace('{{ROLE}}', sections.role ?? DEFAULT_ROLE)
    .replace('{{REVIEW_PRIORITIES}}', sections.reviewPriorities ?? DEFAULT_REVIEW_PRIORITIES)
    .replace('{{MENTAL_MODEL}}', sections.mentalModel ?? DEFAULT_MENTAL_MODEL)
    .replace('{{EXCEPTIONS}}', sections.exceptions ?? DEFAULT_EXCEPTIONS)
}

export function validateLocalPrompt(path: string): void {
  const template = getBaseTemplate()
  const content = readFileSync(path, 'utf-8')
  console.log(`Validating prompt: ${path}`)
  const sections = parseRepoPrompt(content)
  logSections(sections)
  const filled = fillTemplate(template, sections)
  console.log(`\nFilled prompt length: ${filled.length} chars (~${Math.ceil(filled.length / 4).toLocaleString()} tokens)`)
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
    logSections(sections)
    const filled = fillTemplate(template, sections)
    return { content: filled, source: localPromptPath }
  }

  // 2. Try source commit, then target branch; check root and docs/ in each
  //    Use sourceCommit (hash) instead of sourceBranch because branch names
  //    with slashes (e.g. feature/foo) break Bitbucket's src API URL routing.
  const paths = [REPO_PROMPT_FILE, `docs/${REPO_PROMPT_FILE}`]
  for (const ref of [prInfo.sourceCommit, prInfo.targetBranch]) {
    for (const path of paths) {
      const repoPrompt = await adapter.getRepoFileContent(path, ref)
      if (repoPrompt) {
        console.log(`Using repo-specific prompt from ${path} (${ref.slice(0, 12)})`)
        const sections = parseRepoPrompt(repoPrompt)
        logSections(sections)
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
