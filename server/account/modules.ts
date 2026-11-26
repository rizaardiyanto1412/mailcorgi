import { buildRegistry, type ActionsOf, type AnyAction } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import type { AccountRegistrar, AccountRpc } from './rpc.ts'
import { getPolicy } from './usage/index.ts'
import { usageModule } from './usage/index.ts'
import { newslettersModule } from './newsletters/index.ts'
import { contactsModule } from './contacts/index.ts'
import { segmentsModule } from './segments/index.ts'
import { sequencesModule } from './sequences/index.ts'
import { importsModule } from './imports/index.ts'
import { campaignsModule } from './campaigns/index.ts'
import { renderModule } from './render/index.ts'
import { sendingModule } from './sending/index.ts'
import { trackingModule } from './tracking/index.ts'
import { signupModule } from './signup/index.ts'
import { websiteModule } from './website/index.ts'
import { domainsModule } from './domains/index.ts'
import { statsModule } from './stats/index.ts'
import { assertSendingAllowed, hygieneModule } from './hygiene/index.ts'
import { teamModule } from './team/index.ts'
import { notificationsModule } from './notifications/index.ts'
import { apikeysModule } from './apikeys/index.ts'
import { oauthModule } from './oauth/index.ts'
import { setupModule } from './setup/index.ts'
import { devModule } from './dev/index.ts'

/** Jobs and RPC every account store has, whatever modules are built. */
const kernelModule = {
  name: 'kernel',
  register(reg: AccountRegistrar) {
    reg.job<{ kind: string; title: string; body?: string }>('alerts.raise', async (ctx, alert) => {
      await ctx.stores.control.raiseAlert({ kind: alert.kind, accountId: ctx.accountId, title: alert.title, body: alert.body })
      return 'done'
    })
    reg.rpc('blobGet', async (ctx, { key }) => {
      const blob = await ctx.platform.blobs.get(key)
      return blob ? { bytes: Array.from(blob.bytes), contentType: blob.contentType } : null
    })
  },
}

/** Every account store module, wired once. A module adds itself here and nowhere else. */
const modules = {
  kernel: kernelModule,
  usage: usageModule,
  newsletters: newslettersModule,
  contacts: contactsModule,
  segments: segmentsModule,
  imports: importsModule,
  campaigns: campaignsModule,
  sequences: sequencesModule,
  render: renderModule,
  sending: sendingModule,
  tracking: trackingModule,
  signup: signupModule,
  website: websiteModule,
  domains: domainsModule,
  stats: statsModule,
  hygiene: hygieneModule,
  team: teamModule,
  notifications: notificationsModule,
  apikeys: apikeysModule,
  oauth: oauthModule,
  setup: setupModule,
  dev: devModule,
}

export const accountRegistry = buildRegistry<'account', AccountRpc>('account', Object.values(modules), (ctx, action) => {
  if (getPolicy(ctx).status === 'deleting') throw new AppError('account_deleted', 'This account is being deleted.', 410)
  if (action.effect === 'send') assertSendingAllowed(ctx)
  if (action.effect === 'send' && getPolicy(ctx).status !== 'active') throw new AppError('account_blocked', 'This account cannot send right now.', 403)
})

type ModuleActions<M> = M extends { register: (reg: any) => infer R } ? (R extends readonly AnyAction[] ? ActionsOf<R> : {}) : {}
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never

export type AccountActions = UnionToIntersection<ModuleActions<(typeof modules)[keyof typeof modules]>>
