import { AppError } from '../core/http.ts'
import { KeyRateError } from '../account/apikeys/index.ts'
import { OAuthRateError } from '../account/oauth/tokens.ts'

export function apiError(err: unknown) {
  const error = err instanceof AppError ? { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) } : { code: 'internal', message: 'Something went wrong.' }
  return Response.json({ error }, { status: err instanceof AppError ? err.status : 500, headers: err instanceof KeyRateError || err instanceof OAuthRateError ? { 'Retry-After': String(err.retryAfter) } : {} })
}
