import type { StoreCtx } from '../../core/store.ts'
import { isWriteRefused } from '../../core/db.ts'
import { park } from './pending.ts'
import type { ProviderEvent } from '../../email/index.ts'
import { checkProtection, hygieneEpoch } from '../hygiene/index.ts'
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
  if (ctx.db.run("UPDATE deliveries SET status = 'sent', sent_at = ?, provider_message_id = COALESCE(provider_message_id, ?), hygiene_epoch = ? WHERE id = ? AND status = 'sending'", at, messageId, hygieneEpoch(ctx), d.id).changes) {
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
      const soft = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE newsletter_id = ? AND contact_id = ? AND type = 'soft_bounce'", d.newsletter_id, d.contact_id)!.n
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
export async function ingestProviderEvents(ctx: StoreCtx, events: ProviderEvent[], opts: { park?: boolean } = {}): Promise<{ applied: number }> {
  let applied = 0
  const valid = events.filter((e) => e && typeof e.id === 'string' && !!e.id && typeof e.recipient === 'string')
  for (let i = 0; i < valid.length; i++) {
    try {
      if (ctx.db.tx(() => applyEvent(ctx, valid[i]))) applied++
    } catch (err) {
      // A refused write must not lose a complaint or a bounce: the rest of the batch is parked and
      // the provider is answered, so it stops retrying. Duplicates are dropped on replay by event id.
      if (!isWriteRefused(err) || opts.park === false) throw err
      const rest = valid.slice(i)
      if (!(await park(ctx, { kind: 'events', events: rest }))) throw err
      return { applied: applied + rest.length }
    }
  }
  try {
    checkProtection(ctx)
  } catch (err) {
    if (!isWriteRefused(err)) throw err
  }
  return { applied }
}

/** The engagement score, recomputed in the same statement as the counters it depends on. */
const SCORE = 'engaged_score = ROUND((open_count + 3.0 * click_count) / MAX(sent_count, 1), 3)'

/**
 * A first open of a delivery (a later one waits in memory, see `recordRepeatOpen`). The delivery's
 * `opened_at` is the record the timeline and the reports read; no `events` row is written.
 */
export function recordOpen(ctx: StoreCtx, d: DeliveryWithNewsletter, at: number, privacyProxy = false) {
  ctx.db.tx(() => {
    const first = !d.opened_at
    ctx.db.run('UPDATE deliveries SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?', at, d.id)
    ctx.db.run(`UPDATE contacts SET open_count = open_count + 1, last_opened_at = ?, ignored_streak = 0, strict_ignored_streak = CASE WHEN ? THEN 0 ELSE strict_ignored_streak END, updated_at = ?, ${SCORE} WHERE id = ?`, at, privacyProxy ? 0 : 1, at, d.contact_id)
    if (!first) return
    bumpStat(ctx, d.campaign_id, 'opens')
    daily(ctx, d.newsletter_id, 'opens', at)
  })
}

const REPEAT_OPENS = 'tracking.repeatOpens'
interface RepeatOpen { deliveryId: number; contactId: string; n: number; at: number; strict: boolean }

/** A later open of the same delivery only bumps counters, so it waits in memory and lands in one batch. */
export function recordRepeatOpen(ctx: StoreCtx, d: DeliveryWithNewsletter, at: number, privacyProxy = false) {
  let pending = ctx.memory.get(REPEAT_OPENS) as Map<number, RepeatOpen> | undefined
  if (!pending) {
    pending = new Map()
    ctx.memory.set(REPEAT_OPENS, pending)
  }
  const row = pending.get(d.id) ?? { deliveryId: d.id, contactId: d.contact_id, n: 0, at, strict: false }
  row.n++
  row.at = Math.max(row.at, at)
  row.strict ||= !privacyProxy
  pending.set(d.id, row)
  ctx.later.add(REPEAT_OPENS, flushRepeatOpens)
}

export function flushRepeatOpens(ctx: StoreCtx) {
  const pending = ctx.memory.get(REPEAT_OPENS) as Map<number, RepeatOpen> | undefined
  if (!pending?.size) return
  const rows = [...pending.values()]
  pending.clear()
  ctx.db.tx(() => {
    for (const r of rows) {
      ctx.db.run('UPDATE deliveries SET open_count = open_count + ? WHERE id = ?', r.n, r.deliveryId)
      ctx.db.run('UPDATE contacts SET open_count = open_count + ?, last_opened_at = MAX(COALESCE(last_opened_at, 0), ?), ignored_streak = 0, strict_ignored_streak = CASE WHEN ? THEN 0 ELSE strict_ignored_streak END, updated_at = ?, engaged_score = ROUND((open_count + ? + 3.0 * click_count) / MAX(sent_count, 1), 3) WHERE id = ?', r.n, r.at, r.strict ? 1 : 0, r.at, r.n, r.contactId)
    }
  })
}

export const BURST_WINDOW_MS = 10_000

/**
 * Count a click; a burst that hits every link of the issue within seconds is a scanner and is undone.
 * Click events stay in `events` (per-link uniqueness and the burst check need them) and are read
 * through the contact's timeline index, so no index on `delivery_id` is kept.
 */
export function recordClick(ctx: StoreCtx, d: DeliveryWithNewsletter, link: { id: string }, at: number) {
  ctx.db.tx(() => {
    const clicksOf = "FROM events WHERE newsletter_id = ? AND contact_id = ? AND delivery_id = ? AND type = 'click'"
    const before = ctx.db.all<{ id: number; link: string; at: number }>(`SELECT id, json_extract(data, '$.link') AS link, at ${clicksOf} AND at >= ?`, d.newsletter_id, d.contact_id, d.id, at - BURST_WINDOW_MS)
    const firstOnLink = !ctx.db.get(`SELECT 1 ${clicksOf} AND json_extract(data, '$.link') = ?`, d.newsletter_id, d.contact_id, d.id, link.id)
    const firstOnDelivery = !d.clicked_at
    const total = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM links WHERE campaign_id = ?', d.campaign_id)!.n
    const hit = new Set([...before.map((b) => b.link), link.id])
    const human = total < 2 || hit.size < total
    ctx.db.run('UPDATE deliveries SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?) WHERE id = ?', at, d.id)
    ctx.db.run(`UPDATE contacts SET click_count = click_count + 1, last_clicked_at = ?, ignored_streak = 0, strict_ignored_streak = CASE WHEN ? THEN 0 ELSE strict_ignored_streak END, updated_at = ?, ${SCORE} WHERE id = ?`, at, human ? 1 : 0, at, d.contact_id)
    ctx.db.run('UPDATE links SET clicks = clicks + 1, unique_clicks = unique_clicks + ? WHERE id = ?', firstOnLink ? 1 : 0, link.id)
    ctx.db.run('INSERT INTO events (type, newsletter_id, contact_id, campaign_id, delivery_id, data, at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'click', d.newsletter_id, d.contact_id, d.campaign_id, d.id, JSON.stringify({ link: link.id, first: firstOnDelivery, firstOnLink }), at)
    if (firstOnDelivery) {
      bumpStat(ctx, d.campaign_id, 'clicks')
      daily(ctx, d.newsletter_id, 'clicks', at)
    }
    if (human) return
    const burst = ctx.db.all<{ id: number; data: string; at: number }>(`SELECT id, data, at ${clicksOf} AND at >= ?`, d.newsletter_id, d.contact_id, d.id, at - BURST_WINDOW_MS)
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
    ctx.db.run(`UPDATE contacts SET click_count = MAX(0, click_count - ?), last_clicked_at = (SELECT MAX(at) FROM events WHERE newsletter_id = ? AND contact_id = contacts.id AND type = 'click'), ${SCORE} WHERE id = ?`, burst.length, d.newsletter_id, d.contact_id)
  })
}

/** How many provider webhook events this store has accepted, and when the last one arrived. */
export function providerEventStats(ctx: StoreCtx): { count: number; lastAt: number | null } {
  const row = ctx.db.get<{ n: number; last: number | null }>('SELECT COUNT(*) AS n, MAX(received_at) AS last FROM provider_events')!
  return { count: row.n, lastAt: row.last }
}
