import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { defineAction } from '../../core/actions.ts'
import { decrypt, encrypt } from '../../core/crypto.ts'
import type { ControlRegistrar } from '../rpc.ts'

/** Settings whose values are encrypted at rest and never returned to a browser. */
export const isSecretSetting = (key: string) => /(secret|password|api_key|token)/.test(key)

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

export const installModule = {
  name: 'install',
  register(reg: ControlRegistrar) {
    reg.rpc('getInstallSettings', (ctx, { keys }) => getSettings(ctx, keys))
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
          return { values, secretsSet, fromEnv }
        },
      }),
      defineAction({
        name: 'install.settings.set',
        description: 'Change install settings. An empty string clears a setting.',
        scope: 'control',
        role: 'installAdmin',
        effect: 'write',
        input: z.object({ values: z.record(settingKey, z.string().max(4000)).describe('Setting values by key') }),
        mcp: { title: 'Change install settings', destructive: true },
        handler: async (ctx, { values }) => {
          for (const [key, value] of Object.entries(values)) await setSetting(ctx, key, value)
          return { ok: true }
        },
      }),
    )
  },
}
