// ---------------------------------------------------------------------------
// Split a too-large diff into token-bounded bundles — pure, no I/O
// ---------------------------------------------------------------------------

export interface FileUnit {
  path: string
  tokens: number
}

export interface Bundle {
  label: string
  files: string[]
  tokens: number
}

export interface BundlePlan {
  bundles: Bundle[]
  oversized: FileUnit[]
}

export const estimateTokens = (chars: number): number => Math.ceil(chars / 4)

/** Per-file diff sections keyed by new path. */
export function splitDiffByFile(diff: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const section of diff.split(/(?=^diff --git )/m)) {
    const m = section.match(/^diff --git a\/.+? b\/(.+)$/m)
    if (m) out.set(m[1].trim(), (out.get(m[1].trim()) ?? '') + section)
  }
  return out
}

const dirSegments = (path: string): string[] => path.split('/').slice(0, -1)
const dirKey = (path: string, depth: number): string => dirSegments(path).slice(0, depth).join('/')
const sum = (units: FileUnit[]): number => units.reduce((n, u) => n + u.tokens, 0)

function greedyFill(units: FileUnit[], budget: number): FileUnit[][] {
  const chunks: FileUnit[][] = []
  let cur: FileUnit[] = []
  let size = 0
  for (const u of [...units].sort((a, b) => a.path.localeCompare(b.path))) {
    if (cur.length && size + u.tokens > budget) { chunks.push(cur); cur = []; size = 0 }
    cur.push(u)
    size += u.tokens
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

// Descend one directory level at a time so a bundle stays a coherent module; only when a
// directory has no deeper structure left does it fall back to filling in path order.
function split(units: FileUnit[], budget: number, depth: number): FileUnit[][] {
  if (sum(units) <= budget) return [units]
  const deepest = Math.max(...units.map(u => dirSegments(u.path).length))
  if (depth > deepest) return greedyFill(units, budget)

  const groups = new Map<string, FileUnit[]>()
  for (const u of units) {
    const k = dirKey(u.path, depth)
    groups.set(k, [...(groups.get(k) ?? []), u])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, g]) => split(g, budget, depth + 1))
}

function labelFor(files: string[]): string {
  if (files.length === 1) return files[0]
  const dirs = files.map(dirSegments)
  const common: string[] = []
  for (let i = 0; i < Math.min(...dirs.map(d => d.length)); i++) {
    if (dirs.every(d => d[i] === dirs[0][i])) common.push(dirs[0][i])
    else break
  }
  const base = common.length ? common.join('/') + '/' : '(root)'
  return `${base} (${files.length} files)`
}

/** Group files into bundles of at most `budget` tokens, keeping files of one directory
 *  together. Files that alone exceed the budget are returned as `oversized`, not bundled. */
export function planBundles(units: FileUnit[], budget: number): BundlePlan {
  const oversized = units.filter(u => u.tokens > budget)
  const fitting = units.filter(u => u.tokens <= budget)
  if (!fitting.length) return { bundles: [], oversized }

  // Adjacent chunks are merged so many tiny directories don't each cost a reviewer+judge call.
  const merged: FileUnit[][] = []
  for (const chunk of split(fitting, budget, 1)) {
    const last = merged[merged.length - 1]
    if (last && sum(last) + sum(chunk) <= budget) last.push(...chunk)
    else merged.push([...chunk])
  }

  return {
    bundles: merged.map(c => ({ label: labelFor(c.map(u => u.path)), files: c.map(u => u.path), tokens: sum(c) })),
    oversized,
  }
}
