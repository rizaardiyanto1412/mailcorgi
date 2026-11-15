import { z } from 'zod'

export const confirmationSchema = z.tuple([z.string(), z.coerce.number().int()]).transform(([contactId, issuedAt]) => ({ contactId, issuedAt }))
export const formTokenSchema = z.tuple([z.string(), z.coerce.number().int()]).transform(([newsletterId, issuedAt]) => ({ newsletterId, issuedAt }))
