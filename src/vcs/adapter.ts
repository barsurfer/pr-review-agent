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
  /** Fetch a file from the repo root — used to load .claude-review-prompt.md. Returns null if not found. */
  getRepoFileContent(filePath: string): Promise<string | null>
  postComment(prId: string, body: string): Promise<void>
  /** Fetch previous review comments posted by this agent on the PR. */
  getPreviousReviewComments(prId: string): Promise<ReviewComment[]>
  /** Fetch human replies to the agent's review comments. */
  getRepliesToReviewComments(prId: string, reviewCommentIds: string[]): Promise<CommentReply[]>
  /** Post a threaded reply to an existing comment. */
  postReply(prId: string, parentId: string, body: string): Promise<void>
}
