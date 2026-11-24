import { describe, it, expect } from 'vitest'
import type { MarkedThread, MarkedComment } from '../../vcs/adapter.js'
import { resolveIdentity } from '../identity.js'
import type { IdentityResult } from '../identity.js'
import { isInlineMarked, selectSummary, buildRegistry } from '../registry.js'
import { SUMMARY_HEADER, buildRootMarker, buildAnswerMarker } from '../markers.js'
import { withState } from '../state.js'
import { threadRow, resolvedRow } from '../rows.js'

const ME = 'acc-1'
const OTHER = 'acc-9'
const C = 'a1b2c3d4e5f6'
const api = resolveIdentity({ ids: [ME], names: ['bot'] }, '') as Extract<IdentityResult, { status: 'api' }>
const settingOnly = resolveIdentity({ ids: [], names: [] }, ME) as Extract<IdentityResult, { status: 'setting_only' }>

const comment = (id: number, body: string, authorId = ME, parentId?: number): MarkedComment => ({
  id: String(id), seq: id, body, author: 'x', authorIds: [authorId], createdOn: '', ...(parentId ? { parentId: String(parentId) } : {}),
})

function summaryThread(id: number, body: string, authorId = ME): MarkedThread {
  return { root: { ...comment(id, body, authorId), url: `u${id}` }, resolved: false, comments: [] }
}

function findingThread(id: number, k: number, opts: { title?: string; severity?: string; was?: string; path?: string; line?: number; resolved?: boolean; authorId?: string; comments?: MarkedComment[]; inline?: boolean } = {}): MarkedThread {
  const first = `**${opts.severity ?? 'HIGH'} – ${opts.title ?? 'Null user'}**${opts.was ? ` (was ${opts.was}, dismissed)` : ''}`
  const body = `${first}\n\nThe load crashes.\n\n${buildRootMarker(`F${k}`, C)}`
  const inline = opts.inline === false ? {} : { inline: { path: opts.path ?? 'src/a.ts', line: opts.line ?? 10 } }
  return { root: { ...comment(id, body, opts.authorId), url: `u${id}`, ...inline }, resolved: opts.resolved ?? false, comments: opts.comments ?? [] }
}

const validSummary = (rows: string[] = [], n = 1, commits = [C]) => withState([SUMMARY_HEADER, '', '## Findings', ...rows].join('\n'), { n, commits }, ME)

describe('resolveIdentity', () => {
  it('uses the adapter lookup, the setting alone, or reports unavailable', () => {
    expect(resolveIdentity({ ids: [ME, 'uuid-1'], names: ['bot'] }, '')).toMatchObject({ status: 'api', agentId: ME })
    expect(resolveIdentity({ ids: [ME, 'uuid-1'], names: [] }, '{uuid-1}')).toMatchObject({ status: 'api', agentId: ME })
    expect(resolveIdentity({ ids: [], names: [] }, ` ${ME} `)).toMatchObject({ status: 'setting_only', ids: [ME], agentId: ME })
    expect(resolveIdentity(undefined, '')).toEqual({ status: 'unavailable' })
    expect(resolveIdentity({ ids: [], names: [] }, '')).toEqual({ status: 'unavailable' })
  })

  it('a setting that disagrees with the adapter is identity_mismatch', () => {
    expect(resolveIdentity({ ids: [ME], names: [] }, OTHER).status).toBe('identity_mismatch')
  })
})

describe('selectSummary', () => {
  it('a valid summary is selected as valid with its state', () => {
    const sel = selectSummary([summaryThread(5, validSummary())], api)
    expect(sel).toMatchObject({ kind: 'found', check: 'valid', state: { n: 1, commits: [C] }, extras: 0 })
  })

  it('a legacy review quoting the state marker in a code block is not selected and does not mismatch', () => {
    const legacy = '### Summary\nLooks fine.\n\n```\n*inline-state v1 | n=1 | commits= | sig=0123456789abcdef*\n```\n\n---\n*Reviewed by bot (m) | Prompt: p | Review #1 | Commit: abcdef123456*'
    const threads = [summaryThread(5, legacy)]
    expect(isInlineMarked(legacy)).toBe(false)
    expect(selectSummary(threads, api)).toEqual({ kind: 'none' })
    expect(buildRegistry(threads, settingOnly)).toMatchObject({ status: 'ok', untrusted: 0 })
  })

  it('state line removed, header removed, text below the state line: tampered; both removed: none', () => {
    const body = validSummary()
    const noState = body.split('\n').slice(0, -2).join('\n')
    const noHeader = body.split('\n').slice(2).join('\n')
    const below = body + '\nextra'
    expect(selectSummary([summaryThread(5, noState)], api)).toMatchObject({ kind: 'found', check: 'tampered' })
    expect(selectSummary([summaryThread(5, noHeader)], api)).toMatchObject({ kind: 'found', check: 'tampered' })
    expect(selectSummary([summaryThread(5, below)], api)).toMatchObject({ kind: 'found', check: 'tampered' })
    expect(selectSummary([summaryThread(5, 'plain agent text')], api)).toEqual({ kind: 'none' })
  })

  it('a one-character edit in the header line is tampered', () => {
    expect(selectSummary([summaryThread(5, validSummary().replace('### Review summary', '### Review summarY'))], api)).toMatchObject({ kind: 'found', check: 'tampered' })
  })

  it('the oldest candidate wins and extras are counted', () => {
    const sel = selectSummary([summaryThread(9, validSummary()), summaryThread(5, validSummary())], api)
    expect(sel).toMatchObject({ kind: 'found', extras: 1 })
    expect(sel.kind === 'found' && sel.comment.id).toBe('5')
  })

  it('an inline comment or one by another author is never a candidate', () => {
    const inline = summaryThread(5, validSummary())
    inline.root.inline = { path: 'a.ts', line: 1 }
    expect(selectSummary([inline, summaryThread(6, validSummary(), OTHER)], api)).toEqual({ kind: 'none' })
  })
})

describe('buildRegistry', () => {
  it('with API identity an untrusted marker root or candidate is ignored and counted', () => {
    const reg = buildRegistry([findingThread(2, 1, { authorId: OTHER }), summaryThread(5, validSummary(), OTHER), findingThread(3, 2)], api)
    expect(reg).toMatchObject({ status: 'ok', untrusted: 2 })
    if (reg.status !== 'ok') throw new Error('expected ok')
    expect(reg.entries.map(e => e.id)).toEqual(['F2'])
    expect(reg.summary).toEqual({ kind: 'none' })
  })

  it('in setting_only mode the same is identity_mismatch', () => {
    expect(buildRegistry([findingThread(2, 1, { authorId: OTHER })], settingOnly).status).toBe('identity_mismatch')
    expect(buildRegistry([summaryThread(5, validSummary(), OTHER)], settingOnly).status).toBe('identity_mismatch')
  })

  it('an untrusted answer marker is counted but is not a mismatch', () => {
    const t = findingThread(2, 1, { comments: [comment(3, `fake\n\n${buildAnswerMarker('F1', '9')}`, OTHER, 2)] })
    expect(buildRegistry([t], settingOnly)).toMatchObject({ status: 'ok', untrusted: 1 })
  })

  it('parses severity, title, was, gist and the human-comment count from the root', () => {
    const t = findingThread(2, 4, { severity: 'MEDIUM', title: 'Loop', was: 'F3', resolved: true, comments: [comment(3, 'q', OTHER, 2), comment(4, 'a', ME, 2)] })
    const reg = buildRegistry([t], api)
    if (reg.status !== 'ok') throw new Error('expected ok')
    expect(reg.entries[0]).toMatchObject({ id: 'F4', k: 4, severity: 'MEDIUM', title: 'Loop', was: 'F3', gist: 'The load crashes.', rootId: '2', url: 'u2', resolved: true, humanComments: 1 })
  })

  it('nextK is the max of thread ids and verified row ids plus one', () => {
    const rows = [threadRow({ severity: 'LOW', title: 'T', file: 'src/a.ts', lines: '3', base: C, id: 'F9', url: 'https://x/y' })]
    const reg = buildRegistry([summaryThread(5, validSummary(rows)), findingThread(2, 4)], api)
    if (reg.status !== 'ok') throw new Error('expected ok')
    expect(reg.nextK).toBe(10)
    expect(buildRegistry([], api)).toMatchObject({ nextK: 1 })
  })

  it('rows of a tampered summary do not count toward nextK', () => {
    const rows = [resolvedRow({ id: 'F9', severity: 'LOW', title: 'T' })]
    const reg = buildRegistry([summaryThread(5, validSummary(rows) + '\nextra'), findingThread(2, 4)], api)
    if (reg.status !== 'ok') throw new Error('expected ok')
    expect(reg.nextK).toBe(5)
  })

  it('the path, lines and base come together from the verified row, else from the root path, line and openedAt', () => {
    const base2 = 'f'.repeat(12)
    const rows = [threadRow({ severity: 'HIGH', title: 'Null user', file: 'src/old.ts', lines: '100-104', base: base2, id: 'F1', url: 'u2' })]
    const withRow = buildRegistry([summaryThread(5, validSummary(rows)), findingThread(2, 1, { path: 'src/new.ts', line: 7 })], api)
    const without = buildRegistry([findingThread(2, 1, { path: 'src/new.ts', line: 7 })], api)
    if (withRow.status !== 'ok' || without.status !== 'ok') throw new Error('expected ok')
    // Pairing the thread's current path with the row's old lines would map src/new.ts:100 instead of through the rename.
    expect(withRow.entries[0]).toMatchObject({ file: 'src/old.ts', lines: '100-104', openedAt: base2 })
    expect(without.entries[0]).toMatchObject({ file: 'src/new.ts', lines: '7', openedAt: C })
  })

  it('a thread collapsed into Also open falls back to its root line and openedAt', () => {
    const body = withState([SUMMARY_HEADER, '', 'Also open: F1'].join('\n'), { n: 1, commits: [C] }, ME)
    const reg = buildRegistry([summaryThread(5, body), findingThread(2, 1, { line: 12 })], api)
    if (reg.status !== 'ok') throw new Error('expected ok')
    expect(reg.entries[0]).toMatchObject({ lines: '12', openedAt: C })
    expect(reg.nextK).toBe(2)
  })

  it('a non-inline trusted root still yields an entry, and a marker-less trusted comment does not', () => {
    const reg = buildRegistry([findingThread(2, 1, { inline: false })], api)
    if (reg.status !== 'ok') throw new Error('expected ok')
    expect(reg.entries[0]).toMatchObject({ id: 'F1', file: '' })
    expect(reg.entries[0].lines).toBeUndefined()
  })
})

describe('summary layouts', () => {
  const legacyBody = withState(['### Review summary', '*inline-summary v1 | maintained by the review agent*', '', '### Summary', 'old', '', '### Findings', 'No findings.'].join('\n'), { n: 2, commits: [C] }, ME)

  it('recognises a 0.0.63/0.0.64 summary as valid and the single-heading layout as valid', () => {
    expect(isInlineMarked(legacyBody)).toBe(true)
    expect(selectSummary([summaryThread(5, legacyBody)], api)).toMatchObject({ kind: 'found', check: 'valid', state: { n: 2, commits: [C] } })
    expect(selectSummary([summaryThread(5, validSummary())], api)).toMatchObject({ kind: 'found', check: 'valid' })
  })

  it('keeps one summary when an old and a new one exist, and a header without the old tag is tampered', () => {
    const sel = selectSummary([summaryThread(9, validSummary()), summaryThread(5, legacyBody)], api)
    expect(sel).toMatchObject({ kind: 'found', check: 'valid', extras: 1 })
    expect(sel.kind === 'found' && sel.comment.id).toBe('5')
    const noTag = withState('### Review summary\n\nbody', { n: 1, commits: [C] }, ME)
    expect(selectSummary([summaryThread(5, noTag)], api)).toMatchObject({ kind: 'found', check: 'tampered' })
  })

  it('reads the marker commit from a suffixed root and from the old suffix-less root', () => {
    const suffixed = findingThread(10, 1)
    suffixed.root.body = suffixed.root.body.replace(buildRootMarker('F1', C), buildRootMarker('F1', C, { model: 'm', build: 'b' }))
    const reg = buildRegistry([suffixed, findingThread(11, 2)], api)
    expect(reg.status === 'ok' && reg.entries.map(e => [e.id, e.markerAt])).toEqual([['F1', C], ['F2', C]])
  })
})
