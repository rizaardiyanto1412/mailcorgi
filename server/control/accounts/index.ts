import { planLimits } from '../billing/index.ts'
import { accountActions, registerAccountJobs } from './management.ts'
import { AppError } from '../../core/http.ts'
import type { StoreCtx } from '../../core/store.ts'
import { newId } from '../../core/ids.ts'
import type { Policy } from '../../account/rpc.ts'
import type { ControlRegistrar, SessionAccount, SessionInfo } from '../rpc.ts'

interface UserRow {
  id: string
  email: string
  name: string
  password_hash: string
  email_verified_at: number | null
  is_install_admin: number
  disabled: number
  created_at: number
}
export interface AccountRow {
  id: string
  owner_user_id: string
  name: string
  status: 'active' | 'blocked' | 'deleting'
  block_reason: string | null
  policy_version: number
  plan: string
  created_at: number
  billing_provider: 'stripe' | 'polar' | null
  billing_customer_id: string | null
  billing_subscription_id: string | null
  billing_status: string | null
  billing_paused: number
  plan_period_end: number | null
  billing_event_at: number
  billing_grace_until: number | null
  blocked_at: number | null
  deleted_at: number | null
}

export function ownedAccount(ctx: StoreCtx, id: string, userId: string): AccountRow {
  const row = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL', id, userId)
  if (!row) throw new AppError('not_found', 'Account not found.', 404)
  return row
}

export const isInstallAdmin = (ctx: StoreCtx, user: Pick<UserRow, 'email' | 'is_install_admin'>) => !!user.is_install_admin || ctx.config.adminEmails.includes(user.email)

/** The policy an account store should hold, from the control row. Self-hosted installs have no limits. */
export function policyFor(ctx: StoreCtx, account: Pick<AccountRow, 'policy_version' | 'status' | 'plan'>): Policy {
  return { version: account.policy_version, status: account.status, plan: account.plan, limits: planLimits(account.plan, ctx.config.cloud) }
}

/** Every user owns one account. Creates the control rows and bootstraps the account store. */
export async function createAccountForUser(ctx: StoreCtx, user: Pick<UserRow, 'id' | 'email' | 'name'>): Promise<string> {
  const existing = ctx.db.get<{ id: string }>('SELECT id FROM accounts WHERE owner_user_id = ? AND deleted_at IS NULL', user.id)
  if (existing) return existing.id
  const id = newId('acc')
  const now = ctx.now()
  const row = { id, owner_user_id: user.id, name: user.name || user.email, status: 'active' as const, block_reason: null, policy_version: 1, plan: ctx.config.cloud ? 'free' : 'selfhosted', created_at: now }
  await ctx.stores.account(id).bootstrap({ accountId: id, ownerUserId: user.id, ownerEmail: user.email, policy: policyFor(ctx, row) })
  ctx.db.tx(() => {
    ctx.db.run('INSERT INTO accounts (id, owner_user_id, name, status, policy_version, plan, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, user.id, row.name, row.status, row.policy_version, row.plan, now)
    ctx.db.run('INSERT INTO memberships (user_id, account_id, newsletter_id, role, created_at) VALUES (?, ?, NULL, ?, ?)', user.id, id, 'owner', now)
  })
  return id
}

/** Bump the policy version and push it to the account store through a job, in one transaction. */
export function pushPolicy(ctx: StoreCtx, accountId: string, change: Partial<Pick<AccountRow, 'status' | 'block_reason' | 'plan'>> = {}) {
  ctx.db.tx(() => {
    const sets = Object.keys(change).map((k) => `${k} = ?`)
    ctx.db.run(`UPDATE accounts SET policy_version = policy_version + 1${sets.length ? ', ' + sets.join(', ') : ''} WHERE id = ?`, ...Object.values(change), accountId)
    ctx.jobs.enqueue('policy.push', { accountId }, { dedupeKey: `policy.push:${accountId}` })
  })
}

export function resolveSession(ctx: StoreCtx, sessionId: string, wantAccountId?: string | null): SessionInfo | null {
  const now = ctx.now()
  const row = ctx.db.get<UserRow & { csrf: string }>('SELECT u.*, s.csrf FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0', sessionId, now)
  if (!row) return null
  const memberships = ctx.db.all<{ account_id: string; newsletter_id: string | null; role: string; name: string; status: string; owner_user_id: string }>(
    'SELECT m.account_id, m.newsletter_id, m.role, a.name, a.status, a.owner_user_id FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.user_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at',
    row.id,
  )
  const accounts = new Map<string, SessionAccount>()
  for (const m of memberships) {
    let account = accounts.get(m.account_id)
    if (!account) {
      account = { id: m.account_id, name: m.name, owner: false, grants: {}, status: m.status }
      accounts.set(m.account_id, account)
    }
    if (m.role === 'owner' && m.newsletter_id === null) account.owner = true
    else if (m.newsletter_id) account.grants[m.newsletter_id] = m.role === 'admin' ? 'admin' : 'member'
  }
  const list = [...accounts.values()]
  const own = list.find((a) => a.owner)
  const current = (wantAccountId && list.find((a) => a.id === wantAccountId)) || own || list[0] || null
  return {
    user: { id: row.id, email: row.email, name: row.name, isInstallAdmin: isInstallAdmin(ctx, row) },
    csrf: row.csrf,
    accounts: list,
    current: current?.id ?? null,
  }
}

export const accountsModule = {
  name: 'accounts',
  register(reg: ControlRegistrar) {
    registerAccountJobs(reg)
    reg.rpc('resolveSession', (ctx, { sessionId, wantAccountId }) => resolveSession(ctx, sessionId, wantAccountId))
    reg.rpc('masterKey', (ctx) => ({ master: ctx.keys.master }))
    reg.job<{ accountId: string }>('policy.push', async (ctx, { accountId }, budget) => {
      const account = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', accountId)
      if (!account) return 'done'
      if (budget.take(1) < 1) return { again: ctx.now() + 1000 }
      await ctx.stores.account(accountId).applyPolicy(policyFor(ctx, account))
      const latest = ctx.db.get<{ policy_version: number }>('SELECT policy_version FROM accounts WHERE id = ?', accountId)
      if (latest && latest.policy_version > account.policy_version) return { again: ctx.now() }
      return 'done'
    })
    return reg.actions(...accountActions)
  },
}

export { requestDeletion } from './management.ts'
