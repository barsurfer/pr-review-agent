import axios, { AxiosInstance, AxiosRequestConfig } from 'axios'
import { hasReviewFooter, hasReplyFooter } from '../review/formatter.js'
import { decideDirectedElsewhere, mentionsAgent } from './mention-filter.js'
import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply, ReplyResult } from './adapter.js'
import { AGENT_REPLY_AUTHOR, authorIdOf } from './adapter.js'
import { withCallLog, withRetry } from './http-retry.js'

// Bound every Bitbucket call so a hung request fails fast instead of stalling the whole run
const REQUEST_TIMEOUT_MS = 30_000

// Built from parent links, not API order; a chain through a deleted (absent) comment or a cycle reaches no review.
function threadMembers(comments: any[], reviewIds: ReadonlySet<string>): Set<string> {
  const parentOf = new Map<string, string | null>()
  for (const c of comments) parentOf.set(String(c.id), c.parent?.id ? String(c.parent.id) : null)
  const reaches = new Map<string, boolean>()
  const reachesReview = (start: string): boolean => {
    const path = new Set<string>()
    let cur: string | null | undefined = start
    let ok = false
    while (cur != null) {
      if (reviewIds.has(cur)) { ok = true; break }
      const known = reaches.get(cur)
      if (known !== undefined) { ok = known; break }
      if (path.has(cur) || !parentOf.has(cur)) break
      path.add(cur)
      cur = parentOf.get(cur)
    }
    for (const id of path) reaches.set(id, ok)
    return ok
  }
  const members = new Set<string>()
  for (const [id, parent] of parentOf) if (parent != null && reachesReview(parent)) members.add(id)
  return members
}

export class BitbucketAdapter implements VCSAdapter {
  private readonly client: AxiosInstance
  private readonly redirectClient: Pick<AxiosInstance, 'get'>
  private readonly workspace: string
  private readonly authHeader: string
  private readonly baseHost: string

  constructor(baseUrl: string, workspace: string, username: string, token: string) {
    this.workspace = workspace
    this.authHeader = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64')
    try { this.baseHost = new URL(baseUrl).host } catch { this.baseHost = '' }
    this.client = withRetry(withCallLog(axios.create({
      baseURL: baseUrl,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
    }), 'bitbucket'), 'bitbucket')
    this.redirectClient = withRetry(withCallLog(axios, 'bitbucket'), 'bitbucket')
  }

  /** Follow 302 redirects while preserving auth (axios strips auth on redirect).
   *  Only re-attach auth on same-host redirects — never leak the token to another host. */
  private async getFollowingRedirects(url: string, config: AxiosRequestConfig = {}): Promise<any> {
    const res = await this.client.get(url, { ...config, maxRedirects: 0, timeout: REQUEST_TIMEOUT_MS, validateStatus: s => s < 400 || s === 302 })
    if (res.status === 302 && res.headers.location) {
      const location = res.headers.location as string
      let sameHost = false
      try { sameHost = new URL(location).host === this.baseHost } catch { sameHost = false }
      if (!sameHost) {
        console.warn(`  Redirect to a different host — not forwarding auth`)
      }
      return this.redirectClient.get(location, {
        ...config,
        timeout: REQUEST_TIMEOUT_MS,
        headers: sameHost ? { ...config.headers, Authorization: this.authHeader } : { ...config.headers },
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
      author: data.author?.display_name ?? 'Unknown',
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

  async getRepoFileContent(filePath: string, ref = 'HEAD'): Promise<string | null> {
    const repoSlug = this.getRepoSlug()
    try {
      const { data } = await this.client.get(
        `/repositories/${this.workspace}/${repoSlug}/src/${ref}/${filePath}`,
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

  // All PR comments, paginated, with deleted tombstones dropped so no flow treats them as real.
  private async fetchComments(prId: string): Promise<any[]> {
    const repoSlug = this.getRepoSlug()
    const out: any[] = []
    let url: string | null = `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/comments`
    while (url) {
      const { data }: { data: any } = await this.client.get(url)
      for (const c of data.values) if (!c.deleted) out.push(c)
      url = data.next ?? null
    }
    return out
  }

  async getPreviousReviewComments(prId: string): Promise<ReviewComment[]> {
    const comments: ReviewComment[] = []
    for (const c of await this.fetchComments(prId)) {
      const body: string = c.content?.raw ?? ''
      // Match the agent's exact footer line, not a substring — a human writing
      // "Reviewed by me" must not be mistaken for an agent review
      if (hasReviewFooter(body)) {
        comments.push({
          id: String(c.id),
          body,
          createdOn: c.created_on,
          resolved: c.resolution != null,   // a human marked this review thread resolved
        })
      }
    }
    return comments
  }

  async getRepliesToReviewComments(prId: string, reviewCommentIds: string[], includeAnswered = false): Promise<ReplyResult> {
    const reviewIdSet = new Set(reviewCommentIds)
    this.agentIds = new Set()
    this.agentNames = new Set()
    const humanReplies: CommentReply[] = []
    let agentReplyCount = 0
    let latestAgentReply = ''   // ISO timestamp of our most recent reply

    const comments = await this.fetchComments(prId)
    const inThread = threadMembers(comments, reviewIdSet)
    const agentCommentIds = new Set<string>()
    for (const c of comments) {
      if (!reviewIdSet.has(String(c.id)) && !hasReplyFooter(c.content?.raw ?? '')) continue
      agentCommentIds.add(String(c.id))
      // Agent identity = authors of our reviews and replies; derivation only adds ids, so a human is never taken for the agent.
      if (c.user) {
        if (c.user.account_id) this.agentIds.add(String(c.user.account_id))
        if (c.user.uuid) this.agentIds.add(String(c.user.uuid).replace(/[{}]/g, ''))
        if (c.user.display_name) this.agentNames.add(String(c.user.display_name).toLowerCase())
        if (c.user.nickname) this.agentNames.add(String(c.user.nickname).toLowerCase())
      }
    }
    let identityWarned = false

    for (const c of comments) {
      const body: string = c.content?.raw ?? ''
      if (!inThread.has(String(c.id))) continue
      const parentId = String(c.parent.id)
      if (hasReplyFooter(body)) {
        agentReplyCount++
        if (c.created_on > latestAgentReply) latestAgentReply = c.created_on
        // For delta reviews, include agent replies so the model sees its own prior conclusions
        if (includeAnswered) {
          humanReplies.push({
            id: String(c.id),
            parentId,
            author: AGENT_REPLY_AUTHOR,
            body,
            createdOn: c.created_on,
          })
        }
        continue
      }
      // A reply to an agent comment is addressed to the agent implicitly; one to a human only when it @-mentions the agent.
      let contextOnly = false
      if (!agentCommentIds.has(parentId)) {
        if (this.agentIds.size === 0) {
          if (!identityWarned) console.warn('  Could not derive the agent id-set — keeping all replies (nested-reply @-mention rule inert this run)')
          identityWarned = true
        } else {
          contextOnly = !mentionsAgent(body, this.agentIds, this.agentNames)
        }
      }
      humanReplies.push({
        id: String(c.id),
        parentId,
        author: c.user?.display_name ?? 'Unknown',
        ...authorIdOf(c.user?.uuid ?? c.user?.account_id),
        ...(contextOnly ? { contextOnly: true as const } : {}),
        body,
        createdOn: c.created_on,
      })
    }
    // RESPOND_TO_REPLIES answers under the last reply's parent, so the newest must come last whatever the API order.
    humanReplies.sort((a, b) => (a.createdOn < b.createdOn ? -1 : a.createdOn > b.createdOn ? 1 : 0))

    // For delta review context: return all human replies
    if (includeAnswered) return { replies: humanReplies, agentReplyCount }
    // For reply flow: only return replies that came AFTER our last agent reply
    if (!latestAgentReply) return { replies: humanReplies, agentReplyCount }
    return { replies: humanReplies.filter(r => r.createdOn > latestAgentReply), agentReplyCount }
  }

  async postReply(prId: string, parentId: string, body: string): Promise<void> {
    const repoSlug = this.getRepoSlug()
    await this.client.post(
      `/repositories/${this.workspace}/${repoSlug}/pullrequests/${prId}/comments`,
      { parent: { id: Number(parentId) }, content: { raw: body } }
    )
  }

  // Agent id-set/names derived from comment authors during the last getRepliesToReviewComments; the
  // caller can only add to the set. Empty set (no identity resolved) fails safe: keep everything + warn.
  private agentIds = new Set<string>()
  private agentNames = new Set<string>()

  async filterAddressedToAgent(replies: CommentReply[], agentIds: ReadonlySet<string>): Promise<CommentReply[]> {
    const ids = new Set<string>([...agentIds, ...this.agentIds])
    if (ids.size === 0) {
      console.warn('  Could not derive the agent id-set — keeping all replies (skip-directed-replies inert this run)')
      return replies
    }
    const kept: CommentReply[] = []
    for (const r of replies) {
      const decision = decideDirectedElsewhere(r.body, ids, this.agentNames)
      if (decision.drop) {
        console.log(`  Dropping reply ${r.id} by ${r.author} — @-directed elsewhere (matched @{${decision.matchedToken}})`)
        continue
      }
      kept.push(r)
    }
    return kept
  }

  async getCommitDiff(fromCommit: string, toCommit: string): Promise<string> {
    const repoSlug = this.getRepoSlug()
    // Bitbucket Cloud diff spec: {new}..{old} shows what new has over old
    const { data } = await this.getFollowingRedirects(
      `/repositories/${this.workspace}/${repoSlug}/diff/${toCommit}..${fromCommit}`,
      { headers: { Accept: 'text/plain' }, responseType: 'text' }
    )
    return data as string
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
