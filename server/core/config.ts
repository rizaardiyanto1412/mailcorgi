/** Settings from the environment. Parsing only: no file reads, no side effects. */
export interface Config {
  cloud: boolean
  /** Public URL of this install, no trailing slash. Empty until learned from the first sign-in. */
  appUrl: string
  /** True when APP_URL was set, so nothing may guess it. */
  appUrlFixed: boolean
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

/** The host part of the app URL, or empty when not known yet. */
export const appHost = (config: Config) => {
  try {
    return config.appUrl ? new URL(config.appUrl).host : ''
  } catch {
    return ''
  }
}
