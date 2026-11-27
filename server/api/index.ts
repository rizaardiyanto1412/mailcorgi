import type { Hono } from 'hono'
import type { StoreEnv } from '../core/http.ts'
import { AppError } from '../core/http.ts'
import { authenticateKey } from '../account/apikeys/index.ts'
import { apiError } from './errors.ts'
import { executeRest, matchAction, restInput } from './rest.ts'
import { mcp } from './mcp.ts'
import { openApi } from './reference.ts'
export { reference, openApi, markdown } from './reference.ts'

const SEND_DETAIL = /^\/api\/v1\/newsletters\/[^/]+\/sends\/[^/]+$/

/** The send detail carries a recipient's email, so every answer on its path, errors included, is private and never stored. */
export const isSendDetailPath = (path: string) => SEND_DETAIL.test(path)
export function privateNoStore(response: Response): Response {
  if (response.headers.get('Cache-Control') === 'private, no-store') return response
  const out = new Response(response.body, response)
  out.headers.set('Cache-Control', 'private, no-store')
  return out
}

export function mountApi(app: Hono<StoreEnv>) {
  app.all('/api/v1/*', async (c) => {
    const response = await (async () => {
      try {
        const ctx = c.get('ctx')
        const actor = await authenticateKey(ctx, c.req.raw, 'api')
        if (c.req.path === '/api/v1/openapi.json' && c.req.method === 'GET') return Response.json(openApi(ctx.registry, ctx.config.appUrl))
        const matched = matchAction(ctx, c.req.method, c.req.path.slice('/api/v1'.length))
        const input = await restInput(c.req.raw, matched.action, matched.params)
        return await executeRest(ctx, matched.action, input, actor, c.req.header('Idempotency-Key') ?? null)
      } catch (err) { return apiError(err) }
    })()
    return isSendDetailPath(c.req.path) ? privateNoStore(response) : response
  })
  app.all('/mcp', async (c) => {
    try {
      if (c.req.method !== 'POST') return Response.json({ error: { code: 'method_not_allowed', message: 'Use POST for MCP.' } }, { status: 405, headers: { Allow: 'POST' } })
      const ctx = c.get('ctx')
      const origin = c.req.header('origin')
      const appOrigin = new URL(ctx.config.appUrl || c.req.url)
      const allowed = [appOrigin.origin, ...ctx.config.appHosts.map((h) => `${appOrigin.protocol}//${h}`)]
      if (origin && !allowed.includes(origin)) throw new AppError('forbidden', 'This origin is not allowed.', 403)
      const actor = await authenticateKey(ctx, c.req.raw, 'mcp')
      return await mcp(c.req.raw, ctx, actor)
    } catch (err) { return apiError(err) }
  })
}
