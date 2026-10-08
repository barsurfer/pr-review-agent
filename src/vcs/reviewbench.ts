// ReviewBench input: the PR is mounted files + RB_* env; single-shot, so no history and posting is a no-op.

import { readFileSync, realpathSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'
import { parseChangedFiles } from '../review/parsers.js'
import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, ReplyResult } from './adapter.js'

export interface ReviewBenchEnv {
  diffPath: string
  prJsonPath: string
  repoDir: string
  outPath: string
  nwo: string
  prNumber: string
  base: string
  head: string
  agent: string
}

export interface ReviewBenchPR {
  repo?: string
  pr_number?: number | string
  base?: string
  head?: string
  nwo?: string
  title?: string
  body?: string
}

export function readReviewBenchEnv(env: NodeJS.ProcessEnv = process.env): ReviewBenchEnv {
  return {
    diffPath: env.RB_DIFF || '/work/pr/diff.patch',
    prJsonPath: env.RB_PR_JSON || '/work/pr/pr.json',
    repoDir: env.RB_REPO || '/work/repo',
    outPath: env.RB_OUT || '/work/out/findings.json',
    nwo: env.RB_NWO ?? '',
    prNumber: env.RB_PR_NUMBER ?? '',
    base: env.RB_BASE ?? '',
    head: env.RB_HEAD ?? '',
    agent: env.RB_AGENT || 'pr-review-agent',
  }
}

/** pr.json, or {} when it is missing or unreadable — the env carries everything the output needs. */
export function readPrJson(path: string): ReviewBenchPR {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed as ReviewBenchPR : {}
  } catch (err: unknown) {
    console.warn(`  Could not read ${path} (${(err as Error).message}) — continuing without PR metadata`)
    return {}
  }
}

export class ReviewBenchAdapter implements VCSAdapter {
  constructor(private readonly env: ReviewBenchEnv) {}

  async getPullRequestInfo(_prId: string): Promise<PRInfo> {
    const pr = readPrJson(this.env.prJsonPath)
    const head = this.env.head || (pr.head ?? '')
    const base = this.env.base || (pr.base ?? '')
    return {
      id: this.env.prNumber || String(pr.pr_number ?? ''),
      title: pr.title ?? '',
      description: pr.body ?? '',
      author: 'unknown',
      // ReviewBench provides commit SHAs only; these labels never match the branch skip patterns.
      sourceBranch: head ? `head@${head.slice(0, 12)}` : 'head',
      targetBranch: base ? `base@${base.slice(0, 12)}` : 'base',
      sourceCommit: head,
    }
  }

  async getDiff(_prId: string): Promise<string> {
    return readFileSync(this.env.diffPath, 'utf-8')
  }

  async getChangedFiles(prId: string): Promise<ChangedFile[]> {
    return parseChangedFiles(await this.getDiff(prId))
  }

  // The checkout is pinned at RB_HEAD (a shallow clone), so every ref reads the working tree.
  async getFileContent(filePath: string, _ref: string): Promise<string> {
    return this.readRepoFile(filePath)
  }

  async getRepoFileContent(filePath: string, _ref?: string): Promise<string | null> {
    try {
      return this.readRepoFile(filePath)
    } catch {
      return null
    }
  }

  async postComment(_prId: string, _body: string): Promise<void> {}

  async getPreviousReviewComments(_prId: string): Promise<ReviewComment[]> {
    return []
  }

  async getRepliesToReviewComments(_prId: string, _reviewCommentIds: string[], _includeAnswered?: boolean): Promise<ReplyResult> {
    return { replies: [], agentReplyCount: 0 }
  }

  async postReply(_prId: string, _parentId: string, _body: string): Promise<void> {}

  async getCommitDiff(_fromCommit: string, _toCommit: string): Promise<string> {
    throw new Error('ReviewBench runs are single-shot — there is no prior review commit to diff from')
  }

  private readRepoFile(filePath: string): string {
    const root = realpathSync(this.env.repoDir)
    const full = realpathSync(resolve(root, filePath))
    const rel = relative(root, full)
    // Paths come from the PR's diff; never follow ../ or a symlink out of the checkout.
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      throw new Error(`${filePath} resolves outside the repository checkout`)
    }
    const content = readFileSync(full, 'utf-8')
    if (content.includes('\0')) throw new Error(`${filePath} is a binary file`)
    return content
  }
}
