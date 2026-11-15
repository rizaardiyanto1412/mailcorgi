import { z } from 'zod'
import { defineAction, type Actor } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import type { StoreCtx } from '../../core/store.ts'
import { readOutbox } from '../../email/test.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { ingestProviderEvents } from '../tracking/index.ts'

/** Dev endpoints exist only when `MC_TEST_DNS` is on (never in production) and only for an install admin. */
export function assertDevMode(ctx: StoreCtx, actor: Actor) {
  if (!ctx.config.testDns || !actor.installAdmin) throw new AppError('not_found', 'Not found.', 404)
}

const outboxInput = z.object({
  to: z.string().trim().toLowerCase().optional().describe('Only emails sent to this address'),
  limit: z.number().int().min(1).max(200).default(50).describe('Newest emails to return'),
})

export const readOutboxPage = (ctx: StoreCtx, input: z.output<typeof outboxInput>) => ({
  emails: readOutbox(ctx, input.to).slice(-input.limit).map((row) => ({ id: row.id, to: row.to_email, subject: row.subject, html: row.html, text: row.text, headers: JSON.parse(row.headers) as Record<string, string>, kind: row.kind, createdAt: row.created_at })),
})

const eventSchema = z.object({
  id: z.string().min(1).describe('A unique event id'),
  type: z.enum(['delivered', 'bounce', 'complaint', 'deferred']).describe('The provider event type'),
  bounce: z.object({ permanent: z.boolean(), nonexistent: z.boolean(), reason: z.string() }).optional().describe('Bounce details'),
  deliveryId: z.string().nullable().default(null).describe('The delivery id the event is about'),
  messageId: z.string().default('').describe('The provider message id'),
  recipient: z.string().describe('The recipient address'),
  occurredAt: z.number().int().optional().describe('When the event happened, in ms'),
})

export const devModule = {
  name: 'dev',
  register(reg: AccountRegistrar) {
    return reg.actions(
      defineAction({ name: 'dev.outbox', description: 'Read emails the test provider wrote for this account. Dev mode only.', scope: 'account', role: 'owner', effect: 'read', input: outboxInput, handler: (ctx, input, actor) => { assertDevMode(ctx, actor); return readOutboxPage(ctx, input) } }),
      defineAction({ name: 'dev.ingest', description: 'Feed synthetic provider events (bounces, complaints, deliveries) to this account. Dev mode only.', scope: 'account', role: 'owner', effect: 'write', input: z.object({ events: z.array(eventSchema).min(1).max(100).describe('Events to apply') }), handler: (ctx, input, actor) => {
        assertDevMode(ctx, actor)
        return ingestProviderEvents(ctx, input.events.map((e) => ({ ...e, accountId: ctx.accountId, occurredAt: e.occurredAt ?? ctx.now() })))
      } }),
    )
  },
}
