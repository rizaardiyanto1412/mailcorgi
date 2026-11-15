import { buildRegistry, type ActionsOf, type AnyAction } from '../core/actions.ts'
import type { ControlRpc } from './rpc.ts'
import { authModule } from './auth/index.ts'
import { accountsModule } from './accounts/index.ts'
import { directoryModule } from './directory/index.ts'
import { installModule } from './install/index.ts'
import { billingModule } from './billing/index.ts'
import { adminModule } from './admin/index.ts'
import { suppressionModule } from './suppression/index.ts'

/** Every control store module, wired once. A module adds itself here and nowhere else. */
const modules = { auth: authModule, accounts: accountsModule, directory: directoryModule, install: installModule, billing: billingModule, admin: adminModule, suppression: suppressionModule }

export const controlRegistry = buildRegistry<'control', ControlRpc>('control', Object.values(modules))

type ModuleActions<M> = M extends { register: (reg: any) => infer R } ? (R extends readonly AnyAction[] ? ActionsOf<R> : {}) : {}
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never

export type ControlActions = UnionToIntersection<ModuleActions<(typeof modules)[keyof typeof modules]>>
