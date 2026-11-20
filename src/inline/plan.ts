import { createAnchorer } from './anchor.js'
import { parseLineRange } from '../review/findings-output.js'
import { matches, type MappedEntry } from './match.js'
import type { Severity, SummaryOnlyReason } from './types.js'

export const MAX_NEW_ROOTS_PER_RUN = 20

const RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }

export interface PlanFinding { severity: Severity; title: string; body: string; file?: string; lines?: string; fix?: { block: string; body: string } }

export interface PlanInput {
  findings: readonly PlanFinding[]
  entries: readonly MappedEntry[]
  diff: string
  nextK: number
  lowThreads: boolean
  maxNewRoots?: number
}

export interface PlannedRoot { id: string; finding: PlanFinding; path: string; line: number; was?: string }

export interface RunPlan {
  create: PlannedRoot[]
  summaryOnly: { finding: PlanFinding; reason: SummaryOnlyReason }[]
  suppressed: { open: { finding: PlanFinding; id: string }[]; sameRun: { finding: PlanFinding; id: string }[]; resolved: { finding: PlanFinding; id: string }[] }
  changedInPush: Set<string>
}

export function planRun(input: PlanInput): RunPlan {
  const cap = input.maxNewRoots ?? MAX_NEW_ROOTS_PER_RUN
  const anchorOf = createAnchorer(input.diff)
  const open = input.entries.filter(m => !m.entry.resolved)
  const planned: MappedEntry[] = []
  const resolved = input.entries.filter(m => m.entry.resolved)
  const plan: RunPlan = {
    create: [], summaryOnly: [], suppressed: { open: [], sameRun: [], resolved: [] },
    changedInPush: new Set(open.filter(m => m.changed).map(m => m.entry.id)),
  }
  let k = input.nextK
  // Highest severity first so the per-run cap drops the least important findings; the sort is stable.
  const ordered = [...input.findings].sort((a, b) => RANK[b.severity] - RANK[a.severity])

  for (const f of ordered) {
    const dup = open.find(m => matches(m, f, 'open'))
    if (dup) { plan.suppressed.open.push({ finding: f, id: dup.entry.id }); continue }
    // A same-run twin gets no thread but stays a summary-only row, because the strict title match can still join two distinct findings.
    const twin = planned.find(m => matches(m, f, 'resolved'))
    if (twin) { plan.suppressed.sameRun.push({ finding: f, id: twin.entry.id }); plan.summaryOnly.push({ finding: f, reason: 'duplicate' }); continue }

    let was: string | undefined
    const hits = resolved.filter(m => matches(m, f, 'resolved'))
    if (hits.length) {
      const strongest = hits.reduce((a, b) => (RANK[b.entry.severity] > RANK[a.entry.severity] ? b : a))
      if (RANK[f.severity] <= RANK[strongest.entry.severity]) { plan.suppressed.resolved.push({ finding: f, id: strongest.entry.id }); continue }
      was = strongest.entry.id
    }

    if (f.severity === 'LOW' && !input.lowThreads) { plan.summaryOnly.push({ finding: f, reason: 'low' }); continue }
    const a = anchorOf(f.file, f.lines)
    if (!a.ok) { plan.summaryOnly.push({ finding: f, reason: a.reason }); continue }
    if (plan.create.length >= cap) { plan.summaryOnly.push({ finding: f, reason: 'over_cap' }); continue }
    const root: PlannedRoot = { id: `F${k++}`, finding: f, path: a.path, line: a.line, ...(was ? { was } : {}) }
    plan.create.push(root)
    // A later identical finding in this run must match the root just planned, as it would a posted thread.
    planned.push({ entry: { id: root.id, k: 0, severity: f.severity, title: f.title, gist: '', file: f.file ?? a.path, lines: f.lines, openedAt: '', rootId: '', url: '', resolved: false, humanComments: 0 }, loc: { file: f.file ?? a.path, ...(parseLineRange(f.lines) ? { line: parseLineRange(f.lines)!.start } : {}), g: 0, mapped: true }, changed: false })
  }
  return plan
}
