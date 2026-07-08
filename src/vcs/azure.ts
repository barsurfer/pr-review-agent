// ---------------------------------------------------------------------------
// Azure DevOps VCS adapter — WORK IN PROGRESS / EXPERIMENTAL.
//
// Implements the full VCSAdapter interface against the Azure DevOps REST API
// v7.1 (cloud Services and on-prem Server share the API; only the base URL
// differs). Validated against mocked API shapes only — NOT yet exercised against
// a live instance. Confirm end-to-end before production use.
//
// The crux is diff reconstruction: Azure has no native unified-diff endpoint, so
// getDiff/getCommitDiff rebuild a git-style unified diff from the `diffs/commits`
// change list plus old/new blob content, byte-compatible with what filterDiff /
// countChangedLines / scanTodos already parse.
// ---------------------------------------------------------------------------

import axios, { AxiosInstance } from 'axios'
import { structuredPatch } from 'diff'
import { hasReviewFooter, hasReplyFooter } from '../review/formatter.js'
import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply, ReplyResult } from './adapter.js'

// Skip content-diffing files past this size — huge blobs blow up the diff and the
// size thresholds without adding review value (mirrors the context-fetch caps).
const MAX_DIFF_FILE_CHARS = 400_000

type AzureChangeType = 'add' | 'edit' | 'delete' | 'rename'

interface AzureChange {
  path: string
  originalPath?: string
  changeType: AzureChangeType
}

interface AzureCommitDiff {
  baseCommit: string
  targetCommit: string
  changes: AzureChange[]
}

export class AzureDevOpsAdapter implements VCSAdapter {
  private readonly client: AxiosInstance
  private readonly authHeader: string
  private repoSlug = ''

  constructor(baseUrl: string, org: string, project: string, pat: string, accessToken = '') {
    // Auth precedence: AZURE_ACCESS_TOKEN (OAuth Bearer — e.g. an Azure Pipelines
    // System.AccessToken, no PAT needed) wins over AZURE_PAT (HTTP Basic with an
    // empty username: base64(":{PAT}")). One of the two must be supplied.
    this.authHeader = accessToken
      ? `Bearer ${accessToken}`
      : 'Basic ' + Buffer.from(`:${pat}`).toString('base64')
    this.client = axios.create({
      baseURL: `${baseUrl}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git`,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      params: { 'api-version': '7.1' },   // required on every Azure DevOps call
    })
    console.warn('Azure DevOps adapter is experimental (WIP) — validated against mocked API shapes only; confirm against a live instance before production use.')
  }

  async getPullRequestInfo(prId: string): Promise<PRInfo> {
    const repo = this.getRepoSlug()
    const { data } = await this.client.get(`/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}`)
    return {
      id: String(data.pullRequestId),
      title: data.title,
      description: data.description ?? '',
      author: data.createdBy?.displayName ?? 'Unknown',
      sourceBranch: stripRefsHeads(data.sourceRefName),
      targetBranch: stripRefsHeads(data.targetRefName),
      sourceCommit: data.lastMergeSourceCommit?.commitId ?? '',
    }
  }

  async getDiff(prId: string): Promise<string> {
    const { base, target } = await this.getPrCommits(prId)
    // diffCommonCommit → three-dot (merge-base) diff, matching how a PR renders.
    return this.buildDiff(base, target, true)
  }

  async getCommitDiff(fromCommit: string, toCommit: string): Promise<string> {
    // Delta re-reviews pass the previous commit from the review footer, which is abbreviated.
    // Azure's diffs/commits rejects short SHAs, so resolve it to a full 40-char id first.
    const base = await this.resolveCommit(fromCommit, toCommit)
    // Two-dot diff: exactly the changes introduced between the two commits.
    return this.buildDiff(base, toCommit, false)
  }

  async getChangedFiles(prId: string): Promise<ChangedFile[]> {
    const { base, target } = await this.getPrCommits(prId)
    const { changes } = await this.fetchCommitDiff(base, target, true)
    return changes.map(c => ({ path: c.path, status: mapStatus(c.changeType) }))
  }

  async getFileContent(filePath: string, ref: string): Promise<string> {
    const repo = this.getRepoSlug()
    const { data } = await this.client.get(`/repositories/${encodeURIComponent(repo)}/items`, {
      params: {
        path: withLeadingSlash(filePath),
        'versionDescriptor.version': ref,
        'versionDescriptor.versionType': 'commit',
      },
      headers: { Accept: 'text/plain' },
      responseType: 'text',
    })
    return data as string
  }

  async getRepoFileContent(filePath: string, ref = 'HEAD'): Promise<string | null> {
    const repo = this.getRepoSlug()
    const params: Record<string, string> = { path: withLeadingSlash(filePath) }
    // 'HEAD' is not an Azure version type — omit the descriptor to hit the default branch tip.
    // Otherwise pick the version type by ref shape: a hex SHA is a commit, anything else
    // (e.g. a branch name like "main") must be queried as a branch or Azure returns 400.
    if (ref && ref !== 'HEAD') {
      params['versionDescriptor.version'] = ref
      params['versionDescriptor.versionType'] = /^[0-9a-f]{7,40}$/i.test(ref) ? 'commit' : 'branch'
    }
    try {
      const { data } = await this.client.get(`/repositories/${encodeURIComponent(repo)}/items`, {
        params,
        headers: { Accept: 'text/plain' },
        responseType: 'text',
      })
      return data as string
    } catch (err: unknown) {
      // Missing file (404) or an unresolvable ref (400) → no repo prompt here; caller defaults.
      const status = axios.isAxiosError(err) ? err.response?.status : undefined
      if (status === 404 || status === 400) return null
      throw err
    }
  }

  async postComment(prId: string, body: string): Promise<void> {
    const repo = this.getRepoSlug()
    // A top-level review is a new thread; commentType 1 = text, status 1 = active.
    await this.client.post(`/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads`, {
      comments: [{ parentCommentId: 0, content: body, commentType: 1 }],
      status: 1,
    })
  }

  async getPreviousReviewComments(prId: string): Promise<ReviewComment[]> {
    const comments: ReviewComment[] = []
    for (const thread of await this.fetchThreads(prId)) {
      for (const c of thread.comments ?? []) {
        const body: string = c.content ?? ''
        // Match the agent's exact footer line, not a substring (see bitbucket.ts).
        if (hasReviewFooter(body)) {
          comments.push({ id: `${thread.id}:${c.id}`, body, createdOn: c.publishedDate })
        }
      }
    }
    return comments
  }

  async getRepliesToReviewComments(prId: string, reviewCommentIds: string[], includeAnswered = false): Promise<ReplyResult> {
    const reviewIds = new Set(reviewCommentIds)
    // Replies live in the SAME thread as the review comment they answer.
    const threadIds = new Set(reviewCommentIds.map(id => id.split(':')[0]))
    const humanReplies: CommentReply[] = []
    let agentReplyCount = 0
    let latestAgentReply = ''

    for (const thread of await this.fetchThreads(prId)) {
      const tid = String(thread.id)
      if (!threadIds.has(tid)) continue
      const parentReviewId = reviewCommentIds.find(id => id.split(':')[0] === tid)!
      for (const c of thread.comments ?? []) {
        const compositeId = `${tid}:${c.id}`
        if (reviewIds.has(compositeId)) continue   // the review comment itself, not a reply
        const body: string = c.content ?? ''
        const createdOn: string = c.publishedDate
        if (hasReplyFooter(body)) {
          agentReplyCount++
          if (createdOn > latestAgentReply) latestAgentReply = createdOn
          if (includeAnswered) {
            humanReplies.push({ id: compositeId, parentId: parentReviewId, author: 'Agent (prior reply)', body, createdOn })
          }
          continue
        }
        humanReplies.push({ id: compositeId, parentId: parentReviewId, author: c.author?.displayName ?? 'Unknown', body, createdOn })
      }
    }

    if (includeAnswered) return { replies: humanReplies, agentReplyCount }
    if (!latestAgentReply) return { replies: humanReplies, agentReplyCount }
    return { replies: humanReplies.filter(r => r.createdOn > latestAgentReply), agentReplyCount }
  }

  async postReply(prId: string, parentId: string, body: string): Promise<void> {
    const repo = this.getRepoSlug()
    const [threadId, commentId] = parentId.split(':')
    await this.client.post(
      `/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads/${threadId}/comments`,
      { content: body, parentCommentId: Number(commentId), commentType: 1 }
    )
  }

  setRepoSlug(slug: string): void {
    this.repoSlug = slug
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private getRepoSlug(): string {
    if (!this.repoSlug) throw new Error('repo slug not set on AzureDevOpsAdapter')
    return this.repoSlug
  }

  /** Resolve the PR's base (target branch) and target (source branch) commit SHAs. */
  private async getPrCommits(prId: string): Promise<{ base: string; target: string }> {
    const repo = this.getRepoSlug()
    const { data } = await this.client.get(`/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}`)
    return {
      base: data.lastMergeTargetCommit?.commitId ?? '',
      target: data.lastMergeSourceCommit?.commitId ?? '',
    }
  }

  /** Azure's diffs/commits requires full 40-char SHAs, but review footers carry an abbreviated
   *  hash. Resolve it by prefix-matching the commits reachable from `reachableFrom` — a full SHA
   *  we already hold (the current PR source commit) — so no PR id or extra context is needed. */
  private async resolveCommit(ref: string, reachableFrom: string): Promise<string> {
    if (/^[0-9a-f]{40}$/i.test(ref)) return ref
    const repo = this.getRepoSlug()
    const { data }: { data: any } = await this.client.get(`/repositories/${encodeURIComponent(repo)}/commits`, {
      params: {
        'searchCriteria.itemVersion.version': reachableFrom,
        'searchCriteria.itemVersion.versionType': 'commit',
        'searchCriteria.$top': 200,
      },
    })
    const match = (data.value ?? []).find((c: any) => typeof c.commitId === 'string' && c.commitId.startsWith(ref))
    if (!match) throw new Error(`cannot resolve abbreviated commit ${ref} within the ${(data.value ?? []).length} most recent commits`)
    return match.commitId as string
  }

  private async fetchThreads(prId: string): Promise<any[]> {
    const repo = this.getRepoSlug()
    const { data } = await this.client.get(`/repositories/${encodeURIComponent(repo)}/pullRequests/${prId}/threads`)
    return data.value ?? []
  }

  /** GET diffs/commits and normalize to blob-only changes (folders/trees dropped). */
  private async fetchCommitDiff(baseVersion: string, targetVersion: string, diffCommonCommit: boolean): Promise<AzureCommitDiff> {
    const repo = this.getRepoSlug()
    const changes: AzureChange[] = []
    let baseCommit = baseVersion
    let targetCommit = targetVersion
    let skip = 0

    // diffs/commits paginates via $top/$skip and signals completion with allChangesIncluded.
    for (;;) {
      const { data }: { data: any } = await this.client.get(`/repositories/${encodeURIComponent(repo)}/diffs/commits`, {
        params: {
          baseVersion, baseVersionType: 'commit',
          targetVersion, targetVersionType: 'commit',
          diffCommonCommit,
          '$top': 1000,
          '$skip': skip,
        },
      })
      baseCommit = data.baseCommit ?? baseCommit
      targetCommit = data.targetCommit ?? targetCommit
      const batch: any[] = data.changes ?? []
      for (const entry of batch) {
        const item = entry.item ?? {}
        if (item.isFolder || (item.gitObjectType && item.gitObjectType !== 'blob')) continue
        const changeType = mapChangeType(String(entry.changeType ?? ''))
        if (!changeType) continue
        const path = stripLeadingSlash(item.path ?? '')
        if (!path) continue
        const originalPath = item.originalPath ?? entry.sourceServerItem
        changes.push({ path, changeType, originalPath: originalPath ? stripLeadingSlash(originalPath) : undefined })
      }
      if (data.allChangesIncluded !== false || batch.length === 0) break
      skip += batch.length
    }

    return { baseCommit, targetCommit, changes }
  }

  /** Reconstruct a unified diff by fetching old/new blob content and running jsdiff. */
  private async buildDiff(baseVersion: string, targetVersion: string, diffCommonCommit: boolean): Promise<string> {
    const { baseCommit, targetCommit, changes } = await this.fetchCommitDiff(baseVersion, targetVersion, diffCommonCommit)
    const parts: string[] = []
    for (const change of changes) {
      const patch = await this.buildFilePatch(change, baseCommit, targetCommit)
      if (patch) parts.push(patch)
    }
    return parts.join('')
  }

  private async buildFilePatch(change: AzureChange, oldRef: string, newRef: string): Promise<string> {
    let oldPath: string | null
    let newPath: string | null
    let oldContent: string | null
    let newContent: string | null

    switch (change.changeType) {
      case 'add':
        oldPath = null; newPath = change.path
        oldContent = ''
        newContent = await this.contentForDiff(change.path, newRef)
        break
      case 'delete':
        oldPath = change.path; newPath = null
        oldContent = await this.contentForDiff(change.path, oldRef)
        newContent = ''
        break
      case 'rename': {
        const from = change.originalPath ?? change.path
        oldPath = from; newPath = change.path
        oldContent = await this.contentForDiff(from, oldRef)
        newContent = await this.contentForDiff(change.path, newRef)
        break
      }
      default:   // edit
        oldPath = change.path; newPath = change.path
        oldContent = await this.contentForDiff(change.path, oldRef)
        newContent = await this.contentForDiff(change.path, newRef)
    }

    if (oldContent === null || newContent === null) return ''   // binary, oversized, or missing — skip
    return buildUnifiedFilePatch(oldPath, newPath, oldContent, newContent)
  }

  /** Fetch blob text for diffing; null for binary/oversized/missing (caller skips it). */
  private async contentForDiff(path: string, ref: string): Promise<string | null> {
    try {
      const content = await this.getFileContent(path, ref)
      if (content.length > MAX_DIFF_FILE_CHARS) return null
      if (isBinary(content)) return null
      return content
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function stripRefsHeads(ref: string | undefined): string {
  return (ref ?? '').replace(/^refs\/heads\//, '')
}

function withLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : '/' + path
}

function stripLeadingSlash(path: string): string {
  return path.replace(/^\//, '')
}

/** A NUL byte anywhere marks the blob as binary — skip it from the reconstructed diff. */
function isBinary(content: string): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0) return true
  }
  return false
}

/** Map Azure VersionControlChangeType (may be comma-combined, e.g. "edit, rename"). */
function mapChangeType(ct: string): AzureChangeType | null {
  const s = ct.toLowerCase()
  if (s.includes('rename')) return 'rename'   // captures "edit, rename" too — content diff still computed
  if (s.includes('delete')) return 'delete'
  if (s.includes('add')) return 'add'
  if (s.includes('edit')) return 'edit'
  return null
}

function mapStatus(ct: AzureChangeType): ChangedFile['status'] {
  switch (ct) {
    case 'add': return 'added'
    case 'delete': return 'deleted'
    case 'rename': return 'renamed'
    default: return 'modified'
  }
}

/**
 * Emit a git-style unified-diff section for one file. The output is byte-compatible
 * with the project's parsers: a `diff --git a/… b/…` header (filterDiff sections on
 * it), `--- a/…` / `+++ b/…` lines (scanTodos reads the `+++ b/` path), and
 * `@@ -old,n +new,m @@` hunk headers. `/dev/null` marks the missing side of an
 * add/delete. Returns '' when there is no textual change.
 */
export function buildUnifiedFilePatch(
  oldPath: string | null,
  newPath: string | null,
  oldContent: string,
  newContent: string
): string {
  const aPath = oldPath ?? newPath!
  const bPath = newPath ?? oldPath!
  const patch = structuredPatch(aPath, bPath, oldContent, newContent, '', '')
  if (patch.hunks.length === 0) return ''

  const lines: string[] = [`diff --git a/${aPath} b/${bPath}`]
  lines.push(`--- ${oldPath ? `a/${oldPath}` : '/dev/null'}`)
  lines.push(`+++ ${newPath ? `b/${newPath}` : '/dev/null'}`)
  for (const h of patch.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines) lines.push(l)
  }
  return lines.join('\n') + '\n'
}
