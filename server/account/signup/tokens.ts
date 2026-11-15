import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { signToken } from '../tracking/index.ts'

export const confirmationSchema = z.tuple([z.string(), z.coerce.number().int()]).transform(([contactId, issuedAt]) => ({ contactId, issuedAt }))
export const formTokenSchema = z.tuple([z.string(), z.coerce.number().int()]).transform(([newsletterId, issuedAt]) => ({ newsletterId, issuedAt }))

export function formToken(ctx: StoreCtx, newsletterId: string) {
  return signToken(ctx, 'form', [newsletterId, ctx.now()])
}
