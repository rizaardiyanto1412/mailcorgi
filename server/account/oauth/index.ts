import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import type { Migration } from '../../core/db.ts'
import { asAppError, notFound } from '../../core/http.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { exchange, issueCode, OAuthError, revoke, revokeGrant, type GrantRow } from './tokens.ts'
export { authenticateAccessToken, OAuthRateError } from './tokens.ts'

declare module '../rpc.ts' {
  interface AccountRpc {
    oauthIssueCode(args: { clientId: string; clientName: string; clientSecretHash: string | null; userId: string; scope: string; resource: string; redirectUri: string; codeChallenge: string }): Promise<{ code: string }>
  }
}

const migrations: readonly Migration[] = [{
  id: '2026-11-26-oauth-grants',
  sql: `
    CREATE TABLE oauth_grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, client_name TEXT NOT NULL, client_secret_hash TEXT, user_id TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
    CREATE TABLE oauth_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, redirect_uri TEXT, code_challenge TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
    CREATE INDEX oauth_tokens_expiry ON oauth_tokens(expires_at);
  `,
}]

/** CORS for the token and revocation endpoints: MCP clients may call them from a browser. */
export const OAUTH_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
}
const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  const text = await request.text()
  if (type === 'application/json') {
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      return new URLSearchParams(Object.entries(body ?? {}).filter(([, v]) => typeof v === 'string') as [string, string][])
    } catch {
      throw new OAuthError('invalid_request', 'The body is not valid JSON.')
    }
  }
  return new URLSearchParams(text)
}

const oauthError = (err: unknown) => {
  if (err instanceof OAuthError) return Response.json({ error: err.error, error_description: err.description }, { status: err.status, headers: { ...NO_STORE, ...OAUTH_CORS, ...(err.status === 401 ? { 'WWW-Authenticate': 'Basic realm="oauth"' } : {}) } })
  const app = asAppError(err)
  if (app) return Response.json({ error: app.status === 429 ? 'slow_down' : 'temporarily_unavailable', error_description: app.message }, { status: app.status, headers: { ...NO_STORE, ...OAUTH_CORS } })
  return Response.json({ error: 'server_error', error_description: 'Something went wrong.' }, { status: 500, headers: { ...NO_STORE, ...OAUTH_CORS } })
}

const grantId = z.string().min(1).describe('The connected app id')

export const oauthModule = {
  name: 'oauth',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    reg.rpc('oauthIssueCode', (ctx, args) => issueCode(ctx, args))
    reg.routes((app) => {
      app.post('/oauth/token', async (c) => {
        try {
          return Response.json(await exchange(c.get('ctx'), await readForm(c.req.raw)), { headers: { ...NO_STORE, ...OAUTH_CORS } })
        } catch (err) { return oauthError(err) }
      })
      app.post('/oauth/revoke', async (c) => {
        try {
          await revoke(c.get('ctx'), await readForm(c.req.raw))
          return new Response(null, { status: 200, headers: { ...NO_STORE, ...OAUTH_CORS } })
        } catch (err) { return oauthError(err) }
      })
    })
    reg.maintenance((ctx) => {
      const now = ctx.now()
      ctx.db.run('DELETE FROM oauth_tokens WHERE expires_at <= ?', now)
      // A grant whose code was never exchanged, or that was revoked a month ago, has nothing left to show.
      ctx.db.run('DELETE FROM oauth_grants WHERE last_used_at IS NULL AND created_at <= ? AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id)', now - 86_400_000)
      ctx.db.run('DELETE FROM oauth_grants WHERE revoked_at IS NOT NULL AND revoked_at <= ?', now - 30 * 86_400_000)
      // A grant with no live refresh token has expired.
      ctx.db.run("UPDATE oauth_grants SET revoked_at = ? WHERE revoked_at IS NULL AND last_used_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id AND t.kind = 'refresh')", now)
    })
    return reg.actions(
      defineAction({
        name: 'oauth.listApps', description: 'List apps connected to this account with OAuth.', scope: 'account', role: 'owner', effect: 'read', input: z.object({}),
        handler: (ctx) => {
          const rows = ctx.db.all<Pick<GrantRow, 'id' | 'client_name' | 'scope' | 'resource' | 'created_at' | 'last_used_at'>>(
            "SELECT id, client_name, scope, resource, created_at, last_used_at FROM oauth_grants WHERE revoked_at IS NULL AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id AND t.kind = 'refresh' AND t.used_at IS NULL AND t.expires_at > ?) ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 200",
            ctx.now(),
          )
          return { apps: rows.map((r) => ({ id: r.id, name: r.client_name, scope: r.scope as 'mail:read' | 'mail:full', host: new URL(r.resource).host, connectedAt: r.created_at, lastUsedAt: r.last_used_at })) }
        },
      }),
      defineAction({
        name: 'oauth.revokeApp', description: 'Disconnect an OAuth app. Its tokens stop working at once.', scope: 'account', role: 'owner', effect: 'write', input: z.object({ grantId }),
        handler: (ctx, input) => {
          if (!ctx.db.get('SELECT id FROM oauth_grants WHERE id = ?', input.grantId)) throw notFound('That app')
          revokeGrant(ctx, input.grantId)
          return { revoked: true }
        },
      }),
    )
  },
}
