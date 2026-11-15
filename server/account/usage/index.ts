import type { StoreCtx } from '../../core/store.ts'
import { parseJson } from '../../core/db.ts'
import { toHex } from '../../core/crypto.ts'
import type { AccountRegistrar, Limits, Policy } from '../rpc.ts'

export const getMeta = (ctx: StoreCtx, key: string): string | null => ctx.db.get<{ value: string }>('SELECT value FROM account_meta WHERE key = ?', key)?.value ?? null
export const setMeta = (ctx: StoreCtx, key: string, value: string) => ctx.db.run('INSERT INTO account_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)

const DEFAULT_POLICY: Policy = { version: 0, status: 'active', plan: 'selfhosted', limits: { maxContacts: null, maxEmailsPerMonth: null, maxNewsletters: null, maxTeamPerNewsletter: null } }

export const getPolicy = (ctx: StoreCtx): Policy => parseJson<Policy>(getMeta(ctx, 'policy'), DEFAULT_POLICY)

/** Writes a newer policy. An older or equal version is ignored, so pushes may repeat or cross. */
export function applyPolicy(ctx: StoreCtx, policy: Policy): boolean {
  return ctx.db.tx(() => {
    if (policy.version <= getPolicy(ctx).version) return false
    setMeta(ctx, 'policy', JSON.stringify(policy))
    return true
  })
}

export const currentPeriod = (now: number) => new Date(now).toISOString().slice(0, 7)

/** Plan limits for this account. Infinity when there is none. */
export function limits(ctx: StoreCtx): { maxContacts: number; maxEmailsPerMonth: number; maxNewsletters: number; maxTeamPerNewsletter: number } {
  const l: Limits = getPolicy(ctx).limits
  return {
    maxContacts: l.maxContacts ?? Infinity,
    maxEmailsPerMonth: l.maxEmailsPerMonth ?? Infinity,
    maxNewsletters: l.maxNewsletters ?? Infinity,
    maxTeamPerNewsletter: l.maxTeamPerNewsletter ?? Infinity,
  }
}

/** Whether `n` more contacts fit the plan. Call inside the caller's transaction. */
export function reserveContacts(ctx: StoreCtx, n: number): boolean {
  const max = limits(ctx).maxContacts
  if (max === Infinity) return true
  const count = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE status IN ('subscribed', 'unconfirmed')")!.n
  return count + n <= max
}

export function countEmails(ctx: StoreCtx, n: number): void {
  ctx.db.run('INSERT INTO usage (period, emails_sent, contacts_peak) VALUES (?, ?, 0) ON CONFLICT(period) DO UPDATE SET emails_sent = emails_sent + excluded.emails_sent', currentPeriod(ctx.now()), n)
}

export const usageModule = {
  name: 'usage',
  register(reg: AccountRegistrar) {
    reg.rpc('bootstrap', async (ctx, { accountId, ownerUserId, ownerEmail, policy }) => {
      const tokenKey = toHex(await ctx.keys.tokenKey(accountId))
      ctx.db.tx(() => {
        ctx.db.run('INSERT OR IGNORE INTO account_meta (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?)', 'account_id', accountId, 'owner_user_id', ownerUserId, 'owner_email', ownerEmail, 'token_key', tokenKey)
        applyPolicy(ctx, policy)
      })
    })
    reg.rpc('applyPolicy', (ctx, policy) => ({ applied: applyPolicy(ctx, policy) }))
    reg.rpc('summary', (ctx) => ({
      newsletters: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM newsletters WHERE archived_at IS NULL')!.n,
      contacts: ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE status = 'subscribed'")!.n,
    }))
  },
}
