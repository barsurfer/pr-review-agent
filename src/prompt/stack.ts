import type { ChangedFile } from '../vcs/adapter.js'

export const STACKS = ['angular-ionic', 'java-spring', 'typescript-node', 'python'] as const
export type Stack = (typeof STACKS)[number]

// Strictly more than half of the language-bearing files must agree
export const MAJORITY_THRESHOLD = 0.5

// Config, docs and assets carry no language signal — excluded so they can't dilute or swing the vote
const NEUTRAL_EXTENSIONS = new Set([
  'json', 'yml', 'yaml', 'xml', 'md', 'txt', 'properties', 'toml', 'ini', 'lock', 'gradle', 'sql', 'csv', 'map', 'snap',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'eot',
])
const WEB_ASSET_EXTENSIONS = new Set(['html', 'scss', 'css', 'sass', 'less'])
const JS_TS_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

const ANGULAR_MARKER = /\.(component|module|directive|pipe|guard|resolver|interceptor)\.(ts|html|scss|css|sass|less)$|(^|\/)(angular\.json|ionic\.config\.json|capacitor\.config\.[a-z]+)$/

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

// 'other' = real source in an unsupported language; it counts against every stack
function classifyFile(path: string, hasAngularMarker: boolean): Stack | 'other' | null {
  const ext = extensionOf(path)
  if (!ext || NEUTRAL_EXTENSIONS.has(ext)) return null
  if (WEB_ASSET_EXTENSIONS.has(ext)) return hasAngularMarker ? 'angular-ionic' : null
  // Plain .ts is ambiguous (services, specs), so one Angular marker in the PR claims all js/ts files
  if (JS_TS_EXTENSIONS.has(ext)) return hasAngularMarker ? 'angular-ionic' : 'typescript-node'
  if (ext === 'java' || ext === 'kt') return 'java-spring'
  if (ext === 'py') return 'python'
  return 'other'
}

export function detectStack(changedFiles: ChangedFile[]): Stack | null {
  const files = changedFiles.filter(f => f.status !== 'deleted')
  const hasAngularMarker = files.some(f => ANGULAR_MARKER.test(f.path))

  const counts = new Map<Stack | 'other', number>()
  let total = 0
  for (const f of files) {
    const kind = classifyFile(f.path, hasAngularMarker)
    if (!kind) continue
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    total++
  }
  if (total === 0) return null

  for (const stack of STACKS) {
    if ((counts.get(stack) ?? 0) / total > MAJORITY_THRESHOLD) return stack
  }
  return null
}
