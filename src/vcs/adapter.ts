export interface PRInfo {
  id: string
  title: string
  description: string
  sourceBranch: string
  targetBranch: string
  sourceCommit: string
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
}

export interface ReviewComment {
  id: string
  body: string
  createdOn: string
}

export interface CommentReply {
  id: string
  parentId: string
  author: string
  body: string
  createdOn: string
}

export interface VCSAdapter {
  getPullRequestInfo(prId: string): Promise<PRInfo>
  getDiff(prId: string): Promise<string>
  getFileContent(filePath: string, ref: string): Promise<string>
  getChangedFiles(prId: string): Promise<ChangedFile[]>
  /** Fetch a file from the repo at a given ref (branch/commit). Returns null if not found. */
  getRepoFileContent(filePath: string, ref?: string): Promise<string | null>
  postComment(prId: string, body: string): Promise<void>
  /** Fetch previous review comments posted by this agent on the PR. */
  getPreviousReviewComments(prId: string): Promise<ReviewComment[]>
  /** Fetch human replies to the agent's review comments.
   *  When includeAnswered is true, returns all human replies (for delta review context).
   *  When false (default), returns only unanswered replies (for the reply flow). */
  getRepliesToReviewComments(prId: string, reviewCommentIds: string[], includeAnswered?: boolean): Promise<CommentReply[]>
  /** Post a threaded reply to an existing comment. */
  postReply(prId: string, parentId: string, body: string): Promise<void>
}
