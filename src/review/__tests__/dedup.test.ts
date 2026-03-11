import { describe, it, expect } from 'vitest'
import { extractCommitHash } from '../formatter.js'
import type { ReviewComment, CommentReply } from '../../vcs/adapter.js'

// ---------------------------------------------------------------------------
// Reply date filtering — mirrors CHECK_REPLIES logic in index.ts
// ---------------------------------------------------------------------------

function filterRepliesByReviewDate(replies: CommentReply[], latestReviewDate: string): CommentReply[] {
  return replies.filter(r => r.createdOn > latestReviewDate)
}

describe('filterRepliesByReviewDate', () => {
  const oldReply: CommentReply = {
    id: '1', parentId: '100', author: 'Vadim',
    body: 'What about the cache?',
    createdOn: '2026-03-10T11:18:00.000000+00:00',
  }

  const newReply: CommentReply = {
    id: '2', parentId: '100', author: 'Vadim',
    body: 'This still looks wrong',
    createdOn: '2026-03-11T14:00:00.000000+00:00',
  }

  it('filters out replies older than the latest review', () => {
    const latestReviewDate = '2026-03-11T11:42:00.000000+00:00'
    const result = filterRepliesByReviewDate([oldReply, newReply], latestReviewDate)
    expect(result).toEqual([newReply])
  })

  it('keeps all replies if they are newer than latest review', () => {
    const latestReviewDate = '2026-03-10T10:00:00.000000+00:00'
    const result = filterRepliesByReviewDate([oldReply, newReply], latestReviewDate)
    expect(result).toEqual([oldReply, newReply])
  })

  it('returns empty when all replies are older', () => {
    const latestReviewDate = '2026-03-12T00:00:00.000000+00:00'
    const result = filterRepliesByReviewDate([oldReply, newReply], latestReviewDate)
    expect(result).toEqual([])
  })

  it('returns empty for no replies', () => {
    const result = filterRepliesByReviewDate([], '2026-03-11T00:00:00.000000+00:00')
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Pre-post dedup — mirrors POST_REVIEW race condition check in index.ts
// ---------------------------------------------------------------------------

describe('pre-post commit dedup', () => {
  function isAlreadyReviewed(reviews: ReviewComment[], commitShort: string): boolean {
    return reviews.some(r => extractCommitHash(r.body) === commitShort)
  }

  const reviewWithCommit = (hash: string): ReviewComment => ({
    id: '1',
    body: `### Summary\nAll good.\n\n---\n*Reviewed by bot (claude-haiku-4-5-20251001) | Prompt: repo | Review #1 | Commit: ${hash}*`,
    createdOn: '2026-03-11T11:42:00.000000+00:00',
  })

  it('detects same commit already reviewed', () => {
    expect(isAlreadyReviewed([reviewWithCommit('a1b2c3d4e5f6')], 'a1b2c3d4e5f6')).toBe(true)
  })

  it('returns false for different commit', () => {
    expect(isAlreadyReviewed([reviewWithCommit('a1b2c3d4e5f6')], 'ffffff000000')).toBe(false)
  })

  it('returns false for empty reviews', () => {
    expect(isAlreadyReviewed([], 'a1b2c3d4e5f6')).toBe(false)
  })

  it('detects commit in any of multiple reviews', () => {
    const reviews = [
      reviewWithCommit('aaa111222333'),
      reviewWithCommit('bbb444555666'),
    ]
    expect(isAlreadyReviewed(reviews, 'bbb444555666')).toBe(true)
    expect(isAlreadyReviewed(reviews, 'ccc777888999')).toBe(false)
  })

  it('handles NO_CHANGE body with footer', () => {
    const noChangeReview: ReviewComment = {
      id: '9',
      body: 'NO_CHANGE\n\n---\n*Reviewed by bot (claude-haiku-4-5-20251001) | Prompt: repo | Review #9 | Commit: 873106330998*',
      createdOn: '2026-03-11T11:47:00.000000+00:00',
    }
    expect(isAlreadyReviewed([noChangeReview], '873106330998')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POST_REVIEW empty/NO_CHANGE guard — mirrors POST_REVIEW logic in index.ts
// ---------------------------------------------------------------------------

describe('POST_REVIEW guard', () => {
  function shouldSkipPost(reviewText: string): boolean {
    const cleaned = reviewText.trim()
    return !cleaned || cleaned === 'NO_CHANGE'
  }

  it('skips empty string', () => {
    expect(shouldSkipPost('')).toBe(true)
  })

  it('skips whitespace-only', () => {
    expect(shouldSkipPost('   \n\n  ')).toBe(true)
  })

  it('skips NO_CHANGE', () => {
    expect(shouldSkipPost('NO_CHANGE')).toBe(true)
  })

  it('skips NO_CHANGE with whitespace', () => {
    expect(shouldSkipPost('  NO_CHANGE  \n')).toBe(true)
  })

  it('allows real review text', () => {
    expect(shouldSkipPost('### Summary\nAll good.')).toBe(false)
  })

  it('allows text containing NO_CHANGE as substring', () => {
    expect(shouldSkipPost('Found NO_CHANGE in the diff')).toBe(false)
  })
})
