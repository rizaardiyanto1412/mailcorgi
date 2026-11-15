import type { StoreCtx } from '../../core/store.ts'
import { isAccountId } from '../../core/ids.ts'
import { newId } from '../../core/ids.ts'
import type { ControlRegistrar } from '../rpc.ts'

declare module '../rpc.ts' {
  interface ControlRpc {
    accountExists(args: { accountId: string }): Promise<boolean>
  }
}

export function raiseAlert(ctx: StoreCtx, alert: { kind: string; accountId?: string | null; title: string; body?: string }) {
  ctx.db.run('INSERT INTO admin_alerts (id, kind, account_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId('alr'), alert.kind, alert.accountId ?? null, alert.title, alert.body ?? '', ctx.now())
}

/** The admin console is built by its own unit. The kernel only needs a place to put alerts. */
export const adminModule = {
  name: 'admin',
  register(reg: ControlRegistrar) {
    reg.rpc('accountExists', (ctx, { accountId }) => isAccountId(accountId) && !!ctx.db.get('SELECT id FROM accounts WHERE id = ? AND deleted_at IS NULL', accountId))
    reg.rpc('raiseAlert', (ctx, args) => raiseAlert(ctx, args))
    reg.job<Parameters<typeof raiseAlert>[1]>('alerts.raise', async (ctx, alert) => {
      raiseAlert(ctx, alert)
      return 'done'
    })
  },
}
