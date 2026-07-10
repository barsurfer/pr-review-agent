import { describe, it, expect } from 'vitest'
import { buildReviewFooter, buildReplyFooter, stripPreviousFooter, stripDeltaStats, stripJudgeNotes, stripJenkinsMeta, stripPreamble, isNoChange, extractCommitHash, hasReviewFooter, hasReplyFooter, renderReview, type ReviewObject } from '../formatter.js'
import { parseFindings, parseDeltaStats } from '../parsers.js'

// ---------------------------------------------------------------------------
// buildReviewFooter
// ---------------------------------------------------------------------------

describe('buildReviewFooter', () => {
  it('includes all fields', () => {
    const footer = buildReviewFooter('alice@co.com', 'claude-sonnet-4-6', 'repo', 2, 'a1b2c3d4e5f6', '919a10b')
    expect(footer).toContain('alice@co.com')
    expect(footer).toContain('claude-sonnet-4-6')
    expect(footer).toContain('Prompt: repo')
    expect(footer).toContain('Build: 919a10b')
    expect(footer).toContain('Review #2')
    expect(footer).toContain('Commit: a1b2c3d4e5f6')
  })
})

// ---------------------------------------------------------------------------
// buildReplyFooter
// ---------------------------------------------------------------------------

describe('buildReplyFooter', () => {
  it('includes identity and model', () => {
    const footer = buildReplyFooter('bot@co.com', 'claude-haiku-4-5-20251001')
    expect(footer).toContain('bot@co.com')
    expect(footer).toContain('claude-haiku-4-5-20251001')
  })
})

// ---------------------------------------------------------------------------
// stripPreviousFooter
// ---------------------------------------------------------------------------

describe('stripPreviousFooter', () => {
  it('removes a standard review footer', () => {
    const text = '### Summary\nAll good.\n---\n*Reviewed by alice@co.com (claude-sonnet-4-6) | Prompt: repo | Review #1 | Commit: abc123*'
    expect(stripPreviousFooter(text)).toBe('### Summary\nAll good.')
  })

  it('returns text unchanged when no footer present', () => {
    const text = '### Summary\nAll good.'
    expect(stripPreviousFooter(text)).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// stripDeltaStats
// ---------------------------------------------------------------------------

describe('stripDeltaStats', () => {
  it('removes DELTA_STATS comment from end of text', () => {
    const text = '### Merge Confidence: 90%\n<!-- DELTA_STATS: resolved=2 still_open=1 new=0 -->'
    expect(stripDeltaStats(text)).toBe('### Merge Confidence: 90%')
  })

  it('removes DELTA_STATS with extra whitespace', () => {
    const text = '### Merge Confidence: 90%\n\n<!--  DELTA_STATS:  resolved=1  still_open=0  new=3  -->\n'
    expect(stripDeltaStats(text)).toBe('### Merge Confidence: 90%')
  })

  it('returns text unchanged when no DELTA_STATS present', () => {
    const text = '### Summary\nNo issues.'
    expect(stripDeltaStats(text)).toBe(text)
  })

  it('removes DELTA_STATS from the middle of text', () => {
    const text = '### Merge Confidence: 88%\n<!-- DELTA_STATS: resolved=0 still_open=2 new=1 -->\nSome trailing text'
    const result = stripDeltaStats(text)
    expect(result).not.toContain('DELTA_STATS')
    expect(result).toContain('### Merge Confidence: 88%')
    expect(result).toContain('Some trailing text')
  })
})

// ---------------------------------------------------------------------------
// isNoChange
// ---------------------------------------------------------------------------

describe('isNoChange', () => {
  it('detects NO_CHANGE', () => {
    expect(isNoChange('NO_CHANGE')).toBe(true)
  })

  it('detects NO_CHANGE with whitespace', () => {
    expect(isNoChange('  NO_CHANGE  \n')).toBe(true)
  })

  it('rejects other text', () => {
    expect(isNoChange('### Summary\nNO_CHANGE found')).toBe(false)
  })

  it('detects NO_CHANGE on a standalone line after a summary (PR 8718 regression)', () => {
    expect(isNoChange('### Summary\n\nNo new findings. Cosmetic changes only.\n\nNO_CHANGE')).toBe(true)
  })

  it('rejects inline NO_CHANGE mention', () => {
    expect(isNoChange('Found NO_CHANGE in the diff')).toBe(false)
  })

  it('rejects quoted NO_CHANGE line', () => {
    expect(isNoChange('> NO_CHANGE\nsome reply text')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// hasReviewFooter / hasReplyFooter
// ---------------------------------------------------------------------------

describe('hasReviewFooter', () => {
  it('matches the exact agent footer line', () => {
    const body = '### Summary\nAll good.\n\n---\n*Reviewed by bot@co.com (claude-haiku-4-5-20251001) | Prompt: repo | Review #2 | Commit: bf2d9d912db9*'
    expect(hasReviewFooter(body)).toBe(true)
  })

  it('does not match casual "Reviewed by" mentions', () => {
    expect(hasReviewFooter('Reviewed by me, LGTM')).toBe(false)
    expect(hasReviewFooter('This was *Reviewed by the team* already')).toBe(false)
  })
})

describe('hasReplyFooter', () => {
  it('matches the exact agent reply footer line', () => {
    expect(hasReplyFooter('Thanks for clarifying.\n\n---\n*Reply by bot@co.com (claude-sonnet-4-6)*')).toBe(true)
  })

  it('does not match casual "Reply by" mentions', () => {
    expect(hasReplyFooter('Reply by tomorrow please')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Footer round-trip — builders and detectors must stay in sync, or the agent
// stops recognizing its own comments (dedup breaks → re-review/self-reply loops)
// ---------------------------------------------------------------------------

describe('footer round-trip (builder ↔ detector)', () => {
  const reviewBody = '### Summary\nAll good.' + buildReviewFooter('bot@co.com', 'claude-haiku-4-5-20251001', 'repo', 3, 'a1b2c3d4e5f6', '919a10b-dirty')
  const replyBody = 'Because the null path is unguarded.' + buildReplyFooter('bot@co.com', 'claude-sonnet-4-6')

  it('hasReviewFooter matches buildReviewFooter output', () => {
    expect(hasReviewFooter(reviewBody)).toBe(true)
  })

  it('hasReplyFooter matches buildReplyFooter output', () => {
    expect(hasReplyFooter(replyBody)).toBe(true)
  })

  it('review and reply footers never cross-match', () => {
    expect(hasReplyFooter(reviewBody)).toBe(false)
    expect(hasReviewFooter(replyBody)).toBe(false)
  })

  it('extractCommitHash round-trips buildReviewFooter output', () => {
    expect(extractCommitHash(reviewBody)).toBe('a1b2c3d4e5f6')
  })

  it('CI-linked review footer is still detected and hash still extractable', () => {
    const url = 'https://ci/job/x/5094/'
    const linked = '### Summary\nAll good.' + buildReviewFooter('bot', 'model', 'repo', 2, 'abc123def456', 'deadbee', url)
    expect(linked).toContain('[Review #2](https://ci/job/x/5094/)')
    expect(hasReviewFooter(linked)).toBe(true)
    expect(extractCommitHash(linked)).toBe('abc123def456')
  })

  it('CI-linked reply footer is detected and never cross-matches a review', () => {
    const url = 'https://ci/job/x/5094/'
    const linked = 'ok.' + buildReplyFooter('bot', 'model', url)
    expect(linked).toContain('[Reply by bot (model)](https://ci/job/x/5094/)')
    expect(hasReplyFooter(linked)).toBe(true)
    expect(hasReviewFooter(linked)).toBe(false)
  })

  it('extractCommitHash returns the PR commit, never the build hash', () => {
    // 'Build:' label must not shadow 'Commit:' — dedup anchors on the PR commit
    expect(extractCommitHash(reviewBody)).not.toContain('919a10b')
  })

  it('hasReviewFooter still matches pre-Build footers already posted on PRs', () => {
    const legacy = '### Summary\nOld.\n\n---\n*Reviewed by bot@co.com (claude-haiku-4-5-20251001) | Prompt: default | Review #1 | Commit: f65151592964*'
    expect(hasReviewFooter(legacy)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// stripJudgeNotes
// ---------------------------------------------------------------------------

describe('stripJudgeNotes', () => {
  it('strips a multi-line JUDGE_NOTES comment', () => {
    const text = '### Summary\nSafe.\n\n### Findings\n\nNone.\n\n<!-- JUDGE_NOTES:\nDropped MEDIUM about @WithSpan — convention claim not verifiable from diff.\nDropped LOW about test mocking — style only.\n-->'
    expect(stripJudgeNotes(text)).toBe('### Summary\nSafe.\n\n### Findings\n\nNone.')
  })

  it('leaves text without notes unchanged', () => {
    const text = '### Summary\nSafe.\n\n### Findings\n\nNone.'
    expect(stripJudgeNotes(text)).toBe(text)
  })
})

describe('stripJenkinsMeta', () => {
  it('strips an echoed jenkins comment', () => {
    const text = '### Summary\nSafe.\n\n<!-- jenkins: pr-review #709 https://ci/x/709/ -->'
    expect(stripJenkinsMeta(text)).toBe('### Summary\nSafe.')
  })

  it('leaves text without a jenkins comment unchanged', () => {
    const text = '### Summary\nSafe.\n\n### Merge Confidence: 90%'
    expect(stripJenkinsMeta(text)).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// stripPreamble
// ---------------------------------------------------------------------------

describe('stripPreamble', () => {
  it('drops judge deliberation before ### Summary (PR 45 regression)', () => {
    const text = 'I need to validate each finding against the actual diff.\n\n**Finding 1: MEDIUM** — visible in the diff, keep.\n\n### Summary\nRefactor is risky.\n\n### Findings\n\nNone.'
    expect(stripPreamble(text)).toBe('### Summary\nRefactor is risky.\n\n### Findings\n\nNone.')
  })

  it('returns text unchanged when it already starts with ### Summary', () => {
    const text = '### Summary\nAll good.\n\n### Findings\n\nNone.'
    expect(stripPreamble(text)).toBe(text)
  })

  it('returns text unchanged when no Summary heading exists', () => {
    expect(stripPreamble('NO_CHANGE')).toBe('NO_CHANGE')
    expect(stripPreamble('free-form review without headings')).toBe('free-form review without headings')
  })

  it('matches heading depth and case variations', () => {
    expect(stripPreamble('preamble\n\n#### summary\ntext')).toBe('#### summary\ntext')
  })

  it('does not cut on inline "Summary" mention in the preamble', () => {
    const text = 'Checking the Summary claim first.\n\n### Summary\nreal one'
    expect(stripPreamble(text)).toBe('### Summary\nreal one')
  })
})

// ---------------------------------------------------------------------------
// extractCommitHash
// ---------------------------------------------------------------------------

describe('extractCommitHash', () => {
  it('extracts hash from review footer', () => {
    const body = '*Reviewed by alice@co.com (claude-sonnet-4-6) | Prompt: repo | Review #1 | Commit: a1b2c3d4e5f6*'
    expect(extractCommitHash(body)).toBe('a1b2c3d4e5f6')
  })

  it('returns null when no commit hash', () => {
    expect(extractCommitHash('No footer here')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// renderReview — the structured reviewer output must render markdown the rest of
// the pipeline can parse (parseFindings, isNoChange, stripPreamble, cut guard)
// ---------------------------------------------------------------------------

describe('renderReview', () => {
  const base: ReviewObject = {
    summary: 'Low risk.',
    findings: [],
    behavioral_diff: ['Adds a retry wrapper.'],
    production_risk: ['None material.'],
    unresolved_questions: [],
  }

  it('starts with ### Summary so stripPreamble keeps the whole review', () => {
    const md = renderReview(base)
    expect(md.startsWith('### Summary\n')).toBe(true)
    expect(stripPreamble(md)).toBe(md)
  })

  it('always emits the Unresolved Questions section (reviewer-path cut guard)', () => {
    expect(/^#{1,4}\s*Unresolved Questions\b/im.test(renderReview(base))).toBe(true)
  })

  it('renders "No findings." when there are none', () => {
    expect(renderReview(base)).toContain('### Findings\nNo findings.')
    expect(parseFindings(renderReview(base))).toEqual({ high: 0, medium: 0, low: 0 })
  })

  it('renders findings with severity and location that parseFindings counts', () => {
    const md = renderReview({
      ...base,
      findings: [
        { severity: 'HIGH', title: 'N+1 query', file: 'src/user-list.ts', lines: '26-31', body: 'Fires one request per row.' },
        { severity: 'MEDIUM', title: 'Unhandled reject', body: 'Promise has no catch.' },
      ],
    })
    expect(md).toContain('- **HIGH – N+1 query** (`src/user-list.ts:26-31`)')
    expect(md).toContain('- **MEDIUM – Unhandled reject**')
    expect(md).not.toContain('()')   // no empty location parens when file omitted
    expect(parseFindings(md)).toEqual({ high: 1, medium: 1, low: 0 })
  })

  it('omits the :lines suffix when only a file is given', () => {
    const md = renderReview({ ...base, findings: [{ severity: 'LOW', title: 'x', file: 'a.ts', body: 'b' }] })
    expect(md).toContain('- **LOW – x** (`a.ts`)')
  })

  it('returns the NO_CHANGE sentinel and nothing else', () => {
    const md = renderReview({ ...base, no_change: true, summary: 'ignored', findings: [{ severity: 'HIGH', title: 'x', body: 'y' }] })
    expect(md).toBe('NO_CHANGE')
    expect(isNoChange(md)).toBe(true)
  })

  it('appends a DELTA_STATS comment that parseDeltaStats round-trips, then stripDeltaStats removes', () => {
    const md = renderReview({ ...base, delta_stats: { resolved: 2, still_open: 1, new_findings: 0 } })
    expect(parseDeltaStats(md)).toEqual({ resolved: 2, still_open: 1, new_findings: 0 })
    expect(stripDeltaStats(md)).not.toContain('DELTA_STATS')
  })

  it('adds a Can Be Split section only when populated', () => {
    expect(renderReview(base)).not.toContain('Can Be Split')
    const md = renderReview({ ...base, can_be_split: ['Auth refactor', 'Logging change'] })
    expect(md).toContain('### Can Be Split\n- Auth refactor\n- Logging change')
  })
})
