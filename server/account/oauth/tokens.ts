import type { StoreCtx } from '../../core/store.ts'
import type { Actor } from '../../core/actions.ts'
import { randomToken, sha256, sha256Hex, timingSafeEqual, toBase64Url } from '../../core/crypto.ts'
import { formatOAuthToken, newId, parseOAuthToken, type OAuthTokenKind } from '../../core/ids.ts'
import { AppError } from '../../core/http.ts'
import { allowRate } from '../../core/ratelimit.ts'
import { publicOrigin } from '../../core/config.ts'
import { ACCESS_TTL_MS, CODE_TTL_MS, REFRESH_TTL_MS, isCodeVerifier, parseScope, resourceUrl, scopeAccess } from '../../core/oauth.ts'

export interface GrantRow {
  id: string
  client_id: string
  client_name: string
  client_secret_hash: string | null
  user_id: string
  scope: string
  resource: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}
interface TokenRow {
  hash: string
  grant_id: string
  kind: OAuthTokenKind
  expires_at: number
  used_at: number | null
  redirect_uri: string | null
  code_challenge: string | null
}

/** An OAuth error for the token and revocation endpoints (RFC 6749 §5.2). Never carries a token. */
export class OAuthError extends Error {
  constructor(public error: string, public description: string, public status = 400) {
    super(description)
  }
}

export class OAuthRateError extends AppError {
  constructor(public retryAfter: number) {
    super('rate_limited', 'This connection has reached 600 requests per minute.', 429)
  }
}

async function mint(ctx: StoreCtx, grantId: string, kind: OAuthTokenKind, ttl: number, extra: { redirectUri?: string; codeChallenge?: string } = {}) {
  const secret = randomToken()
  ctx.db.run(
    'INSERT INTO oauth_tokens (hash, grant_id, kind, expires_at, redirect_uri, code_challenge, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    await sha256Hex(secret), grantId, kind, ctx.now() + ttl, extra.redirectUri ?? null, extra.codeChallenge ?? null, ctx.now(),
  )
  return formatOAuthToken(kind, ctx.accountId!, secret)
}

/** Called by the control store once the owner approves. Creates the grant and its single-use code. */
export async function issueCode(ctx: StoreCtx, args: { clientId: string; clientName: string; clientSecretHash: string | null; userId: string; scope: string; resource: string; redirectUri: string; codeChallenge: string }) {
  const id = newId('oag')
  ctx.db.run(
    'INSERT INTO oauth_grants (id, client_id, client_name, client_secret_hash, user_id, scope, resource, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, args.clientId, args.clientName, args.clientSecretHash, args.userId, args.scope, args.resource, ctx.now(),
  )
  return { code: await mint(ctx, id, 'code', CODE_TTL_MS, { redirectUri: args.redirectUri, codeChallenge: args.codeChallenge }) }
}

async function findToken(ctx: StoreCtx, value: string, kind: OAuthTokenKind) {
  const parsed = parseOAuthToken(value)
  if (!parsed || parsed.kind !== kind || parsed.accountId !== ctx.accountId) return null
  const token = ctx.db.get<TokenRow>('SELECT * FROM oauth_tokens WHERE hash = ? AND kind = ?', await sha256Hex(parsed.secret), kind)
  if (!token) return null
  const grant = ctx.db.get<GrantRow>('SELECT * FROM oauth_grants WHERE id = ?', token.grant_id)
  return grant ? { token, grant } : null
}

export function revokeGrant(ctx: StoreCtx, grantId: string) {
  ctx.db.run('UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', ctx.now(), grantId)
  ctx.db.run('DELETE FROM oauth_tokens WHERE grant_id = ?', grantId)
}

async function checkClient(grant: GrantRow, clientId: string, clientSecret: string) {
  if (!clientId || clientId !== grant.client_id) throw new OAuthError('invalid_grant', 'The grant was issued to another client.')
  if (grant.client_secret_hash) {
    const given = clientSecret ? await sha256Hex(clientSecret) : ''
    if (!given || !timingSafeEqual(new TextEncoder().encode(given), new TextEncoder().encode(grant.client_secret_hash))) throw new OAuthError('invalid_client', 'Client authentication failed.', 401)
  }
}

async function tokenPair(ctx: StoreCtx, grant: GrantRow) {
  return {
    access_token: await mint(ctx, grant.id, 'access', ACCESS_TTL_MS),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: await mint(ctx, grant.id, 'refresh', REFRESH_TTL_MS),
    scope: grant.scope,
  }
}

/** The token endpoint (RFC 6749 §3.2, OAuth 2.1): authorization_code with PKCE, and refresh_token with rotation. */
export async function exchange(ctx: StoreCtx, form: URLSearchParams) {
  const grantType = form.get('grant_type') ?? ''
  const clientId = form.get('client_id') ?? ''
  const clientSecret = form.get('client_secret') ?? ''
  const resource = form.get('resource')
  const now = ctx.now()

  if (grantType === 'authorization_code') {
    const found = await findToken(ctx, form.get('code') ?? '', 'code')
    if (!found) throw new OAuthError('invalid_grant', 'The code is invalid or has expired.')
    const { token, grant } = found
    if (token.used_at !== null) {
      // A code used twice was probably stolen: drop everything it produced (RFC 6749 §4.1.2).
      revokeGrant(ctx, grant.id)
      throw new OAuthError('invalid_grant', 'The code was already used.')
    }
    ctx.db.run('UPDATE oauth_tokens SET used_at = ? WHERE hash = ?', now, token.hash)
    if (token.expires_at <= now || grant.revoked_at !== null) throw new OAuthError('invalid_grant', 'The code is invalid or has expired.')
    await checkClient(grant, clientId, clientSecret)
    if ((form.get('redirect_uri') ?? '') !== token.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.')
    const verifier = form.get('code_verifier') ?? ''
    if (!isCodeVerifier(verifier)) throw new OAuthError('invalid_request', 'Send a code_verifier of 43 to 128 characters.')
    const challenge = new TextEncoder().encode(toBase64Url(await sha256(verifier)))
    if (!timingSafeEqual(challenge, new TextEncoder().encode(token.code_challenge ?? ''))) throw new OAuthError('invalid_grant', 'code_verifier does not match the code_challenge.')
    if (resource !== null && resource !== grant.resource) throw new OAuthError('invalid_target', 'resource does not match the authorization request.')
    // The used code stays until it expires, so a replay is caught above.
    ctx.db.run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', now, grant.id)
    return tokenPair(ctx, grant)
  }

  if (grantType === 'refresh_token') {
    const found = await findToken(ctx, form.get('refresh_token') ?? '', 'refresh')
    if (!found) throw new OAuthError('invalid_grant', 'The refresh token is invalid or has expired.')
    const { token, grant } = found
    if (token.used_at !== null) {
      // A rotated refresh token came back: someone else holds a copy. End the whole grant.
      revokeGrant(ctx, grant.id)
      throw new OAuthError('invalid_grant', 'The refresh token was already used.')
    }
    if (token.expires_at <= now || grant.revoked_at !== null) throw new OAuthError('invalid_grant', 'The refresh token is invalid or has expired.')
    await checkClient(grant, clientId, clientSecret)
    if (resource !== null && resource !== grant.resource) throw new OAuthError('invalid_target', 'resource does not match the grant.')
    const asked = parseScope(form.get('scope'))
    if (asked.invalid || (asked.scope === 'mail:full' && grant.scope !== 'mail:full')) throw new OAuthError('invalid_scope', 'A refresh cannot add scopes.')
    ctx.db.run('UPDATE oauth_tokens SET used_at = ? WHERE hash = ?', now, token.hash)
    // Keep the used refresh token briefly so a replay is detected, then maintenance removes it.
    const narrowed = asked.scope && asked.scope !== grant.scope ? { ...grant, scope: asked.scope } : grant
    if (narrowed !== grant) ctx.db.run('UPDATE oauth_grants SET scope = ? WHERE id = ?', narrowed.scope, grant.id)
    ctx.db.run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?', now, grant.id)
    return tokenPair(ctx, narrowed)
  }

  throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.')
}

/** RFC 7009. Revoking a refresh token ends the grant; revoking an access token ends only that token. */
export async function revoke(ctx: StoreCtx, form: URLSearchParams) {
  const value = form.get('token') ?? ''
  const parsed = parseOAuthToken(value)
  if (!parsed || parsed.kind === 'code') return
  const found = await findToken(ctx, value, parsed.kind)
  if (!found) return
  const clientId = form.get('client_id')
  if (clientId && clientId !== found.grant.client_id) return
  if (found.grant.client_secret_hash) await checkClient(found.grant, clientId ?? '', form.get('client_secret') ?? '')
  if (parsed.kind === 'refresh') revokeGrant(ctx, found.grant.id)
  else ctx.db.run('DELETE FROM oauth_tokens WHERE hash = ?', found.token.hash)
}

/**
 * The actor for an OAuth access token on /mcp. Same shape as an API key's actor: the token's scope
 * sets read or full access, and the audience must be the /mcp URL of the host it was issued on.
 */
export async function authenticateAccessToken(ctx: StoreCtx, request: Request, value: string): Promise<Actor | null> {
  const found = await findToken(ctx, value, 'access')
  const now = ctx.now()
  if (!found || found.token.expires_at <= now || found.grant.revoked_at !== null) return null
  if (found.grant.resource !== resourceUrl(publicOrigin(ctx.config, new URL(request.url)))) return null
  const { grant } = found
  if (!allowRate(ctx.db, `oauth:${grant.id}`, 600, 60_000, now)) throw new OAuthRateError(Math.ceil((60_000 - now % 60_000) / 1000))
  ctx.db.run('UPDATE oauth_grants SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)', now, grant.id, now - 60_000)
  const email = ctx.db.get<{ value: string }>("SELECT value FROM account_meta WHERE key = 'owner_email'")?.value ?? ''
  return { userId: grant.user_id, email, owner: true, grants: {}, access: scopeAccess(grant.scope), via: 'mcp', keyId: grant.id, installAdmin: false }
}
