import type { StoreCtx } from '../../core/store.ts'
import { fromBase64Url, hmac, timingSafeEqual, toBase64Url } from '../../core/crypto.ts'

/** Public token purposes per architecture 11.3. A token for one purpose never passes for another. */
export type TokenPurpose = 'o' | 'c' | 'u' | 'p' | 'cf' | 'k' | 'w' | 'form'
const PURPOSES = new Set<string>(['o', 'c', 'u', 'p', 'cf', 'k', 'w', 'form'])
const enc = new TextEncoder()
const dec = new TextDecoder()

async function signature(ctx: StoreCtx, purpose: string, payload: string): Promise<Uint8Array> {
  const key = await ctx.keys.tokenKey(ctx.accountId!)
  return (await hmac(key, `${purpose}.${payload}`)).slice(0, 16)
}

/** `<accountId>.<purpose>.<payload>.<sig>`: payload and sig are base64url. */
export async function signToken(ctx: StoreCtx, purpose: TokenPurpose, parts: (string | number)[]): Promise<string> {
  const payload = toBase64Url(enc.encode(parts.join('.')))
  return `${ctx.accountId}.${purpose}.${payload}.${toBase64Url(await signature(ctx, purpose, payload))}`
}

/** The payload parts of a valid token for `purpose`, or null for a wrong account, purpose, format or signature. */
export async function verifyToken(ctx: StoreCtx, token: string, purpose: TokenPurpose): Promise<string[] | null> {
  const [accountId, given, payload, sig, ...rest] = token.split('.')
  if (rest.length || accountId !== ctx.accountId || given !== purpose || !PURPOSES.has(given) || !payload || !sig) return null
  let expected: Uint8Array
  let provided: Uint8Array
  try {
    provided = fromBase64Url(sig)
    expected = await signature(ctx, purpose, payload)
  } catch { return null }
  if (!timingSafeEqual(provided, expected)) return null
  try {
    return dec.decode(fromBase64Url(payload)).split('.')
  } catch { return null }
}

/** Absolute URLs for the links an email carries. */
export const publicUrl = (ctx: StoreCtx, path: string) => `${ctx.config.appUrl}${path}`
