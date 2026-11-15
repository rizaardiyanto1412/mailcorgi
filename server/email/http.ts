import { AppError } from '../core/http.ts'
import type { SendResult } from './index.ts'

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
