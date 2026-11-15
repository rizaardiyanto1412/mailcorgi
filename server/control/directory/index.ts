import type { StoreCtx } from '../../core/store.ts'
import { AppError } from '../../core/http.ts'
import type { ControlRegistrar, SiteRow } from '../rpc.ts'

export function lookupSite(ctx: StoreCtx, where: { slug?: string; host?: string }): SiteRow | null {
  if (where.slug) return ctx.db.get<SiteRow>('SELECT * FROM sites WHERE slug = ?', where.slug.toLowerCase()) ?? null
  if (where.host) return ctx.db.get<SiteRow>('SELECT * FROM sites WHERE custom_host = ? AND host_verified_at IS NOT NULL', where.host.toLowerCase()) ?? null
  return null
}

export const directoryModule = {
  name: 'directory',
  register(reg: ControlRegistrar) {
    reg.rpc('lookupSite', (ctx, args) => lookupSite(ctx, args))
    reg.rpc('upsertSite', (ctx, { newsletterId, accountId, slug, customHost, hostVerifiedAt }) => {
      const taken = ctx.db.get<SiteRow>('SELECT * FROM sites WHERE slug = ? AND newsletter_id != ?', slug, newsletterId)
      if (taken) throw new AppError('slug_taken', 'That address is already in use.', 409)
      const existing = ctx.db.get<SiteRow>('SELECT * FROM sites WHERE newsletter_id = ?', newsletterId)
      if (existing && existing.account_id !== accountId) throw new AppError('forbidden', 'That newsletter belongs to another account.', 403)
      ctx.db.run(
        'INSERT INTO sites (newsletter_id, account_id, slug, custom_host, host_verified_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(newsletter_id) DO UPDATE SET slug = excluded.slug, custom_host = excluded.custom_host, host_verified_at = excluded.host_verified_at',
        newsletterId,
        accountId,
        slug,
        customHost ?? null,
        hostVerifiedAt ?? null,
      )
    })
    reg.rpc('removeSite', (ctx, { newsletterId, accountId }) => {
      ctx.db.run('DELETE FROM sites WHERE newsletter_id = ? AND account_id = ?', newsletterId, accountId)
    })
  },
}
