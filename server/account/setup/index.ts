import type { AccountRegistrar } from '../rpc.ts'
import { countVerifiedDomains } from '../domains/index.ts'
import { providerEventStats } from '../tracking/index.ts'

export interface SetupStatus {
  verifiedDomains: number
  providerEvents: number
  lastProviderEventAt: number | null
}

declare module '../rpc.ts' {
  interface AccountRpc {
    setupStatus(args: Record<string, never>): Promise<SetupStatus>
  }
}

/** Read-only facts the install admin's setup checklist needs from each account store. */
export const setupModule = {
  name: 'setup',
  register(reg: AccountRegistrar) {
    reg.rpc('setupStatus', (ctx): SetupStatus => {
      const events = providerEventStats(ctx)
      return { verifiedDomains: countVerifiedDomains(ctx), providerEvents: events.count, lastProviderEventAt: events.lastAt }
    })
  },
}
