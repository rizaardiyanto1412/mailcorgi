import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { ControlRegistrar } from '../rpc.ts'
import { getSetting, appUrl } from '../install/index.ts'
import { ownedAccount, pushPolicy, type AccountRow } from '../accounts/index.ts'
import { plans, planNames, planLimits } from './plans.ts'
import type { BillingProvider, ProviderName, BillingEvent } from './provider.ts'
import { stripeProvider } from './stripe.ts'
import { polarProvider } from './polar.ts'
import { testBillingProvider } from './test.ts'
export { plans, planLimits, unlimited } from './plans.ts'
export type { BillingProvider, BillingEvent } from './provider.ts'

/** Live counts from the account store. The hourly snapshot, with its age, is the fallback when the store cannot answer. */
async function liveUsage(ctx: StoreCtx, accountId: string): Promise<{ contacts: number; emailsSent: number; live: boolean; updatedAt: number | null }> {
  try {
    return { ...(await ctx.stores.account(accountId).liveUsage({})), live: true, updatedAt: ctx.now() }
  } catch {
    const snapshot = ctx.db.get<{ contacts: number; emails_sent: number; updated_at: number }>('SELECT contacts, emails_sent, updated_at FROM usage_snapshots WHERE account_id = ? AND period = ?', accountId, period(ctx.now()))
    return { contacts: snapshot?.contacts ?? 0, emailsSent: snapshot?.emails_sent ?? 0, live: false, updatedAt: snapshot?.updated_at ?? null }
  }
}

export const GRACE_MS = 7 * 86_400_000
export const BLOCK_CANCEL_MS = 30 * 86_400_000
const period = (now: number) => new Date(now).toISOString().slice(0, 7)
const accountId = z.string().min(1).describe('The account you own.')
const choice = { plan: z.enum(planNames).exclude(['free']).describe('The paid plan to choose.'), interval: z.enum(['monthly', 'yearly']).describe('Monthly or yearly billing.') }
export function requireCloud(ctx: StoreCtx) {
  if (!ctx.config.cloud) throw new AppError('not_found', 'Billing is unavailable on self-hosted installs.', 404)
}
export async function getBillingProvider(ctx: StoreCtx, name = ctx.config.billingProvider): Promise<BillingProvider> {
  requireCloud(ctx)
  if (name === 'stripe') return stripeProvider({ fetch: ctx.platform.fetch, secretKey: await getSetting(ctx, 'stripe_secret_key'), webhookSecret: await getSetting(ctx, 'stripe_webhook_secret') })
  if (name === 'polar') return polarProvider({ fetch: ctx.platform.fetch, accessToken: await getSetting(ctx, 'polar_access_token'), webhookSecret: await getSetting(ctx, 'polar_webhook_secret'), products: z.record(z.string(), z.string()).parse(JSON.parse(await getSetting(ctx, 'polar_products') || '{}')) })
  if (name === 'test' && ctx.config.testDns) return testBillingProvider(ctx.now)
  throw new AppError('billing_unconfigured', 'The install admin has not configured billing.', 503)
}
export function queueBillingSync(ctx: StoreCtx, id: string) {
  if (ctx.config.cloud) ctx.jobs.enqueue('billing.sync', { accountId: id }, { dedupeKey: `billing.sync:${id}` })
}
function applyEvent(ctx: StoreCtx, event: BillingEvent): boolean {
  return ctx.db.tx(() => {
    const inserted = ctx.db.run('INSERT OR IGNORE INTO billing_events (id, provider, type, received_at) VALUES (?, ?, ?, ?)', `${event.provider}:${event.id}`, event.provider, event.type, ctx.now()).changes
    if (!inserted) return false
    const account = event.accountId
      ? ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL', event.accountId)
      : ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE billing_provider = ? AND billing_subscription_id = ? AND deleted_at IS NULL', event.provider, event.subscriptionId)
    if (account && account.status !== 'deleting' && event.occurredAt >= account.billing_event_at && (!account.billing_subscription_id || account.billing_subscription_id === event.subscriptionId)) {
      const active = event.status === 'active'
      if (active && !event.plan) throw new AppError('unknown_price', 'The subscription price has no configured plan.', 400)
      const grace = event.status === 'past_due' || event.status === 'canceled'
        ? account.billing_grace_until ?? Math.max(ctx.now(), event.status === 'canceled' ? event.periodEnd ?? 0 : 0) + GRACE_MS : null
      ctx.db.run('UPDATE accounts SET billing_provider = ?, billing_customer_id = ?, billing_subscription_id = ?, billing_status = ?, plan_period_end = ?, billing_event_at = ?, billing_grace_until = ? WHERE id = ?', event.provider, event.customerId, event.subscriptionId, event.status, event.periodEnd, event.occurredAt, grace, account.id)
      if (active && event.plan && event.plan !== account.plan) pushPolicy(ctx, account.id, { plan: event.plan })
      if (grace) ctx.jobs.enqueue('billing.expire', { accountId: account.id }, { runAt: grace, dedupeKey: `billing.expire:${account.id}` })
      if (account.status === 'blocked') queueBillingSync(ctx, account.id)
    }
    ctx.db.run('UPDATE billing_events SET processed_at = ? WHERE id = ?', ctx.now(), `${event.provider}:${event.id}`)
    return true
  })
}

declare module '../rpc.ts' {
  interface ControlRpc {
    pushUsage(args: { accountId: string; period: string; contacts: number; emailsSent: number }): Promise<void>
  }
}
const snapshot = z.object({ accountId: z.string(), period: z.string().regex(/^\d{4}-\d{2}$/), contacts: z.number().int().nonnegative(), emailsSent: z.number().int().nonnegative() })

export const billingModule = {
  name: 'billing',
  register(reg: ControlRegistrar) {
    reg.rpc('pushUsage', (ctx, raw) => {
      const input = snapshot.parse(raw)
      if (!ctx.db.get('SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL AND status != ?', input.accountId, 'deleting')) return
      ctx.db.run('INSERT INTO usage_snapshots (account_id, period, contacts, emails_sent, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, period) DO UPDATE SET contacts = excluded.contacts, emails_sent = MAX(emails_sent, excluded.emails_sent), updated_at = excluded.updated_at', input.accountId, input.period, input.contacts, input.emailsSent, ctx.now())
    })
    reg.routes((app) => {
      for (const name of ['stripe', 'polar', 'test'] satisfies ProviderName[]) app.post(`/hooks/${name}`, async (c) => {
        const ctx = c.get('ctx')
        requireCloud(ctx)
        if (name === 'test' && !ctx.config.testDns) throw new AppError('not_found', 'Not found.', 404)
        const provider = await getBillingProvider(ctx, name)
        let events: BillingEvent[]
        try { events = await provider.verifyAndParseWebhook(c.req.raw, ctx.now()) } catch (err) {
          if (err instanceof z.ZodError || err instanceof SyntaxError) throw new AppError('invalid_webhook', 'The webhook payload is invalid.', 400)
          throw err
        }
        let applied = 0
        for (const event of events) if (applyEvent(ctx, event)) applied++
        return c.json({ received: true, applied })
      })
    })
    reg.job<{ accountId: string }>('billing.expire', async (ctx, { accountId }) => {
      const account = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', accountId)
      if (!account?.billing_grace_until || account.status === 'deleting') return 'done'
      if (account.billing_grace_until > ctx.now()) return { again: account.billing_grace_until }
      ctx.db.tx(() => {
        if (account.plan !== 'free') pushPolicy(ctx, accountId, { plan: 'free' })
        ctx.db.run('UPDATE accounts SET billing_grace_until = NULL WHERE id = ?', accountId)
        if (account.billing_status === 'canceled') ctx.db.run('UPDATE accounts SET billing_subscription_id = NULL WHERE id = ?', accountId)
      })
      return 'done'
    })
    reg.job<{ accountId: string }>('billing.sync', async (ctx, { accountId }, budget, job) => {
      const account = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', accountId)
      if (!ctx.config.cloud || !account?.billing_subscription_id || !account.billing_provider) return 'done'
      if (budget.take(3) < 3) return { again: ctx.now() + 1000 }
      const provider = await getBillingProvider(ctx, account.billing_provider)
      const canceled = account.status === 'deleting' || (account.status === 'blocked' && account.blocked_at !== null && ctx.now() >= account.blocked_at + BLOCK_CANCEL_MS)
      if (canceled) await provider.cancel(account.billing_subscription_id, job.id)
      else if (account.status === 'blocked' && !account.billing_paused) await provider.pause(account.billing_subscription_id, job.id)
      else if (account.status === 'active' && account.billing_paused) await provider.resume(account.billing_subscription_id, job.id)
      const latest = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', accountId)
      ctx.db.run('UPDATE accounts SET billing_paused = ? WHERE id = ?', canceled ? 0 : account.status === 'blocked' ? 1 : 0, accountId)
      if (canceled) ctx.db.run('UPDATE accounts SET billing_subscription_id = NULL, billing_status = ? WHERE id = ?', 'canceled', accountId)
      if (latest && latest.status !== account.status) return { again: ctx.now() }
      return 'done'
    })
    return reg.actions(
      defineAction({ name: 'billing.get', description: 'Read your current plan, prices and usage. Usage is counted live from the account; when the account cannot answer, the last hourly snapshot is returned with its time.', scope: 'control', role: 'user', effect: 'read', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId }), handler: async (ctx, input, actor) => {
        requireCloud(ctx)
        const account = ownedAccount(ctx, input.accountId, actor.userId)
        const usage = await liveUsage(ctx, account.id)
        return { plan: account.plan, status: account.billing_status, periodEnd: account.plan_period_end, graceUntil: account.billing_grace_until, hasSubscription: !!account.billing_subscription_id, hasCustomer: !!account.billing_customer_id, provider: account.billing_provider || ctx.config.billingProvider, limits: planLimits(account.plan), plans: Object.values(plans), usage }
      } }),
      defineAction({ name: 'billing.checkout', description: 'Open checkout for a paid plan.', scope: 'control', role: 'user', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId, ...choice }), handler: async (ctx, input, actor) => {
        requireCloud(ctx)
        const account = ownedAccount(ctx, input.accountId, actor.userId)
        if (account.status !== 'active') throw new AppError('account_blocked', 'This account cannot change plans.', 403)
        if (account.billing_subscription_id) throw new AppError('subscription_exists', 'Change your existing plan instead.', 409)
        const provider = await getBillingProvider(ctx)
        return provider.createCheckout({ ...input, customerId: account.billing_provider === provider.name ? account.billing_customer_id : null, email: actor.email, returnUrl: `${appUrl(ctx)}/settings/billing`, requestId: `checkout:${account.id}:${account.policy_version}:${input.plan}:${input.interval}` })
      } }),
      defineAction({ name: 'billing.portal', description: 'Open the billing portal to manage payments and invoices.', scope: 'control', role: 'user', effect: 'read', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId }), handler: async (ctx, input, actor) => {
        requireCloud(ctx)
        const a = ownedAccount(ctx, input.accountId, actor.userId)
        if (!a.billing_customer_id || !a.billing_provider) throw new AppError('no_customer', 'Choose a paid plan first.', 409)
        return (await getBillingProvider(ctx, a.billing_provider)).createPortal({ customerId: a.billing_customer_id, returnUrl: `${appUrl(ctx)}/settings/billing` })
      } }),
      defineAction({ name: 'billing.changePlan', description: 'Change your subscription plan. Limits change after payment is confirmed.', scope: 'control', role: 'user', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId, ...choice }), handler: async (ctx, input, actor) => {
        requireCloud(ctx)
        const a = ownedAccount(ctx, input.accountId, actor.userId)
        if (!a.billing_subscription_id || !a.billing_provider || a.status !== 'active') throw new AppError('no_subscription', 'No active subscription to change.', 409)
        await (await getBillingProvider(ctx, a.billing_provider)).changePlan({ ...input, subscriptionId: a.billing_subscription_id, requestId: `plan:${a.id}:${a.policy_version}:${input.plan}:${input.interval}` })
        return { pending: true }
      } }),
      defineAction({ name: 'billing.cancel', description: 'Cancel your subscription. Free limits apply after the grace period.', scope: 'control', role: 'user', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId }), handler: async (ctx, input, actor) => {
        requireCloud(ctx)
        const a = ownedAccount(ctx, input.accountId, actor.userId)
        if (!a.billing_subscription_id || !a.billing_provider) return { pending: false }
        await (await getBillingProvider(ctx, a.billing_provider)).cancel(a.billing_subscription_id, `cancel:${a.id}:${a.billing_subscription_id}`)
        return { pending: true }
      } }),
    )
  },
}
