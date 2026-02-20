import type { VCSAdapter, PRInfo, ChangedFile } from './adapter.js'

export class GitLabAdapter implements VCSAdapter {
  getPullRequestInfo(_prId: string): Promise<PRInfo> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
  getDiff(_prId: string): Promise<string> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
  getFileContent(_filePath: string, _ref: string): Promise<string> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
  getChangedFiles(_prId: string): Promise<ChangedFile[]> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
  getRepoFileContent(_filePath: string): Promise<string | null> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
  postComment(_prId: string, _body: string): Promise<void> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
}
