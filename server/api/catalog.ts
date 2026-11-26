import { controlRegistry } from '../control/modules.ts'
import { runAction, type Actor, type AnyAction, type Registry } from '../core/actions.ts'
import type { StoreCtx } from '../core/store.ts'

export function exposedActions(registry: Registry) {
  return [...registry.actions.values(), ...controlRegistry.actions.values()]
}

export function runExposedAction(ctx: StoreCtx, action: AnyAction, input: unknown, actor: Actor) {
  if (action.scope === 'account') return runAction(ctx, action.name, input, actor)
  return ctx.stores.control.runApiAction({ name: action.name, input, actor: { userId: actor.userId, access: actor.access, via: actor.via, keyId: actor.keyId, oauth: actor.oauth } })
}
