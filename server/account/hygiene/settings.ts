import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { getNewsletterRow } from '../newsletters/index.ts'
import { notFound } from '../../core/http.ts'

export const DAY = 86_400_000
export const settingsShape = {
  enabled: z.boolean().default(true).describe('Automatically ask inactive subscribers whether they want to stay'),
  afterIssues: z.number().int().min(1).max(100).default(8).describe('Consecutive ignored issues before asking, after at least 90 days subscribed'),
  waitDays: z.number().int().min(1).max(30).default(14).describe('Days to wait after the reminder is sent before cleaning'),
  strict: z.boolean().default(false).describe('Ignore privacy-proxy opens when deciding whether a subscriber is engaged'),
  subject: z.string().trim().min(1).max(150).default('Do you still want these emails?').describe('Subject of the keep-subscription email'),
  body: z.string().trim().min(1).max(5000).default('We noticed you have not read our recent issues. If you would like to keep receiving them, please confirm below. Otherwise, we will stop sending.').describe('Markdown copy above the required keep-subscription link'),
}
export const settingsSchema = z.object(settingsShape)
export type HygieneSettings = z.output<typeof settingsSchema>
export function readSettings(ctx: StoreCtx, newsletterId: string): HygieneSettings {
  const nl = getNewsletterRow(ctx, newsletterId)
  if (!nl) throw notFound('That newsletter')
  const raw = z.record(z.string(), z.unknown()).parse(JSON.parse(nl.hygiene))
  return settingsSchema.parse({ ...raw, afterIssues: raw.afterIssues ?? raw.after_issues })
}
