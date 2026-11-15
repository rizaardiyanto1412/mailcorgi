import type { Hono } from 'hono'
import type { StoreEnv } from '../core/http.ts'
import { AppError } from '../core/http.ts'
import { authenticateKey } from '../account/apikeys/index.ts'
import { apiError } from './errors.ts'
import { executeRest, matchAction, restInput } from './rest.ts'
import { mcp } from './mcp.ts'
import { openApi } from './reference.ts'
export { reference, openApi, markdown } from './reference.ts'

export function mountApi(app: Hono<StoreEnv>) {
  app.all('/api/v1/*', async (c) => {
    try {
      const ctx = c.get('ctx')
      const actor = await authenticateKey(ctx, c.req.raw, 'api')
      if (c.req.path === '/api/v1/openapi.json' && c.req.method === 'GET') return Response.json(openApi(ctx.registry, ctx.config.appUrl))
      const matched = matchAction(ctx, c.req.method, c.req.path.slice('/api/v1'.length))
      const input = await restInput(c.req.raw, matched.action, matched.params)
      return await executeRest(ctx, matched.action, input, actor, c.req.header('Idempotency-Key') ?? null)
    } catch (err) { return apiError(err) }
  })
  app.all('/mcp', async (c) => {
    try {
      if (c.req.method !== 'POST') return Response.json({ error: { code: 'method_not_allowed', message: 'Use POST for MCP.' } }, { status: 405, headers: { Allow: 'POST' } })
      const ctx = c.get('ctx')
      const origin = c.req.header('origin')
      const allowed = new URL(ctx.config.appUrl || c.req.url).origin
      if (origin && origin !== allowed) throw new AppError('forbidden', 'This origin is not allowed.', 403)
      const actor = await authenticateKey(ctx, c.req.raw, 'mcp')
      return await mcp(c.req.raw, ctx, actor)
    } catch (err) { return apiError(err) }
  })
}
