import type { AccountRegistrar } from '../rpc.ts'
import type { StoreCtx } from '../../core/store.ts'
import { newId } from '../../core/ids.ts'

export function notify(ctx: StoreCtx, input: { userId: string; kind: string; title: string; body: string; href: string }) {
  ctx.db.run('INSERT INTO notifications (id, user_id, kind, title, body, href, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('nt'), input.userId, input.kind, input.title, input.body, input.href, ctx.now())
}

/** Built by the notifications unit. */
export const notificationsModule = {
  name: 'notifications',
  register(_reg: AccountRegistrar) {},
}
