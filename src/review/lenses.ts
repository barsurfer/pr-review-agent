import { SHOWN_LINE_CLAUSE, allowShownContext, passOverlay } from './breadth.js'
import type { ReviewFinding, IssueType } from './formatter.js'

export type Placement = 'findings' | 'section'
type Severity = ReviewFinding['severity']

export interface SectionKind { label: string; type: IssueType; path: 'any' | 'test' | 'non_test' | 'fully_shown' }

export interface SectionDef {
  heading: string
  legend: string
  order: number
  severity: { fixed: Severity } | { max: Severity }
  criteria: string
  judgeNotes: string
  kinds?: readonly SectionKind[]
  group: boolean
  rowBody: boolean
  addedLines: 'all' | 'overlap'
  maxPlaceLines?: number
  rowCap: number
  absorbLow: boolean
}

export interface Lens { name: string; when: string; overlay: string; scenarioTag?: boolean; defaultPlacement: Placement; cap?: number; section: SectionDef }

export interface LensRecommendation { lens: string; reason: string }

const titleCase = (s: string): string => s[0].toUpperCase() + s.slice(1)

// One shared frame keeps the scope lock and the closing contract identical across lenses; allowShownContext needs the clause verbatim.
const defineLens = (name: string, concern: string, when: string, items: string[], note = '', scenarioTag = false): Lens => ({
  name,
  when,
  ...(scenarioTag ? { scenarioTag } : {}),
  defaultPlacement: 'findings',
  section: {
    heading: `### ${titleCase(name)}`,
    legend: `Findings from the ${name} pass; not counted in the verdict.`,
    order: 0,
    severity: { max: 'HIGH' },
    criteria: items.map(i => `- ${i}`).join('\n'),
    judgeNotes: 'A claim needs a concrete failing scenario in code this diff adds; a style or design preference is incorrect.',
    group: false, rowBody: true, addedLines: 'overlap', rowCap: 10, absorbLow: false,
  },
  overlay: `## ${name.toUpperCase()} LENS
Earlier review passes already ran; their findings are listed in the message. This pass re-reads the whole diff for one concern — ${concern} — to find real problems they missed, not to re-report what they found. Report only defects this change introduces, anchored on added or modified lines — no refactoring advice, no audit of unchanged code. Look for:
${items.map(i => `- ${i}`).join('\n')}
${note ? `${note}\n` : ''}When confidence is limited but potential impact is high (data loss, security, corruption), report it with an explicit note on what remains uncertain — do not silently drop it.
Do not repeat a listed finding (same root cause at the same place). Every finding needs a concrete failing scenario, a file, and ${SHOWN_LINE_CLAUSE} Return an empty list if you find nothing.`,
})

export const SLOP_KINDS = `- Restating comment: a comment that only says what the code or signature next to it already says, including a doc block that lists parameter names and types without adding a constraint, unit, side effect or example. A comment that gives a reason, an invariant, a workaround or a surprising behavior is not slop; neither are given/when/then or arrange/act/assert comments in tests.
- Breadcrumb comment: a comment about the change's history instead of the code: a ticket, PR or reviewer reference ("per review"), "fixed", "removed X", "changed from Y", or a section banner such as "// ===== HELPERS =====" in a file that has none elsewhere.
- Commented-out code: added lines that are code turned into a comment.
- Debug leftover: in non-test code, a debugger statement, or a print or console call that dumps a raw value or a marker ("here", "test", ">>>") in a file that otherwise logs through a logger or not at all.
- Unreachable guard: a null check, try/catch, fallback value or re-validation that cannot trigger because code you were shown guarantees the condition (assigned just above, a non-nullable type, checked earlier on the same path).
- Single-use abstraction: in a file you were shown in full, a new non-exported helper or wrapper that has exactly one caller and only forwards to another call, or a new non-exported interface or abstract class with exactly one implementation and no other use.
- Hollow test: a test that cannot fail: it has no assertion, asserts only on a mock or stub the test itself set up or called, or asserts something always true (a literal, or a value the test just assigned).
- Duplicate test: a test with the same inputs and assertions as another test you were shown.
- Misnamed test: a test whose name claims a case (an error, an edge, a branch) that its body does not exercise.
- Trivial snapshot: a snapshot assertion over output with no logic of its own (a constant, a static or empty element).`

const SLOP_OVERLAY = `## SLOP LENS
This pass looks for one thing only: low-value code this change adds that a careful reviewer would ask to remove or simplify before merge. For this pass only, the FORBIDDEN rules on style, nitpicks and refactoring and the failing-scenario requirement for lower-severity findings do not apply; certainty that a place is one of the kinds below replaces them. Every other rule above still applies, and anything the repository's own sections allow or require (for example doc comments on public APIs, ticket ids in comments, console output in scripts) is not slop.
Report only what you are certain of from what you were shown, and only on lines this change adds (lines starting with "+"). Never report unchanged or removed lines, generated or vendored files (lockfiles, minified or compiled output, files marked generated or "do not edit", vendor/ or third_party/ directories), documentation files, or TODO, FIXME and HACK comments (out of scope for this pass). When in doubt, leave it out.
Kinds. Start every title with one of these labels, a colon and a short reason, e.g. "Restating comment: JSDoc repeats the signature of parseRows":
{SLOP_KINDS}
Report one finding per place: one comment block, one statement, one test or one declaration. Set lines to the number or range of that place only, at most 40 lines. The same kind in several places is several findings. Severity is LOW. Body: what is wrong and what to do (delete it, inline it, assert the real result), in at most two sentences. Return an empty list if you find nothing.`.replace('{SLOP_KINDS}', () => SLOP_KINDS)

const SLOP_JUDGE_NOTES = `For this pass, incorrect also covers: the comment gives a reason, an invariant or a workaround; the test asserts on the code under test; the guard can trigger; the abstraction has another use or adds behavior; the lines are not of the named kind. Having no runtime impact is expected for every kind and is never a reason to reject a candidate. Anything the repository exceptions allow or require is incorrect.`

const SLOP_KIND_LIST: readonly SectionKind[] = [
  { label: 'Restating comment', type: 'maintainability', path: 'any' },
  { label: 'Breadcrumb comment', type: 'maintainability', path: 'any' },
  { label: 'Commented-out code', type: 'maintainability', path: 'any' },
  { label: 'Debug leftover', type: 'maintainability', path: 'non_test' },
  { label: 'Unreachable guard', type: 'maintainability', path: 'any' },
  { label: 'Single-use abstraction', type: 'maintainability', path: 'fully_shown' },
  { label: 'Hollow test', type: 'tests', path: 'test' },
  { label: 'Duplicate test', type: 'tests', path: 'test' },
  { label: 'Misnamed test', type: 'tests', path: 'test' },
  { label: 'Trivial snapshot', type: 'tests', path: 'test' },
]

// A placeholder `when`: slop is excluded from the recommendation schema, so it is never read.
const SLOP: Lens = {
  name: 'slop',
  when: 'low-value code added by the change',
  overlay: SLOP_OVERLAY,
  defaultPlacement: 'section',
  cap: 25,
  section: {
    heading: '### Cleanup',
    legend: 'Low-value code added in this PR; not counted in the findings or the verdict.',
    order: 100,
    severity: { fixed: 'LOW' },
    criteria: SLOP_KINDS,
    judgeNotes: SLOP_JUDGE_NOTES,
    kinds: SLOP_KIND_LIST,
    group: true, rowBody: false, addedLines: 'all', maxPlaceLines: 40, rowCap: 10, absorbLow: true,
  },
}

const RECALL_LENSES: Lens[] = [
  defineLens('reliability', 'failure handling and resource safety', 'new or changed error handling, async or concurrent code, acquired resources, nullable or boundary inputs', [
    'an error, rejection or exception the new code raises or receives that nothing handles, or a returned error or status it ignores;',
    'a dereference of a value that can be null, undefined or empty on a path the new code takes;',
    'a resource the new code acquires but does not release on every path, error path included (handles, connections, subscriptions, listeners, timers);',
    'a race or ordering hazard the platform can actually hit: unawaited async work, check-then-act, state read before it is set;',
    'a realistic input the new code mishandles: empty, zero, missing, duplicate, or at a boundary.',
  ]),
  defineLens('security', 'security', 'new or changed endpoints, auth, input handling, crypto, outbound requests', [
    'injection: untrusted input reaching SQL/NoSQL, shell, path, template or LDAP APIs without the right control;',
    'broken access control: a new or changed endpoint or data access without an authentication, authorization or ownership check;',
    'SSRF: an outbound request built from a user-controlled URL or host without an allowlist;',
    'secrets or sensitive data hardcoded, logged, placed in URLs, or sent to the client;',
    'weak cryptography: broken primitives, a non-CSPRNG security token, hardcoded keys or IVs, disabled TLS verification;',
    'unsafe deserialization or dynamic execution of untrusted data;',
    'untrusted data reaching HTML, headers, redirects or logs without encoding at the sink.',
  ], 'Hold every item to the SECURITY rules above, including their limits on assuming a control is missing.'),
  defineLens('testing', 'test adequacy', 'new or changed behavior shown together with its tests, or changed tests and assertions', [
    'new or changed behavior — a branch, error path or edge case — that no test covers, where a regression would ship unnoticed;',
    'a test that cannot fail: no assertion, an always-true assertion, an assertion on the mock instead of the code under test, or one never reached;',
    'a weak assertion that would still pass if the changed behavior broke (only checks a value is defined or truthy, or a function was called).',
  ], 'Test files may be filtered out of what you were shown, so a test absent from the diff is not evidence none exists: report a missing test only when the shown diff or file context includes the tests for the changed area and they skip the new behavior. Anchor a missing-test finding on the untested added or modified line, and a weak-test finding on the assertion. Do not ask for tests of trivial code (wiring, config, renames).'),
  defineLens('performance', 'performance', 'loops, queries or I/O over data that can grow, or work on a hot path', [
    'N+1 access: a query, request or file read issued per item inside a loop where one batched call would do;',
    'quadratic or worse work on input that can grow: nested loops, repeated linear searches, or copies inside a loop;',
    'unnecessary allocation, copying, serialization or recomputation on a hot path (per request, per item, per render);',
    'blocking or synchronous I/O on a request path, event loop or UI thread;',
    'unbounded work or payloads: a query, list, cache or response with no limit or pagination over data that can grow.',
  ], 'Flag only when the input can realistically be large or the path is hot; a loop over a few fixed items is not a finding.'),
  defineLens('architecture', 'contracts and boundaries', 'changed exported APIs, signatures, schemas, events, config contracts or module boundaries', [
    'a breaking change to an exported API, signature, schema, event or config contract whose callers or consumers are not updated;',
    'a new or changed parameter, field or enum value that a caller, implementation or serializer was not updated for;',
    'interface/implementation drift: an implementation that no longer matches its declared interface, type, schema or documented contract;',
    'a layering or boundary violation the change introduces: a lower layer importing a higher one, transport or UI code reaching into persistence, or a new module cycle.',
  ], 'Report a mismatch with callers, consumers or implementations only when both sides are visible in what you were shown. Design preferences and refactoring suggestions are not findings.'),
  defineLens('impact', 'what breaks when the change meets a real scenario', 'changes crossing files, feature gates, persisted data, deferred or repeated work, or side-effect order', [
    'clean install or build: a module, file, plugin or dependency the new code needs that a manifest, published-files list or setup file omits, only when that whole file is shown in the file context;',
    'a feature, flag or optional dependency switched off: a new code path that depends on something the shown code enables only conditionally (a nil or disabled guard, a config check), so the path fails or errors on every call while it is off;',
    'repeated or overlapping use the platform allows (a second click or key press, a retry, a concurrent request): the next run starting before the previous one\'s deferred work (callback, invokeLater, debounce, queued write) has landed;',
    'existing data and upgrades: records, files or settings written before this change (old ids, missing fields, renamed keys or formats) that the new code, or one of its constructors or modes, cannot read;',
    'order of side effects: a destructive or visible action (delete, hide, overwrite, send) taken before the check that decides whether it should happen;',
    'contracts across files: a field, key, method or parameter one changed file writes or calls that the file reading or implementing it names differently, does not expose, or types differently (a nullable value passed where a non-null one is required).',
  ], 'Trace each scenario from caller to callee through the code you were shown and report a failure only when you can follow it end to end, naming the scenario in the body; report a cross-file mismatch only when both sides are visible. When the same defect occurs in several changed files, report it in each.', true),
]

const LENSES: Lens[] = [...RECALL_LENSES.map((l, i) => ({ ...l, section: { ...l.section, order: 10 * i } })), SLOP]

export const LENS_REGISTRY: Readonly<Record<string, Lens>> = Object.freeze(Object.fromEntries(LENSES.map(l => [l.name, l])))

// Recall lenses only: the recommendation schema and its sanitizer must not offer or accept slop.
export const recommendableLenses = (): Lens[] => LENSES.filter(l => l.defaultPlacement === 'findings')

// ReviewBench builds a run's row id from label values and rejects ids over 64 chars, so the LENSES value needs short forms.
const LENS_ALIASES: Readonly<Record<string, string>> = Object.freeze({ rel: 'reliability', sec: 'security', test: 'testing', perf: 'performance', arch: 'architecture', imp: 'impact' })

export interface LensSettings { enabled: boolean; list: string; sections?: string }

// Section lenses run after every findings lens, in list order, so one sorted view feeds execution, records, judge candidates and the cache plan.
export function activeLenses(settings: LensSettings): Lens[] {
  if (!settings.enabled) return []
  const { lenses } = parseLensList(settings.list)
  const placements = resolvePlacements(settings).placements
  return [...lenses.filter(l => placements.get(l.name) === 'findings'), ...lenses.filter(l => placements.get(l.name) === 'section')]
}

export function resolvePlacements(settings: { list: string; sections?: string }): { placements: Map<string, Placement>; warnings: string[] } {
  const warnings: string[] = []
  const { lenses } = parseLensList(settings.list)
  const raw = (settings.sections ?? '').trim()
  const placements = new Map<string, Placement>()
  let named: Set<string> | undefined
  const names = raw.split(/[,+]/).map(s => s.trim().toLowerCase()).filter(Boolean)
  // Only separators (a stray comma) count as unset, not as an empty placement list.
  if (names.length > 0) {
    const none = names.includes('none')
    if (none && names.length > 1) warnings.push('LENS_SECTIONS mixes none with lens names - treating it as none')
    const canonical = names.filter(n => n !== 'none').map(n => (Object.hasOwn(LENS_ALIASES, n) ? LENS_ALIASES[n] : n))
    const unknown = canonical.filter(n => !Object.hasOwn(LENS_REGISTRY, n))
    if (unknown.length) warnings.push(`LENS_SECTIONS: ignoring unknown lens name(s) ${unknown.join(', ')}`)
    const known = canonical.filter(n => Object.hasOwn(LENS_REGISTRY, n))
    // A value of only typos must not silently push every lens, slop included, into Findings.
    if (!none && known.length === 0) warnings.push('LENS_SECTIONS has no known lens name - using each lens default placement')
    else named = none ? new Set() : new Set(known)
  }
  for (const l of lenses) placements.set(l.name, named ? (named.has(l.name) ? 'section' : 'findings') : l.defaultPlacement)
  if (placements.get('slop') === 'findings') warnings.push('Lens slop is placed in Findings: the main judge files its content as minor or style-only, so almost nothing will post')
  return { placements, warnings }
}

export function parseLensList(value: string): { lenses: Lens[]; unknown: string[] } {
  // hasOwn, not `in`: inherited keys like "constructor" must not resolve to a lens.
  const canonical = (n: string) => (Object.hasOwn(LENS_ALIASES, n) ? LENS_ALIASES[n] : n)
  const names = [...new Set(value.split(/[,+]/).map(s => canonical(s.trim().toLowerCase())).filter(Boolean))]
  return {
    lenses: names.filter(n => Object.hasOwn(LENS_REGISTRY, n)).map(n => LENS_REGISTRY[n]),
    unknown: names.filter(n => !Object.hasOwn(LENS_REGISTRY, n)),
  }
}

// Same FINDINGS LIMIT text as breadthSystemPrompt, pinned by a test, so every extra pass reads one cap wording.
export function lensSystemPrompt(reviewerPrompt: string, lens: Lens, limit: number, shownAnchors = false): string {
  const limitSection = limit > 0
    ? `\n\n## FINDINGS LIMIT\nReport at most ${limit} findings, prioritized by severity and impact. If more exist, include only the most important and omit the rest.`
    : ''
  return `${reviewerPrompt}${limitSection}\n\n${shownAnchors ? allowShownContext(lens.overlay) : lens.overlay}`
}

export function lensOverlay(lens: Lens, limit: number, shownAnchors = false): string {
  return passOverlay(shownAnchors ? allowShownContext(lens.overlay) : lens.overlay, limit)
}

export function lensBriefing(known: readonly ReviewFinding[]): string {
  const located = (f: ReviewFinding) => (f.file ? `${f.file}${f.lines ? `:${f.lines}` : ''}` : '(no file)')
  const findings = known.length ? known.map(f => `- ${located(f)} — ${f.title}`).join('\n') : 'None.'
  return `## Findings already reported (do NOT repeat — find additional distinct problems within this concern across the whole diff):\n${findings}`
}

export const LENS_REASON_CAP = 200

export function sanitizeLensRecommendations(raw: unknown): LensRecommendation[] | null {
  if (!Array.isArray(raw)) return null
  const out: LensRecommendation[] = []
  for (const item of raw) {
    const lens = (item as { lens?: unknown } | null)?.lens
    if (typeof lens !== 'string' || !Object.hasOwn(LENS_REGISTRY, lens) || LENS_REGISTRY[lens].defaultPlacement !== 'findings' || out.some(r => r.lens === lens)) continue
    const reason = (item as { reason?: unknown }).reason
    out.push({ lens, reason: typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim().slice(0, LENS_REASON_CAP) : '' })
  }
  return out
}
