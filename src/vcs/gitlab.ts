import type { VCSAdapter, PRInfo, ChangedFile, ReviewComment, CommentReply } from './adapter.js'

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
  getPreviousReviewComments(_prId: string): Promise<ReviewComment[]> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
  getRepliesToReviewComments(_prId: string, _reviewCommentIds: string[], _includeAnswered?: boolean): Promise<CommentReply[]> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
  postReply(_prId: string, _parentId: string, _body: string): Promise<void> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
  getCommitDiff(_fromCommit: string, _toCommit: string): Promise<string> {
    throw new Error('GitLabAdapter not implemented — deferred to Phase 3')
  }
}
