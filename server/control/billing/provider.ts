import { z } from 'zod'
import { AppError } from '../../core/http.ts'
import type { Interval, PlanName } from './plans.ts'

export type ProviderName = 'stripe' | 'polar' | 'test'
export type BillingEvent = {
  id: string; provider: ProviderName; type: string; occurredAt: number
  accountId: string | null; customerId: string; subscriptionId: string
  status: 'active' | 'past_due' | 'canceled' | 'paused' | 'pending'
  plan: PlanName | null; periodEnd: number | null
}
export interface BillingProvider {
  name: ProviderName
  createCheckout(input: { accountId: string; email: string; customerId: string | null; plan: PlanName; interval: Interval; returnUrl: string; requestId: string }): Promise<{ url: string }>
  createPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>
  changePlan(input: { subscriptionId: string; plan: PlanName; interval: Interval; requestId: string }): Promise<void>
  cancel(subscriptionId: string, requestId: string): Promise<void>
  pause(subscriptionId: string, requestId: string): Promise<void>
  resume(subscriptionId: string, requestId: string): Promise<void>
  verifyAndParseWebhook(request: Request, now: number): Promise<BillingEvent[]>
}
export const urlResponse = z.object({ url: z.url().refine((url) => new URL(url).protocol === 'https:') })
export const providerError = () => new AppError('billing_provider', 'Billing is unavailable. Try again later or contact the install admin.', 502)
export const signatureError = () => new AppError('bad_signature', 'The webhook signature is invalid or expired.', 400)
export function checkTimestamp(value: string, now: number): void {
  if (!/^\d+$/.test(value) || Math.abs(now - Number(value) * 1000) > 300_000) throw signatureError()
}
export async function readWebhook(request: Request): Promise<string> {
  const body = await request.text()
  if (body.length > 1_000_000) throw new AppError('too_large', 'Webhook too large.', 413)
  return body
}
export async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw providerError()
  return response.status === 204 ? null : response.json()
}
