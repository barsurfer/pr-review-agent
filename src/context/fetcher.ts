import type { VCSAdapter, ChangedFile } from '../vcs/adapter.js'

const EXCLUDED_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.lock$/,
  /-generated\./,
  /\.min\.js$/,
  /\.min\.css$/,
  /db\/migrate\//,
  /\.snap$/,
  /\.map$/,
]

export interface FileContext {
  path: string
  content: string
}

function isExcluded(filePath: string): boolean {
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(filePath))
}

function countLines(content: string): number {
  return content.split('\n').length
}

function highChurnInDiff(filePath: string, diff: string): boolean {
  // Extract this file's hunk from the unified diff and check if >30% of lines changed
  const fileSection = extractFileDiff(filePath, diff)
  if (!fileSection) return false

  const lines = fileSection.split('\n')
  const changed = lines.filter((l) => l.startsWith('+') || l.startsWith('-')).length
  const total = lines.filter((l) => !l.startsWith('@@') && !l.startsWith('---') && !l.startsWith('+++')).length

  return total > 0 && changed / total > 0.3
}

function extractFileDiff(filePath: string, diff: string): string | null {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = diff.match(new RegExp(`--- a/${escaped}[\\s\\S]*?(?=^--- a/|$)`, 'm'))
  return match ? match[0] : null
}

export async function fetchContext(
  adapter: VCSAdapter,
  changedFiles: ChangedFile[],
  sourceCommit: string,
  diff: string,
  maxFiles: number,
  maxFileLines: number
): Promise<FileContext[]> {
  const candidates = changedFiles.filter(
    (f) => f.status !== 'deleted' && !isExcluded(f.path)
  )

  // Prioritise high-churn files — they need full context most
  const sorted = candidates.sort((a, b) => {
    const aChurn = highChurnInDiff(a.path, diff) ? 0 : 1
    const bChurn = highChurnInDiff(b.path, diff) ? 0 : 1
    return aChurn - bChurn
  })

  const results: FileContext[] = []

  for (const file of sorted) {
    if (results.length >= maxFiles) break

    try {
      const content = await adapter.getFileContent(file.path, sourceCommit)
      const lineCount = countLines(content)

      if (lineCount > maxFileLines && !highChurnInDiff(file.path, diff)) {
        console.log(`Skipping ${file.path} — ${lineCount} lines (over limit, low churn)`)
        continue
      }

      results.push({ path: file.path, content })
    } catch (err: unknown) {
      console.warn(`Could not fetch content for ${file.path}:`, (err as Error).message)
    }
  }

  return results
}
