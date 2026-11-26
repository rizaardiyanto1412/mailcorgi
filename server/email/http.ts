import { AppError } from '../core/http.ts'
import type { SendResult } from './index.ts'
import { InvalidMessageError } from './mime.ts'

export function sendError(status: number, retryAfter: string | null, code = ''): SendResult {
  const kind = status === 429 || /throttl|limitexceeded|toomany/i.test(code) ? 'throttled' : status >= 500 ? 'temporary' : status === 408 ? 'unknown' : 'permanent'
  const seconds = retryAfter ? Number(retryAfter) : NaN
  return { ok: false, kind, message: `Email provider refused the request (${status}).`, ...(Number.isFinite(seconds) ? { retryAfterMs: Math.max(0, seconds * 1000) } : {}) }
}
export const unknownSend = (): SendResult => ({ ok: false, kind: 'unknown', message: 'The email provider did not confirm the outcome.' })
export function identityError(): never {
  throw new AppError('provider_failed', 'The email provider could not update the domain. Check the install settings and try again.', 502)
}

export const invalidSend = (): SendResult => ({ ok: false, kind: 'permanent', message: 'The email contains an invalid header.' })

/**
 * Outbound calls never follow a redirect. Workers rejects the 'error' redirect mode with a TypeError before
 * the request leaves, so every call asks for 'manual' and refuses the 3xx itself with `isRedirect`.
 */
export const noRedirect = { redirect: 'manual' } as const
/** Node hands back the 3xx itself, a browser-like runtime an `opaqueredirect`. Neither is ever followed or a success. */
export const isRedirect = (response: Response) => response.type === 'opaqueredirect' || response.status >= 300 && response.status <= 399
export const redirectSend = (hint = 'Check the endpoint URL.'): SendResult => ({ ok: false, kind: 'permanent', message: `The email provider answered with a redirect. ${hint}` })

export type FailureStage = 'fetch' | 'timeout' | 'redirect' | 'status' | 'parse'
type FailureDetail = { status?: number; error?: unknown; body?: string; redact?: (string | undefined)[] }

const isTimeout = (error: unknown) => {
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown }
  return name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT'
}
/** Cuts to 200 characters after removing the given secrets, credentials in auth schemes or URLs, and email addresses. */
function scrub(text: string, redact: (string | undefined)[]) {
  let out = text.slice(0, 4000)
  for (const secret of redact) if (secret) out = out.split(secret).join('[redacted]')
  return out
    .replace(/\b(basic|bearer|aws4-hmac-sha256)\s+\S+/gi, '$1 [redacted]')
    .replace(/\/\/[^/\s@]*@/g, '//[redacted]@')
    .replace(/[^\s<>"',;:()[\]{}]+@[^\s<>"',;()[\]{}]+/g, '[address]')
    .slice(0, 200)
}

/**
 * One log line for a send that failed in a way the caller only sees as a generic result. It carries the
 * provider, the stage, the status, the error name and a scrubbed message, and the reply snippet only for
 * a non-OK status. Settings, headers, the request body and recipients are never passed in.
 */
export function logSendFailure(provider: string, stage: FailureStage, detail: FailureDetail = {}) {
  const redact = detail.redact ?? []
  const error = detail.error === undefined ? undefined : detail.error instanceof Error ? detail.error : new Error(typeof detail.error === 'string' ? detail.error : 'Unknown error')
  const line = {
    provider, stage,
    ...(detail.status === undefined ? {} : { status: detail.status }),
    ...(error ? { error: scrub(error.name, redact), message: scrub(error.message, redact) } : {}),
    ...(detail.body && detail.status !== undefined && (detail.status < 200 || detail.status > 299) ? { body: scrub(detail.body, redact) } : {}),
  }
  console.error(`email provider failed ${JSON.stringify(line)}`)
}

/** For a provider's catch block: an invalid header is the caller's fault, anything else is logged and unknown. */
export function failedSend(provider: string, error: unknown, redact: (string | undefined)[] = []): SendResult {
  if (error instanceof InvalidMessageError) return invalidSend()
  logSendFailure(provider, isTimeout(error) ? 'timeout' : 'fetch', { error, redact })
  return unknownSend()
}
/** A reply that arrived but is not what the provider documents: logged as a parse failure, outcome unknown. */
export function unparsedSend(provider: string, status: number, error?: unknown): SendResult {
  logSendFailure(provider, 'parse', { status, ...(error === undefined ? {} : { error }) })
  return unknownSend()
}
/** A 3xx reply: logged and refused for good. */
export function redirectedSend(provider: string, status: number, hint?: string): SendResult {
  logSendFailure(provider, 'redirect', { status })
  return redirectSend(hint)
}
/** Parses JSON text without throwing, so a broken reply is a parse failure and not a fetch failure. */
export function parseJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}
