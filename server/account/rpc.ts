import type { Registrar, Module } from '../core/actions.ts'
import type { ProviderEvent } from '../email/index.ts'

export interface Policy {
  version: number
  status: 'active' | 'blocked' | 'deleting'
  plan: string
  limits: Limits
}
/** `null` means no limit (self-hosted). JSON cannot carry Infinity. */
export interface Limits {
  maxContacts: number | null
  maxEmailsPerMonth: number | null
  maxNewsletters: number | null
  maxTeamPerNewsletter: number | null
}

/**
 * Methods the control store and the edge may call on an account store. Modules add their own with
 * `declare module '../rpc.ts' { interface AccountRpc { … } }` and register them with `reg.rpc`.
 */
export interface AccountRpc {
  bootstrap(args: { accountId: string; ownerUserId: string; ownerEmail: string; policy: Policy }): Promise<void>
  applyPolicy(args: Policy): Promise<{ applied: boolean }>
  ingestProviderEvents(args: { events: ProviderEvent[] }): Promise<{ applied: number }>
  summary(args: Record<string, never>): Promise<{ newsletters: number; contacts: number }>
  blobGet(args: { key: string }): Promise<{ bytes: number[]; contentType: string } | null>
  [name: string]: (args: any) => Promise<any>
}

export type AccountRegistrar = Registrar<'account', AccountRpc>
export type AccountModule = Module<'account', AccountRpc>
