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

export interface VCSAdapter {
  getPullRequestInfo(prId: string): Promise<PRInfo>
  getDiff(prId: string): Promise<string>
  getFileContent(filePath: string, ref: string): Promise<string>
  getChangedFiles(prId: string): Promise<ChangedFile[]>
  /** Fetch a file from the repo root — used to load .claude-review-prompt.md. Returns null if not found. */
  getRepoFileContent(filePath: string): Promise<string | null>
  postComment(prId: string, body: string): Promise<void>
}
