import { z } from 'zod'
import type { StoreCtx } from '../core/store.ts'
import { AppError } from '../core/http.ts'
import { fromHex, hmac, sha256Hex, timingSafeEqual, toBytes } from '../core/crypto.ts'
import type { ProviderEvent } from './index.ts'

const scalar = z.union([z.string(), z.number(), z.boolean()])
const eventSchema = z.object({
  event: z.string(), email: z.string(), timestamp: z.coerce.number(), sg_event_id: z.string().optional(), sg_message_id: z.string().optional(), 'smtp-id': z.string().optional(),
  reason: z.string().optional(), response: z.string().optional(), status: z.string().optional(), type: z.string().optional(), test: z.boolean().optional(),
  unique_args: z.record(z.string(), scalar).optional(),
})

/**
 * PostShiba posts a JSON array of SendGrid-format events, signed with HMAC-SHA256 over `{timestamp}.{body}`.
 * A hard `bounce` is permanent; a `blocked` bounce and a `dropped` message (PostShiba's own suppression
 * list included) count as soft bounces, so only repeats retire a contact. `processed` and `unsubscribe`
 * are skipped: MailCorgi's own List-Unsubscribe link already records unsubscribes.
 */
export async function parsePostshibaWebhook(ctx: Pick<StoreCtx, 'now'>, request: Request, settings: Record<string, string>): Promise<{ events: ProviderEvent[] }> {
  const timestamp = request.headers.get('x-capsule-timestamp') || ''
  const signature = (request.headers.get('x-capsule-signature') || '').replace(/^sha256=/, '')
  const secret = settings.postshiba_webhook_secret
  const body = await request.text()
  let verified = false
  if (secret && /^\d+$/.test(timestamp) && /^[0-9a-f]{64}$/.test(signature) && Math.abs(ctx.now() - Number(timestamp) * 1000) <= 300_000) verified = timingSafeEqual(await hmac(toBytes(secret), `${timestamp}.${body}`), fromHex(signature))
  if (!verified) throw new AppError('invalid_webhook', 'Webhook verification failed.', 401)
  let list: unknown
  try { list = JSON.parse(body) } catch { throw new AppError('invalid_webhook', 'Webhook body is not JSON.', 400) }
  if (!Array.isArray(list)) throw new AppError('invalid_webhook', 'Webhook body is not a list of events.', 400)
  if (request.headers.get('x-capsule-test') === '1') return { events: [] }
  const events: ProviderEvent[] = []
  for (const item of list) {
    const parsed = eventSchema.safeParse(item)
    if (!parsed.success || parsed.data.test) continue
    const e = parsed.data
    const type = e.event === 'delivered' ? 'delivered' : e.event === 'bounce' || e.event === 'dropped' ? 'bounce' : e.event === 'spamreport' ? 'complaint' : e.event === 'deferred' ? 'deferred' : null
    if (!type) continue
    const messageId = e['smtp-id'] || e.sg_message_id || ''
    const args = e.unique_args ?? {}
    const hard = e.event === 'bounce' && e.type === 'bounce'
    const detail = `${e.status || ''} ${e.reason || e.response || ''}`
    events.push({
      id: e.sg_event_id || await sha256Hex(`${messageId}\n${e.event}\n${e.timestamp}\n${e.email}`), type,
      accountId: args.mc_account === undefined ? null : String(args.mc_account), deliveryId: args.mc_delivery === undefined ? null : String(args.mc_delivery),
      messageId, recipient: e.email, occurredAt: e.timestamp * 1000,
      ...(type === 'bounce' ? { bounce: { permanent: hard, nonexistent: hard && (/^\s*5\.1\.1\b/.test(detail) || /user unknown|unknown user|no such user|does not exist|mailbox not found/i.test(detail)), reason: e.event === 'dropped' ? `Dropped by PostShiba${e.reason ? `: ${e.reason}` : ''}` : hard ? 'Permanent bounce' : 'Blocked by the receiving server' } } : {}),
    })
  }
  return { events }
}
