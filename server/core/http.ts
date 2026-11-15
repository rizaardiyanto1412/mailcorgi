import type { Context } from 'hono'
import type { StoreCtx } from './store.ts'
import type { Actor } from './actions.ts'

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

export type ErrorBody = { error: string; code: string; details?: unknown }

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    const body: ErrorBody = { error: err.message, code: err.code }
    if (err.details !== undefined) body.details = err.details
    return Response.json(body, { status: err.status })
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

export function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!response.headers.has(name)) response.headers.set(name, value)
  if (!response.headers.has('Content-Security-Policy')) response.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  return response
}

/** Hono variables available inside a store's HTTP app. */
export type StoreEnv = { Variables: { ctx: StoreCtx; actor: Actor | null } }

export async function readJson<T = Record<string, unknown>>(c: Context<any>): Promise<T> {
  try {
    const body = await c.req.json()
    if (body === null || typeof body !== 'object') throw new Error()
    return body as T
  } catch {
    throw new AppError('invalid_json', 'The request body must be JSON.', 400)
  }
}

export const clientIp = (c: Context<any>) => c.req.header('cf-connecting-ip') || (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || c.req.header('x-real-ip') || ''

export const jsonNotFound = (c: Context<any>) => c.json({ error: 'Not found.', code: 'not_found' }, 404)

/** Parse a body or query with zod; a failure is a 400 the client can show. */
export function validate<T>(schema: { safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, data: unknown): T {
  const parsed = schema.safeParse(data ?? {})
  if (parsed.success) return parsed.data
  const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))
  const first = issues[0]
  throw new AppError('invalid_input', first ? `${first.path ? first.path + ': ' : ''}${first.message}` : 'Invalid input.', 400, { issues })
}
