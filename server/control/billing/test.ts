import { z } from 'zod'
import { AppError } from '../../core/http.ts'
import { planNames } from './plans.ts'
import type { BillingProvider, BillingEvent } from './provider.ts'

const event = z.object({
  id: z.string().min(1),
  type: z.string().default('subscription.updated'),
  accountId: z.string().nullable().default(null),
  customerId: z.string().default('cus_test'),
  subscriptionId: z.string().default('sub_test'),
  status: z.enum(['active', 'past_due', 'canceled', 'paused', 'pending']),
  plan: z.enum(planNames).nullable().default(null),
  periodEnd: z.number().nullable().default(null),
})

/**
 * A billing provider for development and the smoke journey: no network, and `/hooks/test` accepts a
 * plain JSON event. Only available while `MC_TEST_DNS` is on, which production never sets.
 */
export function testBillingProvider(now: () => number): BillingProvider {
  return {
    name: 'test',
    async createCheckout(input) {
      return { url: `${input.returnUrl}?test_checkout=${input.plan}_${input.interval}` }
    },
    async createPortal(input) {
      return { url: `${input.returnUrl}?test_portal=1` }
    },
    async changePlan() {},
    async cancel() {},
    async pause() {},
    async resume() {},
    async verifyAndParseWebhook(request) {
      const body = await request.text()
      if (body.length > 100_000) throw new AppError('too_large', 'Webhook too large.', 413)
      const parsed = z.array(event).or(event.transform((e) => [e])).parse(JSON.parse(body))
      return parsed.map((e): BillingEvent => ({ ...e, provider: 'test', occurredAt: now() }))
    },
  }
}
