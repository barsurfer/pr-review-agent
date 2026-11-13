// Bitbucket limits are rolling windows, so a quick resend hits the same limit; the waits are long on purpose.
const RETRY_DELAYS_MS = [3_000, 18_000, 36_000]
export const MAX_RETRIES = RETRY_DELAYS_MS.length
const MAX_DELAY_MS = 60_000
export const RETRY_BUDGET_MS = 120_000
const METHODS = new Set(['get', 'post', 'put', 'delete'])

interface HttpError {
  code?: string
  config?: { method?: string; url?: string }
  response?: { status?: number; headers?: Record<string, unknown> }
}

function header(err: HttpError, name: string): string | undefined {
  const v = err.response?.headers?.[name]
  return v == null || v === '' ? undefined : String(v)
}

// Says which call failed and which limit was hit; the query string is dropped because it can carry tokens on some hosts.
export function describeHttpError(err: unknown): string | null {
  const e = (err ?? {}) as HttpError
  if (!e.config?.url) return null
  const parts = [`${(e.config.method ?? 'get').toUpperCase()} ${e.config.url.split('?')[0]}`]
  const resource = header(e, 'x-ratelimit-resource')
  const retryAfter = header(e, 'retry-after')
  if (resource) parts.push(`X-RateLimit-Resource: ${resource}`)
  if (retryAfter) parts.push(`Retry-After: ${retryAfter}`)
  return parts.join('; ')
}

// A 429 was refused before any work, so every method may resend it; a 5xx or dropped connection may have been applied, so only reads are resent.
function isRetryable(err: unknown, read: boolean): boolean {
  const e = (err ?? {}) as HttpError
  const status = e.response?.status
  if (status === 429) return true
  if (!read) return false
  if (status !== undefined) return status >= 500
  return e.code === 'ECONNRESET' || e.code === 'EAI_AGAIN'
}

export function retryDelayMs(attempt: number, err: unknown): number {
  const retryAfter = Number(header((err ?? {}) as HttpError, 'retry-after'))
  const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS_MS[Math.min(attempt, MAX_RETRIES - 1)]
  return Math.min(ms, MAX_DELAY_MS)
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

type AsyncMethod = (...a: unknown[]) => Promise<unknown>

// A proxy, not an interceptor: it resolves the method at call time, so it also wraps a client whose methods are replaced later.
function wrapMethods<T extends object>(client: T, wrap: (method: string, call: AsyncMethod) => AsyncMethod): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string' || !METHODS.has(prop)) return Reflect.get(target, prop, receiver)
      return wrap(prop, (...args) => (Reflect.get(target, prop) as AsyncMethod).apply(target, args))
    },
  })
}

// An absolute URL keeps host + path; the query is dropped because it can carry tokens (e.g. signed redirects).
function callTarget(url: unknown): string {
  const raw = typeof url === 'string' ? url : ''
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      return u.host + u.pathname
    } catch { /* malformed: fall through to the plain split */ }
  }
  return raw.split(/[?#]/)[0]
}

function limitDetails(err: HttpError): string[] {
  const resource = header(err, 'x-ratelimit-resource')
  const retryAfter = header(err, 'retry-after')
  return [...(resource ? [`X-RateLimit-Resource: ${resource}`] : []), ...(retryAfter ? [`Retry-After: ${retryAfter}`] : [])]
}

export function withCallLog<T extends object>(client: T, label: string): T {
  return wrapMethods(client, (method, call) => async (...args) => {
    const target = `${method.toUpperCase()} ${callTarget(args[0])}`
    const started = Date.now()
    try {
      const res = await call(...args)
      console.log(`  [${label}] ${target} → ${(res as { status?: number } | undefined)?.status ?? 'ok'} (${Date.now() - started}ms)`)
      return res
    } catch (err: unknown) {
      const e = (err ?? {}) as HttpError
      console.log(`  [${label}] ${target} → ${e.response?.status ?? e.code ?? 'error'} (${[`${Date.now() - started}ms`, ...limitDetails(e)].join('; ')})`)
      throw err
    }
  })
}

// Sits on top of withCallLog so each attempt is logged by the layer below.
export function withRetry<T extends object>(client: T, label: string, sleep: (ms: number) => Promise<void> = delay): T {
  // Per client: many files failing at once must not stack their waits into an hour.
  let slept = 0
  let budgetLogged = false
  return wrapMethods(client, (method, call) => async (...args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call(...args)
      } catch (err: unknown) {
        if (attempt >= MAX_RETRIES || !isRetryable(err, method === 'get')) throw err
        const ms = retryDelayMs(attempt, err)
        if (slept + ms > RETRY_BUDGET_MS) {
          if (!budgetLogged) {
            budgetLogged = true
            console.warn(`  [${label}] retry budget (${RETRY_BUDGET_MS / 1000}s) spent - failing without further retries`)
          }
          throw err
        }
        slept += ms
        console.warn(`  [${label}] retry ${attempt + 1}/${MAX_RETRIES} in ${ms / 1000}s`)
        await sleep(ms)
      }
    }
  })
}
