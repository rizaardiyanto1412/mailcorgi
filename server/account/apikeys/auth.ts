import type { StoreCtx } from '../../core/store.ts'
import type { Actor } from '../../core/actions.ts'
import { sha256Hex } from '../../core/crypto.ts'
import { parseApiKey } from '../../core/ids.ts'
import { AppError, unauthorized } from '../../core/http.ts'
import { allowRate } from '../../core/ratelimit.ts'

export class KeyRateError extends AppError {
  constructor(public retryAfter: number) {
    super('rate_limited', 'This key has reached 600 requests per minute.', 429)
  }
}

export async function authenticateKey(ctx: StoreCtx, request: Request, via: 'api' | 'mcp'): Promise<Actor> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')
  const parsed = bearer && parseApiKey(bearer[1])
  if (!parsed || parsed.accountId !== ctx.accountId) throw unauthorized('Send a valid API key.')
  const hash = await sha256Hex(parsed.secret)
  const key = ctx.db.get<{ id: string; access: 'full' | 'read'; created_by: string }>('SELECT id, access, created_by FROM api_keys WHERE hash = ? AND revoked_at IS NULL', hash)
  if (!key) throw unauthorized('Send a valid API key.')
  const now = ctx.now()
  if (!allowRate(ctx.db, `apikey:${key.id}`, 600, 60_000, now)) throw new KeyRateError(Math.ceil((60_000 - now % 60_000) / 1000))
  ctx.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)', now, key.id, now - 60_000)
  const email = ctx.db.get<{ value: string }>("SELECT value FROM account_meta WHERE key = 'owner_email'")?.value ?? ''
  return { userId: key.created_by, email, owner: true, grants: {}, access: key.access, via, keyId: key.id, installAdmin: false }
}
