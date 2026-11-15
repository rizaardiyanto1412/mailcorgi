import type { StoreCtx } from '../../core/store.ts'
import { newId } from '../../core/ids.ts'
import type { ControlRegistrar } from '../rpc.ts'
import { sendSystemEmail, simpleEmail } from '../../email/platform-email.ts'
import type { NotificationInput } from '../../account/notifications/index.ts'
import { migrations } from './migrations.ts'

const COOLDOWN = 6 * 60 * 60_000
export interface AdminAlert { kind: string; accountId?: string | null; title: string; body?: string }
export function raiseAdminAlert(ctx: StoreCtx, alert: AdminAlert) {
  ctx.db.tx(() => {
    const id = newId('alr')
    ctx.db.run('INSERT INTO admin_alerts (id, kind, account_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, alert.kind, alert.accountId ?? null, alert.title, alert.body ?? '', ctx.now())
    const last = ctx.db.get<{ reserved_at: number }>('SELECT reserved_at FROM admin_alert_emails WHERE kind = ?', alert.kind)
    if (last && last.reserved_at > ctx.now() - COOLDOWN) return
    ctx.db.run('INSERT INTO admin_alert_emails (kind, reserved_at) VALUES (?, ?) ON CONFLICT(kind) DO UPDATE SET reserved_at = excluded.reserved_at', alert.kind, ctx.now())
    for (const to of new Set(ctx.config.adminEmails)) ctx.jobs.enqueue('admin.alertEmail', { id, to })
  })
}
export function registerAlerts(reg: ControlRegistrar) {
  reg.migrations(migrations)
  reg.job<{ id: string; to: string }>('admin.alertEmail', async (ctx, { id, to }, budget) => {
    if (budget.take(1) < 1) return { again: ctx.now() + 1000 }
    const alert = ctx.db.get<{ title: string; body: string }>('SELECT title, body FROM admin_alerts WHERE id = ?', id)
    if (!alert || !ctx.db.run('INSERT OR IGNORE INTO admin_alert_email_attempts (alert_id, recipient) VALUES (?, ?)', id, to).changes) return 'done'
    await sendSystemEmail(ctx, { to, subject: alert.title, kind: 'admin_alert', ...simpleEmail({ title: alert.title, lines: [alert.body], ...(ctx.config.appUrl ? { link: { label: 'Review alerts', url: ctx.config.appUrl + '/admin/alerts' } } : {}) }) })
    return 'done'
  })
  reg.job<{ accountId: string; notification: NotificationInput }>('notifications.forward', async (ctx, input, budget, job) => {
    if (!ctx.db.get('SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL', input.accountId)) return 'done'
    if (budget.take(1) < 1) return { again: ctx.now() + 1000 }
    await ctx.stores.account(input.accountId).receiveNotification({ eventId: job.id, notification: input.notification })
    return 'done'
  })
}
