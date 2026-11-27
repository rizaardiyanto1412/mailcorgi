import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { AppError, notFound } from '../../core/http.ts'
import { emptyDoc, nodeSchema, parseDoc } from '../render/index.ts'

export const statusSchema = z.enum(['draft', 'scheduled', 'sending', 'paused', 'sent', 'canceled'])
/** How far in the past a scheduled time may be and still count as now. */
export const SCHEDULE_DRIFT_MS = 5_000
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
  sendFormat: z.enum(['html', 'plain']).describe('How the email is sent. html: the themed email with header, footer and tracking. plain: a plain text email that reads like a personally written one, with no theme, no open pixel and no click tracking, ending in a one-line unsubscribe link.'),
}
/** Shared by campaigns and sequence steps. The welcome email has `transactional` on signup.saveWelcome instead. */
export const hideUnsubscribeFooterSchema = z.boolean().describe('Only for sendFormat plain: leave out the closing "--" and "Unsubscribe: <address>" lines of the plain text email. The List-Unsubscribe and List-Unsubscribe-Post headers are always sent, so readers can still unsubscribe from their mail app. No effect on an html email: its footer stays.')
/**
 * The optional per-campaign sender override, shared by campaigns, the welcome email and sequence steps. Each field falls
 * back to the newsletter's value on its own while it is null or not stored. On save, null clears a field and omitting it keeps it.
 */
export const senderOverrideFields = {
  fromDomainId: z.string().min(1).describe('Sender override: the id of a verified sending domain of this account to send this email from, instead of the newsletter domain. Must be verified when saved and again when sent.'),
  fromLocal: z.string().min(1).max(64).regex(/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/).describe('Sender override: the local part of the From address (before the @), instead of the newsletter fromLocal'),
  fromName: z.string().trim().max(200).regex(/^[^\r\n<>]*$/).describe('Sender override: the From display name, instead of the newsletter fromName. An empty string sends with no display name.'),
}
const CLEAR = ' Send null to clear it (use the newsletter value again); omit to keep the stored value.'
const NEW = ' Omit or null for no override (use the newsletter value).'
/** The three override fields as an action takes them when saving. `create`: null and omitted both mean no override. `update`: null clears, omitted keeps. */
export const senderOverrideInput = {
  create: { fromDomainId: senderOverrideFields.fromDomainId.nullable().optional().describe(senderOverrideFields.fromDomainId.description + NEW), fromLocal: senderOverrideFields.fromLocal.nullable().optional().describe(senderOverrideFields.fromLocal.description + NEW), fromName: senderOverrideFields.fromName.nullable().optional().describe(senderOverrideFields.fromName.description + NEW) },
  update: { fromDomainId: senderOverrideFields.fromDomainId.nullable().optional().describe(senderOverrideFields.fromDomainId.description + CLEAR), fromLocal: senderOverrideFields.fromLocal.nullable().optional().describe(senderOverrideFields.fromLocal.description + CLEAR), fromName: senderOverrideFields.fromName.nullable().optional().describe(senderOverrideFields.fromName.description + CLEAR) },
}
export type SendFormat = z.infer<typeof draftFields.sendFormat>
export interface CampaignRow {
  id: string
  newsletter_id: string
  author_id: string | null
  /** `sequence`: the hidden template of one email-sequence step. It stays a draft and is managed by the sequences module. */
  kind: 'issue' | 'welcome' | 'keep' | 'sequence'
  format: 'doc' | 'markdown' | 'html'
  send_format: SendFormat
  hide_unsubscribe_footer: number
  from_domain_id: string | null
  from_local: string | null
  from_name: string | null
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
    format: row.format, sendFormat: row.send_format, hideUnsubscribeFooter: !!row.hide_unsubscribe_footer, fromDomainId: row.from_domain_id, fromLocal: row.from_local, fromName: row.from_name, subject: row.subject, previewText: row.preview_text,
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
/** A sequence step's hidden campaign is not a standalone campaign: only the sequences module may copy, cancel or remove it. */
export function assertNotSequenceStep(row: CampaignRow) {
  if (row.kind === 'sequence') throw new AppError('sequence_step', 'This email is a step of a sequence. Change it from the sequence instead.', 409)
}
export function assertRevision(row: CampaignRow, revision: number) {
  if (row.revision !== revision) throw new AppError('revision_conflict', 'A newer version is available. Reload it before saving.', 409, { revision: row.revision })
}
const transitions: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['scheduled', 'canceled'], scheduled: ['sending', 'paused', 'canceled'], sending: ['paused', 'sent'], paused: ['sending', 'scheduled'], sent: [], canceled: [],
}
export function transitionCampaign(ctx: StoreCtx, campaignId: string, status: CampaignStatus, detail: {
  scheduledAt?: number
  reason?: string
} = {}): Campaign {
  return ctx.db.tx(() => {
    const row = getCampaignRow(ctx, campaignId)
    if (row.status === status) return serializeCampaign(row)
    if (!transitions[row.status].includes(status)) throw new AppError('invalid_transition', `Cannot move a ${row.status} campaign to ${status}.`, 409)
    // "Send now" schedules for the moment the caller read the clock; a real clock has moved on by the time this runs.
    if (status === 'scheduled' && (!detail.scheduledAt || detail.scheduledAt < ctx.now() - SCHEDULE_DRIFT_MS)) throw new AppError('invalid_schedule', 'Choose a send time in the future.', 400)
    const now = ctx.now()
    ctx.db.run(`UPDATE campaigns SET status = ?, scheduled_at = ?, send_started_at = ?, sent_at = ?, pause_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND newsletter_id = ?`,
      status, status === 'scheduled' ? detail.scheduledAt : row.scheduled_at, status === 'sending' ? row.send_started_at ?? now : row.send_started_at, status === 'sent' ? now : row.sent_at,
      status === 'paused' ? detail.reason ?? '' : null, now, campaignId, row.newsletter_id)
    ctx.db.run('INSERT INTO events (type, newsletter_id, campaign_id, data, at) VALUES (?, ?, ?, ?, ?)', `campaign.${status}`, row.newsletter_id, campaignId, JSON.stringify({ from: row.status, to: status, reason: detail.reason ?? null }), now)
    ctx.db.run('INSERT INTO daily_stats (newsletter_id, day) VALUES (?, ?) ON CONFLICT DO NOTHING', row.newsletter_id, new Date(now).toISOString().slice(0, 10))
    return getCampaign(ctx, campaignId)
  })
}
