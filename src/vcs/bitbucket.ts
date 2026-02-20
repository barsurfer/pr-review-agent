import axios, { AxiosInstance } from 'axios'
import type { VCSAdapter, PRInfo, ChangedFile } from './adapter.js'

export class BitbucketAdapter implements VCSAdapter {
  private readonly client: AxiosInstance
  private readonly workspace: string

  constructor(baseUrl: string, workspace: string, token: string) {
    this.workspace = workspace
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
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
    const { data } = await this.client.get(
      `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/diff`,
      { headers: { Accept: 'text/plain' }, responseType: 'text' }
    )
    return data as string
  }

  async getChangedFiles(prId: string): Promise<ChangedFile[]> {
    const repoSlug = this.getRepoSlug()
    const files: ChangedFile[] = []
    let url = `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/diffstat`

    while (url) {
      const { data } = await this.client.get(url)
      for (const entry of data.values) {
        const path: string = entry.new?.path ?? entry.old?.path
        const status = this.mapStatus(entry.status)
        if (path) files.push({ path, status })
      }
      url = data.next ?? null
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
