import axios, { AxiosInstance } from 'axios'
import { hasReviewFooter, hasReplyFooter } from '../review/formatter.js'
import { PrTooLargeError } from './adapter.js'
import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply, ReplyResult } from './adapter.js'

// Fail a hung request fast instead of stalling the whole run.
const REQUEST_TIMEOUT_MS = 30_000
const DIFF_ACCEPT = 'application/vnd.github.diff'
const RAW_ACCEPT = 'application/vnd.github.raw'

// Cap the compare download so a mega-PR is skipped, not buffered into memory.
const MAX_COMPARE_DIFF_BYTES = 25 * 1024 * 1024

// Big-PR compare diffs can take well over the 30s default to generate.
const COMPARE_TIMEOUT_MS = 120_000

// GitHub's /files list (and getChangedFiles) silently truncates here, so a complete diff is impossible past it
const MAX_CHANGED_FILES = 3000

export class GitHubAdapter implements VCSAdapter {
  private readonly client: AxiosInstance
  private readonly owner: string

  constructor(baseUrl: string, owner: string, token: string) {
    this.owner = owner
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
    })
  }

  async getPullRequestInfo(prId: string): Promise<PRInfo> {
    const { data } = await this.client.get(`${this.repoPath()}/pulls/${prId}`)
    return {
      id: String(data.number),
      title: data.title,
      description: data.body ?? '',
      author: data.user?.login ?? 'Unknown',
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
      sourceCommit: data.head.sha,
    }
  }

  async getDiff(prId: string): Promise<string> {
    try {
      const { data } = await this.client.get(
        `${this.repoPath()}/pulls/${prId}`,
        { headers: { Accept: DIFF_ACCEPT }, responseType: 'text' }
      )
      return data as string
    } catch (err: unknown) {
      // 406 means the diff was too big to render; fall back to compare (any other error is real).
      if (!(axios.isAxiosError(err) && err.response?.status === 406)) throw err
      // Surface why the fallback fired so the stale-base/non-size-406 risks are observable in CI logs.
      const body = typeof err.response?.data === 'string' ? err.response.data.slice(0, 200) : ''
      console.warn(`PR #${prId} diff returned 406; falling back to compare. ${body}`)
      return this.getCompareDiff(prId)
    }
  }

  // Compare has no diff-size ceiling, so it recovers a PR the /pulls diff endpoint 406'd.
  private async getCompareDiff(prId: string): Promise<string> {
    const { data: pr } = await this.client.get(`${this.repoPath()}/pulls/${prId}`)
    if (pr.changed_files > MAX_CHANGED_FILES) throw new PrTooLargeError(prId, `exceeds ${MAX_CHANGED_FILES} files`)

    // Open PR: base.ref reproduces GitHub's merge-base diff; a closed PR's base already has head, so use base.sha.
    const anchor = pr.state === 'open' ? pr.base.ref : pr.base.sha
    // Encode the branch name so a slash in it isn't read as a path separator.
    const range = `${encodeURIComponent(anchor)}...${pr.head.sha}`
    console.warn(`PR #${prId} compare fallback using ${range} (state=${pr.state})`)

    try {
      const { data } = await this.client.get(`${this.repoPath()}/compare/${range}`, {
        headers: { Accept: DIFF_ACCEPT },
        responseType: 'text',
        timeout: COMPARE_TIMEOUT_MS,
        maxContentLength: MAX_COMPARE_DIFF_BYTES,
        maxBodyLength: MAX_COMPARE_DIFF_BYTES,
      })
      return data as string
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        // A timeout on an already-oversized PR means it's effectively too large — skip, don't retry a slow diff.
        if (err.code === 'ECONNABORTED') throw new PrTooLargeError(prId, 'compare diff timed out (likely too large)')
        // axios aborts the stream past maxContentLength (no response) — the PR is genuinely too big.
        if (/maxContentLength|maxBodyLength/i.test(err.message)) throw new PrTooLargeError(prId, `diff exceeds ${MAX_COMPARE_DIFF_BYTES / (1024 * 1024)}MB`)
      }
      throw new Error(`PR #${prId} diff exceeded the GitHub PR endpoint (406) and the compare fallback failed: ${(err as Error).message}`, { cause: err })
    }
  }

  async getChangedFiles(prId: string): Promise<ChangedFile[]> {
    const entries = await this.getPaginated(`${this.repoPath()}/pulls/${prId}/files?per_page=100`)
    return entries
      .filter(e => e.filename)
      .map(e => ({ path: e.filename as string, status: this.mapStatus(e.status) }))
  }

  async getFileContent(filePath: string, ref: string): Promise<string> {
    const { data } = await this.client.get(this.contentsUrl(filePath), {
      params: { ref },
      headers: { Accept: RAW_ACCEPT },
      responseType: 'text',
    })
    return data as string
  }

  async getRepoFileContent(filePath: string, ref?: string): Promise<string | null> {
    try {
      const { data } = await this.client.get(this.contentsUrl(filePath), {
        // Omitting ref makes GitHub resolve the repo's default branch
        params: ref ? { ref } : undefined,
        headers: { Accept: RAW_ACCEPT },
        responseType: 'text',
      })
      return data as string
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null
      throw err
    }
  }

  async postComment(prId: string, body: string): Promise<void> {
    await this.client.post(`${this.repoPath()}/issues/${prId}/comments`, { body })
  }

  async getPreviousReviewComments(prId: string): Promise<ReviewComment[]> {
    const comments = await this.getIssueComments(prId)
    return comments
      // Match the exact footer line, not a substring, so a human "Reviewed by me" isn't mistaken for one.
      .filter(c => hasReviewFooter(c.body ?? ''))
      .map(c => ({ id: String(c.id), body: c.body as string, createdOn: c.created_at }))
  }

  // Issue comments are flat (no parent id): a reply is any human comment after the agent's latest one.
  async getRepliesToReviewComments(prId: string, _reviewCommentIds: string[], includeAnswered = false): Promise<ReplyResult> {
    const comments = await this.getIssueComments(prId)
    const humanReplies: CommentReply[] = []
    let agentReplyCount = 0
    let latestAgentComment = ''
    let latestReview: { id: string; createdOn: string } | null = null

    for (const c of comments) {
      const body: string = c.body ?? ''
      if (hasReviewFooter(body)) {
        if (!latestReview || c.created_at > latestReview.createdOn) latestReview = { id: String(c.id), createdOn: c.created_at }
        if (c.created_at > latestAgentComment) latestAgentComment = c.created_at
      } else if (hasReplyFooter(body)) {
        agentReplyCount++
        if (c.created_at > latestAgentComment) latestAgentComment = c.created_at
      }
    }

    // No review to answer yet
    if (!latestReview) return { replies: [], agentReplyCount }
    const parentId = latestReview.id

    for (const c of comments) {
      const body: string = c.body ?? ''
      if (hasReviewFooter(body)) continue
      if (hasReplyFooter(body)) {
        // For delta reviews, include agent replies so the model sees its own prior conclusions
        if (includeAnswered) {
          humanReplies.push({ id: String(c.id), parentId, author: 'Agent (prior reply)', body, createdOn: c.created_at })
        }
        continue
      }
      humanReplies.push({ id: String(c.id), parentId, author: c.user?.login ?? 'Unknown', body, createdOn: c.created_at })
    }

    if (includeAnswered) return { replies: humanReplies, agentReplyCount }
    return { replies: humanReplies.filter(r => r.createdOn > latestAgentComment), agentReplyCount }
  }

  async postReply(prId: string, _parentId: string, body: string): Promise<void> {
    await this.client.post(`${this.repoPath()}/issues/${prId}/comments`, { body })
  }

  async getCommitDiff(fromCommit: string, toCommit: string): Promise<string> {
    // Non-2xx (e.g. 404 after a force-push drops the old sha) throws so the caller falls back to the full diff
    const { data } = await this.client.get(
      `${this.repoPath()}/compare/${fromCommit}...${toCommit}`,
      { headers: { Accept: DIFF_ACCEPT }, responseType: 'text' }
    )
    return data as string
  }

  // repo slug is passed in at call sites via CLI — store it after construction
  private repoSlug = ''

  setRepoSlug(slug: string): void {
    this.repoSlug = slug
  }

  private getRepoSlug(): string {
    if (!this.repoSlug) throw new Error('repo slug not set on GitHubAdapter')
    return this.repoSlug
  }

  private repoPath(): string {
    return `/repos/${this.owner}/${this.getRepoSlug()}`
  }

  private contentsUrl(filePath: string): string {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/')
    return `${this.repoPath()}/contents/${encoded}`
  }

  private getIssueComments(prId: string): Promise<any[]> {
    return this.getPaginated(`${this.repoPath()}/issues/${prId}/comments?per_page=100`)
  }

  // GitHub paginates via the Link header (rel="next"), not a body field
  private async getPaginated(firstUrl: string): Promise<any[]> {
    const items: any[] = []
    let url: string | null = firstUrl
    while (url) {
      const res: { data: any; headers: Record<string, any> } = await this.client.get(url)
      items.push(...res.data)
      url = this.nextLink(res.headers?.link)
    }
    return items
  }

  private nextLink(header: unknown): string | null {
    if (typeof header !== 'string') return null
    for (const part of header.split(',')) {
      const m = part.match(/<([^>]+)>\s*;\s*rel="next"/)
      if (m) return m[1]
    }
    return null
  }

  private mapStatus(s: string): ChangedFile['status'] {
    switch (s) {
      case 'added': return 'added'
      case 'removed': return 'deleted'
      case 'renamed': return 'renamed'
      default: return 'modified'
    }
  }
}
