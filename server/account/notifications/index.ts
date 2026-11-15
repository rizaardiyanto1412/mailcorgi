import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import type { StoreCtx } from '../../core/store.ts'
import { newId } from '../../core/ids.ts'
import { sendSystemEmail, simpleEmail } from '../../email/platform-email.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { migrations } from './migrations.ts'

export const notificationKinds = ['import_finished', 'import_failed', 'campaign_sent', 'campaign_paused', 'campaign_failed', 'domain_verified', 'domain_failed', 'account_blocked', 'account_protection', 'invite_accepted', 'plan_limit_near'] as const
export type NotificationKind = typeof notificationKinds[number]
export type Tone = 'info' | 'ok' | 'warn' | 'danger'
export const notificationTones = {
  import_finished: 'ok', import_failed: 'warn', campaign_sent: 'ok', campaign_paused: 'warn', campaign_failed: 'danger',
  domain_verified: 'ok', domain_failed: 'warn', account_blocked: 'danger', account_protection: 'danger', invite_accepted: 'info', plan_limit_near: 'warn',
} satisfies Record<NotificationKind, Tone>
const important = new Set<NotificationKind>(['import_failed', 'campaign_paused', 'campaign_failed', 'domain_failed', 'account_blocked', 'account_protection', 'plan_limit_near'])
export interface NotificationInput { kind: NotificationKind; tone?: Tone; title: string; body?: string; href?: string; userId?: string }
const meta = (ctx: StoreCtx, key: string) => ctx.db.get<{ value: string }>('SELECT value FROM account_meta WHERE key = ?', key)?.value
const safeHref = (href: string) => href.startsWith('/') && !href.startsWith('//') && !/[\\\r\n]/.test(href) ? href : '/'
export const EMAIL_COOLDOWN = 6 * 60 * 60_000

export function notify(ctx: StoreCtx, input: NotificationInput): string {
  return ctx.db.tx(() => {
    const id = newId('ntf')
    const userId = input.userId ?? meta(ctx, 'owner_user_id') ?? null
    ctx.db.run('INSERT INTO notifications (id, user_id, kind, tone, title, body, href, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, userId, input.kind, input.tone ?? notificationTones[input.kind], input.title, input.body ?? '', safeHref(input.href ?? '/'), ctx.now())
    if (important.has(input.kind) && (!input.userId || input.userId === meta(ctx, 'owner_user_id'))) {
      const last = ctx.db.get<{ reserved_at: number }>('SELECT reserved_at FROM notification_emails WHERE kind = ?', input.kind)
      if (!last || last.reserved_at <= ctx.now() - EMAIL_COOLDOWN) {
        ctx.db.run('INSERT INTO notification_emails (kind, reserved_at) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET reserved_at = excluded.reserved_at', input.kind, ctx.now())
        ctx.jobs.enqueue('notifications.email', { id }, { dedupeKey: `notifications.email:${input.kind}` })
      }
    }
    return id
  })
}

export function notifyLimitNear(ctx: StoreCtx, resource: 'contacts' | 'emails') {
  const key = `notifications.limit:${new Date(ctx.now()).toISOString().slice(0, 7)}:${resource}`
  ctx.db.tx(() => {
    if (!ctx.db.run('INSERT OR IGNORE INTO account_meta (key, value) VALUES (?, ?)', key, '1').changes) return
    notify(ctx, { kind: 'plan_limit_near', title: 'You are close to your plan limit', body: `Your ${resource} usage has reached 90% of the plan allowance.`, href: '/settings/billing' })
  })
}

/** Once a month: the plan is full and readers who sign up are being turned away. */
export function notifySignupsRefused(ctx: StoreCtx) {
  const key = `notifications.limit:${new Date(ctx.now()).toISOString().slice(0, 7)}:signups`
  ctx.db.tx(() => {
    if (!ctx.db.run('INSERT OR IGNORE INTO account_meta (key, value) VALUES (?, ?)', key, '1').changes) return
    notify(ctx, { kind: 'plan_limit_near', tone: 'danger', title: 'New signups are being turned away', body: 'Your account has reached its contact limit, so the signup form refuses new readers. Remove inactive contacts or change your plan.', href: '/settings/billing' })
  })
}

const notificationSchema = z.object({ kind: z.enum(notificationKinds), tone: z.enum(['info', 'ok', 'warn', 'danger']).optional(), title: z.string().max(500), body: z.string().max(4000).optional(), href: z.string().max(2000).optional(), userId: z.string().optional() })

export const notificationsModule = {
  name: 'notifications',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    reg.rpc('receiveNotification', (ctx, { eventId, notification }) => receive(ctx, eventId, notificationSchema.parse(notification)))
    reg.rpc('notify', (ctx, input) => ({ id: notify(ctx, notificationSchema.parse(input)) }))
    reg.job<{ id: string }>('notifications.email', async (ctx, { id }, budget) => {
      if (budget.take(2) < 2) return { again: ctx.now() + 1000 }
      const row = ctx.db.get<{ title: string; body: string; href: string; email_attempted_at: number | null }>('SELECT title, body, href, email_attempted_at FROM notifications WHERE id = ?', id)
      const to = meta(ctx, 'owner_email')
      if (!row || row.email_attempted_at !== null || !to) return 'done'
      // Reserve before network I/O: an uncertain result must not email the owner twice.
      ctx.db.run('UPDATE notifications SET email_attempted_at = ? WHERE id = ?', ctx.now(), id)
      await sendSystemEmail(ctx, { to, subject: row.title, kind: 'notification', ...simpleEmail({ title: row.title, lines: [row.body], ...(ctx.config.appUrl ? { link: { label: 'Open MailCorgi', url: ctx.config.appUrl + safeHref(row.href) } } : {}) }) })
      return 'done'
    })
    return reg.actions(
      defineAction({ name: 'notifications.list', description: 'Read your notifications and unread count.', scope: 'account', role: 'member', effect: 'read', input: z.object({ before: z.number().int().nonnegative().optional().describe('Only show notifications older than this UTC millisecond timestamp.'), beforeId: z.string().default('').describe('The last notification id at the before timestamp, to page through timestamp ties.') }), rest: { method: 'GET', path: '/notifications' }, mcp: { title: 'Read notifications', destructive: false }, handler: (ctx, input, actor) => ({
        unread: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications n LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.user_id = ? WHERE (n.user_id = ? OR (n.user_id IS NULL AND ?)) AND r.read_at IS NULL AND n.read_at IS NULL', actor.userId, actor.userId, actor.owner)?.n ?? 0,
        items: ctx.db.all<{ id: string; kind: string; tone: Tone; title: string; body: string; href: string; created_at: number; read_at: number | null }>('SELECT n.id, n.kind, n.tone, n.title, n.body, n.href, n.created_at, COALESCE(r.read_at, n.read_at) read_at FROM notifications n LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.user_id = ? WHERE (n.user_id = ? OR (n.user_id IS NULL AND ?)) AND (? IS NULL OR n.created_at < ? OR (n.created_at = ? AND n.id < ?)) ORDER BY n.created_at DESC, n.id DESC LIMIT 50', actor.userId, actor.userId, actor.owner, input.before ?? null, input.before ?? null, input.before ?? null, input.beforeId),
      }) }),
      defineAction({ name: 'notifications.markRead', description: 'Mark your visible notifications as read.', scope: 'account', role: 'member', effect: 'write', input: z.object({ ids: z.array(z.string()).max(50).default([]).describe('The visible notification ids to mark read; an empty list changes nothing.') }), rest: { method: 'POST', path: '/notifications/read' }, mcp: { title: 'Mark notifications read', destructive: false }, handler: (ctx, { ids }, actor) => {
        ctx.db.tx(() => { for (const id of ids) ctx.db.run('INSERT OR IGNORE INTO notification_receipts (notification_id, user_id, read_at) SELECT id, ?, ? FROM notifications WHERE id = ? AND (user_id = ? OR (user_id IS NULL AND ?))', actor.userId, ctx.now(), id, actor.userId, actor.owner) })
        return { ok: true }
      } }),
    )
  },
}

function receive(ctx: StoreCtx, eventId: string, input: NotificationInput) {
  return ctx.db.tx(() => {
    const existing = ctx.db.get<{ notification_id: string }>('SELECT notification_id FROM notification_events WHERE id = ?', eventId)
    if (existing) return { id: existing.notification_id }
    const id = notify(ctx, input)
    ctx.db.run('INSERT INTO notification_events (id, notification_id) VALUES (?, ?)', eventId, id)
    return { id }
  })
}

declare module '../rpc.ts' { interface AccountRpc {
  notify(input: NotificationInput): Promise<{ id: string }>
  receiveNotification(input: { eventId: string; notification: NotificationInput }): Promise<{ id: string }>
} }
