import { notify, notifyLimitNear } from '../notifications/index.ts'
import { observeProtectionPolicy } from '../hygiene/index.ts'
import type { StoreCtx } from '../../core/store.ts'
import { parseJson } from '../../core/db.ts'
import { z } from 'zod'
import { AppError } from '../../core/http.ts'
import { retryDead } from '../../core/jobs.ts'
import { toHex } from '../../core/crypto.ts'
import type { AccountRegistrar, Limits, Policy } from '../rpc.ts'

export const getMeta = (ctx: StoreCtx, key: string): string | null => ctx.db.get<{ value: string }>('SELECT value FROM account_meta WHERE key = ?', key)?.value ?? null
export const setMeta = (ctx: StoreCtx, key: string, value: string) => ctx.db.run('INSERT INTO account_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)

const DEFAULT_POLICY: Policy = { version: 0, status: 'active', plan: 'selfhosted', limits: { maxContacts: null, maxEmailsPerMonth: null, maxNewsletters: null, maxTeamPerNewsletter: null } }

export const getPolicy = (ctx: StoreCtx): Policy => parseJson<Policy>(getMeta(ctx, 'policy'), DEFAULT_POLICY)

/** Writes a newer policy. An older or equal version is ignored, so pushes may repeat or cross. */
export function applyPolicy(ctx: StoreCtx, policy: Policy): boolean {
  return ctx.db.tx(() => {
    if (policy.version <= getPolicy(ctx).version) return false
    if (policy.status === 'blocked' && getPolicy(ctx).status !== 'blocked') notify(ctx, { kind: 'account_blocked', title: 'Your account is blocked', body: 'Sending is paused. Contact the install administrator.', href: '/settings/account' })
    setMeta(ctx, 'policy', JSON.stringify(policy))
    observeProtectionPolicy(ctx, policy)
    return true
  })
}

export const currentPeriod = (now: number) => new Date(now).toISOString().slice(0, 7)

/** Plan limits for this account. Infinity when there is none. */
export function limits(ctx: StoreCtx): { maxContacts: number; maxEmailsPerMonth: number; maxNewsletters: number; maxTeamPerNewsletter: number } {
  const l: Limits = ctx.config.cloud ? getPolicy(ctx).limits : DEFAULT_POLICY.limits
  return {
    maxContacts: l.maxContacts ?? Infinity,
    maxEmailsPerMonth: l.maxEmailsPerMonth ?? Infinity,
    maxNewsletters: l.maxNewsletters ?? Infinity,
    maxTeamPerNewsletter: l.maxTeamPerNewsletter ?? Infinity,
  }
}

const countActiveContacts = (ctx: StoreCtx) => ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE status IN ('subscribed', 'unconfirmed')")!.n

/** Contacts that use a plan slot, from the counter the contacts triggers maintain. */
export function activeContacts(ctx: StoreCtx): number {
  const value = getMeta(ctx, 'active_contacts')
  if (value !== null) return Number(value)
  return repairActiveContacts(ctx)
}

/** Recount from the table and reset the counter. The hourly usage job runs it to undo any drift. */
export function repairActiveContacts(ctx: StoreCtx): number {
  const count = countActiveContacts(ctx)
  setMeta(ctx, 'active_contacts', String(count))
  return count
}

/** The error for a contact that does not fit the plan, with the live count from the maintained counter. */
export function contactLimitError(ctx: StoreCtx): AppError {
  const used = activeContacts(ctx)
  const limit = limits(ctx).maxContacts
  return new AppError('limit_reached', `This account has reached its contact limit: ${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} contacts used. Remove inactive contacts or change your plan.`, 403, { resource: 'contacts', used, limit })
}

/** Whether `n` more contacts fit the plan. Call inside the caller's transaction. */
export function reserveContacts(ctx: StoreCtx, n: number): boolean {
  const max = limits(ctx).maxContacts
  if (max === Infinity) return true
  const count = activeContacts(ctx)
  if (count + n >= max * 0.9) notifyLimitNear(ctx, 'contacts')
  return count + n <= max
}

export function countEmails(ctx: StoreCtx, n: number): void {
  ctx.db.run('INSERT INTO usage (period, emails_sent, contacts_peak) VALUES (?, ?, 0) ON CONFLICT(period) DO UPDATE SET emails_sent = emails_sent + excluded.emails_sent', currentPeriod(ctx.now()), n)
  if ((ctx.db.get<{ n: number }>('SELECT emails_sent n FROM usage WHERE period = ?', currentPeriod(ctx.now()))?.n ?? 0) >= limits(ctx).maxEmailsPerMonth * 0.9) notifyLimitNear(ctx, 'emails')
}

export const usageModule = {
  name: 'usage',
  register(reg: AccountRegistrar) {
    reg.rpc('selfWipe', async (ctx) => {
      ctx.db.tx(() => {
        const current = getPolicy(ctx)
        setMeta(ctx, 'policy', JSON.stringify({ ...current, status: 'deleting' }))
        ctx.db.run('DELETE FROM jobs')
      })
      const prefix = `${ctx.accountId}/`
      const keys = await ctx.platform.blobs.list(prefix)
      for (const key of keys.slice(0, 20)) await ctx.platform.blobs.delete(key)
      if (keys.length > 20) return { done: false }
      const tables = ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_migrations', 'account_meta') ORDER BY rowid DESC")
      ctx.db.tx(() => {
        ctx.db.exec('PRAGMA defer_foreign_keys = ON')
        for (const { name } of tables) ctx.db.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`)
        ctx.db.run("DELETE FROM account_meta WHERE key != 'policy'")
      })
      return { done: true }
    })
    reg.rpc('updateOwnerEmail', (ctx, { email }) => {
      if (getPolicy(ctx).status !== 'deleting') setMeta(ctx, 'owner_email', email)
    })
    reg.rpc('adminDeadJobs', (ctx, { operation, id }) => {
      if (operation === 'retry' && id) retryDead(ctx.db, id, ctx.now())
      if (operation === 'discard' && id) ctx.db.run('DELETE FROM jobs_dead WHERE id = ?', id)
      return ctx.db.all<{ id: string; kind: string; attempts: number; last_error: string; died_at: number }>('SELECT id, kind, attempts, last_error, died_at FROM jobs_dead ORDER BY died_at DESC LIMIT 100')
    })
    reg.job('usage.push', async (ctx, _input, budget) => {
      if (getPolicy(ctx).status === 'deleting') return 'done'
      if (budget.take(1) < 1) return { again: ctx.now() + 1000 }
      const period = currentPeriod(ctx.now())
      const contacts = repairActiveContacts(ctx)
      // One count an hour records the month's peak; counting on every subscribe made imports quadratic.
      ctx.db.run('INSERT INTO usage (period, emails_sent, contacts_peak) VALUES (?, 0, ?) ON CONFLICT(period) DO UPDATE SET contacts_peak = MAX(contacts_peak, excluded.contacts_peak)', period, contacts)
      const emailsSent = ctx.db.get<{ n: number }>('SELECT emails_sent AS n FROM usage WHERE period = ?', period)?.n ?? 0
      if (emailsSent >= limits(ctx).maxEmailsPerMonth * 0.9) notifyLimitNear(ctx, 'emails')
      await ctx.stores.control.pushUsage({ accountId: ctx.accountId!, period, contacts, emailsSent })
      return { again: ctx.now() + 60 * 60_000 }
    })
    reg.rpc('bootstrap', async (ctx, { accountId, ownerUserId, ownerEmail, policy }) => {
      if (getPolicy(ctx).status === 'deleting') throw new AppError('account_deleted', 'This account has been deleted.', 410)
      const tokenKey = toHex(await ctx.keys.tokenKey(accountId))
      ctx.db.tx(() => {
        ctx.db.run('INSERT OR IGNORE INTO account_meta (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?)', 'account_id', accountId, 'owner_user_id', ownerUserId, 'owner_email', ownerEmail, 'token_key', tokenKey)
        applyPolicy(ctx, policy)
        ctx.jobs.enqueue('usage.push', {}, { dedupeKey: 'usage.push' })
        ctx.jobs.enqueue('stats.rollup', {}, { dedupeKey: 'stats.rollup' })
      })
    })
    reg.rpc('applyPolicy', (ctx, policy) => ({ applied: applyPolicy(ctx, policySchema.parse(policy)) }))
    // Any call re-arms the alarm on the way out, which is all the daily wake-up needs.
    reg.rpc('ping', () => ({ ok: true as const }))
    reg.rpc('liveUsage', (ctx) => ({
      contacts: activeContacts(ctx),
      emailsSent: ctx.db.get<{ n: number }>('SELECT emails_sent AS n FROM usage WHERE period = ?', currentPeriod(ctx.now()))?.n ?? 0,
    }))
    reg.rpc('summary', (ctx) => ({
      newsletters: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM newsletters WHERE archived_at IS NULL')!.n,
      contacts: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE status = 'subscribed'")!.n,
    }))
  },
}

const limit = z.number().int().nonnegative().nullable()
const policySchema = z.object({ version: z.number().int().nonnegative(), status: z.enum(['active', 'blocked', 'deleting']), plan: z.string(), limits: z.object({ maxContacts: limit, maxEmailsPerMonth: limit, maxNewsletters: limit, maxTeamPerNewsletter: limit }) })
declare module '../rpc.ts' {
  interface AccountRpc {
    selfWipe(args: Record<string, never>): Promise<{ done: boolean }>
    /** Plan-slot contacts (subscribed and unconfirmed) and this month's emails, read now. */
    liveUsage(args: Record<string, never>): Promise<{ contacts: number; emailsSent: number }>
    updateOwnerEmail(args: { email: string }): Promise<void>
    adminDeadJobs(args: { operation: 'list' | 'retry' | 'discard'; id?: string }): Promise<{ id: string; kind: string; attempts: number; last_error: string; died_at: number }[]>
  }
}
