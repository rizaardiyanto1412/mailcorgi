/**
 * The stateless edge: works out who is asking and which store answers, then forwards the request
 * with a signed actor envelope. Section 3.5 of docs/architecture.md is the routing table.
 */
import type { Config } from '../core/config.ts'
import { appHost } from '../core/config.ts'
import type { Keys } from '../core/crypto.ts'
import { sha256Hex, signEnvelope } from '../core/crypto.ts'
import type { BlobStore, StoreRef } from '../core/platform.ts'
import { storeId } from '../core/platform.ts'
import { ACTOR_HEADER, ACTOR_TTL_MS, type ActorEnvelope, type Stores } from '../core/store.ts'
import type { Actor } from '../core/actions.ts'
import { accountIdOfToken, isAccountId, parseApiKey, parseNewsletterKey } from '../core/ids.ts'
import { errorResponse, withSecurityHeaders } from '../core/http.ts'
import type { SessionInfo, SiteRow } from '../control/rpc.ts'
import { accountRegistry } from '../account/modules.ts'
import { controlRegistry } from '../control/modules.ts'

export const SESSION_COOKIE = 'mc_session'
export const ACCOUNT_COOKIE = 'mc_account'
export const CSRF_HEADER = 'x-mc-csrf'
const SESSION_CACHE_MS = 30_000
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
}

export interface Edge {
  fetch(request: Request): Promise<Response>
}

const CONTROL_PREFIXES = ['/api/auth/', '/api/control/', '/api/billing/', '/api/admin/']
const TOKEN_PREFIXES = ['/t/o/', '/t/c/', '/u/', '/confirm/', '/keep/']

const json = (body: unknown, status = 200) => Response.json(body, { status })
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
  const sessionCache = new Map<string, { at: number; info: SessionInfo | null }>()
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
    const cacheKey = `${sessionId}:${wantAccountId ?? ''}`
    const hit = sessionCache.get(cacheKey)
    if (hit && deps.now() - hit.at < SESSION_CACHE_MS) return hit.info
    const info = await deps.stores.control.resolveSession({ sessionId, wantAccountId })
    sessionCache.set(cacheKey, { at: deps.now(), info })
    trim(sessionCache)
    return info
  }

  async function lookupSite(where: { slug?: string; host?: string }): Promise<SiteRow | null> {
    const cacheKey = where.slug ? `slug:${where.slug}` : `host:${where.host}`
    const hit = siteCache.get(cacheKey)
    if (hit && deps.now() - hit.at < SITE_CACHE_MS) return hit.site
    const site = await deps.stores.control.lookupSite(where)
    siteCache.set(cacheKey, { at: deps.now(), site })
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

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const headers = stripHeaders(request)
    const method = request.method.toUpperCase()
    if (path === '/healthz') return json({ ok: true })

    if (!appHost(deps.config) && !learnedHost) {
      const setupEntry = method === 'GET' && ['/', '/setup', '/signin', '/signup', '/api/auth/bootstrap'].includes(path)
      learnedHost = await deps.stores.control.resolveAppHost({ setupOrigin: setupEntry ? url.origin : undefined })
    }
    const host = appHost(deps.config) || learnedHost

    // Caddy's on-demand TLS asks here before it issues a certificate for a custom website host.
    if (path === '/api/public/tls-check') {
      const domain = (url.searchParams.get('domain') || '').toLowerCase()
      const known = domain === host || (domain !== '' && (await lookupSite({ host: domain })) !== null)
      return known ? json({ ok: true }) : notFound()
    }

    if (!host || url.host !== host) {
      const site = await lookupSite({ host: url.host.toLowerCase() })
      if (!site) return notFound()
      return forward({ kind: 'account', accountId: site.account_id }, request, headers, { 'x-mc-site': site.newsletter_id, 'x-mc-host': url.host })
    }

    if (path.startsWith('/img/')) {
      const [accountId, ...rest] = path.slice(5).split('/')
      return serveImage(accountId, rest.join('/'))
    }

    if (path === '/hooks/stripe' || path === '/hooks/polar') return forward({ kind: 'control' }, request, headers)
    if (path === '/hooks/ses' || path === '/hooks/resend') return notFound()

    if (path.startsWith('/api/v1/') || path === '/mcp') {
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')
      const key = bearer ? parseApiKey(bearer[1]) : null
      if (!key) return unauthorized('Send an API key as "Authorization: Bearer mc_…".')
      return forward({ kind: 'account', accountId: key.accountId }, request, headers)
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
      return forward({ kind: 'account', accountId: site.account_id }, request, headers, { 'x-mc-site': site.newsletter_id })
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
      if (sessionId && path.startsWith('/api/auth/') && method === 'POST') for (const key of sessionCache.keys()) if (key.startsWith(sessionId)) sessionCache.delete(key)

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
    async fetch(request) {
      try {
        return withSecurityHeaders(await handle(request))
      } catch (err) {
        return withSecurityHeaders(errorResponse(err))
      }
    },
  }
}
