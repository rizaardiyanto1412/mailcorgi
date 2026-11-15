import type { AccountRegistrar } from '../rpc.ts'

declare module '../rpc.ts' {
  interface AccountRpc {
    teamNewsletters(args: { newsletterIds: string[] | null }): Promise<{ id: string; name: string }[]>
  }
}

export const teamModule = {
  name: 'team',
  register(reg: AccountRegistrar) {
    reg.rpc('teamNewsletters', (ctx, { newsletterIds }) => ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM newsletters WHERE archived_at IS NULL ORDER BY created_at').filter((n) => newsletterIds === null || newsletterIds.includes(n.id)))
  },
}
