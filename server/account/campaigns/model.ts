import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { AppError, notFound } from '../../core/http.ts'
import { emptyDoc, nodeSchema, parseDoc } from '../render/index.ts'

export const statusSchema = z.enum(['draft', 'scheduled', 'sending', 'paused', 'sent', 'canceled'])
export type CampaignStatus = z.infer<typeof statusSchema>
export const audienceSchema = z.object({
  all: z.boolean().optional(),
  segmentId: z.string().min(1).optional(),
  tagIds: z.array(z.string().min(1)).max(50).optional(),
  engaged: z.boolean().optional(),
  exclude: z.object({ segmentIds: z.array(z.string()).max(50).optional(), tagIds: z.array(z.string()).max(50).optional() }).optional(),
}).refine((a) => [a.all === true, !!a.segmentId, !!a.tagIds?.length, a.engaged === true].filter(Boolean).length === 1, 'Choose one audience: all, segment, tags or engaged.')
export type CampaignAudience = z.infer<typeof audienceSchema>
export const draftFields = {
  subject: z.string().max(500).describe('The email subject, also used as the draft name'),
  previewText: z.string().max(1000).describe('Inbox preview text'),
  format: z.enum(['doc', 'markdown', 'html']).describe('Content format: editor document, Markdown or raw email HTML'),
  doc: nodeSchema.refine((n) => n.type === 'doc', 'The root must be a doc node.').describe('TipTap document JSON'),
  source: z.string().max(1_000_000).describe('Markdown or HTML source'),
  html: z.string().max(1_000_000).describe('Raw email HTML for the HTML format'),
  text: z.string().max(1_000_000).describe('Optional plain text alternative for HTML campaigns'),
  audience: audienceSchema.describe('Exactly one of all, segmentId, tagIds or engaged, plus exclusions'),
}
export interface CampaignRow {
  id: string
  newsletter_id: string
  author_id: string | null
  kind: 'issue' | 'welcome' | 'keep'
  format: 'doc' | 'markdown' | 'html'
  subject: string
  preview_text: string
  doc: string | null
  source: string | null
  html: string | null
  text: string | null
  slug: string
  status: CampaignStatus
  pause_reason: string | null
  audience: string
  scheduled_at: number | null
  send_started_at: number | null
  sent_at: number | null
  published_at: number | null
  web_visible: number
  stats: string
  revision: number
  created_by: string
  created_at: number
  updated_at: number
}
export function getCampaignRow(ctx: StoreCtx, id: string): CampaignRow {
  const row = ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', id)
  if (!row) throw notFound('That campaign')
  return row
}
export function serializeCampaign(row: CampaignRow) {
  return {
    id: row.id, newsletterId: row.newsletter_id, authorId: row.author_id, kind: row.kind,
    format: row.format, subject: row.subject, previewText: row.preview_text,
    doc: row.doc ? parseDoc(row.doc) : emptyDoc, source: row.source ?? '', html: row.html ?? '', text: row.text ?? '', slug: row.slug,
    status: row.status, pauseReason: row.pause_reason, audience: audienceSchema.parse(JSON.parse(row.audience === '{}' ? '{"all":true}' : row.audience)),
    scheduledAt: row.scheduled_at, sendStartedAt: row.send_started_at, sentAt: row.sent_at,
    publishedAt: row.published_at, webVisible: !!row.web_visible, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
export type Campaign = ReturnType<typeof serializeCampaign>
export const getCampaign = (ctx: StoreCtx, id: string) => serializeCampaign(getCampaignRow(ctx, id))
export function assertEditable(row: CampaignRow) {
  if (row.status !== 'draft') throw new AppError('not_editable', 'Only drafts can be edited.', 409)
}
export function assertRevision(row: CampaignRow, revision: number) {
  if (row.revision !== revision) throw new AppError('revision_conflict', 'A newer version is available. Reload it before saving.', 409, { revision: row.revision })
}
const transitions: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['scheduled', 'canceled'], scheduled: ['sending', 'canceled'], sending: ['paused', 'sent'], paused: ['sending'], sent: [], canceled: [],
}
export function transitionCampaign(ctx: StoreCtx, campaignId: string, status: CampaignStatus, detail: {
  scheduledAt?: number
  reason?: string
} = {}): Campaign {
  return ctx.db.tx(() => {
    const row = getCampaignRow(ctx, campaignId)
    if (row.status === status) return serializeCampaign(row)
    if (!transitions[row.status].includes(status)) throw new AppError('invalid_transition', `Cannot move a ${row.status} campaign to ${status}.`, 409)
    if (status === 'scheduled' && (!detail.scheduledAt || detail.scheduledAt < ctx.now())) throw new AppError('invalid_schedule', 'Choose a send time in the future.', 400)
    const now = ctx.now()
    ctx.db.run(`UPDATE campaigns SET status = ?, scheduled_at = ?, send_started_at = ?, sent_at = ?, pause_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND newsletter_id = ?`,
      status, status === 'scheduled' ? detail.scheduledAt : row.scheduled_at, status === 'sending' ? row.send_started_at ?? now : row.send_started_at, status === 'sent' ? now : row.sent_at,
      status === 'paused' ? detail.reason ?? '' : null, now, campaignId, row.newsletter_id)
    ctx.db.run('INSERT INTO events (type, newsletter_id, campaign_id, data, at) VALUES (?, ?, ?, ?, ?)', `campaign.${status}`, row.newsletter_id, campaignId, JSON.stringify({ from: row.status, to: status, reason: detail.reason ?? null }), now)
    ctx.db.run('INSERT INTO daily_stats (newsletter_id, day) VALUES (?, ?) ON CONFLICT DO NOTHING', row.newsletter_id, new Date(now).toISOString().slice(0, 10))
    return getCampaign(ctx, campaignId)
  })
}
