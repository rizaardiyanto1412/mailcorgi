/**
 * The stateless edge: works out who is asking and which store answers, then forwards the request
 * with a signed actor envelope. Section 3.5 of docs/architecture.md is the routing table.
 */
import { handleEmailHook } from './email-hooks.ts'
import type { Config } from '../core/config.ts'
import { appHost, isAppHost, publicOrigin } from '../core/config.ts'
import { authorizationServerMetadata, protectedResourceMetadata, resourceMetadataUrl } from '../core/oauth.ts'
import type { Keys } from '../core/crypto.ts'
import { sha256Hex, signEnvelope } from '../core/crypto.ts'
import type { BlobStore, StoreRef } from '../core/platform.ts'
import type { Meter } from '../core/db.ts'
import { storeId } from '../core/platform.ts'
import { ACTOR_HEADER, ACTOR_TTL_MS, type ActorEnvelope, type Stores } from '../core/store.ts'
import type { Actor } from '../core/actions.ts'
import { accountIdOfToken, isAccountId, parseApiKey, parseNewsletterKey, parseOAuthToken } from '../core/ids.ts'
import { CLIENT_IP_HEADER, errorResponse, withSecurityHeaders } from '../core/http.ts'
import type { SessionInfo, SiteRow } from '../control/rpc.ts'
import { accountRegistry } from '../account/modules.ts'
import { isSendDetailPath, markdown, privateNoStore } from '../api/index.ts'
import { controlRegistry } from '../control/modules.ts'
import { HSTS_VALUE, wantsHsts } from './assets.ts'

export const SESSION_COOKIE = 'mc_session'
export const ACCOUNT_COOKIE = 'mc_account'
export const CSRF_HEADER = 'x-mc-csrf'
const SITE_CACHE_MS = 60_000
const ACCOUNT_CACHE_MS = 5_000

export interface EdgeDeps {
  config: Config
  keys: () => Promise<Keys>
  stores: Stores
  storeFetch(ref: StoreRef, request: Request): Promise<Response>
  /** Images, when the edge can reach them directly. Null means ask the account store. */
  blobs: BlobStore | null
  assets(request: Request): Promise<Response>
  now(): number
  fetch?: typeof fetch
  /** Dev mode: a store's write meter, without going through its request path. */
  meter?(ref: StoreRef): Promise<Meter>
  /** The client address the platform can vouch for, given the socket peer when it has one. */
  clientIp?(request: Request, peer: string | null): string
  /** Node: whether the socket peer is a trusted proxy. When it is not, forwarding headers are dropped. */
  trustsProxy?(peer: string | null): boolean
}

export interface Edge {
  fetch(request: Request, peer?: string | null): Promise<Response>
}

const CONTROL_PREFIXES = ['/api/auth/', '/api/control/', '/api/billing/', '/api/admin/']
const TOKEN_PREFIXES = ['/t/o/', '/t/c/', '/u/', '/confirm/', '/keep/']

const json = (body: unknown, status = 200) => Response.json(body, { status })
/** CORS for OAuth discovery and the token, registration and revocation endpoints. Bearer tokens only, no cookies. */
const OAUTH_CORS: Record<string, string> = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version', 'Access-Control-Max-Age': '86400' }
const OAUTH_PATHS = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token', '/oauth/revoke'])
const withCors = (response: Response) => {
  const out = new Response(response.body, response)
  for (const [k, v] of Object.entries(OAUTH_CORS)) out.headers.set(k, v)
  return out
}
const notFound = () => json({ error: 'Not found.', code: 'not_found' }, 404)
const unauthorized = (message = 'Sign in to continue.') => json({ error: message, code: 'unauthorized' }, 401)

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

export function createEdge(deps: EdgeDeps): Edge {
  let learnedHost = ''
  const accountCache = new Map<string, { at: number; exists: boolean }>()
  const siteCache = new Map<string, { at: number; site: SiteRow | null }>()

  const trim = (map: Map<string, unknown>) => {
    if (map.size > 5000) for (const key of [...map.keys()].slice(0, 1000)) map.delete(key)
  }

  async function accountExists(accountId: string): Promise<boolean> {
    if (!isAccountId(accountId)) return false
    const hit = accountCache.get(accountId)
    if (hit && deps.now() - hit.at < ACCOUNT_CACHE_MS) return hit.exists
    const exists = await deps.stores.control.accountExists({ accountId })
    accountCache.set(accountId, { at: deps.now(), exists })
    trim(accountCache)
    return exists
  }

  async function resolveSession(sessionId: string, wantAccountId: string | null): Promise<SessionInfo | null> {
    return deps.stores.control.resolveSession({ sessionId, wantAccountId })
  }

  async function lookupSite(where: { slug?: string; host?: string }): Promise<SiteRow | null> {
    const cacheKey = where.slug ? `slug:${where.slug}` : `host:${where.host}`
    const hit = siteCache.get(cacheKey)
    if (hit && deps.now() - hit.at < SITE_CACHE_MS) return hit.site
    const site = await deps.stores.control.lookupSite(where)
    if (site) siteCache.set(cacheKey, { at: deps.now(), site })
    trim(siteCache)
    return site
  }

  const stripHeaders = (request: Request) => {
    const headers = new Headers(request.headers)
    for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith('x-mc-')) headers.delete(name)
    return headers
  }

  async function signActor(actor: Actor, aud: string): Promise<string> {
    const keys = await deps.keys()
    const envelope: ActorEnvelope = { actor, aud, exp: deps.now() + ACTOR_TTL_MS }
    return signEnvelope(keys.session, envelope)
  }

  const forward = async (ref: StoreRef, request: Request, headers: Headers, extra: Record<string, string> = {}) => {
    if (ref.kind === 'account' && !(await accountExists(ref.accountId))) return notFound()
    for (const [name, value] of Object.entries(extra)) headers.set(name, value)
    if (ref.kind === 'account') headers.set('x-mc-account', ref.accountId)
    return deps.storeFetch(ref, new Request(request, { headers }))
  }

  const sessionActor = (info: SessionInfo, accountId: string | null): Actor => {
    const account = accountId ? info.accounts.find((a) => a.id === accountId) : null
    return { userId: info.user.id, email: info.user.email, owner: account?.owner ?? false, grants: account?.grants ?? {}, access: 'full', via: 'web', installAdmin: info.user.isInstallAdmin }
  }

  async function forwardSite(site: SiteRow, request: Request, headers: Headers, custom = false) {
    // The actor only lets the owner's own visits skip page-view counting. Custom hosts serve
    // anonymous reads and public form posts, and a state-changing method gets no actor anywhere.
    const cookies = parseCookies(request.headers.get('cookie'))
    if (!custom && (request.method === 'GET' || request.method === 'HEAD') && cookies[SESSION_COOKIE]) {
      const info = await resolveSession(await sha256Hex(cookies[SESSION_COOKIE]), site.account_id)
      if (info?.accounts.some((a) => a.id === site.account_id && a.owner)) {
        headers.set(ACTOR_HEADER, await signActor(sessionActor(info, site.account_id), site.account_id))
      }
    }
    return forward({ kind: 'account', accountId: site.account_id }, request, headers, { 'x-mc-site': site.newsletter_id, ...(custom ? { 'x-mc-host': new URL(request.url).host } : {}) })
  }

  async function serveImage(accountId: string, key: string): Promise<Response> {
    if (!key || key.includes('..') || !(await accountExists(accountId))) return notFound()
    const fullKey = `${accountId}/${key}`
    let bytes: Uint8Array | null = null
    let contentType = 'application/octet-stream'
    if (deps.blobs) {
      const blob = await deps.blobs.get(fullKey)
      if (blob) {
        bytes = blob.bytes
        contentType = blob.contentType || contentType
      }
    } else {
      const blob = await deps.stores.account(accountId).blobGet({ key: fullKey })
      if (blob) {
        bytes = Uint8Array.from(blob.bytes)
        contentType = blob.contentType || contentType
      }
    }
    if (!bytes) return notFound()
    return new Response(bytes as BodyInit, { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } })
  }

  /** The form fields of a token or revocation request, read from a copy so the store still gets the body. */
  async function oauthForm(request: Request): Promise<URLSearchParams> {
    const text = (await request.clone().text()).slice(0, 20_000)
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json') {
      try {
        const body = JSON.parse(text) as Record<string, unknown>
        return new URLSearchParams(Object.entries(body ?? {}).filter(([, v]) => typeof v === 'string') as [string, string][])
      } catch { return new URLSearchParams() }
    }
    return new URLSearchParams(text)
  }

  async function handle(request: Request, peer: string | null): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const headers = stripHeaders(request)
    if (deps.trustsProxy && !deps.trustsProxy(peer)) for (const name of ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip']) headers.delete(name)
    const ip = deps.clientIp?.(request, peer) ?? ''
    if (ip) headers.set(CLIENT_IP_HEADER, ip)
    const method = request.method.toUpperCase()
    if (path === '/healthz') return json({ ok: true })
    // Dev mode: rows written and read by the control store and the named account stores.
    if (path === '/api/dev/writes' && deps.config.testDns && deps.meter) {
      const refs: StoreRef[] = [{ kind: 'control' }, ...(url.searchParams.get('accounts') || '').split(',').filter(isAccountId).map((accountId) => ({ kind: 'account' as const, accountId }))]
      const stores: Record<string, Meter> = {}
      for (const ref of refs) stores[storeId(ref)] = await deps.meter(ref)
      const writes = Object.values(stores).reduce((n, m) => n + m.writes, 0)
      const reads = Object.values(stores).reduce((n, m) => n + m.reads, 0)
      return json({ writes, reads, stores })
    }

    if (!appHost(deps.config) && !learnedHost) {
      const setupEntry = method === 'GET' && ['/', '/setup', '/signin', '/signup', '/api/auth/bootstrap'].includes(path)
      learnedHost = await deps.stores.control.resolveAppHost({ setupOrigin: setupEntry ? url.origin : undefined })
    }
    const host = appHost(deps.config) || learnedHost

    // Caddy's on-demand TLS asks here before it issues a certificate for an app host or a custom website host.
    if (path === '/api/public/tls-check') {
      const domain = (url.searchParams.get('domain') || '').toLowerCase()
      const known = domain !== '' && (isAppHost(deps.config, domain, host) || (await deps.stores.control.lookupSite({ host: domain })) !== null)
      return known ? json({ ok: true }) : notFound()
    }

    // The APP_URL host and its APP_HOSTS aliases serve the app. Any other host is a customer website or a 404.
    if (!isAppHost(deps.config, url.host, host)) {
      const site = await lookupSite({ host: url.host.toLowerCase() })
      if (!site) return notFound()
      return forwardSite(site, request, headers, true)
    }

    if (path.startsWith('/img/')) {
      const [accountId, ...rest] = path.slice(5).split('/')
      return serveImage(accountId, rest.join('/'))
    }
    if (path === '/llms.txt' && method === 'GET') return new Response(markdown(accountRegistry, deps.config.appUrl), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

    if (path === '/hooks/stripe' || path === '/hooks/polar' || (path === '/hooks/test' && deps.config.testDns)) return forward({ kind: 'control' }, request, headers)
    // Dev mode only: the newest sign-in code for an address, so an unattended cloud journey can sign up.
    if (path === '/api/dev/code' && deps.config.testDns) return forward({ kind: 'control' }, request, headers)
    if (path === '/hooks/ses' || path === '/hooks/resend' || path === '/hooks/postshiba') return handleEmailHook(deps, request, accountExists)

    // OAuth 2.1 for MCP clients (docs/api.md). The issuer is this host's public origin.
    if (OAUTH_PATHS.has(path)) {
      const origin = publicOrigin(deps.config, url)
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: OAUTH_CORS })
      if (path.startsWith('/.well-known/')) {
        if (method !== 'GET' && method !== 'HEAD') return withCors(json({ error: 'Use GET.', code: 'method_not_allowed' }, 405))
        const body = path === '/.well-known/oauth-authorization-server' ? authorizationServerMetadata(origin) : protectedResourceMetadata(origin)
        return withCors(Response.json(body, { headers: { 'Cache-Control': 'public, max-age=3600' } }))
      }
      if (method !== 'POST') return withCors(json({ error: 'invalid_request', error_description: 'Use POST.' }, 405))
      if (path === '/oauth/register') return withCors(await forward({ kind: 'control' }, request, headers))
      // The code, refresh token or token to revoke names its account, like an API key does.
      const form = await oauthForm(request)
      const value = path === '/oauth/revoke' ? form.get('token') : form.get('grant_type') === 'refresh_token' ? form.get('refresh_token') : form.get('code')
      const token = value ? parseOAuthToken(value) : null
      if (!token || !(await accountExists(token.accountId))) {
        if (path === '/oauth/revoke') return new Response(null, { status: 200, headers: OAUTH_CORS })
        const unsupported = !['authorization_code', 'refresh_token'].includes(form.get('grant_type') ?? '')
        return withCors(Response.json(unsupported ? { error: 'unsupported_grant_type', error_description: 'Use authorization_code or refresh_token.' } : { error: 'invalid_grant', error_description: 'The code or refresh token is invalid or has expired.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }))
      }
      return withCors(await forward({ kind: 'account', accountId: token.accountId }, request, headers))
    }

    if (path.startsWith('/api/v1/') || path === '/mcp') {
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')
      const key = bearer ? parseApiKey(bearer[1]) : null
      const oauth = path === '/mcp' && bearer && !key ? parseOAuthToken(bearer[1]) : null
      const accountId = key?.accountId ?? (oauth?.kind === 'access' ? oauth.accountId : null)
      const response = accountId && (!oauth || (await accountExists(accountId)))
        ? await forward({ kind: 'account', accountId }, request, headers)
        : json({ error: { code: 'unauthorized', message: path === '/mcp' ? 'Sign in with OAuth, or send an API key as "Authorization: Bearer mc_…".' : 'Send an API key as "Authorization: Bearer mc_…".' } }, 401)
      // MCP clients find the authorization server from this challenge (RFC 9728 §5.1).
      if (path === '/mcp' && response.status === 401) {
        const challenge = new Response(response.body, response)
        challenge.headers.set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl(publicOrigin(deps.config, url))}"${bearer ? ', error="invalid_token"' : ''}`)
        return challenge
      }
      return isSendDetailPath(path) ? privateNoStore(response) : response
    }

    for (const prefix of TOKEN_PREFIXES) {
      if (!path.startsWith(prefix)) continue
      const accountId = accountIdOfToken(path.slice(prefix.length))
      return accountId ? forward({ kind: 'account', accountId }, request, headers) : notFound()
    }

    if (path.startsWith('/api/public/subscribe/') || path.startsWith('/f/') || path === '/embed.js') {
      const key = path === '/embed.js' ? url.searchParams.get('key') || '' : path.split('/').filter(Boolean).pop() || ''
      const parsed = parseNewsletterKey(key)
      return parsed ? forward({ kind: 'account', accountId: parsed.accountId }, request, headers) : notFound()
    }

    if (path === '/n' || path.startsWith('/n/')) {
      const slug = path.split('/')[2]?.toLowerCase() || ''
      const site = slug ? await lookupSite({ slug }) : null
      if (!site) return notFound()
      return forwardSite(site, request, headers)
    }

    const isControl = CONTROL_PREFIXES.some((p) => path.startsWith(p))
    const isAction = path.startsWith('/api/actions/')
    if (isControl || isAction) {
      const cookies = parseCookies(request.headers.get('cookie'))
      const token = cookies[SESSION_COOKIE]
      const sessionId = token ? await sha256Hex(token) : null
      const info = sessionId ? await resolveSession(sessionId, cookies[ACCOUNT_COOKIE] || null) : null
      if (info && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && request.headers.get(CSRF_HEADER) !== info.csrf) {
        return json({ error: 'Request blocked. Reload the page and try again.', code: 'csrf' }, 403)
      }

      if (isAction) {
        const name = path.slice('/api/actions/'.length)
        const scope = accountRegistry.actions.has(name) ? 'account' : controlRegistry.actions.has(name) ? 'control' : null
        if (!scope) return json({ error: `Unknown action ${name}.`, code: 'unknown_action' }, 404)
        if (!info) return unauthorized()
        if (scope === 'control') return forward({ kind: 'control' }, request, headers, { [ACTOR_HEADER]: await signActor(sessionActor(info, null), 'control') })
        if (!info.current) return json({ error: 'You have no account yet.', code: 'no_account' }, 403)
        const ref: StoreRef = { kind: 'account', accountId: info.current }
        return forward(ref, request, headers, { [ACTOR_HEADER]: await signActor(sessionActor(info, info.current), storeId(ref)) })
      }
      const extra: Record<string, string> = info ? { [ACTOR_HEADER]: await signActor(sessionActor(info, null), 'control') } : {}
      return forward({ kind: 'control' }, request, headers, extra)
    }

    if (path.startsWith('/api/')) return notFound()
    return deps.assets(request)
  }

  return {
    async fetch(request, peer = null) {
      let response: Response
      try {
        response = withSecurityHeaders(await handle(request, peer))
      } catch (err) {
        response = withSecurityHeaders(errorResponse(err))
      }
      const forwardedProto = deps.trustsProxy?.(peer) ? request.headers.get('x-forwarded-proto') : null
      const requestUrl = new URL(request.url)
      // An alias host goes by the scheme it was reached on, not by the APP_URL scheme.
      const alias = requestUrl.host !== appHost(deps.config) && deps.config.appHosts.includes(requestUrl.host.toLowerCase())
      if (wantsHsts(alias ? '' : deps.config.appUrl, requestUrl, forwardedProto)) response.headers.set('Strict-Transport-Security', HSTS_VALUE)
      return response
    },
  }
}
