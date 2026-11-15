import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { randomToken, sha256Hex } from '../../core/crypto.ts'
import { formatApiKey, newId } from '../../core/ids.ts'
import { notFound } from '../../core/http.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { mountApi, reference } from '../../api/index.ts'
export { authenticateKey, KeyRateError } from './auth.ts'

const keyId = z.string().min(1).describe('The API key id')
const name = z.string().trim().min(1).max(120).describe('A name to identify this key')
const access = z.enum(['full', 'read']).default('full').describe('Full access or read-only access')

export const apikeysModule = {
  name: 'apikeys',
  register(reg: AccountRegistrar) {
    reg.routes(mountApi)
    reg.maintenance((ctx) => { ctx.db.run('DELETE FROM api_idempotency WHERE expires_at <= ?', ctx.now()) })
    return reg.actions(
      defineAction({
        name: 'apikeys.create', description: 'Create an API key. Save the secret now; it is shown only once.',
        scope: 'account', role: 'owner', effect: 'write', input: z.object({ name, access }),
        handler: async (ctx, input, actor) => {
          const secret = randomToken()
          const id = newId('key')
          ctx.db.run('INSERT INTO api_keys (id, name, hash, last4, access, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, input.name, await sha256Hex(secret), secret.slice(-4), input.access, actor.userId, ctx.now())
          return { id, name: input.name, access: input.access, secret: formatApiKey(ctx.accountId!, secret) }
        },
      }),
      defineAction({
        name: 'apikeys.list', description: 'List API keys without their secrets.', scope: 'account', role: 'owner', effect: 'read',
        input: z.object({ limit: z.number().int().min(1).max(100).default(50).describe('Maximum keys per page, up to 100'), cursor: z.string().optional().describe('The nextCursor from the previous page') }),
        rest: { method: 'GET', path: '/keys' }, mcp: { title: 'List API keys', destructive: false },
        handler: (ctx, input) => {
          const keys = ctx.db.all<{ id: string; name: string; last4: string; access: 'full' | 'read'; lastUsedAt: number | null; createdAt: number; revokedAt: number | null }>('SELECT id, name, last4, access, last_used_at AS lastUsedAt, created_at AS createdAt, revoked_at AS revokedAt FROM api_keys WHERE id > ? ORDER BY id LIMIT ?', input.cursor ?? '', input.limit + 1)
          const more = keys.length > input.limit
          const items = keys.slice(0, input.limit)
          return { keys: items, nextCursor: more ? items.at(-1)!.id : null }
        },
      }),
      defineAction({
        name: 'apikeys.rename', description: 'Rename an API key.', scope: 'account', role: 'owner', effect: 'write', resource: { type: 'apiKey', param: 'keyId' },
        input: z.object({ keyId, name }), rest: { method: 'PATCH', path: '/keys/:keyId' }, mcp: { title: 'Rename an API key', destructive: false },
        handler: (ctx, input) => {
          if (!ctx.db.run('UPDATE api_keys SET name = ? WHERE id = ? AND revoked_at IS NULL', input.name, input.keyId).changes) throw notFound('That key')
          return { id: input.keyId, name: input.name }
        },
      }),
      defineAction({
        name: 'apikeys.revoke', description: 'Revoke an API key immediately.', scope: 'account', role: 'owner', effect: 'write', resource: { type: 'apiKey', param: 'keyId' },
        input: z.object({ keyId }), rest: { method: 'DELETE', path: '/keys/:keyId' }, mcp: { title: 'Revoke an API key', destructive: true },
        handler: (ctx, input) => {
          if (!ctx.db.get('SELECT id FROM api_keys WHERE id = ?', input.keyId)) throw notFound('That key')
          ctx.db.run('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', ctx.now(), input.keyId)
          return { revoked: true }
        },
      }),
      defineAction({
        name: 'api.reference', description: 'Read the REST and MCP reference for this install.', scope: 'account', role: 'member', effect: 'read', input: z.object({}),
        handler: (ctx) => reference(ctx.registry, ctx.config.appUrl || ''),
      }),
    )
  },
}
