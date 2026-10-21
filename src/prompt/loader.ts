import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { VCSAdapter, PRInfo, ChangedFile } from '../vcs/adapter.js'
import { detectStacks } from './stack.js'
import { DEFAULT_ROLE, DEFAULT_REVIEW_PRIORITIES, DEFAULT_SECURITY, DEFAULT_MENTAL_MODEL, DEFAULT_EXCEPTIONS } from './defaults.js'
import { config } from '../config.js'

const REPO_PROMPT_FILE = '.agent-review-instructions.md'

// base-prompt.txt low-severity suppressors; ENABLE_NITPICKS relaxes only the low-severity certainty rule (the two FORBIDDEN style lines stay); a sentinel test pins all three verbatim so a prompt edit can't silently no-op the on-transform.
const LOW_SEVERITY_CERTAINTY_RULE = '- For lower-severity concerns, be certain before flagging. If you cannot explain the problem with a concrete failing scenario, do not flag it — prefer not reporting over guessing.'
const FORBIDDEN_FORMATTING_RULE = '- Do not focus on formatting or style.'
const FORBIDDEN_NITPICK_RULE = '- Do not nitpick. Style, naming, and formatting preferences are not findings.'
export const NITPICK_SENTINELS = [LOW_SEVERITY_CERTAINTY_RULE, FORBIDDEN_FORMATTING_RULE, FORBIDDEN_NITPICK_RULE]

// Keeps the anti-speculation bar for uncertain correctness, but permits concrete real-but-minor findings.
const LOW_SEVERITY_CERTAINTY_RULE_RELAXED = '- For lower-severity concerns, keep the anti-speculation bar for uncertain correctness: if you cannot explain a suspected bug with a concrete failing scenario, do not flag it — prefer not reporting over guessing. But DO surface real, concrete, low-impact issues that are plainly visible in the diff — stale or misleading docs, comments, or names; dead code; duplicated logic; tests that cannot fail or miss the case they claim to cover — tagging each with its `type` and a concrete reason it is wrong. These are findings, not the style, naming, or formatting preferences forbidden below.'

// Off: bytes untouched (byte-identical by construction); on: exact-string replace the low-severity certainty rule so the reviewer also emits real-but-minor findings. One gate for both load paths.
export function applyNitpickTransform(template: string): string {
  if (!config.review.enableNitpicks) return template
  return template.replace(LOW_SEVERITY_CERTAINTY_RULE, LOW_SEVERITY_CERTAINTY_RULE_RELAXED)
}

export function getBaseTemplate(): string {
  return applyNitpickTransform(loadBaseTemplateBytes())
}

// Load raw template bytes — works both from source (tsc) and the single-file bundle (esbuild).
function loadBaseTemplateBytes(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url))
    return readFileSync(join(__dir, 'base-prompt.txt'), 'utf-8')
  } catch {
    // esbuild replaces __BASE_PROMPT__ at build time via --define.
    // @ts-ignore — injected at bundle time
    if (typeof __BASE_PROMPT__ !== 'undefined') return __BASE_PROMPT__ as string
    throw new Error('Cannot load base prompt: file not found and no embedded copy')
  }
}

// esbuild embeds src/prompt/stacks/*.txt as __STACK_PROMPTS__ for the single-file bundle
function getStackPrompt(stack: string): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url))
    return readFileSync(join(__dir, 'stacks', `${stack}.txt`), 'utf-8')
  } catch {
    // @ts-ignore — injected at bundle time
    const embedded = typeof __STACK_PROMPTS__ !== 'undefined' ? (__STACK_PROMPTS__ as Record<string, string>)[stack] : undefined
    if (embedded) return embedded
    throw new Error(`Cannot load stack prompt '${stack}': file not found and no embedded copy`)
  }
}

interface RepoPromptSections {
  role?: string
  reviewPriorities?: string
  security?: string
  mentalModel?: string
  exceptions?: string
}

/**
 * Parse a repo-specific prompt into sections.
 * Splits on ## headers; ROLE, REVIEW PRIORITIES, SECURITY, MENTAL MODEL, EXCEPTION(S) are kept, others ignored.
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
    } else if (name.startsWith('SECURITY')) {
      sections.security = body
    } else if (name.startsWith('MENTAL MODEL')) {
      sections.mentalModel = body
    } else if (name.startsWith('EXCEPTION')) {
      sections.exceptions = body
    }
  }

  return sections
}

const SECTION_NAMES: (keyof RepoPromptSections)[] = ['role', 'reviewPriorities', 'security', 'mentalModel', 'exceptions']
const SECTION_LABELS: Record<keyof RepoPromptSections, string> = {
  role: 'ROLE',
  reviewPriorities: 'REVIEW PRIORITIES',
  security: 'SECURITY',
  mentalModel: 'MENTAL MODEL',
  exceptions: 'EXCEPTIONS',
}

// Fragments are ordered base-first; the first ROLE wins, other sections concatenate with identical lines de-duplicated
function composeSections(fragments: RepoPromptSections[]): RepoPromptSections {
  const merge = (key: keyof RepoPromptSections): string | undefined => {
    const seen = new Set<string>()
    const lines: string[] = []
    for (const body of fragments.map(f => f[key]).filter((b): b is string => !!b)) {
      for (const line of body.split('\n')) {
        const t = line.trim()
        if (t.startsWith('- ')) {
          if (seen.has(t)) continue
          seen.add(t)
        }
        lines.push(line)
      }
      lines.push('')
    }
    return lines.length ? lines.join('\n').trim() : undefined
  }
  return {
    role: fragments.find(f => f.role)?.role,
    reviewPriorities: merge('reviewPriorities'),
    security: merge('security'),
    mentalModel: merge('mentalModel'),
    exceptions: merge('exceptions'),
  }
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
    .replace('{{SECURITY}}', sections.security ?? DEFAULT_SECURITY)
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

function looksLikeSymlink(content: string): boolean {
  const trimmed = content.trim()
  return !trimmed.includes('\n') && /^\.{1,2}\/[^\s]+\.\w+$/.test(trimmed)
}

function resolveSymlink(symlinkDir: string, target: string): string {
  const parts = (symlinkDir ? symlinkDir + '/' + target : target).split('/')
  const resolved: string[] = []
  for (const p of parts) {
    if (p === '..') resolved.pop()
    else if (p !== '.') resolved.push(p)
  }
  return resolved.join('/')
}

/** When every changed file lives under one top-level directory (monorepo module,
 *  e.g. web-app/), that directory acts as the effective repo root for prompt lookup.
 *  Root-level files don't disqualify the detection — only a second directory does. */
function detectModuleDir(changedFiles: ChangedFile[]): string | null {
  const dirs = new Set<string>()
  for (const f of changedFiles) {
    const slash = f.path.indexOf('/')
    if (slash > 0) dirs.add(f.path.slice(0, slash))
  }
  return dirs.size === 1 ? [...dirs][0] : null
}

export type PromptSource = 'repo' | 'default' | string

export interface LoadedPrompt {
  content: string
  source: PromptSource
}

export async function loadPrompt(adapter: VCSAdapter, prInfo: PRInfo, localPromptPath?: string, changedFiles?: ChangedFile[], diff?: string): Promise<LoadedPrompt> {
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

  // Fallback: PRs confined to one top-level module dir also check inside it
  const moduleDir = changedFiles?.length ? detectModuleDir(changedFiles) : null
  if (moduleDir) {
    console.log(`  PR changes are confined to "${moduleDir}/" — will also check it for instructions`)
    paths.push(`${moduleDir}/${REPO_PROMPT_FILE}`, `${moduleDir}/docs/${REPO_PROMPT_FILE}`)
  }
  for (const ref of [prInfo.sourceCommit, prInfo.targetBranch]) {
    for (const path of paths) {
      let repoPrompt = await adapter.getRepoFileContent(path, ref)
      if (repoPrompt) {
        // Git symlinks are stored as a single line with the target path
        if (looksLikeSymlink(repoPrompt)) {
          const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
          const resolved = resolveSymlink(dir, repoPrompt.trim())
          console.log(`  ${path} is a symlink → ${resolved}`)
          repoPrompt = await adapter.getRepoFileContent(resolved, ref)
          if (!repoPrompt) continue
        }
        console.log(`Using repo-specific prompt from ${path} (${ref.slice(0, 12)})`)
        const sections = parseRepoPrompt(repoPrompt)
        logSections(sections)
        const filled = fillTemplate(template, sections)
        return { content: filled, source: 'repo' }
      }
    }
  }

  // 3. No repo prompt: compose the bundled base + overlay rule sets detected from the PR
  const { bases, overlays } = changedFiles?.length ? detectStacks(changedFiles, diff) : { bases: [], overlays: [] }
  if (bases.length) {
    const names = [...bases, ...overlays]
    console.log(`Detected tech stack: ${names.join(' + ')} — using bundled rule sets`)
    const sections = composeSections(names.map(n => parseRepoPrompt(getStackPrompt(n))))
    logSections(sections)
    return { content: fillTemplate(template, sections), source: `stack:${names.join('+')}` }
  }

  // 4. Fall back to all defaults
  console.log(`No ${REPO_PROMPT_FILE} found in source or target branch — using default prompt`)
  const filled = fillTemplate(template, {})
  return { content: filled, source: 'default' }
}
