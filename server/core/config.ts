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
  port: number
  host: string
  imagesPublicUrl: string
  sendBatchSize: number
  maxNewsletters: number
  billingProvider: 'stripe' | 'polar' | ''
  turnstile: { siteKey: string; secretKey: string } | null
  /** APP_SECRET when set. The platform generates one otherwise. */
  secret: string
  isProd: boolean
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
    port,
    host: env.HOST || '0.0.0.0',
    imagesPublicUrl: (env.IMAGES_PUBLIC_URL || '').replace(/\/+$/, ''),
    sendBatchSize: Number(env.SEND_BATCH_SIZE || 100),
    maxNewsletters: Number(env.MAX_NEWSLETTERS || 3),
    billingProvider: provider === 'stripe' || provider === 'polar' ? provider : '',
    turnstile: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY } : null,
    secret,
    isProd: env.NODE_ENV === 'production',
    env,
  }
}

/** The host part of the app URL, or empty when not known yet. */
export const appHost = (config: Config) => {
  try {
    return config.appUrl ? new URL(config.appUrl).host : ''
  } catch {
    return ''
  }
}
