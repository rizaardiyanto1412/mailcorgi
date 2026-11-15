import type { StoreCtx } from '../../core/store.ts'
import type { ProviderEvent } from '../../email/index.ts'
import { checkProtection } from '../hygiene/index.ts'
import { setContactStatus } from '../contacts/index.ts'
import { getCampaignRow } from '../campaigns/index.ts'
import { AUTO_PAUSE_MIN_SENT, bumpStat, daily, markSentEffects, pauseCampaign, rateBreach, readStats } from '../sending/index.ts'

export const SOFT_BOUNCES_BEFORE_HARD = 3

export interface DeliveryRow {
  id: number
  campaign_id: string
  contact_id: string
  email: string
  status: string
  sent_at: number | null
  opened_at: number | null
  clicked_at: number | null
}
export interface DeliveryWithNewsletter extends DeliveryRow {
  newsletter_id: string
}

export const deliveryById = (ctx: StoreCtx, id: number) => ctx.db.get<DeliveryWithNewsletter>('SELECT d.*, c.newsletter_id FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE d.id = ?', id)
const deliveryByMessage = (ctx: StoreCtx, messageId: string) => ctx.db.get<DeliveryWithNewsletter>('SELECT d.*, c.newsletter_id FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE d.provider_message_id = ? ORDER BY d.id DESC LIMIT 1', messageId)

/** An event that arrives before the send result is stored still means the email left (architecture 11.6). */
function ensureSent(ctx: StoreCtx, d: DeliveryWithNewsletter, messageId: string, at: number) {
  if (d.status !== 'sending') return
  if (ctx.db.run("UPDATE deliveries SET status = 'sent', sent_at = ?, provider_message_id = COALESCE(provider_message_id, ?) WHERE id = ? AND status = 'sending'", at, messageId, d.id).changes) {
    markSentEffects(ctx, d, d.newsletter_id, at)
    d.status = 'sent'
  }
}

function checkAutoPause(ctx: StoreCtx, campaignId: string) {
  const breach = rateBreach(readStats(ctx, campaignId), AUTO_PAUSE_MIN_SENT)
  if (!breach) return
  const row = getCampaignRow(ctx, campaignId)
  pauseCampaign(ctx, row, breach)
}

function hardBounce(ctx: StoreCtx, d: DeliveryWithNewsletter, reason: string, at: number) {
  if (!['sending', 'sent', 'delivered'].includes(d.status)) return false
  ctx.db.run("UPDATE deliveries SET status = 'bounced', bounced_at = ?, error = ? WHERE id = ?", at, reason.slice(0, 500), d.id)
  bumpStat(ctx, d.campaign_id, 'bounced')
  if (d.status === 'delivered') bumpStat(ctx, d.campaign_id, 'delivered', -1)
  setContactStatus(ctx, d.contact_id, 'bounced', { reason: reason.slice(0, 200), campaignId: d.campaign_id, at })
  return true
}

/** Apply one provider event inside a transaction. Returns false for a duplicate or an unknown delivery. */
function applyEvent(ctx: StoreCtx, e: ProviderEvent): boolean {
  const now = ctx.now()
  const at = Number.isFinite(e.occurredAt) && e.occurredAt > 0 ? Math.min(e.occurredAt, now) : now
  const byId = e.deliveryId && /^\d+$/.test(e.deliveryId) ? deliveryById(ctx, Number(e.deliveryId)) : undefined
  const d = byId ?? (e.messageId ? deliveryByMessage(ctx, e.messageId) : undefined)
  if (!ctx.db.run('INSERT OR IGNORE INTO provider_events (id, delivery_id, type, occurred_at, received_at) VALUES (?, ?, ?, ?, ?)', e.id, d?.id ?? null, e.type, at, now).changes) return false
  if (!d || d.email !== e.recipient.trim().toLowerCase()) return false
  ensureSent(ctx, d, e.messageId, at)
  switch (e.type) {
    case 'delivered':
      if (d.status !== 'sent') return false
      ctx.db.run("UPDATE deliveries SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'sent'", at, d.id)
      bumpStat(ctx, d.campaign_id, 'delivered')
      daily(ctx, d.newsletter_id, 'delivered', at)
      return true
    case 'bounce': {
      const reason = e.bounce?.reason ?? 'Bounced'
      if (e.bounce?.permanent) {
        if (!hardBounce(ctx, d, reason, at)) return false
        if (e.bounce.nonexistent) ctx.jobs.enqueue('suppression.report', { events: [e] })
        checkAutoPause(ctx, d.campaign_id)
        return true
      }
      if (!['sent', 'delivered'].includes(d.status)) return false
      ctx.db.run('INSERT INTO events (type, newsletter_id, contact_id, campaign_id, delivery_id, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'soft_bounce', d.newsletter_id, d.contact_id, d.campaign_id, d.id, JSON.stringify({ reason: reason.slice(0, 200) }), at)
      bumpStat(ctx, d.campaign_id, 'softBounces')
      const soft = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE contact_id = ? AND type = 'soft_bounce'", d.contact_id)!.n
      if (soft >= SOFT_BOUNCES_BEFORE_HARD) {
        hardBounce(ctx, d, `${SOFT_BOUNCES_BEFORE_HARD} soft bounces: ${reason}`, at)
        checkAutoPause(ctx, d.campaign_id)
      }
      return true
    }
    case 'complaint':
      if (!['sent', 'delivered'].includes(d.status)) return false
      ctx.db.run("UPDATE deliveries SET status = 'complained', complained_at = ? WHERE id = ?", at, d.id)
      bumpStat(ctx, d.campaign_id, 'complained')
      if (d.status === 'delivered') bumpStat(ctx, d.campaign_id, 'delivered', -1)
      setContactStatus(ctx, d.contact_id, 'complained', { campaignId: d.campaign_id, at })
      checkAutoPause(ctx, d.campaign_id)
      return true
    case 'deferred':
      bumpStat(ctx, d.campaign_id, 'deferred')
      return true
    default:
      return false
  }
}

/** `account.ingestProviderEvents` per architecture 11.6: each event is deduped and applied in one transaction. */
export function ingestProviderEvents(ctx: StoreCtx, events: ProviderEvent[]): { applied: number } {
  let applied = 0
  for (const e of events) {
    if (!e || typeof e.id !== 'string' || !e.id || typeof e.recipient !== 'string') continue
    if (ctx.db.tx(() => applyEvent(ctx, e))) applied++
  }
  checkProtection(ctx)
  return { applied }
}

const score = (ctx: StoreCtx, contactId: string) => ctx.db.run('UPDATE contacts SET engaged_score = ROUND((open_count + 3.0 * click_count) / MAX(sent_count, 1), 3) WHERE id = ?', contactId)

export function recordOpen(ctx: StoreCtx, d: DeliveryWithNewsletter, at: number, privacyProxy = false) {
  ctx.db.tx(() => {
    const first = !d.opened_at
    ctx.db.run('UPDATE deliveries SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?', at, d.id)
    ctx.db.run('UPDATE contacts SET open_count = open_count + 1, last_opened_at = ?, ignored_streak = 0, updated_at = ? WHERE id = ?', at, at, d.contact_id)
    if (!privacyProxy) ctx.db.run('UPDATE contacts SET strict_ignored_streak = 0 WHERE id = ?', d.contact_id)
    score(ctx, d.contact_id)
    if (!first) return
    ctx.db.run('INSERT INTO events (type, newsletter_id, contact_id, campaign_id, delivery_id, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'open', d.newsletter_id, d.contact_id, d.campaign_id, d.id, JSON.stringify({ privacyProxy }), at)
    bumpStat(ctx, d.campaign_id, 'opens')
    daily(ctx, d.newsletter_id, 'opens', at)
  })
}

export const BURST_WINDOW_MS = 10_000

/** Count a click; a burst that hits every link of the issue within seconds is a scanner and is undone. */
export function recordClick(ctx: StoreCtx, d: DeliveryWithNewsletter, link: { id: string }, at: number) {
  ctx.db.tx(() => {
    const before = ctx.db.all<{ id: number; link: string; at: number }>("SELECT id, json_extract(data, '$.link') AS link, at FROM events WHERE delivery_id = ? AND type = 'click' AND at >= ?", d.id, at - BURST_WINDOW_MS)
    const firstOnLink = !ctx.db.get("SELECT 1 FROM events WHERE delivery_id = ? AND type = 'click' AND json_extract(data, '$.link') = ?", d.id, link.id)
    const firstOnDelivery = !d.clicked_at
    ctx.db.run('UPDATE deliveries SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?) WHERE id = ?', at, d.id)
    ctx.db.run('UPDATE contacts SET click_count = click_count + 1, last_clicked_at = ?, ignored_streak = 0, updated_at = ? WHERE id = ?', at, at, d.contact_id)
    ctx.db.run('UPDATE links SET clicks = clicks + 1, unique_clicks = unique_clicks + ? WHERE id = ?', firstOnLink ? 1 : 0, link.id)
    ctx.db.run('INSERT INTO events (type, newsletter_id, contact_id, campaign_id, delivery_id, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'click', d.newsletter_id, d.contact_id, d.campaign_id, d.id, JSON.stringify({ link: link.id, first: firstOnDelivery, firstOnLink }), at)
    if (firstOnDelivery) {
      bumpStat(ctx, d.campaign_id, 'clicks')
      daily(ctx, d.newsletter_id, 'clicks', at)
    }
    score(ctx, d.contact_id)
    const total = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM links WHERE campaign_id = ?', d.campaign_id)!.n
    const hit = new Set([...before.map((b) => b.link), link.id])
    if (total < 2 || hit.size < total) {
      ctx.db.run('UPDATE contacts SET strict_ignored_streak = 0 WHERE id = ?', d.contact_id)
      return
    }
    const burst = ctx.db.all<{ id: number; data: string; at: number }>("SELECT id, data, at FROM events WHERE delivery_id = ? AND type = 'click' AND at >= ?", d.id, at - BURST_WINDOW_MS)
    for (const b of burst) {
      const data = JSON.parse(b.data) as { link: string; first: boolean; firstOnLink: boolean }
      ctx.db.run('UPDATE links SET clicks = clicks - 1, unique_clicks = unique_clicks - ? WHERE id = ?', data.firstOnLink ? 1 : 0, data.link)
      if (data.first) {
        bumpStat(ctx, d.campaign_id, 'clicks', -1)
        daily(ctx, d.newsletter_id, 'clicks', b.at, -1)
        ctx.db.run('UPDATE deliveries SET clicked_at = NULL WHERE id = ?', d.id)
      }
      ctx.db.run('DELETE FROM events WHERE id = ?', b.id)
    }
    ctx.db.run('UPDATE deliveries SET click_count = MAX(0, click_count - ?) WHERE id = ?', burst.length, d.id)
    ctx.db.run('UPDATE contacts SET click_count = MAX(0, click_count - ?), last_clicked_at = (SELECT MAX(at) FROM events WHERE contact_id = contacts.id AND type = ?) WHERE id = ?', burst.length, 'click', d.contact_id)
    score(ctx, d.contact_id)
  })
}
