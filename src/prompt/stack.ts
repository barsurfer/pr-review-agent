import type { ChangedFile } from '../vcs/adapter.js'

export const BASE_STACKS = ['java', 'kotlin', 'python', 'typescript-node', 'frontend'] as const
export const OVERLAY_STACKS = ['spring', 'angular', 'ionic'] as const
export type BaseStack = (typeof BASE_STACKS)[number]
export type OverlayStack = (typeof OVERLAY_STACKS)[number]

export interface StackSelection {
  bases: BaseStack[]
  overlays: OverlayStack[]
}

// A base is injected when it owns at least this share of the classified files
export const BASE_FLOOR = 0.2

// Config, docs and assets carry no language signal — excluded so they can't dilute or swing the vote
const NEUTRAL_EXTENSIONS = new Set([
  'json', 'yml', 'yaml', 'xml', 'md', 'txt', 'properties', 'toml', 'ini', 'lock', 'gradle', 'sql', 'csv', 'map', 'snap',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'woff', 'woff2', 'ttf', 'eot',
])
const FRONTEND_EXTENSIONS = new Set(['tsx', 'jsx', 'vue', 'svelte', 'html', 'htm', 'scss', 'css', 'sass', 'less'])
const JS_TS_EXTENSIONS = new Set(['ts', 'js', 'mjs', 'cjs'])

// .module/.pipe/.guard are deliberately absent: NestJS uses the same suffixes
const ANGULAR_PATH = /\.(component|directive)\.(ts|html|scss|css|sass|less)$|(^|\/)angular\.json$/
const IONIC_PATH = /(^|\/)(ionic\.config\.json|capacitor\.config\.[a-z]+)$/
const SPRING_PATH = /(^|\/)application(-[\w.-]+)?\.(properties|ya?ml)$/

// Diff hunks often omit the import block, so a few unambiguous Spring annotations count too
const SPRING_DIFF = /^[+ ]\s*import\s+(static\s+)?org\.springframework\.|^[+ ]\s*@(SpringBootApplication|SpringBootTest|RestController|Autowired|ConfigurationProperties|(Get|Post|Put|Patch|Delete|Request)Mapping)\b/m
const ANGULAR_DIFF = /^[+ ]\s*import\b.*['"]@angular\//m
const IONIC_DIFF = /^[+ ]\s*import\b.*['"]@(ionic|capacitor)\//m
const FRONTEND_DIFF = /^[+ ]\s*import\b.*['"](react|react-dom|vue|svelte|@angular\/[^'"]*|@ionic\/[^'"]*)['"]/m

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

// 'other' = real source in an unsupported language; it counts against every base
function classifyFile(path: string, frontendSignal: boolean): BaseStack | 'other' | null {
  const ext = extensionOf(path)
  if (!ext || NEUTRAL_EXTENSIONS.has(ext)) return null
  if (FRONTEND_EXTENSIONS.has(ext)) return 'frontend'
  // Plain js/ts is ambiguous, so any frontend signal in the PR claims it for the frontend base
  if (JS_TS_EXTENSIONS.has(ext)) return frontendSignal ? 'frontend' : 'typescript-node'
  if (ext === 'java') return 'java'
  if (ext === 'kt' || ext === 'kts') return 'kotlin'
  if (ext === 'py') return 'python'
  return 'other'
}

export function detectStacks(changedFiles: ChangedFile[], diff = ''): StackSelection {
  const files = changedFiles.filter(f => f.status !== 'deleted')
  const paths = files.map(f => f.path)
  const anyPath = (re: RegExp) => paths.some(p => re.test(p))

  const angular = anyPath(ANGULAR_PATH) || ANGULAR_DIFF.test(diff)
  const ionic = anyPath(IONIC_PATH) || IONIC_DIFF.test(diff)
  const frontendSignal = angular || ionic || FRONTEND_DIFF.test(diff)
    || paths.some(p => ['tsx', 'jsx', 'vue', 'svelte'].includes(extensionOf(p)))

  const counts = new Map<BaseStack | 'other', number>()
  let total = 0
  for (const p of paths) {
    const kind = classifyFile(p, frontendSignal)
    if (!kind) continue
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    total++
  }
  if (total === 0) return { bases: [], overlays: [] }

  const bases = BASE_STACKS
    .filter(b => (counts.get(b) ?? 0) / total >= BASE_FLOOR)
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))

  const hasJvm = bases.includes('java') || bases.includes('kotlin')
  const hasFrontend = bases.includes('frontend')
  const overlays: OverlayStack[] = []
  if (hasJvm && (anyPath(SPRING_PATH) || SPRING_DIFF.test(diff))) overlays.push('spring')
  if (hasFrontend && angular) overlays.push('angular')
  if (hasFrontend && ionic) overlays.push('ionic')

  return { bases, overlays }
}
