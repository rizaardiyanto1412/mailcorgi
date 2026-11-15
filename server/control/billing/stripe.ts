import { z } from 'zod'
import { fromHex, hmac, timingSafeEqual, toBytes } from '../../core/crypto.ts'
import { isPlan, plans, planNames } from './plans.ts'
import type { BillingProvider, BillingEvent } from './provider.ts'
import { checkTimestamp, providerError, readWebhook, responseJson, signatureError, urlResponse } from './provider.ts'

const ref = z.union([z.string(), z.object({ id: z.string() })]).nullable().optional().transform((v) => typeof v === 'string' ? v : v?.id ?? '')
const item = z.object({ id: z.string(), current_period_end: z.number().optional(), price: z.object({ id: z.string(), lookup_key: z.string().nullable().optional() }) })
const subscription = z.object({ id: z.string(), customer: ref, status: z.string(), metadata: z.object({ accountId: z.string().optional() }).optional(), current_period_end: z.number().optional(), items: z.object({ data: z.array(item) }) })
const envelope = z.object({ id: z.string(), type: z.string(), created: z.number(), data: z.object({ object: z.unknown() }) })

export function stripeProvider(options: { fetch: typeof fetch; secretKey: string; webhookSecret: string }): BillingProvider {
  const api = async (path: string, method = 'GET', body?: Record<string, string>, requestId?: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.secretKey}`, 'Stripe-Version': '2026-09-30.endive' }
    if (requestId) headers['Idempotency-Key'] = requestId
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    return responseJson(await options.fetch(`https://api.stripe.com/v1${path}`, { method, headers, body: body ? new URLSearchParams(body) : undefined }))
  }
  const price = async (p: keyof typeof plans, interval: 'monthly' | 'yearly') => {
    const result = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await api(`/prices?active=true&lookup_keys[]=${encodeURIComponent(plans[p].lookupKeys[interval])}&limit=2`))
    if (result.data.length !== 1 || !result.data[0]) throw providerError()
    return result.data[0].id
  }
  return {
    name: 'stripe',
    async createCheckout(input) {
      const priceId = await price(input.plan, input.interval)
      return urlResponse.parse(await api('/checkout/sessions', 'POST', {
        mode: 'subscription', 'line_items[0][price]': priceId, 'line_items[0][quantity]': '1',
        client_reference_id: input.accountId, 'metadata[accountId]': input.accountId, 'subscription_data[metadata][accountId]': input.accountId,
        ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
        success_url: input.returnUrl, cancel_url: input.returnUrl,
      }, input.requestId))
    },
    async createPortal({ customerId, returnUrl }) { return urlResponse.parse(await api('/billing_portal/sessions', 'POST', { customer: customerId, return_url: returnUrl })) },
    async changePlan(input) {
      const sub = subscription.parse(await api(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`))
      const first = sub.items.data[0]
      if (!first || sub.items.data.length !== 1) throw providerError()
      await api(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`, 'POST', { 'items[0][id]': first.id, 'items[0][price]': await price(input.plan, input.interval), proration_behavior: 'always_invoice', payment_behavior: 'pending_if_incomplete' }, input.requestId)
    },
    async cancel(id, key) {
      const sub = subscription.parse(await api(`/subscriptions/${encodeURIComponent(id)}`))
      if (sub.status !== 'canceled') await api(`/subscriptions/${encodeURIComponent(id)}`, 'DELETE', undefined, key)
    },
    async pause(id, key) { await api(`/subscriptions/${encodeURIComponent(id)}`, 'POST', { 'pause_collection[behavior]': 'void' }, key) },
    async resume(id, key) { await api(`/subscriptions/${encodeURIComponent(id)}`, 'POST', { pause_collection: '' }, key) },
    async verifyAndParseWebhook(request, now) {
      if (!options.webhookSecret) throw signatureError()
      const body = await readWebhook(request)
      const parts = (request.headers.get('stripe-signature') ?? '').split(',').map((part) => part.trim().split('='))
      const timestamp = parts.find(([k]) => k === 't')?.[1] ?? ''
      checkTimestamp(timestamp, now)
      const expected = await hmac(toBytes(options.webhookSecret), `${timestamp}.${body}`)
      if (!parts.some(([k, value]) => k === 'v1' && /^[a-f0-9]{64}$/i.test(value ?? '') && timingSafeEqual(fromHex(value), expected))) throw signatureError()
      const event = envelope.parse(JSON.parse(body))
      if (!event.type.startsWith('customer.subscription.') && event.type !== 'invoice.payment_failed') return []
      let sub: z.infer<typeof subscription>
      if (event.type === 'invoice.payment_failed') {
        const invoice = z.object({ subscription: ref, parent: z.object({ subscription_details: z.object({ subscription: ref }).nullable().optional() }).nullable().optional() }).parse(event.data.object)
        const id = invoice.subscription || invoice.parent?.subscription_details?.subscription
        if (!id) return []
        sub = subscription.parse(await api(`/subscriptions/${encodeURIComponent(id)}`))
      } else sub = subscription.parse(event.data.object)
      const lookup = sub.items.data[0]?.price.lookup_key
      const plan = planNames.find((p) => Object.values(plans[p].lookupKeys).some((k) => k === lookup)) ?? null
      const status: BillingEvent['status'] = event.type.endsWith('.deleted') || ['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status) ? 'canceled' : event.type === 'invoice.payment_failed' || sub.status === 'past_due' ? 'past_due' : ['active', 'trialing'].includes(sub.status) ? 'active' : sub.status === 'paused' ? 'paused' : 'pending'
      return [{ id: event.id, provider: 'stripe', type: event.type, occurredAt: event.created * 1000, accountId: sub.metadata?.accountId ?? null, customerId: sub.customer, subscriptionId: sub.id, status, plan: plan && isPlan(plan) ? plan : null, periodEnd: (sub.items.data[0]?.current_period_end ?? sub.current_period_end ?? 0) * 1000 || null }]
    },
  }
}
