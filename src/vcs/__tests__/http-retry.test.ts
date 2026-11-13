import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AxiosInstance } from 'axios'
import { withRetry, withCallLog, retryDelayMs, describeHttpError, MAX_RETRIES, RETRY_BUDGET_MS } from '../http-retry.js'

const httpError = (status: number, headers: Record<string, string> = {}, method = 'get', url = '/repositories/ws/repo/src/abc/file.md?x=1') =>
  Object.assign(new Error(`Request failed with status code ${status}`), { config: { method, url }, response: { status, headers } })

function setup() {
  const raw = { get: vi.fn(), post: vi.fn(), defaults: { timeout: 5 } }
  const sleep = vi.fn(async (_ms: number) => {})
  return { raw, sleep, client: withRetry(raw as unknown as AxiosInstance, 'bitbucket', sleep) }
}

let warn: ReturnType<typeof vi.spyOn>
let log: ReturnType<typeof vi.spyOn>
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}) })
afterEach(() => { warn.mockRestore(); log.mockRestore() })

describe('withRetry', () => {
  it('passes a successful call straight through with its arguments', async () => {
    const { raw, sleep, client } = setup()
    raw.get.mockResolvedValue({ data: 'ok' })
    expect(await client.get('/a', { responseType: 'text' })).toEqual({ data: 'ok' })
    expect(raw.get.mock.calls).toEqual([['/a', { responseType: 'text' }]])
    expect(sleep).not.toHaveBeenCalled()
    expect((client as unknown as typeof raw).defaults).toBe(raw.defaults)
  })

  it('resends a GET after 429 and honours Retry-After', async () => {
    const { raw, sleep, client } = setup()
    raw.get.mockRejectedValueOnce(httpError(429, { 'retry-after': '7', 'x-ratelimit-resource': 'api' })).mockResolvedValue({ data: 'ok' })
    expect(await client.get('/a')).toEqual({ data: 'ok' })
    expect(sleep.mock.calls).toEqual([[7000]])
    expect(warn.mock.calls[0][0]).toBe('  [bitbucket] retry 1/3 in 7s')
  })

  it('gives up after the retry limit and throws the last error', async () => {
    const { raw, sleep, client } = setup()
    const err = httpError(429)
    raw.get.mockRejectedValue(err)
    await expect(client.get('/a')).rejects.toBe(err)
    expect(raw.get).toHaveBeenCalledTimes(MAX_RETRIES + 1)
    expect(sleep.mock.calls).toEqual([[3000], [18_000], [36_000]])
  })

  it('resends a GET after 5xx or a dropped connection, never after 4xx or a timeout', async () => {
    for (const [err, calls] of [
      [httpError(503), 2],
      [Object.assign(new Error('reset'), { code: 'ECONNRESET' }), 2],
      [httpError(404), 1],
      [httpError(401), 1],
      [Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }), 1],
      [new Error('plain'), 1],
    ] as const) {
      const { raw, client } = setup()
      raw.get.mockRejectedValueOnce(err).mockResolvedValue({ data: 'ok' })
      await client.get('/a').catch(() => undefined)
      expect(raw.get, err.message).toHaveBeenCalledTimes(calls)
    }
  })

  it('resends a POST after 429 only: a 5xx may already have posted the comment', async () => {
    const limited = setup()
    limited.raw.post.mockRejectedValueOnce(httpError(429, {}, 'post')).mockResolvedValue({ data: 1 })
    expect(await limited.client.post('/c', { a: 1 })).toEqual({ data: 1 })
    expect(limited.raw.post).toHaveBeenCalledTimes(2)

    const failed = setup()
    failed.raw.post.mockRejectedValue(httpError(502, {}, 'post'))
    await expect(failed.client.post('/c', {})).rejects.toThrow('502')
    expect(failed.raw.post).toHaveBeenCalledTimes(1)
  })
})

describe('retryDelayMs', () => {
  it('waits 3 s, 18 s, 36 s and caps a long Retry-After at 60 s', () => {
    expect([0, 1, 2].map(n => retryDelayMs(n, httpError(429)))).toEqual([3000, 18_000, 36_000])
    expect(retryDelayMs(0, httpError(429, { 'retry-after': '3600' }))).toBe(60_000)
    expect(retryDelayMs(1, httpError(429, { 'retry-after': 'soon' }))).toBe(18_000)
  })
})

describe('describeHttpError', () => {
  it('names the method and path without the query, plus the limit headers when present', () => {
    expect(describeHttpError(httpError(429, { 'x-ratelimit-resource': 'repository', 'retry-after': '60' }))).toBe('GET /repositories/ws/repo/src/abc/file.md; X-RateLimit-Resource: repository; Retry-After: 60')
    expect(describeHttpError(httpError(500, {}, 'post', '/c'))).toBe('POST /c')
  })

  it('is null for anything that is not an HTTP client error', () => {
    for (const v of [new Error('x'), null, undefined, 'text']) expect(describeHttpError(v)).toBeNull()
  })
})

describe('withRetry budget', () => {
  it('stops retrying across calls once the shared wait budget is spent', async () => {
    const { raw, sleep, client } = setup()
    raw.get.mockRejectedValue(httpError(429, { 'retry-after': '60' }))
    await expect(client.get('/a')).rejects.toThrow('429')
    expect(sleep.mock.calls).toEqual([[60_000], [60_000]])
    expect(RETRY_BUDGET_MS).toBe(120_000)

    const before = raw.get.mock.calls.length
    await expect(client.get('/b')).rejects.toThrow('429')
    expect(raw.get.mock.calls.length).toBe(before + 1)
    expect(sleep).toHaveBeenCalledTimes(2)
    await expect(client.get('/c')).rejects.toThrow('429')
    const budgetWarnings = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('retry budget'))
    expect(budgetWarnings).toEqual([['  [bitbucket] retry budget (120s) spent - failing without further retries']])
  })

  it('gives a fresh client a fresh budget', async () => {
    const spent = setup()
    spent.raw.get.mockRejectedValue(httpError(429, { 'retry-after': '60' }))
    await spent.client.get('/a').catch(() => undefined)
    const fresh = setup()
    fresh.raw.get.mockRejectedValueOnce(httpError(429)).mockResolvedValue({ status: 200 })
    await fresh.client.get('/a')
    expect(fresh.sleep).toHaveBeenCalledTimes(1)
  })
})

describe('withCallLog', () => {
  const logged = () => log.mock.calls.map((c: unknown[]) => c[0])
  const make = () => {
    const raw = { get: vi.fn(), post: vi.fn() }
    return { raw, client: withCallLog(raw, 'bitbucket') }
  }

  it('logs a success with method, path, status and duration', async () => {
    const { raw, client } = make()
    raw.get.mockResolvedValue({ status: 200, data: 'x' })
    await client.get('/repositories/ws/repo/pullrequests/1')
    expect(logged()).toHaveLength(1)
    expect(logged()[0]).toMatch(/^ {2}\[bitbucket\] GET \/repositories\/ws\/repo\/pullrequests\/1 → 200 \(\d+ms\)$/)
  })

  it('logs a failure with the rate-limit headers, or the error code when there is no response', async () => {
    const { raw, client } = make()
    raw.get.mockRejectedValueOnce(httpError(429, { 'x-ratelimit-resource': 'api', 'retry-after': '60' }))
    raw.post.mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    await client.get('/a').catch(() => undefined)
    await client.post('/b', {}).catch(() => undefined)
    expect(logged()[0]).toMatch(/^ {2}\[bitbucket\] GET \/a → 429 \(\d+ms; X-RateLimit-Resource: api; Retry-After: 60\)$/)
    expect(logged()[1]).toMatch(/^ {2}\[bitbucket\] POST \/b → ECONNRESET \(\d+ms\)$/)
  })

  it('drops the query string and never logs headers, bodies or tokens', async () => {
    const { raw, client } = make()
    raw.post.mockResolvedValue({ status: 201 })
    await client.post('/c?access_token=SECRET#frag', { token: 'BODYSECRET' }, { headers: { Authorization: 'Basic HEADERSECRET' } })
    const line = String(logged()[0])
    expect(line).toContain('POST /c →')
    for (const secret of ['SECRET', 'access_token', 'frag', 'Basic']) expect(line).not.toContain(secret)
  })

  it('logs host and path for an absolute URL', async () => {
    const { raw, client } = make()
    raw.get.mockResolvedValue({ status: 200 })
    await client.get('https://bbuseruploads.s3.amazonaws.com/a/b?X-Amz-Signature=SIG')
    expect(String(logged()[0])).toContain('GET bbuseruploads.s3.amazonaws.com/a/b →')
    expect(String(logged()[0])).not.toContain('SIG')
  })

  it('logs every attempt of a retried call, with one retry line between them', async () => {
    const raw = { get: vi.fn() }
    raw.get.mockRejectedValueOnce(httpError(429)).mockResolvedValue({ status: 200 })
    const client = withRetry(withCallLog(raw, 'bitbucket'), 'bitbucket', async () => {})
    await client.get('/a')
    expect(logged()).toHaveLength(2)
    expect(String(logged()[0])).toContain('GET /a → 429')
    expect(String(logged()[1])).toContain('GET /a → 200')
    expect(warn.mock.calls).toEqual([['  [bitbucket] retry 1/3 in 3s']])
  })
})
