import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import type { StoreCtx } from '../../core/store.ts'
import { AppError } from '../../core/http.ts'
import { newId } from '../../core/ids.ts'
import { retryDead } from '../../core/jobs.ts'
import type { ControlRegistrar } from '../rpc.ts'
import { pushPolicy, requestDeletion, type AccountRow } from '../accounts/index.ts'
import { queueBillingSync, BLOCK_CANCEL_MS } from '../billing/index.ts'
import { getSetting, setSetting, isSecretSetting } from '../install/index.ts'
import { suppressionHash } from '../suppression/index.ts'

export function raiseAlert(ctx: StoreCtx, alert: { kind: string; accountId?: string | null; title: string; body?: string }) {
  ctx.db.run('INSERT INTO admin_alerts (id, kind, account_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId('alr'), alert.kind, alert.accountId ?? null, alert.title, alert.body ?? '', ctx.now())
}
const accountId = z.string().min(1).describe('The account id.')
const settingsKeys = ['signup_mode', 'allowed_emails', 'stripe_secret_key', 'stripe_webhook_secret', 'polar_access_token', 'polar_webhook_secret', 'polar_products'] as const
const settingKey = z.enum(settingsKeys)
const settingsInput = z.object({ key: settingKey.describe('The install setting to change.'), value: z.string().max(20_000).describe('The new value. An empty value clears it.') })
const period = (now: number) => new Date(now).toISOString().slice(0, 7)
function account(ctx: StoreCtx, id: string) {
  const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL', id)
  if (!a) throw new AppError('not_found', 'Account not found.', 404)
  return a
}
export function blockAccount(ctx: StoreCtx, id: string, reason: string | null) {
  const a = account(ctx, id)
  if (a.status === 'deleting') throw new AppError('account_deleting', 'This account is being deleted.', 409)
  ctx.db.tx(() => {
    if (reason !== null) {
      if (a.status !== 'blocked') ctx.db.run('UPDATE accounts SET blocked_at = ? WHERE id = ?', ctx.now(), id)
      pushPolicy(ctx, id, { status: 'blocked', block_reason: reason })
      ctx.jobs.enqueue('billing.blockedExpire', { accountId: id }, { runAt: (a.blocked_at ?? ctx.now()) + BLOCK_CANCEL_MS, dedupeKey: `billing.blockedExpire:${id}` })
    } else {
      pushPolicy(ctx, id, { status: 'active', block_reason: null })
      ctx.db.run('UPDATE accounts SET blocked_at = NULL WHERE id = ?', id)
      ctx.jobs.cancelByKey(`billing.blockedExpire:${id}`)
    }
    queueBillingSync(ctx, id)
  })
}
export const adminModule = {
  name: 'admin',
  register(reg: ControlRegistrar) {
    reg.rpc('raiseAlert', (ctx, args) => raiseAlert(ctx, args))
    reg.rpc('blockAccount', (ctx, { accountId, reason }) => { blockAccount(ctx, accountId, reason) })
    reg.job<{ accountId: string }>('billing.blockedExpire', async (ctx, { accountId }) => {
      const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', accountId)
      if (!a || a.status !== 'blocked' || a.blocked_at === null) return 'done'
      if (a.blocked_at + BLOCK_CANCEL_MS > ctx.now()) return { again: a.blocked_at + BLOCK_CANCEL_MS }
      ctx.db.tx(() => {
        if (ctx.config.cloud) pushPolicy(ctx, a.id, { plan: 'free' })
        queueBillingSync(ctx, a.id)
      })
      return 'done'
    })
    return reg.actions(
      defineAction({ name: 'admin.accounts', description: 'List accounts with their plan, status and latest usage.', scope: 'control', role: 'installAdmin', effect: 'read', input: z.object({ search: z.string().max(200).default('').describe('Search account name or owner email.'), status: z.enum(['all', 'active', 'blocked', 'deleting']).default('all').describe('Account status filter.'), plan: z.string().max(30).default('').describe('Optional plan filter.'), offset: z.number().int().nonnegative().default(0).describe('Skip this many accounts.') }), handler: (ctx, input) => ctx.db.all<{ id: string; name: string; email: string; plan: string; status: string; block_reason: string | null; contacts: number; emails_sent: number }>(`SELECT a.id, a.name, u.email, a.plan, a.status, a.block_reason, COALESCE(s.contacts, 0) contacts, COALESCE(s.emails_sent, 0) emails_sent FROM accounts a JOIN users u ON u.id = a.owner_user_id LEFT JOIN usage_snapshots s ON s.account_id = a.id AND s.period = ? WHERE a.deleted_at IS NULL AND (a.name LIKE ? OR u.email LIKE ?) AND (? = 'all' OR a.status = ?) AND (? = '' OR a.plan = ?) ORDER BY a.created_at DESC, a.id LIMIT 50 OFFSET ?`, period(ctx.now()), `%${input.search}%`, `%${input.search}%`, input.status, input.status, input.plan, input.plan, input.offset) }),
      defineAction({ name: 'admin.accountSummary', description: 'Read an account summary without impersonating its owner.', scope: 'control', role: 'installAdmin', effect: 'read', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId }), handler: async (ctx, input) => {
        const a = account(ctx, input.accountId)
        return { id: a.id, name: a.name, plan: a.plan, status: a.status, summary: await ctx.stores.account(a.id).summary({}) }
      } }),
      defineAction({ name: 'admin.block', description: 'Block an account and pause its billing.', scope: 'control', role: 'installAdmin', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId, reason: z.string().trim().min(1).max(1000).describe('Why this account is blocked.') }), handler: (ctx, input) => { blockAccount(ctx, input.accountId, input.reason); return { ok: true } } }),
      defineAction({ name: 'admin.unblock', description: 'Unblock an account and resume its billing.', scope: 'control', role: 'installAdmin', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId }), handler: (ctx, input) => { blockAccount(ctx, input.accountId, null); return { ok: true } } }),
      defineAction({ name: 'admin.deleteAccount', description: 'Permanently delete an account and its images.', scope: 'control', role: 'installAdmin', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId, confirmation: z.literal('DELETE').describe('Type DELETE to confirm permanent deletion.') }), handler: (ctx, input) => { requestDeletion(ctx, account(ctx, input.accountId)); return { deleting: true } } }),
      defineAction({ name: 'admin.alerts', description: 'Read install alerts.', scope: 'control', role: 'installAdmin', effect: 'read', input: z.object({ resolved: z.boolean().default(false).describe('Show resolved alerts instead of open alerts.') }), handler: (ctx, input) => ctx.db.all<{ id: string; kind: string; account_id: string | null; title: string; body: string; created_at: number }>(`SELECT id, kind, account_id, title, body, created_at FROM admin_alerts WHERE resolved_at IS ${input.resolved ? 'NOT NULL' : 'NULL'} ORDER BY created_at DESC LIMIT 100`) }),
      defineAction({ name: 'admin.resolveAlert', description: 'Resolve an install alert.', scope: 'control', role: 'installAdmin', effect: 'write', input: z.object({ alertId: z.string().describe('The alert to resolve.') }), handler: (ctx, input) => { ctx.db.run('UPDATE admin_alerts SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?', ctx.now(), input.alertId); return { ok: true } } }),
      defineAction({ name: 'admin.deadJobs', description: 'List, retry or discard dead jobs in the control store or one account store.', scope: 'control', role: 'installAdmin', effect: 'write', input: z.object({ accountId: z.string().nullable().default(null).describe('An account id, or null for the control store.'), operation: z.enum(['list', 'retry', 'discard']).default('list').describe('List dead jobs, or retry or discard one.'), jobId: z.string().optional().describe('The job to retry or discard.') }), handler: async (ctx, input) => {
        if (input.operation !== 'list' && !input.jobId) throw new AppError('invalid_input', 'Choose a job.', 400)
        if (input.accountId) {
          account(ctx, input.accountId)
          return ctx.stores.account(input.accountId).adminDeadJobs({ operation: input.operation, id: input.jobId })
        }
        if (input.operation === 'retry' && input.jobId) retryDead(ctx.db, input.jobId, ctx.now())
        if (input.operation === 'discard' && input.jobId) ctx.db.run('DELETE FROM jobs_dead WHERE id = ?', input.jobId)
        return ctx.db.all<{ id: string; kind: string; attempts: number; last_error: string; died_at: number }>('SELECT id, kind, attempts, last_error, died_at FROM jobs_dead ORDER BY died_at DESC LIMIT 100')
      } }),
      defineAction({ name: 'admin.settings', description: 'Read sign-up and billing settings without exposing secrets.', scope: 'control', role: 'installAdmin', effect: 'read', input: z.object({}), handler: async (ctx) => {
        const values: Record<string, string> = {}
        const secretsSet: Record<string, boolean> = {}
        const fromEnv: Record<string, boolean> = {}
        for (const key of settingsKeys) {
          const value = await getSetting(ctx, key)
          if (isSecretSetting(key)) secretsSet[key] = !!value
          else values[key] = value
          fromEnv[key] = !!ctx.config.env[key.toUpperCase()]
        }
        return { values, secretsSet, fromEnv, billingProvider: ctx.config.billingProvider, cloud: ctx.config.cloud }
      } }),
      defineAction({ name: 'admin.setSetting', description: 'Set sign-up rules, billing credentials or Polar product ids.', scope: 'control', role: 'installAdmin', effect: 'write', input: settingsInput, handler: async (ctx, input) => {
        if (input.key === 'signup_mode' && !['', 'open', 'closed', 'allowlist'].includes(input.value)) throw new AppError('invalid_input', 'Choose open, closed or allowlist.', 400)
        if (input.key === 'polar_products' && input.value) {
          let value: unknown
          try { value = JSON.parse(input.value) } catch { throw new AppError('invalid_input', 'Enter valid JSON for Polar products.', 400) }
          const parsed = z.record(z.string().regex(/^(starter|growth|pro|scale)_(monthly|yearly)$/), z.uuid()).safeParse(value)
          if (!parsed.success) throw new AppError('invalid_input', 'Enter a JSON object mapping plan_interval to Polar product UUIDs.', 400)
        }
        if (input.key === 'allowed_emails' && input.value.split(',').some((v) => !z.email().safeParse(v.trim().toLowerCase()).success)) throw new AppError('invalid_input', 'Enter email addresses separated by commas.', 400)
        await setSetting(ctx, input.key, input.value)
        return { ok: true }
      } }),
      defineAction({ name: 'admin.suppressions', description: 'List global suppressions or look up an email by its keyed hash.', scope: 'control', role: 'installAdmin', effect: 'read', input: z.object({ email: z.string().trim().toLowerCase().email().optional().describe('An optional email address to look up; only its hash is stored.'), offset: z.number().int().nonnegative().default(0).describe('Skip this many suppressions.') }), handler: async (ctx, input) => {
        const hash = input.email ? await suppressionHash(ctx, input.email) : null
        return ctx.db.all<{ email_hash: string; reason: string; until: number | null; created_at: number }>('SELECT email_hash, reason, until, created_at FROM global_suppressions WHERE (until IS NULL OR until > ?) AND (? IS NULL OR email_hash = ?) ORDER BY created_at DESC, email_hash LIMIT 50 OFFSET ?', ctx.now(), hash, hash, input.offset)
      } }),
    )
  },
}

declare module '../rpc.ts' {
  interface ControlRpc { blockAccount(args: { accountId: string; reason: string }): Promise<void> }
}
