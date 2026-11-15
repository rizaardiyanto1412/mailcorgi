import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { getNewsletterRow } from '../newsletters/index.ts'
import { getCampaign, type CampaignRow } from '../campaigns/index.ts'
import { safeUrl } from '../render/index.ts'
import { notFound } from '../../core/http.ts'

export const redirectSchema = z.string().max(2048).refine((v) => v === '' || (/^https?:\/\//.test(v) && !v.includes('\\') && !!safeUrl(v)), 'Use an absolute http or https address without credentials.')
export const settingsSchema = z.object({
  showName: z.boolean().default(true).describe('Show the reader name field'),
  fieldKeys: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)).max(50).default([]).describe('Custom field keys shown in the form'),
  buttonLabel: z.string().trim().min(1).max(80).default('Subscribe').describe('Subscribe button label'),
  successMessage: z.string().trim().min(1).max(1000).default('Thanks! Check your inbox for the next step.').describe('Message shown after every accepted signup'),
  redirectUrl: redirectSchema.default('').describe('Optional absolute http or https success redirect'),
  style: z.enum(['card', 'inline']).default('card').describe('Form layout'),
})
export type FormSettings = z.infer<typeof settingsSchema>
export function getSettings(ctx: StoreCtx, newsletterId: string): FormSettings {
  const row = ctx.db.get<{ settings: string }>('SELECT settings FROM signup_settings WHERE newsletter_id = ?', newsletterId)
  return settingsSchema.parse(row ? JSON.parse(row.settings) : {})
}
export function getNewsletter(ctx: StoreCtx, id: string) {
  const nl = getNewsletterRow(ctx, id)
  if (!nl || nl.archived_at !== null) throw notFound('That active newsletter')
  return nl
}
export function publicNewsletter(ctx: StoreCtx, key: string) {
  const row = ctx.db.get<{ id: string }>('SELECT id FROM newsletters WHERE key = ? AND archived_at IS NULL', key)
  if (!row) throw notFound('That newsletter')
  return getNewsletter(ctx, row.id)
}
export function customFields(ctx: StoreCtx, newsletterId: string) {
  return ctx.db.all<{ key: string; label: string; type: 'text' | 'number' | 'date' | 'boolean' }>('SELECT key, label, type FROM contact_fields WHERE newsletter_id = ? ORDER BY label', newsletterId)
}
export function welcomeCampaign(ctx: StoreCtx, newsletterId: string) {
  const row = ctx.db.get<CampaignRow>("SELECT * FROM campaigns WHERE newsletter_id = ? AND kind = 'welcome' ORDER BY created_at, id LIMIT 1", newsletterId)
  return row ? getCampaign(ctx, row.id) : null
}
export function welcomeEnabled(value: string) {
  return z.object({ enabled: z.boolean().default(false) }).parse(JSON.parse(value)).enabled
}
