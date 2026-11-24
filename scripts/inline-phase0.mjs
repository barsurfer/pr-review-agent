#!/usr/bin/env node
// Phase 0 live checks (SPEC section 12) for inline reviews. GET-only unless --execute AND the PR title contains [inline-sandbox].
import { parseArgs } from 'util'

const SANDBOX_TAG = '[inline-sandbox]'
const { values: args } = parseArgs({
  options: {
    'pr-id': { type: 'string' },
    repo: { type: 'string' },
    workspace: { type: 'string' },
    'print-only': { type: 'boolean', default: false },
    execute: { type: 'boolean', default: false },
  },
})

const CHECKS = [
  ['P0', 'MANUAL (blocker)', 'In prod, confirm the bot own pullrequest:comment_* events are dropped by the trigger filter and that a per-PR lock exists. Not testable from this script.'],
  ['P1', 'blocker', 'PUT of the agent own summary works and content.raw round-trips byte-identical after CRLF/trailing-space normalisation (sample: unicode, tab, backslash titles). Needs --execute.'],
  ['P2', '', 'GET /2.0/user returns the agent ids. Failing: set AGENT_ACCOUNT_ID.'],
  ['P3', '', 'Inline comment on a context line, outside a hunk, and as a range. Needs --execute. Failing: ADDED_LINES_ONLY, single-line `to`.'],
  ['P4', '', 'POST response has id, links.html.href and user; ids increase with creation. Needs --execute.'],
  ['P5', 'blocker', 'The comment list shows a human resolve and unresolve. GET-only: reports the resolution field of existing inline comments (resolve one by hand and rerun). --execute also toggles one of its own.'],
  ['P6', '', 'A burst of 20 inline POSTs. Needs --execute. Failing: lower MAX_NEW_ROOTS_PER_RUN or add pacing.'],
  ['P7', '', 'A file rename updates inline.path in the list. GET-only: prints inline.path of existing comments; rename a commented file in the sandbox and rerun.'],
]

function printChecks() {
  console.log('Phase 0 checks (P0 is a manual step, do it first):')
  for (const [id, kind, text] of CHECKS) console.log(`  ${id}${kind ? ` [${kind}]` : ''}: ${text}`)
}

// Titles with unicode, tab and backslash exercise the P1 canonicalisation.
const P1_SAMPLE = [
  '### Review summary *(inline)*',
  '',
  '- **HIGH – Row with note** (`src/d.ts:4@a1b2c3d4e5f6`) · F1 · [thread](https://example.com/t) · line changed since a1b2c3d',
  '*Finding F1 | opened at a1b2c3d4e5f6 | claude-haiku-5-5 | Build abc1234*',
  '*Answer on F1 | through 12 | claude-haiku-5-5 | Build abc1234*',
  '- **HIGH – Ünïcode “title” ✓** (`src/a.ts:1`) · no thread',
  '- **LOW – Tab\there** (`src/b.ts:2`) · no thread',
  '- **MEDIUM – Back\\slash C:\\dir\\file** (`src/c.ts:3`) · no thread',
].join('\n')

if (args['print-only']) {
  printChecks()
  process.exit(0)
}

const baseUrl = process.env.BITBUCKET_BASE_URL || 'https://api.bitbucket.org/2.0'
const username = process.env.BITBUCKET_USERNAME
const token = process.env.BITBUCKET_TOKEN
const workspace = args.workspace || process.env.BITBUCKET_WORKSPACE
if (!username || !token || !workspace || !args.repo || !args['pr-id']) {
  console.error('Missing credentials or target: need BITBUCKET_USERNAME, BITBUCKET_TOKEN, a workspace (--workspace or BITBUCKET_WORKSPACE), --repo and --pr-id. Use --print-only to list the checks.')
  process.exit(1)
}

const auth = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64')
const prPath = `/repositories/${workspace}/${args.repo}/pullrequests/${args['pr-id']}`
let writesAllowed = false

async function call(method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, ok: res.ok, json, text }
}

// The only write path: refuses unless --execute and the sandbox title were both verified.
async function write(method, path, body) {
  if (!writesAllowed) throw new Error(`refusing ${method} ${path}: writes are not enabled`)
  return call(method, path, body)
}

const report = []
const note = (id, verdict, detail) => { report.push({ id, verdict, detail }); console.log(`${id} ${verdict}: ${detail}`) }

async function allComments() {
  const out = []
  let url = `${prPath}/comments?pagelen=100`
  while (url) {
    const r = await call('GET', url)
    if (!r.ok) throw new Error(`GET comments -> ${r.status}`)
    out.push(...(r.json.values ?? []))
    url = r.json.next ? r.json.next.replace(baseUrl, '') : ''
  }
  return out
}

// Added-line and context-line candidates from the first hunk of the raw diff.
function diffTargets(diff) {
  let file = null, newLine = 0, inHunk = false
  const found = { added: null, context: null, outside: null }
  const lines = diff.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('+++ b/')) { file = l.slice(6); inHunk = false; continue }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
    if (h) { newLine = Number(h[1]); inHunk = true; continue }
    if (!file || !inHunk) continue
    if (l.startsWith('+')) { found.added ??= { path: file, line: newLine }; newLine++ }
    else if (l.startsWith(' ')) { found.context ??= { path: file, line: newLine }; newLine++ }
    else if (l.startsWith('-')) continue
  }
  if (found.added) found.outside = { path: found.added.path, line: 100000 }
  return found
}

async function main() {
  printChecks()
  console.log('')

  const pr = await call('GET', prPath)
  if (!pr.ok) throw new Error(`GET PR -> ${pr.status}`)
  const title = pr.json.title ?? ''
  const sandbox = title.includes(SANDBOX_TAG)
  writesAllowed = Boolean(args.execute) && sandbox
  console.log(`PR "${title}" | mode: ${writesAllowed ? 'EXECUTE (writes enabled)' : 'GET-only'}`)
  if (args.execute && !sandbox) console.log(`--execute ignored: the PR title does not contain ${SANDBOX_TAG}`)

  const me = await call('GET', '/user')
  if (me.ok) note('P2', 'pass', `ids: ${[me.json.uuid, me.json.account_id].filter(Boolean).join(', ')} (names: ${[me.json.display_name, me.json.nickname].filter(Boolean).join(', ')})`)
  else note('P2', 'fail', `GET /user -> ${me.status}; set AGENT_ACCOUNT_ID`)

  const existing = await allComments()
  const inlineExisting = existing.filter(c => c.inline)
  note('P5', 'info', `${inlineExisting.length} inline comments; resolution fields: ${inlineExisting.slice(0, 5).map(c => `#${c.id}=${c.resolution ? 'resolved' : 'open'}`).join(' ') || 'none'}`)
  note('P7', 'info', `inline paths now: ${[...new Set(inlineExisting.map(c => c.inline.path))].slice(0, 5).join(', ') || 'none'}`)

  if (!writesAllowed) {
    for (const id of ['P1', 'P3', 'P4', 'P6']) note(id, 'skipped', 'needs --execute on an [inline-sandbox] PR')
    return
  }

  const created = []
  const track = r => { if (r.ok && r.json?.id) created.push(r.json.id); return r }
  try {
    // P1: round-trip and edit of a top-level comment.
    const post = track(await write('POST', `${prPath}/comments`, { content: { raw: P1_SAMPLE } }))
    if (!post.ok) { note('P1', 'fail', `POST -> ${post.status}`) } else {
      const edited = P1_SAMPLE + '\n\nedited'
      const put = await write('PUT', `${prPath}/comments/${post.json.id}`, { content: { raw: edited } })
      const back = await call('GET', `${prPath}/comments/${post.json.id}`)
      const norm = s => s.replace(/\r\n/g, '\n').split('\n').map(x => x.trimEnd()).join('\n').replace(/\n+$/, '')
      const identical = back.ok && back.json.content.raw === edited
      note('P1', put.ok && identical ? 'pass' : put.ok && back.ok && norm(back.json.content.raw) === norm(edited) ? 'pass-after-normalisation' : 'fail', `PUT -> ${put.status}; raw byte-identical: ${identical}`)
    }
    // P4: response shape and id ordering.
    const second = track(await write('POST', `${prPath}/comments`, { content: { raw: 'phase0 ordering probe' } }))
    const idsOrdered = post.ok && second.ok && Number(second.json.id) > Number(post.json.id)
    note('P4', post.ok && post.json.links?.html?.href && post.json.user && idsOrdered ? 'pass' : 'fail',
      `links.html.href: ${Boolean(post.json?.links?.html?.href)}, user: ${Boolean(post.json?.user)}, ids increase: ${idsOrdered}`)

    // P3: context line, outside a hunk, range.
    const diff = await call('GET', `${prPath}/diff`)
    const t = diff.ok ? diffTargets(diff.text) : {}
    const results = []
    for (const [name, target, extra] of [['context', t.context, {}], ['outside', t.outside, {}], ['range', t.added, { from: t.added ? t.added.line : undefined }]]) {
      if (!target) { results.push(`${name}: no target in diff`); continue }
      const to = name === 'range' ? target.line + 1 : target.line
      const r = track(await write('POST', `${prPath}/comments`, { content: { raw: `phase0 ${name}` }, inline: { path: target.path, to, ...extra } }))
      results.push(`${name}: ${r.status}`)
    }
    note('P3', 'info', results.join(' | '))

    // P5 toggle on one of our own inline comments (resolve endpoint is unverified: a non-2xx is reported, not fatal).
    const inlineId = created.at(-1)
    if (inlineId) {
      const res = await write('POST', `${prPath}/comments/${inlineId}/resolve`, {})
      const afterResolve = await call('GET', `${prPath}/comments/${inlineId}`)
      const un = res.ok ? await write('DELETE', `${prPath}/comments/${inlineId}/resolve`) : { status: 'n/a' }
      const afterReopen = await call('GET', `${prPath}/comments/${inlineId}`)
      note('P5', res.ok && afterResolve.json?.resolution && !afterReopen.json?.resolution ? 'pass' : 'fail',
        `resolve -> ${res.status}, listed resolved: ${Boolean(afterResolve.json?.resolution)}, unresolve -> ${un.status}, listed open: ${!afterReopen.json?.resolution}`)
    }

    // P6: burst of 20 inline POSTs.
    if (t.added) {
      const statuses = {}
      const started = Date.now()
      for (let i = 0; i < 20; i++) {
        const r = track(await write('POST', `${prPath}/comments`, { content: { raw: `phase0 burst ${i + 1}/20` }, inline: { path: t.added.path, to: t.added.line } }))
        statuses[r.status] = (statuses[r.status] ?? 0) + 1
      }
      note('P6', statuses[200] === 20 || statuses[201] === 20 ? 'pass' : 'fail', `statuses ${JSON.stringify(statuses)} in ${Date.now() - started} ms`)
    } else note('P6', 'skipped', 'no added line in the diff')
  } finally {
    for (const id of created.reverse()) {
      const r = await write('DELETE', `${prPath}/comments/${id}`).catch(e => ({ status: e.message }))
      if (!(r.status === 204 || r.status === 200)) console.log(`cleanup: comment ${id} -> ${r.status}`)
    }
  }
}

main().then(() => {
  const failed = report.filter(r => r.verdict === 'fail')
  console.log(`\nDone. ${failed.length} failing check(s).`)
  process.exit(0)
}).catch(e => { console.error(`phase0 error: ${e.message}`); process.exit(2) })
