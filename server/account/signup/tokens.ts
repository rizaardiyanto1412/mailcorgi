import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { encodeJsonUrl, decodeJsonUrl, hmac, toBase64Url, fromBase64Url, timingSafeEqual } from '../../core/crypto.ts'

export async function token(ctx: StoreCtx, purpose: 'cf' | 'u' | 'p' | 'form', payload: unknown) {
  const body = `${purpose}.${encodeJsonUrl(payload)}`
  const sig = await hmac(await ctx.keys.tokenKey(ctx.accountId!), body)
  return `${ctx.accountId}.${body}.${toBase64Url(sig.slice(0, 16))}`
}
export async function readToken(ctx: StoreCtx, purpose: 'cf' | 'form', value: string) {
  const [account, kind, payload, signature, extra] = value.split('.')
  if (account !== ctx.accountId || kind !== purpose || !payload || !signature || extra) return null
  try {
    const expected = (await hmac(await ctx.keys.tokenKey(account), `${kind}.${payload}`)).slice(0, 16)
    if (!timingSafeEqual(expected, fromBase64Url(signature))) return null
    return decodeJsonUrl<unknown>(payload)
  } catch { return null }
}
export const confirmationSchema = z.object({ contactId: z.string(), issuedAt: z.number().int() })
export const formTokenSchema = z.object({ newsletterId: z.string(), issuedAt: z.number().int() })
