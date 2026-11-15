import { z } from 'zod'
import type { StoreCtx } from '../core/store.ts'
import { AppError } from '../core/http.ts'
import { fromBase64, hmac, timingSafeEqual } from '../core/crypto.ts'
import type { ProviderEvent } from './index.ts'

const eventSchema = z.object({ type: z.string(), created_at: z.string(), data: z.object({ email_id: z.string(), to: z.array(z.string()), tags: z.union([z.record(z.string(), z.string()), z.array(z.object({ name: z.string(), value: z.string() }))]).optional(), bounce: z.object({ type: z.string().optional(), subType: z.string().optional(), message: z.string().optional() }).optional() }) })

export async function parseResendWebhook(ctx: Pick<StoreCtx, 'now'>, request: Request, settings: Record<string, string>): Promise<{ events: ProviderEvent[] }> {
  const rejected = () => new AppError('invalid_webhook', 'Webhook verification failed.', 400)
  try {
    const id = request.headers.get('svix-id') || ''
    const timestamp = request.headers.get('svix-timestamp') || ''
    const signatures = request.headers.get('svix-signature') || ''
    if (!id || !/^\d+$/.test(timestamp) || Math.abs(ctx.now() - Number(timestamp) * 1000) > 300_000 || !settings.resend_webhook_secret) throw rejected()
    const body = await request.text()
    const secret = settings.resend_webhook_secret.replace(/^whsec_/, '')
    const expected = await hmac(fromBase64(secret), `${id}.${timestamp}.${body}`)
    const verified = signatures.split(' ').some((sig) => {
      const [version, value] = sig.split(',')
      if (version !== 'v1' || !value) return false
      try { return timingSafeEqual(expected, fromBase64(value)) } catch { return false }
    })
    if (!verified) throw rejected()
    const event = eventSchema.parse(JSON.parse(body))
    const type = event.type === 'email.delivered' ? 'delivered' : event.type === 'email.bounced' ? 'bounce' : event.type === 'email.complained' ? 'complaint' : event.type === 'email.delivery_delayed' ? 'deferred' : null
    if (!type) return { events: [] }
    const tags = Array.isArray(event.data.tags) ? Object.fromEntries(event.data.tags.map((tag) => [tag.name, tag.value])) : event.data.tags ?? {}
    const occurredAt = Date.parse(event.created_at)
    if (!Number.isFinite(occurredAt)) throw rejected()
    return { events: event.data.to.map((recipient): ProviderEvent => ({ id: `${id}:${recipient}`, type, accountId: tags.mc_account ?? null, deliveryId: tags.mc_delivery ?? null, messageId: event.data.email_id, recipient, occurredAt, ...(type === 'bounce' ? { bounce: { permanent: event.data.bounce?.type !== 'Transient', nonexistent: event.data.bounce?.subType === 'NoEmail', reason: 'Provider reported a bounce' } } : {}) })) }
  } catch { throw rejected() }
}
