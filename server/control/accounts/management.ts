import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import { hashPassword, randomCode, sha256Hex, verifyPassword } from '../../core/crypto.ts'
import { allowRate } from '../../core/ratelimit.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { ControlRegistrar } from '../rpc.ts'
import { sendSystemEmail, simpleEmail } from '../../email/platform-email.ts'
import { getBillingProvider } from '../billing/index.ts'
import { ownedAccount, pushPolicy, type AccountRow } from './index.ts'

const accountId = z.string().min(1).describe('The account you own.')
const password = z.string().min(8).max(200)
async function reauthenticate(ctx: StoreCtx, userId: string, value: string) {
  if (!allowRate(ctx.db, `account:password:${userId}`, 10, 15 * 60_000, ctx.now())) throw new AppError('rate_limited', 'Too many attempts. Try again later.', 429)
  const user = ctx.db.get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', userId)
  if (!user || !await verifyPassword(value, user.password_hash)) throw new AppError('bad_password', 'Your current password is incorrect.', 400)
}
export function requestDeletion(ctx: StoreCtx, account: AccountRow) {
  ctx.db.tx(() => {
    if (account.status !== 'deleting') pushPolicy(ctx, account.id, { status: 'deleting' })
    ctx.jobs.enqueue('account.delete', { accountId: account.id }, { dedupeKey: `account.delete:${account.id}` })
  })
}
export function registerAccountJobs(reg: ControlRegistrar) {
  reg.job<{ accountId: string }>('account.delete', async (ctx, { accountId }, budget, job) => {
    const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', accountId)
    if (!a || a.deleted_at || a.status !== 'deleting') return 'done'
    if (budget.take(25) < 25) return { again: ctx.now() + 1000 }
    if (ctx.config.cloud && a.billing_subscription_id && a.billing_provider) {
      await (await getBillingProvider(ctx, a.billing_provider)).cancel(a.billing_subscription_id, job.id)
      ctx.db.run('UPDATE accounts SET billing_subscription_id = NULL, billing_status = ? WHERE id = ?', 'canceled', a.id)
    }
    await ctx.stores.account(a.id).applyPolicy({ version: a.policy_version, status: 'deleting', plan: a.plan, limits: { maxContacts: 0, maxEmailsPerMonth: 0, maxNewsletters: 0, maxTeamPerNewsletter: 0 } })
    const wiped = await ctx.stores.account(a.id).selfWipe({})
    if (!wiped.done) return { again: ctx.now() + 1000 }
    ctx.db.tx(() => {
      const user = ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', a.owner_user_id)
      ctx.db.run('DELETE FROM sites WHERE account_id = ?', a.id)
      ctx.db.run('DELETE FROM usage_snapshots WHERE account_id = ?', a.id)
      ctx.db.run('DELETE FROM invites WHERE account_id = ? OR invited_by = ?', a.id, a.owner_user_id)
      ctx.db.run('DELETE FROM memberships WHERE account_id = ? OR user_id = ?', a.id, a.owner_user_id)
      ctx.db.run('DELETE FROM admin_alerts WHERE account_id = ?', a.id)
      ctx.db.run('DELETE FROM accounts WHERE id = ?', a.id)
      if (user) {
        ctx.db.run('DELETE FROM invites WHERE email = ?', user.email)
        ctx.db.run('DELETE FROM login_codes WHERE email = ?', user.email)
        ctx.db.run('DELETE FROM outbox WHERE to_email = ?', user.email)
      }
      const pending = ctx.db.get<{ email: string }>('SELECT email FROM account_email_changes WHERE user_id = ?', a.owner_user_id)
      if (pending) ctx.db.run('DELETE FROM outbox WHERE to_email = ?', pending.email)
      ctx.db.run("DELETE FROM jobs WHERE json_extract(payload, '$.accountId') = ? AND id != ?", a.id, job.id)
      ctx.db.run("DELETE FROM jobs_dead WHERE json_extract(payload, '$.accountId') = ?", a.id)
      ctx.db.run('DELETE FROM users WHERE id = ?', a.owner_user_id)
    })
    return 'done'
  })
  reg.job<{ accountId: string }>('account.email.push', async (ctx, input, budget) => {
    if (budget.take(1) < 1) return { again: ctx.now() + 1000 }
    const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', input.accountId)
    const user = a ? ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', a.owner_user_id) : null
    if (a && user && a.status !== 'deleting') {
      await ctx.stores.account(a.id).updateOwnerEmail({ email: user.email })
      const latest = ctx.db.get<{ email: string }>('SELECT email FROM users WHERE id = ?', a.owner_user_id)
      if (latest && latest.email !== user.email) return { again: ctx.now() }
    }
    return 'done'
  })
}
export const accountActions = [
  defineAction({ name: 'account.profile', description: 'Read your profile.', scope: 'control', role: 'user', effect: 'read', input: z.object({}), handler: (ctx, _input, actor) => {
    const user = ctx.db.get<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', actor.userId)
    if (!user) throw new AppError('not_found', 'Profile not found.', 404)
    return user
  } }),
  defineAction({ name: 'account.updateProfile', description: 'Change your display name.', scope: 'control', role: 'user', effect: 'write', input: z.object({ name: z.string().trim().min(1).max(120).describe('Your display name.') }), handler: (ctx, input, actor) => {
    ctx.db.run('UPDATE users SET name = ? WHERE id = ?', input.name, actor.userId)
    return { ok: true }
  } }),
  defineAction({ name: 'account.changePassword', description: 'Change your password and sign out every session.', scope: 'control', role: 'user', effect: 'write', input: z.object({ currentPassword: password.describe('Your current password.'), newPassword: password.describe('Your new password, at least eight characters.') }), handler: async (ctx, input, actor) => {
    await reauthenticate(ctx, actor.userId, input.currentPassword)
    const hash = await hashPassword(input.newPassword)
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, actor.userId)
      ctx.db.run('DELETE FROM sessions WHERE user_id = ?', actor.userId)
    })
    return { ok: true, signedOut: true }
  } }),
  defineAction({ name: 'account.requestEmailChange', description: 'Email a confirmation code to your new address.', scope: 'control', role: 'user', effect: 'write', input: z.object({ email: z.string().trim().toLowerCase().email().max(254).describe('Your new email address.'), currentPassword: password.describe('Your current password.') }), handler: async (ctx, input, actor) => {
    await reauthenticate(ctx, actor.userId, input.currentPassword)
    if (!allowRate(ctx.db, `account:email:${actor.userId}`, 3, 60 * 60_000, ctx.now())) throw new AppError('rate_limited', 'Ask for another code in an hour.', 429)
    if (ctx.db.get('SELECT id FROM users WHERE email = ?', input.email)) throw new AppError('email_taken', 'That address is already in use.', 409)
    const code = randomCode()
    ctx.db.run('INSERT INTO account_email_changes (user_id, email, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0', actor.userId, input.email, await sha256Hex(`${actor.userId}:${code}`), ctx.now() + 15 * 60_000)
    await sendSystemEmail(ctx, { to: input.email, subject: 'Confirm your new email', kind: 'email_change', ...simpleEmail({ title: 'Confirm your new email', lines: ['This code expires in 15 minutes.'], code }) })
    return { pending: true }
  } }),
  defineAction({ name: 'account.confirmEmailChange', description: 'Confirm your new email and sign out every session.', scope: 'control', role: 'user', effect: 'write', input: z.object({ code: z.string().regex(/^\d{6}$/).describe('The six-digit code sent to your new email.') }), handler: async (ctx, input, actor) => {
    const row = ctx.db.get<{ email: string; code_hash: string; expires_at: number; attempts: number }>('SELECT * FROM account_email_changes WHERE user_id = ?', actor.userId)
    if (!row || row.expires_at <= ctx.now() || row.attempts >= 5) throw new AppError('bad_code', 'That code is wrong or expired. Ask for a new one.', 400)
    const hash = await sha256Hex(`${actor.userId}:${input.code}`)
    if (hash !== row.code_hash) {
      ctx.db.run('UPDATE account_email_changes SET attempts = attempts + 1 WHERE user_id = ?', actor.userId)
      throw new AppError('bad_code', 'That code is wrong or expired.', 400)
    }
    if (ctx.db.get('SELECT id FROM users WHERE email = ?', row.email)) throw new AppError('email_taken', 'That address is already in use.', 409)
    ctx.db.tx(() => {
      ctx.db.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', row.email, ctx.now(), actor.userId)
      ctx.db.run('DELETE FROM sessions WHERE user_id = ?', actor.userId)
      ctx.db.run('DELETE FROM account_email_changes WHERE user_id = ?', actor.userId)
      ctx.db.run('DELETE FROM outbox WHERE to_email = ?', actor.email)
      for (const a of ctx.db.all<{ id: string }>('SELECT id FROM accounts WHERE owner_user_id = ?', actor.userId)) ctx.jobs.enqueue('account.email.push', { accountId: a.id })
    })
    return { ok: true, signedOut: true }
  } }),
  defineAction({ name: 'account.sessions', description: 'List your active sessions.', scope: 'control', role: 'user', effect: 'read', input: z.object({}), handler: (ctx, _input, actor) => ctx.db.all<{ id: string; created_at: number; expires_at: number; ip: string; user_agent: string }>('SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC', actor.userId, ctx.now()) }),
  defineAction({ name: 'account.revokeSession', description: 'Sign out one of your sessions.', scope: 'control', role: 'user', effect: 'write', input: z.object({ sessionId: z.string().describe('The id of a session you own.') }), handler: (ctx, input, actor) => {
    ctx.db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', input.sessionId, actor.userId)
    return { ok: true }
  } }),
  defineAction({ name: 'account.delete', description: 'Permanently delete your account, newsletters, contacts and images.', scope: 'control', role: 'user', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId, currentPassword: password.describe('Your current password.'), confirmation: z.literal('DELETE').describe('Type DELETE to confirm permanent deletion.') }), handler: async (ctx, input, actor) => {
    await reauthenticate(ctx, actor.userId, input.currentPassword)
    const a = ownedAccount(ctx, input.accountId, actor.userId)
    requestDeletion(ctx, a)
    return { deleting: true }
  } }),
] as const
