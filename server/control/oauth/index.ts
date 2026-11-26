import { z } from 'zod'
import { defineAction, type Actor } from '../../core/actions.ts'
import type { Migration } from '../../core/db.ts'
import type { StoreCtx } from '../../core/store.ts'
import { isAppHost, publicOrigin } from '../../core/config.ts'
import { randomToken, sha256Hex } from '../../core/crypto.ts'
import { newId } from '../../core/ids.ts'
import { AppError, clientIp, forbidden } from '../../core/http.ts'
import { allowRate } from '../../core/ratelimit.ts'
import { OAUTH_SCOPES, isCodeChallenge, parseScope, redirectUriMatches, redirectUriProblem, resourceUrl, type OAuthScope } from '../../core/oauth.ts'
import type { ControlRegistrar } from '../rpc.ts'

const migrations: readonly Migration[] = [{
  id: '2026-11-26-oauth-clients',
  sql: `CREATE TABLE oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, secret_hash TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);`,
}]

interface ClientRow { id: string; name: string; redirect_uris: string; secret_hash: string | null; created_at: number; last_used_at: number | null }

const CORS: Record<string, string> = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version' }
const registerError = (error: string, description: string, status = 400) => Response.json({ error, error_description: description }, { status, headers: { ...CORS, 'Cache-Control': 'no-store' } })

/** RFC 7591 dynamic client registration. Public clients (no secret) are the normal case for MCP. */
async function register(ctx: StoreCtx, request: Request, ip: string): Promise<Response> {
  if (!allowRate(ctx.db, `oauth-register:${ip}`, 30, 3_600_000, ctx.now())) return registerError('slow_down', 'Too many registrations from this address. Try again later.', 429)
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  } catch {
    return registerError('invalid_client_metadata', 'Send a JSON object.')
  }
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || uris.some((u) => typeof u !== 'string')) return registerError('invalid_redirect_uri', 'Send redirect_uris: one to ten URLs.')
  for (const uri of uris as string[]) {
    const problem = redirectUriProblem(uri)
    if (problem) return registerError('invalid_redirect_uri', `The redirect URI ${problem}.`)
  }
  const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : 'MCP client'
  const method = body.token_endpoint_auth_method ?? 'none'
  if (method !== 'none' && method !== 'client_secret_post') return registerError('invalid_client_metadata', 'token_endpoint_auth_method must be none or client_secret_post.')
  for (const [field, allowed] of [['grant_types', ['authorization_code', 'refresh_token']], ['response_types', ['code']]] as const) {
    const value = body[field]
    if (value !== undefined && (!Array.isArray(value) || value.some((v) => !(allowed as readonly string[]).includes(v)))) return registerError('invalid_client_metadata', `${field} may only contain ${allowed.join(' and ')}.`)
  }
  const id = newId('mcl')
  const secret = method === 'client_secret_post' ? randomToken() : null
  const now = ctx.now()
  ctx.db.run('INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)', id, name, JSON.stringify(uris), secret ? await sha256Hex(secret) : null, now)
  return Response.json({
    client_id: id,
    client_id_issued_at: Math.floor(now / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
  }, { status: 201, headers: { ...CORS, 'Cache-Control': 'no-store' } })
}

const authorizeInput = {
  origin: z.string().max(300).describe('The origin of the page the user is on'),
  client_id: z.string().max(100).default('').describe('The registered client id'),
  redirect_uri: z.string().max(2000).default('').describe('Where to send the user back; must match a registered URI'),
  response_type: z.string().max(50).default('').describe('Must be code'),
  code_challenge: z.string().max(200).default('').describe('PKCE challenge: base64url SHA-256 of the verifier'),
  code_challenge_method: z.string().max(20).default('').describe('Must be S256'),
  state: z.string().max(1000).optional().describe('Opaque value returned to the client unchanged'),
  scope: z.string().max(500).optional().describe('mail:read or mail:full, space-separated'),
  resource: z.string().max(2000).optional().describe('The MCP server URL the token is for (RFC 8707)'),
}
type AuthorizeInput = z.output<z.ZodObject<typeof authorizeInput>>

/** An error the client should hear about at its redirect URI (RFC 6749 §4.1.2.1). */
class RedirectError extends Error {
  constructor(public error: string, public description: string) { super(description) }
}

function redirectWith(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)
  return url.toString()
}

/**
 * Validate an authorization request. Problems with the client or redirect URI throw an AppError and are
 * shown to the user, never sent to the redirect URI. Anything else throws a RedirectError.
 */
function checkRequest(ctx: StoreCtx, input: AuthorizeInput) {
  let origin: URL
  try { origin = new URL(input.origin) } catch { throw new AppError('invalid_request', 'Open this page from MailCorgi.') }
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || !isAppHost(ctx.config, origin.host)) throw new AppError('invalid_request', 'Open this page from MailCorgi.')
  const client = input.client_id ? ctx.db.get<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', input.client_id) : null
  if (!client) throw new AppError('invalid_client', 'This app is not registered with MailCorgi. Remove it from your MCP client and add the server URL again.')
  if (!input.redirect_uri || !redirectUriMatches(JSON.parse(client.redirect_uris) as string[], input.redirect_uri)) throw new AppError('invalid_redirect_uri', 'This app asked to return to an address it did not register.')
  if (input.state !== undefined && !/^[\x20-\x7e]*$/.test(input.state)) throw new RedirectError('invalid_request', 'state must be printable ASCII.')
  if (input.response_type !== 'code') throw new RedirectError('unsupported_response_type', 'Only response_type=code is supported.')
  if (input.code_challenge_method !== 'S256' || !isCodeChallenge(input.code_challenge)) throw new RedirectError('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.')
  const scope = parseScope(input.scope)
  if (scope.invalid) throw new RedirectError('invalid_scope', `Unknown scope. Use ${Object.keys(OAUTH_SCOPES).join(' or ')}.`)
  const issuer = publicOrigin(ctx.config, origin)
  const resource = resourceUrl(issuer)
  if (input.resource !== undefined && input.resource.replace(/\/$/, '') !== resource) throw new RedirectError('invalid_target', `resource must be ${resource}.`)
  return { client, origin: issuer, resource, requested: scope.scope }
}

const ownedAccounts = (ctx: StoreCtx, userId: string) =>
  ctx.db.all<{ id: string; name: string }>("SELECT id, name FROM accounts WHERE owner_user_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY created_at", userId)

const webOnly = (actor: Actor) => { if (actor.via !== 'web') throw forbidden('Approve apps from the MailCorgi website.') }

export const oauthControlModule = {
  name: 'oauth',
  register(reg: ControlRegistrar) {
    reg.migrations(migrations)
    reg.routes((app) => {
      app.options('/oauth/register', () => new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } }))
      app.post('/oauth/register', (c) => register(c.get('ctx'), c.req.raw, clientIp(c)))
    })
    reg.maintenance((ctx) => {
      // Clients that never finished a sign-in in a week, or went a year without one.
      ctx.db.run('DELETE FROM oauth_clients WHERE (last_used_at IS NULL AND created_at <= ?) OR last_used_at <= ?', ctx.now() - 7 * 86_400_000, ctx.now() - 365 * 86_400_000)
    })
    return reg.actions(
      defineAction({
        name: 'oauth.describe', description: 'Check an OAuth authorization request and describe it for the consent screen.', scope: 'control', role: 'user', effect: 'read', input: z.object(authorizeInput),
        handler: (ctx, input, actor) => {
          webOnly(actor)
          try {
            const { client, requested, resource } = checkRequest(ctx, input)
            const redirect = new URL(input.redirect_uri)
            return {
              ok: true as const,
              client: { name: client.name, redirectTo: redirect.protocol === 'https:' || redirect.protocol === 'http:' ? redirect.host : `${redirect.protocol}//` },
              requested,
              resource,
              scopes: OAUTH_SCOPES,
              accounts: ownedAccounts(ctx, actor.userId),
            }
          } catch (err) {
            if (err instanceof RedirectError) return { ok: false as const, error: err.description, redirect: redirectWith(input.redirect_uri, { error: err.error, error_description: err.description, state: input.state }) }
            throw err
          }
        },
      }),
      defineAction({
        name: 'oauth.decide', description: 'Approve or deny an OAuth authorization request. Returns the address to send the user back to.', scope: 'control', role: 'user', effect: 'write',
        input: z.object({ ...authorizeInput, approve: z.boolean().describe('True to approve, false to deny'), accountId: z.string().max(40).optional().describe('The account to connect; the user must own it'), grantScope: z.enum(['mail:read', 'mail:full']).optional().describe('The access the user chose') }),
        handler: async (ctx, input, actor) => {
          webOnly(actor)
          let checked: ReturnType<typeof checkRequest>
          try {
            checked = checkRequest(ctx, input)
          } catch (err) {
            if (err instanceof RedirectError) return { redirect: redirectWith(input.redirect_uri, { error: err.error, error_description: err.description, state: input.state }) }
            throw err
          }
          const { client, origin, resource, requested } = checked
          if (!input.approve) return { redirect: redirectWith(input.redirect_uri, { error: 'access_denied', error_description: 'The user denied access.', state: input.state, iss: origin }) }
          const account = ownedAccounts(ctx, actor.userId).find((a) => a.id === input.accountId)
          if (!account) throw forbidden('Only the account owner can connect apps. Pick an account you own.')
          const scope: OAuthScope = input.grantScope ?? requested ?? 'mail:read'
          if (requested === 'mail:read' && scope === 'mail:full') throw new AppError('invalid_scope', 'This app asked for read-only access.')
          const { code } = await ctx.stores.account(account.id).oauthIssueCode({ clientId: client.id, clientName: client.name, clientSecretHash: client.secret_hash, userId: actor.userId, scope, resource, redirectUri: input.redirect_uri, codeChallenge: input.code_challenge })
          ctx.db.run('UPDATE oauth_clients SET last_used_at = ? WHERE id = ?', ctx.now(), client.id)
          return { redirect: redirectWith(input.redirect_uri, { code, state: input.state, iss: origin }) }
        },
      }),
    )
  },
}
