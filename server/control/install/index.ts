import { z } from 'zod'
import { AppError } from '../../core/http.ts'
import { sendSystemEmail, simpleEmail } from '../../email/index.ts'
import { takeSendPermits } from './permits.ts'
import type { StoreCtx } from '../../core/store.ts'
import { defineAction } from '../../core/actions.ts'
import { decrypt, encrypt } from '../../core/crypto.ts'
import type { ControlRegistrar } from '../rpc.ts'

/** Settings whose values are encrypted at rest and never returned to a browser. */
export const isSecretSetting = (key: string) => /(secret|password|api_key|token|access_key_id|smtp_user)/.test(key)

/** Where the last successful test email is recorded, for the setup checklist. */
export const TEST_EMAIL_KEY = '_test_email'

/** Which env var overrides a setting: `ses_access_key_id` → `SES_ACCESS_KEY_ID`. */
const envName = (key: string) => key.toUpperCase()

export function getSettingSync(ctx: StoreCtx, key: string): string {
  const fromEnv = ctx.config.env[envName(key)]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return ctx.db.get<{ value: string }>('SELECT value FROM install_settings WHERE key = ?', key)?.value ?? ''
}

export async function getSetting(ctx: StoreCtx, key: string): Promise<string> {
  const fromEnv = ctx.config.env[envName(key)]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const raw = ctx.db.get<{ value: string }>('SELECT value FROM install_settings WHERE key = ?', key)?.value ?? ''
  return isSecretSetting(key) ? decrypt(ctx.keys.credentials, raw) : raw
}

export async function getSettings(ctx: StoreCtx, keys: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const key of keys) out[key] = await getSetting(ctx, key)
  return out
}

export async function setSetting(ctx: StoreCtx, key: string, value: string): Promise<void> {
  const stored = isSecretSetting(key) ? await encrypt(ctx.keys.credentials, value) : value
  if (stored === '') ctx.db.run('DELETE FROM install_settings WHERE key = ?', key)
  else ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, stored)
}

/** The public URL: APP_URL, else what the first sign-in taught us. */
export const appUrl = (ctx: StoreCtx) => ctx.config.appUrl || getSettingSync(ctx, 'app_url')

/** Whether system email reaches anyone. The built-in `test` provider only writes to the outbox. */
export const emailConfigured = (ctx: StoreCtx) => (getSettingSync(ctx, 'email_provider') || 'test') !== 'test'

export function learnAppUrl(ctx: StoreCtx, origin: string) {
  if (ctx.config.appUrlFixed || !origin.startsWith('http')) return
  if (!getSettingSync(ctx, 'app_url')) ctx.db.run('INSERT OR IGNORE INTO install_settings (key, value) VALUES (?, ?)', 'app_url', origin)
  ctx.config.appUrl = getSettingSync(ctx, 'app_url')
}

export const SETTING_KEYS = [
  'email_provider',
  'email_from',
  'email_from_name',
  'sending_enabled',
  'send_rate_per_second',
  'signup_mode',
  'ses_region',
  'ses_access_key_id',
  'ses_secret_access_key',
  'ses_configuration_set',
  'ses_sns_topic_arn',
  'resend_api_key',
  'resend_webhook_secret',
  'smtp_host',
  'smtp_port',
  'smtp_security',
  'smtp_user',
  'smtp_password',
  'stripe_secret_key',
  'stripe_webhook_secret',
  'polar_access_token',
  'polar_webhook_secret',
  'cf_api_token',
  'cf_zone_id',
] as const

const settingKey = z.enum(SETTING_KEYS)

declare module '../rpc.ts' {
  interface ControlRpc {
    claimEmailDomain(args: { name: string; accountId: string; domainId: string }): Promise<{ claimed: boolean }>
    releaseEmailDomain(args: { name: string; accountId: string; domainId: string }): Promise<void>
  }
}

export const PROVIDER_NAMES: Record<string, string> = { ses: 'Amazon SES', resend: 'Resend', smtp: 'SMTP' }
/** Settings a provider cannot send without. */
export const PROVIDER_CREDENTIALS: Record<string, readonly string[]> = {
  ses: ['ses_region', 'ses_access_key_id', 'ses_secret_access_key'],
  resend: ['resend_api_key'],
  smtp: ['smtp_host'],
}

/** The credentials the chosen provider still lacks, after `pending` is applied and env overrides win. */
export async function missingCredentials(ctx: StoreCtx, pending: Record<string, string> = {}): Promise<{ provider: string; missing: string[] }> {
  const read = async (key: string) => {
    const fromEnv = ctx.config.env[envName(key)]
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    return key in pending ? pending[key] : getSetting(ctx, key)
  }
  const provider = (await read('email_provider')) || 'test'
  const missing: string[] = []
  for (const key of PROVIDER_CREDENTIALS[provider] ?? []) if (!(await read(key))) missing.push(key)
  if (provider === 'smtp' && (await read('smtp_user')) && !(await read('smtp_password'))) missing.push('smtp_password')
  return { provider, missing }
}

function validateSettings(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n\0]/.test(value)) throw new AppError('invalid_setting', 'Settings must fit on one line.', 400)
    if (value === '') continue
    if (key === 'email_provider' && !['test', 'ses', 'resend', 'smtp'].includes(value)) throw new AppError('invalid_setting', 'Choose a supported email provider.', 400)
    if (key === 'email_from' && !z.email().safeParse(value).success) throw new AppError('invalid_setting', 'Enter a valid system sender address.', 400)
    if (key === 'sending_enabled' && !['true', 'false'].includes(value)) throw new AppError('invalid_setting', 'Sending enabled must be true or false.', 400)
    if (key === 'send_rate_per_second' && (!Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 10000)) throw new AppError('invalid_setting', 'Send rate must be between 0 and 10000.', 400)
    if (key === 'smtp_port' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new AppError('invalid_setting', 'Enter a valid SMTP port.', 400)
    if (key === 'smtp_security' && !['tls', 'starttls', 'none'].includes(value)) throw new AppError('invalid_setting', 'Choose a supported SMTP security mode.', 400)
    if (key === 'ses_region' && !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value)) throw new AppError('invalid_setting', 'Enter a valid SES region.', 400)
  }
}

export const installModule = {
  name: 'install',
  register(reg: ControlRegistrar) {
    reg.rpc('getInstallSettings', (ctx, { keys }) => getSettings(ctx, keys))
    reg.rpc('takeSendPermits', takeSendPermits)
    reg.rpc('claimEmailDomain', (ctx, input) => ctx.db.tx(() => {
      const key = `_email_domain:${input.name}`
      const raw = getSettingSync(ctx, key)
      if (raw) {
        const claim = z.object({ accountId: z.string(), domainId: z.string() }).parse(JSON.parse(raw))
        if (claim.accountId !== input.accountId || claim.domainId !== input.domainId) return { claimed: false }
      }
      ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(input))
      return { claimed: true }
    }))
    reg.rpc('releaseEmailDomain', (ctx, input) => {
      ctx.db.run('DELETE FROM install_settings WHERE key = ? AND value = ?', `_email_domain:${input.name}`, JSON.stringify(input))
    })
    return reg.actions(
      defineAction({
        name: 'install.settings.get',
        description: 'Read the install settings. Secrets come back as a flag that says whether one is set.',
        scope: 'control',
        role: 'installAdmin',
        effect: 'read',
        input: z.object({}),
        handler: async (ctx) => {
          const values: Record<string, string> = {}
          const secretsSet: Record<string, boolean> = {}
          const fromEnv: Record<string, boolean> = {}
          for (const key of SETTING_KEYS) {
            const value = await getSetting(ctx, key)
            fromEnv[key] = !!ctx.config.env[envName(key)]
            if (isSecretSetting(key)) secretsSet[key] = value !== ''
            else values[key] = value
          }
          const { missing } = await missingCredentials(ctx)
          return { values, secretsSet, fromEnv, missing, webhookUrls: { ses: `${appUrl(ctx)}/hooks/ses`, resend: `${appUrl(ctx)}/hooks/resend` } }
        },
      }),
      defineAction({
        name: 'install.settings.set',
        description: 'Change install settings. An empty string clears a setting. The result is checked as a whole: choosing an email provider needs its credentials (saved, sent in the same call, or set by environment).',
        scope: 'control',
        role: 'installAdmin',
        effect: 'write',
        input: z.object({ values: z.partialRecord(settingKey, z.string().max(4000)).describe('Setting values by key') }),
        mcp: { title: 'Change install settings', destructive: true },
        handler: async (ctx, { values }) => {
          validateSettings(values)
          const { provider, missing } = await missingCredentials(ctx, values)
          if (missing.length) throw new AppError('missing_credentials', `${PROVIDER_NAMES[provider]} needs ${missing.join(', ')}. Nothing was saved.`, 400, { provider, missing })
          const stored = await Promise.all(Object.entries(values).map(async ([key, value]) => [key, isSecretSetting(key) ? await encrypt(ctx.keys.credentials, value) : value] as const))
          ctx.db.tx(() => {
            for (const [key, value] of stored) {
              if (!value) ctx.db.run('DELETE FROM install_settings WHERE key = ?', key)
              else ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
            }
          })
          return { ok: true }
        },
      }),
      defineAction({
        name: 'install.email.test', description: 'Send a test message using the configured system sender and email provider.', scope: 'control', role: 'installAdmin', effect: 'send',
        input: z.object({ to: z.email().describe('Recipient address for the test email') }),
        handler: async (ctx, { to }) => {
          const result = await sendSystemEmail(ctx, { to, subject: 'MailCorgi test email', ...simpleEmail({ title: 'Your email provider works', lines: ['MailCorgi sent this test email using your saved settings.'] }), kind: 'test' })
          if (!result.ok) throw new AppError('email_failed', result.message, 502)
          const provider = (await getSetting(ctx, 'email_provider')) || 'test'
          ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', TEST_EMAIL_KEY, JSON.stringify({ provider, at: ctx.now() }))
          return { ok: true }
        },
      }),
    )
  },
}
