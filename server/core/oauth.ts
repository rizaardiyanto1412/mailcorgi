/**
 * OAuth 2.1 for the MCP endpoint (MCP Authorization, 2025-06-18). Shared by the edge (metadata),
 * the control store (clients, consent) and the account store (codes and tokens).
 *
 * The issuer is the app host the client used, so every APP_URL and APP_HOSTS host is its own
 * authorization server, and a token works only on the host that issued it.
 */
export const OAUTH_SCOPES = {
  'mail:read': 'Read newsletters, contacts, campaigns and reports.',
  'mail:full': 'Read and change data, and send email.',
} as const
export type OAuthScope = keyof typeof OAUTH_SCOPES
export const SCOPES_SUPPORTED = Object.keys(OAUTH_SCOPES) as OAuthScope[]

export const CODE_TTL_MS = 10 * 60_000
export const ACCESS_TTL_MS = 60 * 60_000
export const REFRESH_TTL_MS = 30 * 86_400_000

/** `mail:full` includes `mail:read`. The stored scope is always one of the two. */
export function parseScope(raw: string | null | undefined): { scope: OAuthScope | null; invalid: boolean } {
  const parts = (raw ?? '').split(/\s+/).filter(Boolean)
  if (parts.some((p) => !(p in OAUTH_SCOPES))) return { scope: null, invalid: true }
  if (parts.includes('mail:full')) return { scope: 'mail:full', invalid: false }
  if (parts.includes('mail:read')) return { scope: 'mail:read', invalid: false }
  return { scope: null, invalid: false }
}
export const scopeAccess = (scope: string): 'full' | 'read' => (scope === 'mail:full' ? 'full' : 'read')

export const resourceUrl = (origin: string) => `${origin}/mcp`
export const resourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`

export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'MailCorgi',
    resource_documentation: `${origin}/llms.txt`,
  }
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: SCOPES_SUPPORTED,
    service_documentation: `${origin}/llms.txt`,
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:', 'mailto:', 'tel:', 'sms:'])

/**
 * A redirect URI a client may register: https, http on a loopback host (RFC 8252 §7.3), or a
 * private-use scheme for native apps such as `cursor://` (RFC 8252 §7.1). No fragments, no credentials.
 */
export function redirectUriProblem(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'is not a URL'
  }
  if (value.length > 2000) return 'is too long'
  if (url.hash || value.includes('#')) return 'must not have a fragment'
  if (url.username || url.password) return 'must not carry credentials'
  if (url.protocol === 'https:') return url.hostname ? null : 'needs a host'
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname) ? null : 'must use https unless it is a localhost or 127.0.0.1 address'
  if (BLOCKED_SCHEMES.has(url.protocol)) return 'uses a scheme that is not allowed'
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? null : 'uses an invalid scheme'
}

/**
 * Whether a redirect_uri from an authorization request matches a registered one. Exact match, except
 * that a loopback redirect may use any port (RFC 8252 §7.3): native apps pick a free port per run.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true
  let want: URL
  try {
    want = new URL(requested)
  } catch {
    return false
  }
  if (want.protocol !== 'http:' || !LOOPBACK.has(want.hostname)) return false
  return registered.some((r) => {
    try {
      const have = new URL(r)
      return have.protocol === 'http:' && have.hostname === want.hostname && have.pathname === want.pathname && have.search === want.search
    } catch {
      return false
    }
  })
}

/** RFC 7636: 43 to 128 characters from the unreserved set. */
export const isCodeVerifier = (value: string) => /^[A-Za-z0-9._~-]{43,128}$/.test(value)
export const isCodeChallenge = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)
