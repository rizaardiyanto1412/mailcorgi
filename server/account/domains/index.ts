import { notify } from '../notifications/index.ts'
import { z } from 'zod'
import type { AccountRegistrar } from '../rpc.ts'
import type { StoreCtx } from '../../core/store.ts'
import { defineAction } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import { newId } from '../../core/ids.ts'
import { providerFromSettings, providerSettings, type Identity } from '../../email/index.ts'

const DAY = 86_400_000
const recordSchema = z.object({ name: z.string(), type: z.enum(['TXT', 'CNAME', 'MX', 'A']), value: z.string(), purpose: z.string(), found: z.boolean().default(false), required: z.boolean().default(true) })
type DnsRecord = z.infer<typeof recordSchema>
interface DomainRow {
  id: string
  name: string
  status: 'pending' | 'verified' | 'failed' | 'suspended'
  provider_identity: string
  records: string
  last_checked_at: number | null
  verified_at: number | null
  created_at: number
}
const domainInput = z.object({ domainId: z.string().min(1).describe('Sending domain ID') })
const domainName = z.string().trim().toLowerCase().max(253).refine((s) => s.includes('.') && s.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), 'Enter a domain name without a protocol or path')
function getDomain(ctx: StoreCtx, id: string): DomainRow {
  const row = ctx.db.get<DomainRow>('SELECT * FROM domains WHERE id = ?', id)
  if (!row) throw new AppError('not_found', 'Sending domain not found.', 404)
  return row
}
function output(row: DomainRow) {
  return { id: row.id, name: row.name, status: row.status, records: z.array(recordSchema).parse(JSON.parse(row.records)), lastCheckedAt: row.last_checked_at, verifiedAt: row.verified_at }
}

export function transitionDomain(ctx: StoreCtx, id: string, status: 'verified' | 'failed') {
  const row = getDomain(ctx, id)
  if (row.status === status) return
  if (!(row.status === 'pending' && status === 'verified' || row.status === 'verified' && status === 'failed' || row.status === 'failed' && status === 'verified')) throw new AppError('invalid_transition', 'This domain cannot change to that state.', 409)
  ctx.db.tx(() => {
    ctx.db.run('UPDATE domains SET status = ?, verified_at = CASE WHEN ? = ? THEN ? ELSE verified_at END WHERE id = ?', status, status, 'verified', ctx.now(), id)
    for (const newsletter of ctx.db.all<{ id: string }>('SELECT id FROM newsletters WHERE domain_id = ?', id)) {
      ctx.db.run('INSERT INTO events (type, newsletter_id, data, at) VALUES (?, ?, ?, ?)', `domain.${status}`, newsletter.id, JSON.stringify({ domainId: id }), ctx.now())
      ctx.db.run('INSERT OR IGNORE INTO daily_stats (newsletter_id, day) VALUES (?, ?)', newsletter.id, new Date(ctx.now()).toISOString().slice(0, 10))
    }
    notify(ctx, { kind: status === 'verified' ? 'domain_verified' : 'domain_failed', title: status === 'verified' ? 'Sending domain verified' : 'Sending domain needs attention', body: row.name, href: '/settings/domains' })
  })
}

function recordsFor(name: string, identity?: Identity): DnsRecord[] {
  const records = (identity?.records ?? []).map((record) => recordSchema.parse({ ...record, required: true }))
  if (!identity) records.push({ name, type: 'TXT', value: 'v=spf1 mx ~all', purpose: 'SPF', found: false, required: true })
  records.push({ name: `_dmarc.${name}`, type: 'TXT', value: 'v=DMARC1; p=none', purpose: 'DMARC', found: false, required: !identity })
  return records
}
const normalized = (value: string) => value.trim().replace(/\.$/, '').toLowerCase()

export async function checkDomain(ctx: StoreCtx, id: string) {
  const row = getDomain(ctx, id)
  if (row.status === 'suspended') return output(row)
  const settings = await providerSettings(ctx)
  const stored = z.object({ provider: z.string(), remoteId: z.string().optional() }).parse(JSON.parse(row.provider_identity))
  const provider = await providerFromSettings(ctx, { ...settings, resend_identity_domain: row.name, resend_identity_id: stored.remoteId || '' })
  if (stored.provider !== provider.name) throw new AppError('provider_changed', 'The install email provider changed. Remove this domain and add it again.', 409)
  const identity = provider.getIdentity ? await provider.getIdentity(row.name) : undefined
  const records = identity ? recordsFor(row.name, identity) : z.array(recordSchema).parse(JSON.parse(row.records))
  if (identity && !records.some((record) => record.required && record.purpose !== 'DMARC')) throw new AppError('identity_pending', 'The provider has not supplied DNS records yet. Check again shortly.', 409)
  for (const record of records) {
    let values: string[]
    try { values = await ctx.platform.resolveDns(record.name, record.type) } catch { throw new AppError('dns_unavailable', 'DNS lookup failed. Try again shortly.', 502) }
    record.found = values.some((value) => {
      const actual = value.replace(/"\s*"/g, '').replace(/^"|"$/g, '')
      if (record.purpose === 'DMARC') return /^v=DMARC1\s*;/i.test(actual)
      if (record.purpose === 'SPF' && !identity) return /^v=spf1\s/i.test(actual)
      return record.type === 'TXT' ? actual.trim() === record.value.trim() : normalized(actual) === normalized(record.value)
    })
  }
  ctx.db.tx(() => {
    // A delete may complete while DNS is in flight; never revive its row.
    if (!ctx.db.get('SELECT id FROM domains WHERE id = ?', id)) throw new AppError('not_found', 'Sending domain not found.', 404)
    ctx.db.run('UPDATE domains SET records = ?, last_checked_at = ? WHERE id = ?', JSON.stringify(records), ctx.now(), id)
    const verified = records.filter((record) => record.required).every((record) => record.found) && (!identity || identity.status === 'verified')
    const current = getDomain(ctx, id)
    if (verified) transitionDomain(ctx, id, 'verified')
    else if (current.status === 'verified') transitionDomain(ctx, id, 'failed')
  })
  return output(getDomain(ctx, id))
}

export function verifiedSenderFor(ctx: StoreCtx, newsletterId: string): { from: string; replyTo?: string } | null {
  const row = ctx.db.get<{ from_name: string; from_local: string; reply_to: string; name: string }>("SELECT n.from_name, n.from_local, n.reply_to, d.name FROM newsletters n JOIN domains d ON d.id = n.domain_id WHERE n.id = ? AND d.status = 'verified' AND n.archived_at IS NULL", newsletterId)
  if (!row || !/^[a-zA-Z0-9.!#$%&'*+\-/=?^_`{|}~]+$/.test(row.from_local) || /[\r\n<>]/.test(row.from_name)) return null
  return { from: `${row.from_name ? `"${row.from_name.replace(/["\\]/g, '\\$&')}" ` : ''}<${row.from_local}@${row.name}>`, ...(row.reply_to ? { replyTo: row.reply_to } : {}) }
}

export const domainsModule = {
  name: 'domains',
  register(reg: AccountRegistrar) {
    reg.job<{ name: string; accountId: string; domainId: string }>('domains.release', async (ctx, input) => {
      await ctx.stores.control.releaseEmailDomain(input)
      return 'done'
    })
    reg.job<{ domainId: string }>('domains.recheck', async (ctx, { domainId }, budget) => {
      if (!ctx.db.get('SELECT id FROM domains WHERE id = ?', domainId)) return 'done'
      const count = z.array(recordSchema).parse(JSON.parse(getDomain(ctx, domainId).records)).length + 3
      if (budget.take(count) < count) return { again: ctx.now() + 1000 }
      await checkDomain(ctx, domainId)
      return { again: ctx.now() + DAY }
    })
    return reg.actions(
      defineAction({ name: 'domains.list', description: 'List sending domains and the DNS records to publish.', scope: 'account', role: 'owner', effect: 'read', input: z.object({}), rest: { method: 'GET', path: '/domains' }, mcp: { title: 'List sending domains', destructive: false }, handler: (ctx) => ctx.db.all<DomainRow>('SELECT * FROM domains ORDER BY created_at, id').map(output) }),
      defineAction({ name: 'domains.add', description: 'Add a domain to use as a newsletter sender.', scope: 'account', role: 'owner', effect: 'write', input: z.object({ name: domainName.describe('Domain name, such as example.com') }), rest: { method: 'POST', path: '/domains' }, mcp: { title: 'Add a sending domain', destructive: false }, handler: async (ctx, { name }) => {
        const existing = ctx.db.get<DomainRow>('SELECT * FROM domains WHERE name = ?', name)
        if (existing) return output(existing)
        const provider = await providerFromSettings(ctx, await providerSettings(ctx))
        const id = newId('dom')
        const claim = await ctx.stores.control.claimEmailDomain({ name, accountId: ctx.accountId!, domainId: id })
        if (!claim.claimed) throw new AppError('domain_claimed', 'This domain is already in use. If you just removed it, try again shortly.', 409)
        let identity: Identity | undefined
        try { identity = await provider.createIdentity?.(name) } catch (error) {
          await ctx.stores.control.releaseEmailDomain({ name, accountId: ctx.accountId!, domainId: id })
          throw error
        }
        ctx.db.tx(() => {
          ctx.db.run('INSERT OR IGNORE INTO domains (id, name, provider_identity, records, created_at) VALUES (?, ?, ?, ?, ?)', id, name, JSON.stringify({ provider: provider.name, remoteId: z.object({ id: z.string() }).safeParse(identity?.raw).data?.id }), JSON.stringify(recordsFor(name, identity)), ctx.now())
          const actual = ctx.db.get<DomainRow>('SELECT * FROM domains WHERE name = ?', name)!
          ctx.jobs.enqueue('domains.recheck', { domainId: actual.id }, { runAt: ctx.now() + DAY, dedupeKey: `domains.recheck:${actual.id}` })
        })
        return output(ctx.db.get<DomainRow>('SELECT * FROM domains WHERE name = ?', name)!)
      } }),
      defineAction({ name: 'domains.check', description: 'Check the sending domain DNS records now.', scope: 'account', role: 'owner', effect: 'write', resource: { type: 'domain', param: 'domainId' }, input: domainInput, rest: { method: 'POST', path: '/domains/:domainId/check' }, mcp: { title: 'Check sending domain DNS', destructive: false }, handler: (ctx, { domainId }) => checkDomain(ctx, domainId) }),
      defineAction({ name: 'domains.delete', description: 'Remove a sending domain. Newsletters using it must choose another sender.', scope: 'account', role: 'owner', effect: 'write', resource: { type: 'domain', param: 'domainId' }, input: domainInput, rest: { method: 'DELETE', path: '/domains/:domainId' }, mcp: { title: 'Delete a sending domain', destructive: true }, handler: async (ctx, { domainId }) => {
        const row = getDomain(ctx, domainId)
        const stored = z.object({ provider: z.string(), remoteId: z.string().optional() }).parse(JSON.parse(row.provider_identity))
        const provider = await providerFromSettings(ctx, { ...await providerSettings(ctx), resend_identity_domain: row.name, resend_identity_id: stored.remoteId || '' })
        if (stored.provider === provider.name) await provider.deleteIdentity?.(row.name)
        ctx.db.tx(() => {
          ctx.db.run('UPDATE newsletters SET domain_id = NULL WHERE domain_id = ?', domainId)
          ctx.db.run('DELETE FROM domains WHERE id = ?', domainId)
          ctx.jobs.enqueue('domains.release', { name: row.name, accountId: ctx.accountId!, domainId }, { dedupeKey: `domains.release:${domainId}` })
        })
        return { ok: true }
      } }),
      defineAction({ name: 'domains.senders', description: 'List verified domains available to this newsletter.', scope: 'account', role: 'admin', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId: z.string().min(1).describe('Newsletter choosing a sender domain') }), handler: (ctx) => ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM domains WHERE status = 'verified' ORDER BY name") }),
    )
  },
}
