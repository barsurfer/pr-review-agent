import { SHOWN_LINE_CLAUSE, allowShownContext } from './breadth.js'
import type { ReviewFinding } from './formatter.js'

export interface Lens { name: string; when: string; overlay: string }

export interface LensRecommendation { lens: string; reason: string }

// One shared frame keeps the scope lock and the closing contract identical across lenses; allowShownContext needs the clause verbatim.
const defineLens = (name: string, concern: string, when: string, items: string[], note = ''): Lens => ({
  name,
  when,
  overlay: `## ${name.toUpperCase()} LENS
Earlier review passes already ran; their findings are listed in the message. This pass re-reads the whole diff for one concern — ${concern} — to find real problems they missed, not to re-report what they found. Report only defects this change introduces, anchored on added or modified lines — no refactoring advice, no audit of unchanged code. Look for:
${items.map(i => `- ${i}`).join('\n')}
${note ? `${note}\n` : ''}When confidence is limited but potential impact is high (data loss, security, corruption), report it with an explicit note on what remains uncertain — do not silently drop it.
Do not repeat a listed finding (same root cause at the same place). Every finding needs a concrete failing scenario, a file, and ${SHOWN_LINE_CLAUSE} Return an empty list if you find nothing.`,
})

const LENSES: Lens[] = [
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
]

export const LENS_REGISTRY: Readonly<Record<string, Lens>> = Object.freeze(Object.fromEntries(LENSES.map(l => [l.name, l])))

// ReviewBench builds a run's row id from label values and rejects ids over 64 chars, so the LENSES value needs short forms.
const LENS_ALIASES: Readonly<Record<string, string>> = Object.freeze({ rel: 'reliability', sec: 'security', test: 'testing', perf: 'performance', arch: 'architecture' })

export function activeLenses(settings: { enabled: boolean; list: string }): Lens[] {
  return settings.enabled ? parseLensList(settings.list).lenses : []
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
    if (typeof lens !== 'string' || !Object.hasOwn(LENS_REGISTRY, lens) || out.some(r => r.lens === lens)) continue
    const reason = (item as { reason?: unknown }).reason
    out.push({ lens, reason: typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim().slice(0, LENS_REASON_CAP) : '' })
  }
  return out
}
