import type { AccountRegistrar } from '../rpc.ts'

/** Built by the campaigns unit. The resolver is here so authorization works as soon as rows exist. */
export const campaignsModule = {
  name: 'campaigns',
  register(reg: AccountRegistrar) {
    reg.resolver('campaign', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM campaigns WHERE id = ?', id)?.newsletter_id ?? null)
  },
}
