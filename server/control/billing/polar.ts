import { z } from 'zod'
import { fromBase64, hmac, timingSafeEqual, toBytes } from '../../core/crypto.ts'
import { planNames, type Interval, type PlanName } from './plans.ts'
import type { BillingProvider, BillingEvent } from './provider.ts'
import { checkTimestamp, providerError, readWebhook, responseJson, signatureError, urlResponse } from './provider.ts'

const subscription = z.object({ id: z.string(), customer_id: z.string(), product_id: z.string(), status: z.string(), current_period_end: z.iso.datetime({ offset: true }), metadata: z.object({ accountId: z.string().optional() }).optional(), customer: z.object({ external_id: z.string().nullable().optional() }).optional() })
const envelope = z.object({ type: z.string(), timestamp: z.iso.datetime({ offset: true }), data: z.unknown() })

export function polarProvider(options: { fetch: typeof fetch; accessToken: string; webhookSecret: string; products: Record<string, string> }): BillingProvider {
  const api = async (path: string, method: string, body?: unknown) => responseJson(await options.fetch(`https://api.polar.sh/v1${path}`, {
    method, headers: { Authorization: `Bearer ${options.accessToken}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }))
  const product = (plan: PlanName, interval: Interval) => {
    const id = options.products[`${plan}_${interval}`]
    if (!id) throw providerError()
    return id
  }
  const update = async (id: string, body: unknown) => { await api(`/subscriptions/${encodeURIComponent(id)}`, 'PATCH', body) }
  return {
    name: 'polar',
    async createCheckout(input) {
      return urlResponse.parse(await api('/checkouts/', 'POST', { products: [product(input.plan, input.interval)], external_customer_id: input.accountId, ...(input.customerId ? { customer_id: input.customerId } : { customer_email: input.email }), metadata: { accountId: input.accountId }, success_url: input.returnUrl, return_url: input.returnUrl }))
    },
    async createPortal({ customerId, returnUrl }) {
      const result = z.object({ customer_portal_url: urlResponse.shape.url }).parse(await api('/customer-sessions/', 'POST', { customer_id: customerId, return_url: returnUrl }))
      return { url: result.customer_portal_url }
    },
    async changePlan(input) { await update(input.subscriptionId, { product_id: product(input.plan, input.interval), proration_behavior: 'invoice' }) },
    async cancel(id) {
      const sub = z.object({ status: z.string() }).parse(await api(`/subscriptions/${encodeURIComponent(id)}`, 'GET'))
      if (!['canceled', 'unpaid'].includes(sub.status)) await update(id, { revoke: true })
    },
    async pause(id) { await update(id, { pause_at_period_end: true }) },
    async resume(id) {
      const sub = z.object({ status: z.string(), pause_at_period_end: z.boolean() }).parse(await api(`/subscriptions/${encodeURIComponent(id)}`, 'GET'))
      if (sub.status === 'paused') await update(id, { resume: true })
      else if (sub.pause_at_period_end) await update(id, { pause_at_period_end: false })
    },
    async verifyAndParseWebhook(request, now) {
      if (!options.webhookSecret) throw signatureError()
      const body = await readWebhook(request)
      const id = request.headers.get('webhook-id') ?? ''
      const timestamp = request.headers.get('webhook-timestamp') ?? ''
      if (!id) throw signatureError()
      checkTimestamp(timestamp, now)
      const keys = [toBytes(options.webhookSecret)]
      try { keys.push(fromBase64(options.webhookSecret.replace(/^whsec_/, ''))) } catch { /* Legacy Polar keys are UTF-8. */ }
      let valid = false
      for (const key of keys) {
        const expected = await hmac(key, `${id}.${timestamp}.${body}`)
        for (const sig of (request.headers.get('webhook-signature') ?? '').split(' ')) {
          if (!sig.startsWith('v1,')) continue
          try { valid ||= timingSafeEqual(fromBase64(sig.slice(3)), expected) } catch { /* A rotated signature can still match. */ }
        }
      }
      if (!valid) throw signatureError()
      const event = envelope.parse(JSON.parse(body))
      if (!event.type.startsWith('subscription.')) return []
      const sub = subscription.parse(event.data)
      const plan = planNames.find((p) => ['monthly', 'yearly'].some((interval) => options.products[`${p}_${interval}`] === sub.product_id)) ?? null
      const status: BillingEvent['status'] = ['canceled', 'unpaid'].includes(sub.status) || event.type === 'subscription.revoked' ? 'canceled' : sub.status === 'past_due' ? 'past_due' : ['active', 'trialing'].includes(sub.status) ? 'active' : sub.status === 'paused' ? 'paused' : 'pending'
      return [{ id, provider: 'polar', type: event.type, occurredAt: Date.parse(event.timestamp), accountId: sub.customer?.external_id ?? sub.metadata?.accountId ?? null, customerId: sub.customer_id, subscriptionId: sub.id, status, plan, periodEnd: Date.parse(sub.current_period_end) }]
    },
  }
}
