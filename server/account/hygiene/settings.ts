import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { getNewsletterRow } from '../newsletters/index.ts'
import { notFound } from '../../core/http.ts'
import { withPatch } from '../../core/patch.ts'

export const DAY = 86_400_000
export const defaultSettings = {
  enabled: true, afterIssues: 8, waitDays: 14, strict: false,
  subject: 'Do you still want these emails?',
  body: 'We noticed you have not read our recent issues. If you would like to keep receiving them, please confirm below. Otherwise, we will stop sending.',
}
/** Every key is optional: on an update an omitted one keeps its saved value, and a newsletter never saved reads the defaults. */
export const settingsShape = {
  enabled: z.boolean().optional().describe('Automatically ask inactive subscribers whether they want to stay'),
  afterIssues: z.number().int().min(1).max(100).optional().describe('Consecutive ignored issues before asking, after at least 90 days subscribed'),
  waitDays: z.number().int().min(1).max(30).optional().describe('Days to wait after the reminder is sent before cleaning'),
  strict: z.boolean().optional().describe('Ignore privacy-proxy opens when deciding whether a subscriber is engaged'),
  subject: z.string().trim().min(1).max(150).optional().describe('Subject of the keep-subscription email'),
  body: z.string().trim().min(1).max(5000).optional().describe('Markdown copy above the required keep-subscription link'),
}
export const settingsSchema = z.object(settingsShape)
export type HygieneSettings = typeof defaultSettings
export function readSettings(ctx: StoreCtx, newsletterId: string): HygieneSettings {
  const nl = getNewsletterRow(ctx, newsletterId)
  if (!nl) throw notFound('That newsletter')
  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(nl.hygiene))
  return withPatch(defaultSettings, settingsSchema.parse({ ...raw, afterIssues: raw.afterIssues ?? raw.after_issues }))
}
