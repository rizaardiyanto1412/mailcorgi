import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import type { ControlRegistrar } from '../control/rpc.ts'
import { isInstallAdmin } from '../control/accounts/index.ts'

type KeyActor = Pick<Actor, 'userId' | 'access' | 'via' | 'keyId' | 'oauth'>

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
      // An account key never inherits the creating user's install-admin privileges. An OAuth session
      // is the signed-in user, so it is an install admin exactly when a web session would be.
      const user = actor.oauth
        ? ctx.db.get<{ email: string; is_install_admin: number; email_verified_at: number | null }>('SELECT email, is_install_admin, email_verified_at FROM users WHERE id = ? AND disabled = 0', actor.userId)
        : undefined
      return runAction(ctx, name, input, { ...actor, email: user?.email ?? '', owner: false, grants: {}, installAdmin: !!user && isInstallAdmin(ctx, user) })
    })
  },
}
