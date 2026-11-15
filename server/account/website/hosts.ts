import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import { encodeJsonUrl, hmac, randomToken, toBase64Url } from '../../core/crypto.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { baseUrl, ensureAppUrl, hostnameSchema, newsletter, websiteHost } from './model.ts'

const newsletterId = z.string().min(1).describe('The newsletter id')
const resource = { type: 'newsletter', param: 'newsletterId' } as const
export function hostInfo(ctx: StoreCtx, id: string) {
  const host = websiteHost(ctx, id)
  const target = ctx.config.env.WEBSITE_CNAME_TARGET || new URL(ctx.config.appUrl).hostname
  return { hostname: host?.hostname ?? '', verifiedAt: host?.verified_at ?? null, cname: { name: host?.hostname ?? '', value: target }, txt: { name: host ? `_mailcorgi.${host.hostname}` : '', value: host?.token ?? '' }, url: baseUrl(ctx, id), cloudflareId: host?.cf_id ?? null }
}
export const syncHost = (ctx: StoreCtx, id: string) => ctx.jobs.enqueue('website.syncHost', { newsletterId: id }, { dedupeKey: `website.syncHost:${id}` })
export function registerHostJobs(reg: AccountRegistrar) {
  reg.job<{ id: string }>('website.deleteHost', async (ctx, { id }, budget) => {
    const { CF_API_TOKEN, CF_ZONE_ID } = ctx.config.env
    if (!CF_API_TOKEN || !CF_ZONE_ID || !/^[a-f0-9]{32}$/i.test(CF_ZONE_ID)) return 'done'
    if (ctx.db.get('SELECT newsletter_id FROM website_hosts WHERE cf_id = ?', id)) return 'done'
    if (!budget.take(1)) return { again: ctx.now() + 1000 }
    const response = await ctx.platform.fetch(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/custom_hostnames/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${CF_API_TOKEN}` } })
    if (!response.ok && response.status !== 404) throw new AppError('host_delete_failed', 'Cloudflare could not remove the old hostname.', 502)
    return 'done'
  })
  reg.job<{ newsletterId: string }>('website.syncHost', async (ctx, { newsletterId }) => {
    const nl = newsletter(ctx, newsletterId)
    const host = websiteHost(ctx, newsletterId)
    if (nl.archived_at !== null) await ctx.stores.control.removeSite({ newsletterId, accountId: ctx.accountId! })
    else await ctx.stores.control.upsertSite({ newsletterId, accountId: ctx.accountId!, slug: nl.slug, customHost: host?.hostname ?? null, hostVerifiedAt: host?.verified_at ?? null })
    return 'done'
  })
  reg.job<{ newsletterId: string; hostname: string; token: string }>('website.provisionHost', async (ctx, input, budget) => {
    const host = websiteHost(ctx, input.newsletterId)
    if (!host || host.hostname !== input.hostname || host.token !== input.token || host.verified_at === null || host.cf_id) return 'done'
    const { CF_API_TOKEN, CF_ZONE_ID } = ctx.config.env
    if (!CF_API_TOKEN || !CF_ZONE_ID) return 'done'
    if (!/^[a-f0-9]{32}$/i.test(CF_ZONE_ID)) throw new AppError('invalid_cf_zone', 'Configure a valid Cloudflare zone id.')
    if (budget.take(2) < 2) return { again: ctx.now() + 1000 }
    const endpoint = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/custom_hostnames`
    const headers = { authorization: `Bearer ${CF_API_TOKEN}`, 'content-type': 'application/json' }
    const listed = await ctx.platform.fetch(`${endpoint}?hostname=${encodeURIComponent(host.hostname)}`, { headers })
    const existing = z.object({ success: z.boolean(), result: z.array(z.object({ id: z.string(), hostname: z.string() })).optional() }).parse(await listed.json())
    if (!listed.ok || !existing.success) throw new AppError('host_provision_failed', 'Cloudflare could not check existing hostnames.', 502)
    let id = existing.result?.find((row) => row.hostname === host.hostname)?.id
    if (!id) {
      const response = await ctx.platform.fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ hostname: host.hostname, ssl: { method: 'txt', type: 'dv' } }) })
      const result = z.object({ success: z.boolean(), result: z.object({ id: z.string() }).nullable().optional() }).parse(await response.json())
      if (!response.ok || !result.success || !result.result) throw new AppError('host_provision_failed', 'Cloudflare could not provision that hostname. Check the install settings.', 502)
      id = result.result.id
    }
    ctx.db.tx(() => {
      const updated = ctx.db.run('UPDATE website_hosts SET cf_id = ? WHERE newsletter_id = ? AND hostname = ? AND token = ?', id, input.newsletterId, input.hostname, input.token)
      if (!updated.changes) ctx.jobs.enqueue('website.deleteHost', { id }, { dedupeKey: `website.deleteHost:${id}` })
    })
    return 'done'
  })
}
export const hostActions = [
  defineAction({ name: 'website.setHost', description: 'Set or remove a custom website hostname and get the DNS verification records.', scope: 'account', role: 'owner', effect: 'write', resource, input: z.object({ newsletterId, hostname: hostnameSchema.or(z.literal('')).describe('Custom hostname, or empty to remove it') }), rest: { method: 'PUT', path: '/newsletters/:newsletterId/website/host' }, mcp: { title: 'Set website host', destructive: false }, handler: async (ctx, input) => {
    await ensureAppUrl(ctx)
    const nl = newsletter(ctx, input.newsletterId)
    if (input.hostname && input.hostname === new URL(ctx.config.appUrl).hostname) throw new AppError('invalid_host', 'Use a hostname different from the app host.')
    if (input.hostname) {
      const existing = await ctx.stores.control.lookupSite({ host: input.hostname })
      if (existing && (existing.account_id !== ctx.accountId || existing.newsletter_id !== nl.id)) throw new AppError('host_taken', 'That hostname is already in use.', 409)
    }
    const current = websiteHost(ctx, nl.id)
    if (current?.hostname === input.hostname) return hostInfo(ctx, nl.id)
    const payload = encodeJsonUrl({ newsletterId: nl.id, hostname: input.hostname, nonce: randomToken(16) })
    const sig = toBase64Url((await hmac(await ctx.keys.tokenKey(ctx.accountId!), `w.${payload}`)).slice(0, 16))
    const token = `${ctx.accountId}.w.${payload}.${sig}`
    ctx.db.tx(() => {
      if (!input.hostname) ctx.db.run('DELETE FROM website_hosts WHERE newsletter_id = ?', nl.id)
      else {
        if (ctx.db.get('SELECT newsletter_id FROM website_hosts WHERE hostname = ? AND newsletter_id != ?', input.hostname, nl.id)) throw new AppError('host_taken', 'That hostname is already in use.', 409)
        ctx.db.run('INSERT INTO website_hosts (newsletter_id, hostname, token) VALUES (?, ?, ?) ON CONFLICT(newsletter_id) DO UPDATE SET hostname = excluded.hostname, token = excluded.token, verified_at = NULL, cf_id = NULL', nl.id, input.hostname, token)
      }
      if (current?.cf_id) ctx.jobs.enqueue('website.deleteHost', { id: current.cf_id }, { dedupeKey: `website.deleteHost:${current.cf_id}` })
      syncHost(ctx, nl.id)
    })
    return hostInfo(ctx, nl.id)
  } }),
  defineAction({ name: 'website.checkHost', description: 'Check CNAME and TXT ownership records before enabling a custom hostname.', scope: 'account', role: 'owner', effect: 'write', resource, input: z.object({ newsletterId }), rest: { method: 'POST', path: '/newsletters/:newsletterId/website/host/check' }, mcp: { title: 'Verify website host', destructive: false }, handler: async (ctx, input) => {
    await ensureAppUrl(ctx)
    const host = websiteHost(ctx, input.newsletterId)
    if (!host) throw new AppError('no_host', 'Add a custom hostname first.')
    const existing = await ctx.stores.control.lookupSite({ host: host.hostname })
    if (existing && (existing.account_id !== ctx.accountId || existing.newsletter_id !== input.newsletterId)) throw new AppError('host_taken', 'That hostname is already in use.', 409)
    const info = hostInfo(ctx, input.newsletterId)
    const [cnames, txts] = await Promise.all([ctx.platform.resolveDns(host.hostname, 'CNAME'), ctx.platform.resolveDns(info.txt.name, 'TXT')])
    const normalize = (s: string) => s.toLowerCase().replace(/\.$/, '')
    const cnameFound = cnames.some((s) => normalize(s) === normalize(info.cname.value))
    const txtFound = txts.some((s) => s.replace(/"\s*"/g, '').replace(/^"|"$/g, '') === host.token)
    if (websiteHost(ctx, input.newsletterId)?.token !== host.token) throw new AppError('host_changed', 'The hostname changed during the check. Try again.', 409)
    ctx.db.tx(() => {
      ctx.db.run('UPDATE website_hosts SET verified_at = ? WHERE newsletter_id = ? AND token = ?', cnameFound && txtFound ? host.verified_at ?? ctx.now() : null, input.newsletterId, host.token)
      syncHost(ctx, input.newsletterId)
      if (cnameFound && txtFound) ctx.jobs.enqueue('website.provisionHost', { newsletterId: input.newsletterId, hostname: host.hostname, token: host.token }, { dedupeKey: `website.provisionHost:${host.token}` })
    })
    return { ...hostInfo(ctx, input.newsletterId), cnameFound, txtFound }
  } }),
] as const
