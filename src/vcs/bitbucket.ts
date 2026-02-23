import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'
import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply } from './adapter.js'

export class BitbucketAdapter implements VCSAdapter {
  private readonly client: AxiosInstance
  private readonly workspace: string
  private readonly authHeader: string

  constructor(baseUrl: string, workspace: string, username: string, token: string) {
    this.workspace = workspace
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64')
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
    })
  }

  /** Follow 302 redirects while preserving auth (axios strips auth on redirect). */
  private async getFollowingRedirects(url: string, config: AxiosRequestConfig = {}): Promise<any> {
    const res = await this.client.get(url, { ...config, maxRedirects: 0, validateStatus: s => s < 400 || s === 302 })
    if (res.status === 302 && res.headers.location) {
      return axios.get(res.headers.location, {
        ...config,
        headers: { ...config.headers, Authorization: this.authHeader },
      })
    }
    return res
  }

  async getPullRequestInfo(prId: string): Promise<PRInfo> {
    const repoSlug = this.getRepoSlug()
    const { data } = await this.client.get(
      `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}`
    )
    return {
      id: String(data.id),
      title: data.title,
      description: data.description ?? '',
      sourceBranch: data.source.branch.name,
      targetBranch: data.destination.branch.name,
      sourceCommit: data.source.commit.hash,
    }
  }

  async getDiff(prId: string): Promise<string> {
    const repoSlug = this.getRepoSlug()
    const { data } = await this.getFollowingRedirects(
      `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/diff`,
      { headers: { Accept: 'text/plain' }, responseType: 'text' }
    )
    return data as string
  }

  async getChangedFiles(prId: string): Promise<ChangedFile[]> {
    const repoSlug = this.getRepoSlug()
    const files: ChangedFile[] = []

    // First request may redirect — use redirect-safe helper
    const first = await this.getFollowingRedirects(
      `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/diffstat`
    )
    for (const entry of first.data.values) {
      const path: string = entry.new?.path ?? entry.old?.path
      const status = this.mapStatus(entry.status)
      if (path) files.push({ path, status })
    }

    // Pagination pages are direct URLs, no redirect
    let next = first.data.next ?? null
    while (next) {
      const { data } = await this.client.get(next)
      for (const entry of data.values) {
        const path: string = entry.new?.path ?? entry.old?.path
        const status = this.mapStatus(entry.status)
        if (path) files.push({ path, status })
      }
      next = data.next ?? null
    }

    return files
  }

  async getFileContent(filePath: string, ref: string): Promise<string> {
    const repoSlug = this.getRepoSlug()
    const { data } = await this.client.get(
      `/repositories/${this.workspace}/${repoSlug}/src/${ref}/${filePath}`,
      { responseType: 'text' }
    )
    return data as string
  }

  async getRepoFileContent(filePath: string): Promise<string | null> {
    const repoSlug = this.getRepoSlug()
    try {
      const { data } = await this.client.get(
        `/repositories/${this.workspace}/${repoSlug}/src/HEAD/${filePath}`,
        { responseType: 'text' }
      )
      return data as string
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null
      throw err
    }
  }

  async postComment(prId: string, body: string): Promise<void> {
    const repoSlug = this.getRepoSlug()
    await this.client.post(
      `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/comments`,
      { content: { raw: body } }
    )
  }

  async getPreviousReviewComments(prId: string): Promise<ReviewComment[]> {
    const repoSlug = this.getRepoSlug()
    const comments: ReviewComment[] = []
    let url: string | null = `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/comments`

    while (url) {
      const { data }: { data: any } = await this.client.get(url)
      for (const c of data.values) {
        const body: string = c.content?.raw ?? ''
        // Only include comments posted by this agent (footer always contains this marker)
        if (body.includes('Reviewed by Claude')) {
          comments.push({
            id: String(c.id),
            body,
            createdOn: c.created_on,
          })
        }
      }
      url = data.next ?? null
    }

    return comments
  }

  async getRepliesToReviewComments(prId: string, reviewCommentIds: string[]): Promise<CommentReply[]> {
    const repoSlug = this.getRepoSlug()
    const idSet = new Set(reviewCommentIds)
    const humanReplies: CommentReply[] = []
    let latestAgentReply = ''   // ISO timestamp of our most recent reply
    let url: string | null = `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/comments`

    while (url) {
      const { data }: { data: any } = await this.client.get(url)
      for (const c of data.values) {
        const parentId = c.parent?.id ? String(c.parent.id) : null
        if (!parentId || !idSet.has(parentId)) continue
        const body: string = c.content?.raw ?? ''
        if (body.includes('Reply by Claude')) {
          // Track the latest agent reply timestamp
          if (c.created_on > latestAgentReply) latestAgentReply = c.created_on
          continue
        }
        humanReplies.push({
          id: String(c.id),
          parentId,
          author: c.user?.display_name ?? 'Unknown',
          body,
          createdOn: c.created_on,
        })
      }
      url = data.next ?? null
    }

    // Only return human replies that came AFTER our last agent reply
    if (!latestAgentReply) return humanReplies
    return humanReplies.filter(r => r.createdOn > latestAgentReply)
  }

  async postReply(prId: string, parentId: string, body: string): Promise<void> {
    const repoSlug = this.getRepoSlug()
    await this.client.post(
      `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/comments`,
      { parent: { id: Number(parentId) }, content: { raw: body } }
    )
  }

  // repo slug is passed in at call sites via CLI — store it after construction
  private repoSlug = ''

  setRepoSlug(slug: string): void {
    this.repoSlug = slug
  }

  private getRepoSlug(): string {
    if (!this.repoSlug) throw new Error('repo slug not set on BitbucketAdapter')
    return this.repoSlug
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
