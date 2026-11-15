import type { Registrar, Module } from '../core/actions.ts'
import type { ProviderEvent } from '../email/index.ts'

/**
 * Methods other stores and the edge may call on the control store. Modules add their own with
 * `declare module '../rpc.ts' { interface ControlRpc { … } }` and register them with `reg.rpc`.
 */
export interface ControlRpc {
  resolveSession(args: { sessionId: string; wantAccountId?: string | null }): Promise<SessionInfo | null>
  lookupSite(args: { slug?: string; host?: string }): Promise<SiteRow | null>
  upsertSite(args: { newsletterId: string; accountId: string; slug: string; customHost?: string | null; hostVerifiedAt?: number | null }): Promise<void>
  removeSite(args: { newsletterId: string; accountId: string }): Promise<void>
  raiseAlert(args: { kind: string; accountId?: string | null; title: string; body?: string }): Promise<void>
  getInstallSettings(args: { keys: string[] }): Promise<Record<string, string>>
  takeSendPermits(args: { accountId: string; want: number }): Promise<{ granted: number; retryAt: number | null }>
  reportSuppressions(args: { accountId: string; events: ProviderEvent[] }): Promise<void>
  pushUsage(args: { accountId: string; period: string; contacts: number; emailsSent: number }): Promise<void>
  masterKey(args: Record<string, never>): Promise<{ master: string }>
  [name: string]: (args: any) => Promise<any>
}

export interface SessionInfo {
  user: { id: string; email: string; name: string; isInstallAdmin: boolean }
  csrf: string
  accounts: SessionAccount[]
  current: string | null
}
export interface SessionAccount {
  id: string
  name: string
  owner: boolean
  grants: Record<string, 'admin' | 'member'>
  status: string
}
export interface SiteRow {
  newsletter_id: string
  account_id: string
  slug: string
  custom_host: string | null
  host_verified_at: number | null
}

export type ControlRegistrar = Registrar<'control', ControlRpc>
export type ControlModule = Module<'control', ControlRpc>
