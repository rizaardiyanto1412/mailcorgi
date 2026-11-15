import type { AccountActions } from './account/modules.ts'
import type { ControlActions } from './control/modules.ts'
import type { InputOf, OutputOf } from './core/actions.ts'

/** Every action the dashboard may call, typed from the server registry. */
export type Actions = AccountActions & ControlActions
export type ActionName = keyof Actions & string
export type ActionInput<K extends ActionName> = InputOf<Actions[K]>
export type ActionOutput<K extends ActionName> = OutputOf<Actions[K]>
