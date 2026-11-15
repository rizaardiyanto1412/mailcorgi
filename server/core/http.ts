import type { Context } from 'hono'
import type { StoreCtx } from './store.ts'
import type { Actor } from './actions.ts'
import { isWriteRefused } from './db.ts'

export class AppError extends Error {
  code: string
  status: number
  details?: unknown
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

export const notFound = (what = 'That') => new AppError('not_found', `${what} was not found.`, 404)
export const forbidden = (message = "You can't do that.") => new AppError('forbidden', message, 403)
export const unauthorized = (message = 'Sign in to continue.') => new AppError('unauthorized', message, 401)

export const STORAGE_WRITE_LIMIT_MESSAGE = "Cloudflare's free plan allows 100,000 database writes a day and this account has used them. Reading still works. Writes resume at 00:00 UTC, or now if you upgrade to Workers Paid."
/** The error every entry point answers when the platform refuses a row write. */
export const storageWriteLimit = () => new AppError('storage_write_limit', STORAGE_WRITE_LIMIT_MESSAGE, 503)
/** An `AppError` for anything the kernel can name; a refused write becomes `storage_write_limit`. */
export const asAppError = (err: unknown): AppError | null => (err instanceof AppError ? err : isWriteRefused(err) ? storageWriteLimit() : null)

export type ErrorBody = { error: string; code: string; details?: unknown }

export function errorResponse(err: unknown): Response {
  const known = asAppError(err)
  if (known) {
    const body: ErrorBody = { error: known.message, code: known.code }
    if (known.details !== undefined) body.details = known.details
    return Response.json(body, { status: known.status })
  }
  console.error('[http]', err)
  return Response.json({ error: 'Something went wrong.', code: 'internal' }, { status: 500 })
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

/** Responses from a Durable Object stub or the assets binding have immutable headers, so copy first. */
export function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(name)) out.headers.set(name, value)
  if (!out.headers.has('Content-Security-Policy')) out.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  return out
}

/** Hono variables available inside a store's HTTP app. */
export type StoreEnv = { Variables: { ctx: StoreCtx; actor: Actor | null } }

export async function readJson<T = Record<string, unknown>>(c: Context<any>): Promise<T> {
  // A cross-site form can post text/plain without a preflight; JSON needs one, so sessionless routes stay same-origin.
  if ((c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError('unsupported_media_type', 'Send the request body as application/json.', 415)
  try {
    const body = await c.req.json()
    if (body === null || typeof body !== 'object') throw new Error()
    return body as T
  } catch {
    throw new AppError('invalid_json', 'The request body must be JSON.', 400)
  }
}

/** Set only by the edge, from what the platform can vouch for. Client-sent forwarding headers are never read. */
export const CLIENT_IP_HEADER = 'x-mc-ip'
export const clientAddress = (c: Context<any>) => c.req.header(CLIENT_IP_HEADER) || ''

/** The client as rate limits see it: an IPv6 address counts as its /64, which one host usually controls. */
export function clientIp(c: Context<any>): string {
  const ip = clientAddress(c).replace(/%.*$/, '')
  if (!ip.includes(':')) return ip
  const [head, tail] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`
}

export const jsonNotFound = (c: Context<any>) => c.json({ error: 'Not found.', code: 'not_found' }, 404)

/** Parse a body or query with zod; a failure is a 400 the client can show. */
export function validate<T>(schema: { safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, data: unknown): T {
  const parsed = schema.safeParse(data ?? {})
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))
  const first = issues[0]
  throw new AppError('invalid_input', first ? `${first.path ? first.path + ': ' : ''}${first.message}` : 'Invalid input.', 400, { issues })
}
