/** Settings from the environment. Parsing only: no file reads, no side effects. */
export interface Config {
  cloud: boolean
  /** Public URL of this install, no trailing slash. Empty until learned from the first sign-in. */
  appUrl: string
  /** True when APP_URL was set, so nothing may guess it. */
  appUrlFixed: boolean
  /**
   * More hosts that serve the app itself (`APP_HOSTS`), lower case, port kept when given. Links still
   * use `appUrl`; these hosts only answer like it. Customer website hosts never belong here.
   */
  appHosts: string[]
  adminEmails: string[]
  allowedEmails: string[]
  dataDir: string
  /** Node only: proxy addresses whose forwarding headers count (`TRUST_PROXY`); `true` means any private or loopback peer. */
  trustProxy: string[]
  port: number
  host: string
  imagesPublicUrl: string
  sendBatchSize: number
  billingProvider: 'stripe' | 'polar' | 'test' | ''
  turnstile: { siteKey: string; secretKey: string } | null
  /** APP_SECRET when set. The platform generates one otherwise. */
  secret: string
  isProd: boolean
  /**
   * Canned DNS answers for development and tests, keyed `TYPE:name` (`MC_TEST_DNS` as JSON).
   * Null in production and whenever the flag is unset, so real lookups are never replaced.
   */
  testDns: Record<string, string[]> | null
  /** Raw environment for install settings that env vars may override (SES_ACCESS_KEY_ID, …). */
  env: Record<string, string | undefined>
}

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

export function parseConfig(env: Record<string, string | undefined>): Config {
  const port = Number(env.PORT || 3000)
  const appUrl = (env.APP_URL || '').replace(/\/+$/, '')
  const secret = env.APP_SECRET && env.APP_SECRET.length >= 16 ? env.APP_SECRET : ''
  const provider = (env.BILLING_PROVIDER || '').toLowerCase()
  return {
    cloud: env.CLOUD === 'true' || env.CLOUD === '1',
    appUrl,
    appUrlFixed: appUrl !== '',
    appHosts: list(env.APP_HOSTS).map(hostOf).filter(Boolean),
    adminEmails: list(env.ADMIN_EMAILS),
    allowedEmails: list(env.ALLOWED_EMAILS),
    dataDir: env.DATA_DIR || './data',
    trustProxy: list(env.TRUST_PROXY),
    port,
    host: env.HOST || '0.0.0.0',
    imagesPublicUrl: (env.IMAGES_PUBLIC_URL || '').replace(/\/+$/, ''),
    sendBatchSize: Number(env.SEND_BATCH_SIZE || 100),
    billingProvider: provider === 'stripe' || provider === 'polar' || provider === 'test' ? provider : '',
    turnstile: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY } : null,
    secret,
    isProd: env.NODE_ENV === 'production',
    testDns: env.NODE_ENV === 'production' ? null : parseTestDns(env.MC_TEST_DNS),
    env,
  }
}

function parseTestDns(raw: string | undefined): Record<string, string[]> | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('MC_TEST_DNS must be a JSON object such as {"TXT:example.com":["v=spf1 mx ~all"]}')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MC_TEST_DNS must be a JSON object')
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^(TXT|CNAME|MX|A):[a-z0-9._-]+$/i.test(key) || !Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`MC_TEST_DNS: bad entry ${key}`)
    out[key.toUpperCase().split(':')[0] + ':' + key.slice(key.indexOf(':') + 1).toLowerCase()] = value as string[]
  }
  return out
}

/** `news.example.com`, `news.example.com:8443` or `https://news.example.com/` → the host, or empty. */
function hostOf(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).host
  } catch {
    return ''
  }
}

/** True when `host` serves the app: the APP_URL host (or `learned`, before APP_URL is known) or an `APP_HOSTS` alias. */
export const isAppHost = (config: Config, host: string, learned = '') => {
  const h = host.toLowerCase()
  const main = appHost(config) || learned
  return (main !== '' && h === main) || config.appHosts.includes(h)
}

/** The host part of the app URL, or empty when not known yet. */
export const appHost = (config: Config) => {
  try {
    return config.appUrl ? new URL(config.appUrl).host : ''
  } catch {
    return ''
  }
}

/**
 * The public origin of an app-host request. The APP_URL scheme wins for the APP_URL host and its
 * aliases, so a Node install behind a TLS proxy still says https. Other hosts keep the request's own.
 */
export function publicOrigin(config: Config, url: URL): string {
  let main: URL | null
  try { main = config.appUrl ? new URL(config.appUrl) : null } catch { main = null }
  const host = url.host.toLowerCase()
  if (main && (host === main.host || config.appHosts.includes(host))) return `${main.protocol}//${host}`
  return url.origin
}
