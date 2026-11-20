export interface PRInfo {
  id: string
  title: string
  description: string
  author: string
  sourceBranch: string
  targetBranch: string
  sourceCommit: string
  targetCommit?: string
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
}

export interface ReviewComment {
  id: string
  body: string
  createdOn: string
  resolved?: boolean
}

export interface CommentReply {
  id: string
  parentId: string
  author: string
  // Platform account id for usage records only; never part of any model input.
  authorId?: string
  findingId?: string
  // Set when a human answered a human without @-mentioning the agent: discussion context, never a question to answer.
  contextOnly?: true
  body: string
  createdOn: string
}

// Spread target: the key is omitted, not undefined, when the payload has no id.
export const authorIdOf = (id: unknown): { authorId?: string } => (typeof id === 'string' && id ? { authorId: id } : {})

export const AGENT_REPLY_AUTHOR = 'Agent (prior reply)'

// Every adapter labels its own earlier replies (reply-footer match) with this author; no human reply carries it.
export const isAgentReply = (r: CommentReply): boolean => r.author === AGENT_REPLY_AUTHOR

export interface ReplyResult {
  replies: CommentReply[]
  agentReplyCount: number
}

// Raised when a PR's full diff exceeds the provider's fetch ceilings; the FSM turns it into a clean SKIP.
export class PrTooLargeError extends Error {
  constructor(public readonly prId: string, public readonly reason: string) {
    super(`PR too large to review (${reason})`)
    this.name = 'PrTooLargeError'
  }
}

export interface VCSAdapter {
  getPullRequestInfo(prId: string): Promise<PRInfo>
  getDiff(prId: string): Promise<string>
  getFileContent(filePath: string, ref: string): Promise<string>
  getChangedFiles(prId: string): Promise<ChangedFile[]>
  /** Fetch a file from the repo at a given ref (branch/commit). Returns null if not found. */
  getRepoFileContent(filePath: string, ref?: string, opts?: { found?: boolean }): Promise<string | null>
  postComment(prId: string, body: string): Promise<void>
  /** Fetch previous review comments posted by this agent on the PR. */
  getPreviousReviewComments(prId: string): Promise<ReviewComment[]>
  /** Fetch human replies to the agent's review comments.
   *  When includeAnswered is true, returns all human replies (for delta review context).
   *  When false (default), returns only unanswered replies (for the reply flow). */
  getRepliesToReviewComments(prId: string, reviewCommentIds: string[], includeAnswered?: boolean): Promise<ReplyResult>
  /** Post a threaded reply to an existing comment. */
  postReply(prId: string, parentId: string, body: string): Promise<void>
  /** Keep only replies addressed to the agent, dropping ones @-directed solely elsewhere. Valid only
   *  right after getRepliesToReviewComments, where the agent id-set is derived. Omit if unsupported. */
  filterAddressedToAgent?(replies: CommentReply[], agentIds: ReadonlySet<string>): Promise<CommentReply[]>
  /** Fetch the diff between two commits (for delta reviews). */
  getCommitDiff(fromCommit: string, toCommit: string): Promise<string>
  /** The PR diff as it was when sourceCommit was the head; without it a target merge is reviewed on the full delta. */
  getPrDiffAt?(sourceCommit: string, targetCommit: string): Promise<string>
  /** A commit's parents, first parent first; without it a quiet re-review after a target merge still posts its confirmation. */
  getCommitParents?(commit: string): Promise<string[]>
  listMarkedThreads?: InlineCapableAdapter["listMarkedThreads"]
  postInlineComment?: InlineCapableAdapter["postInlineComment"]
  postTopLevelComment?: InlineCapableAdapter["postTopLevelComment"]
  postThreadComment?: InlineCapableAdapter["postThreadComment"]
  editComment?: InlineCapableAdapter["editComment"]
  getAgentIdentity?: InlineCapableAdapter["getAgentIdentity"]
}

export interface AgentIdentity { ids: string[]; names: string[] }

export interface PostedComment { id: string; url: string; createdOn: string; authorIds: string[] }

export interface MarkedComment {
  id: string
  seq: number
  parentId?: string
  body: string
  author: string
  authorIds: string[]
  createdOn: string
}

export interface MarkedThread {
  root: MarkedComment & { url: string; inline?: { path: string; line?: number } }
  resolved: boolean
  comments: MarkedComment[]
}

export interface InlineCapableAdapter {
  listMarkedThreads(prId: string, isMarked: (body: string) => boolean): Promise<MarkedThread[]>
  postInlineComment(prId: string, anchor: { path: string; line: number }, body: string): Promise<PostedComment>
  postTopLevelComment(prId: string, body: string): Promise<PostedComment>
  postThreadComment(prId: string, parentId: string, body: string): Promise<PostedComment>
  editComment(prId: string, commentId: string, body: string): Promise<void>
  getAgentIdentity(): Promise<AgentIdentity>
}
