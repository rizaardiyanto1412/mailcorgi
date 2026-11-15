import type { StoreCtx } from '../../core/store.ts'
import { newId } from '../../core/ids.ts'
import type { ControlRegistrar } from '../rpc.ts'

export function raiseAlert(ctx: StoreCtx, alert: { kind: string; accountId?: string | null; title: string; body?: string }) {
  ctx.db.run('INSERT INTO admin_alerts (id, kind, account_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId('alr'), alert.kind, alert.accountId ?? null, alert.title, alert.body ?? '', ctx.now())
}

/** The admin console is built by its own unit. The kernel only needs a place to put alerts. */
export const adminModule = {
  name: 'admin',
  register(reg: ControlRegistrar) {
    reg.rpc('raiseAlert', (ctx, args) => raiseAlert(ctx, args))
  },
}
