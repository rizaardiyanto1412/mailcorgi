import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import type { ControlRegistrar } from '../control/rpc.ts'

type KeyActor = Pick<Actor, 'userId' | 'access' | 'via' | 'keyId'>

declare module '../control/rpc.ts' {
  interface ControlRpc {
    runApiAction(args: { name: string; input: unknown; actor: KeyActor }): Promise<unknown>
  }
}

export const apiControlModule = {
  name: 'api',
  register(reg: ControlRegistrar) {
    reg.rpc('runApiAction', (ctx, { name, input, actor }) => {
      const action = ctx.registry.actions.get(name)
      if (!action || (actor.via === 'mcp' ? !action.mcp : !action.rest)) throw new AppError('unknown_action', 'That action is not exposed.', 404)
      // An account key never inherits the creating user's install-admin privileges.
      return runAction(ctx, name, input, { ...actor, email: '', owner: false, grants: {}, installAdmin: false })
    })
  },
}
