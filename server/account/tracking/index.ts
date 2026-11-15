import type { AccountRegistrar } from '../rpc.ts'
import type { ProviderEvent } from '../../email/index.ts'
import { ingestProviderEvents } from './events.ts'
import { mountTrackingRoutes } from './routes.ts'
export { signToken, verifyToken, publicUrl } from './tokens.ts'
export type { TokenPurpose } from './tokens.ts'
export { ingestProviderEvents, recordOpen, recordClick } from './events.ts'
export { providerEventStats } from './events.ts'

export const trackingModule = {
  name: 'tracking',
  register(reg: AccountRegistrar) {
    reg.rpc('ingestProviderEvents', (ctx, { events }) => ingestProviderEvents(ctx, Array.isArray(events) ? events : []))
    reg.job<{ events: ProviderEvent[] }>('suppression.report', async (ctx, { events }, budget) => {
      if (budget.take(1) < 1) return { again: ctx.now() + 1000 }
      await ctx.stores.control.reportSuppressions({ accountId: ctx.accountId!, events })
      return 'done'
    })
    reg.routes(mountTrackingRoutes)
  },
}
