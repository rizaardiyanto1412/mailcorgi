import type { AccountRegistrar } from '../rpc.ts'

/** Built by the imports unit. The resolver is here so authorization works as soon as rows exist. */
export const importsModule = {
  name: 'imports',
  register(reg: AccountRegistrar) {
    reg.resolver('import', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM imports WHERE id = ?', id)?.newsletter_id ?? null)
  },
}
