import { describe, it, expect, afterEach } from 'vitest'
import axios from 'axios'
import http from 'node:http'

// Pins the real-axios error shapes GitHubAdapter.getCompareDiff keys on: ERR_BAD_RESPONSE +
// a "maxContentLength" message for the 25MB cap, ECONNABORTED for the compare timeout. This
// fails loudly if an axios upgrade changes them, instead of the adapter silently turning a
// too-large SKIP into a generic ERROR. See src/vcs/github.ts. (Real axios — not mocked.)

const servers: http.Server[] = []
const timers: NodeJS.Timeout[] = []

function listen(handler: http.RequestListener): Promise<number> {
  return new Promise(resolve => {
    const s = http.createServer(handler)
    servers.push(s)
    s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port))
  })
}

afterEach(() => {
  timers.forEach(clearTimeout)
  timers.length = 0
  servers.forEach(s => s.close())
  servers.length = 0
})

describe('real-axios error shapes (contract for GitHubAdapter.getCompareDiff)', () => {
  it('rejects an over-cap body with ERR_BAD_RESPONSE + a maxContentLength message, no response', async () => {
    const port = await listen((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('x'.repeat(2000)) })
    const err = await axios.get(`http://127.0.0.1:${port}/`, { responseType: 'text', maxContentLength: 1000 }).then(() => null, e => e)

    expect(err).toBeTruthy()
    expect(err.code).toBe('ERR_BAD_RESPONSE')
    expect(err.message).toMatch(/maxContentLength|maxBodyLength/i)
    expect(err.response).toBeUndefined()
  })

  it('rejects a slow response with ECONNABORTED, no response', async () => {
    const port = await listen((_q, r) => { timers.push(setTimeout(() => { try { r.writeHead(200); r.end('late') } catch { /* socket already closed */ } }, 300)) })
    const err = await axios.get(`http://127.0.0.1:${port}/`, { timeout: 50 }).then(() => null, e => e)

    expect(err).toBeTruthy()
    expect(err.code).toBe('ECONNABORTED')
    expect(err.message).toMatch(/timeout/i)
    expect(err.response).toBeUndefined()
  })
})
