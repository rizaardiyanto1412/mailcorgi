import type { StoreCtx } from '../../core/store.ts'
import { newId } from '../../core/ids.ts'
import { getNewsletterRow } from '../newsletters/index.ts'
import { transitionCampaign } from '../campaigns/index.ts'
import { setContactStatus } from '../contacts/index.ts'
import { verifiedSenderFor } from '../domains/index.ts'
import { getMeta, getPolicy } from '../usage/index.ts'
import { protectionState } from './protection.ts'
import { DAY, readSettings } from './settings.ts'

export function queueHygiene(ctx: StoreCtx, newsletterId: string) {
  ctx.jobs.enqueue('hygiene.scan', { newsletterId }, { dedupeKey: `hygiene.scan:${newsletterId}` })
}
export function atRiskWhere(strict: boolean) {
  return `c.status = 'subscribed' AND c.subscribed_at <= ? AND c.${strict ? 'strict_ignored_streak' : 'ignored_streak'} >= ?
    AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email AND (s.newsletter_id IS NULL OR s.newsletter_id = c.newsletter_id))`
}
export function scanNewsletter(ctx: StoreCtx, newsletterId: string) {
  const nl = getNewsletterRow(ctx, newsletterId)
  if (!nl || nl.archived_at) return 'done' as const
  const settings = readSettings(ctx, newsletterId)
  if (!settings.enabled || getPolicy(ctx).status !== 'active' || protectionState(ctx) || !verifiedSenderFor(ctx, newsletterId)) return 'done' as const
  const now = ctx.now()
  const rows = ctx.db.all<{ id: string; email: string }>(`SELECT c.id, c.email FROM contacts c WHERE c.newsletter_id = ? AND ${atRiskWhere(settings.strict)}
    AND c.keep_asked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM hygiene_requests h JOIN campaigns p ON p.id = h.campaign_id WHERE h.contact_id = c.id
      AND (COALESCE(h.sent_at, h.issued_at) > ? OR (h.sent_at IS NULL AND (p.status IN ('scheduled', 'sending', 'paused') OR EXISTS (SELECT 1 FROM deliveries d WHERE d.campaign_id = h.campaign_id AND d.contact_id = h.contact_id AND d.status = 'unknown')))))
    ORDER BY c.id LIMIT 25`, newsletterId, now - 90 * DAY, settings.afterIssues, now - 180 * DAY)
  if (!rows.length) return 'done' as const
  ctx.db.tx(() => {
    const campaignId = newId('cmp')
    const sendId = newId('snd')
    ctx.db.run(`INSERT INTO campaigns (id, newsletter_id, kind, format, subject, source, audience, web_visible, created_by, created_at, updated_at)
      VALUES (?, ?, 'keep', 'markdown', ?, ?, '{"all":true}', 0, 'system', ?, ?)`, campaignId, newsletterId, settings.subject, settings.body + '\n\n[Keep me subscribed]({{keep_url}})', now, now)
    transitionCampaign(ctx, campaignId, 'scheduled', { scheduledAt: ctx.now() + 1000 })
    transitionCampaign(ctx, campaignId, 'sending')
    ctx.db.run(`INSERT INTO campaign_sends (id, campaign_id, step, kind, planned, release_at, state, created_at) VALUES (?, ?, 1, 'main', ?, ?, 'released', ?)`, sendId, campaignId, rows.length, now, now)
    for (const c of rows) {
      ctx.db.run('INSERT INTO hygiene_requests (campaign_id, contact_id) VALUES (?, ?)', campaignId, c.id)
      ctx.db.run(`INSERT INTO deliveries (campaign_id, send_id, contact_id, email, status, queued_at) VALUES (?, ?, ?, ?, 'queued', ?)`, campaignId, sendId, c.id, c.email, now)
    }
    ctx.jobs.enqueue('send.batch', { campaignId }, { dedupeKey: `send.batch:${campaignId}` })
  })
  return { again: now + 1000 }
}
export function markKeepSent(ctx: StoreCtx, campaignId: string, contactId: string, at: number) {
  const campaign = ctx.db.get<{ newsletter_id: string; kind: string }>('SELECT newsletter_id, kind FROM campaigns WHERE id = ?', campaignId)
  if (!campaign || campaign.kind !== 'keep') return
  const cleanAt = at + readSettings(ctx, campaign.newsletter_id).waitDays * DAY
  if (!ctx.db.run('UPDATE hygiene_requests SET sent_at = ?, clean_at = ? WHERE campaign_id = ? AND contact_id = ? AND sent_at IS NULL', at, cleanAt, campaignId, contactId).changes) return
  ctx.db.run('UPDATE contacts SET keep_asked_at = ?, updated_at = ? WHERE id = ? AND newsletter_id = ?', at, at, contactId, campaign.newsletter_id)
  ctx.jobs.enqueue('hygiene.clean', { newsletterId: campaign.newsletter_id }, { runAt: cleanAt, dedupeKey: `hygiene.clean:${campaignId}` })
}
export function cleanNewsletter(ctx: StoreCtx, newsletterId: string) {
  const nl = getNewsletterRow(ctx, newsletterId)
  if (!nl || nl.archived_at || !readSettings(ctx, newsletterId).enabled) return 'done' as const
  const rows = ctx.db.all<{ id: string; email: string; campaign_id: string }>(`SELECT c.id, c.email, h.campaign_id FROM hygiene_requests h JOIN contacts c ON c.id = h.contact_id
    WHERE c.newsletter_id = ? AND c.status = 'subscribed' AND c.keep_asked_at = h.sent_at AND h.clean_at <= ? AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email AND (s.newsletter_id IS NULL OR s.newsletter_id = c.newsletter_id)) ORDER BY h.clean_at LIMIT 100`, newsletterId, ctx.now())
  ctx.db.tx(() => {
    for (const c of rows) setContactStatus(ctx, c.id, 'cleaned', { reason: 'No response to the keep-subscription email', campaignId: c.campaign_id })
  })
  const next = ctx.db.get<{ at: number | null }>(`SELECT MIN(h.clean_at) at FROM hygiene_requests h JOIN contacts c ON c.id = h.contact_id
    WHERE c.newsletter_id = ? AND c.status = 'subscribed' AND c.keep_asked_at = h.sent_at
    AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email AND (s.newsletter_id IS NULL OR s.newsletter_id = c.newsletter_id))`, newsletterId)!.at
  return next === null ? 'done' as const : { again: Math.max(ctx.now() + 1000, next) }
}

export function keepIssuedAt(ctx: StoreCtx, campaignId: string, contactId: string): number {
  ctx.db.run('UPDATE hygiene_requests SET issued_at = COALESCE(issued_at, ?) WHERE campaign_id = ? AND contact_id = ?', ctx.now(), campaignId, contactId)
  return ctx.db.get<{ issued_at: number }>('SELECT issued_at FROM hygiene_requests WHERE campaign_id = ? AND contact_id = ?', campaignId, contactId)?.issued_at ?? ctx.now()
}
export function keepDeliveryAllowed(ctx: StoreCtx, newsletterId: string, contactId: string): boolean {
  const settings = readSettings(ctx, newsletterId)
  return settings.enabled && !!ctx.db.get(`SELECT c.id FROM contacts c WHERE c.id = ? AND c.newsletter_id = ? AND ${atRiskWhere(settings.strict)} AND c.keep_asked_at IS NULL`, contactId, newsletterId, ctx.now() - 90 * DAY, settings.afterIssues)
}

export function recordHygieneSend(ctx: StoreCtx, deliveryId: number, campaignId: string, contactId: string, at: number) {
  ctx.db.run('UPDATE deliveries SET hygiene_epoch = ? WHERE id = ?', Number(getMeta(ctx, 'hygiene_epoch') ?? 0), deliveryId)
  markKeepSent(ctx, campaignId, contactId, at)
}
