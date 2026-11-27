import type { StoreCtx } from '../../core/store.ts'
import { parseJson } from '../../core/db.ts'
import { getCampaignRow } from '../campaigns/index.ts'
import { readStats, type CampaignStats } from '../sending/index.ts'

export const DAY = 86_400_000
export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)
export const rate = (n: number, total: number) => total > 0 ? Math.min(100, Math.max(0, n / total * 100)) : 0
export function metrics(s: CampaignStats) {
  const sent = Math.max(s.sent, 0)
  return { sent, delivered: s.delivered, opens: s.opens, clicks: s.clicks, bounces: s.bounced, complaints: s.complained, unsubscribes: s.unsubscribes, openRate: rate(s.opens, sent), clickRate: rate(s.clicks, sent), clickToOpen: rate(s.clicks, s.opens), bounceRate: rate(s.bounced, sent), complaintRate: rate(s.complained, sent), unsubscribeRate: rate(s.unsubscribes, sent) }
}
export interface TimelinePoint { hour: number; sent: number; delivered: number; opens: number; clicks: number; bounces: number; complaints: number; unsubscribes: number }
export interface ProviderPoint { provider: string; sent: number; delivered: number; opens: number; clicks: number; bounces: number; complaints: number; unsubscribes: number; openRate: number; clickRate: number }
interface ReportCache { timeline: string; providers: string; updated_at: number }

export function report(ctx: StoreCtx, campaignId: string) {
  const campaign = getCampaignRow(ctx, campaignId)
  const cache = ctx.db.get<ReportCache>('SELECT timeline, providers, updated_at FROM stats_reports WHERE campaign_id = ? AND newsletter_id = ?', campaignId, campaign.newsletter_id)
  if (!cache || cache.updated_at < ctx.now() - 30_000) ctx.jobs.enqueue('stats.campaign', { campaignId }, { dedupeKey: `stats.campaign:${campaignId}` })
  return { campaign: { id: campaign.id, newsletterId: campaign.newsletter_id, subject: campaign.subject, status: campaign.status }, counts: metrics(readStats(ctx, campaignId)), timeline: parseJson<TimelinePoint[]>(cache?.timeline, emptyTimeline()), providers: parseJson<ProviderPoint[]>(cache?.providers, []), updatedAt: cache?.updated_at ?? null,
    links: ctx.db.all<{ id: string; url: string; clicks: number; unique_clicks: number }>('SELECT id, url, clicks, unique_clicks FROM links WHERE campaign_id = ? ORDER BY position, id', campaignId) }
}
export const emptyTimeline = (): TimelinePoint[] => Array.from({ length: 48 }, (_, hour) => ({ hour, sent: 0, delivered: 0, opens: 0, clicks: 0, bounces: 0, complaints: 0, unsubscribes: 0 }))

/** Recount from delivery state, not tracking hits: scanner rollbacks are already reflected here. */
export function rebuildCampaign(ctx: StoreCtx, campaignId: string): CampaignStats {
  return ctx.db.tx(() => {
    const campaign = getCampaignRow(ctx, campaignId)
    const current = readStats(ctx, campaignId)
    const counts = ctx.db.get<{ planned: number; sent: number; delivered: number; bounced: number; complained: number; failed: number; skipped: number; unknown: number; opens: number; clicks: number; unsubscribes: number }>(`SELECT COUNT(*) planned,
      COALESCE(SUM(sent_at IS NOT NULL), 0) sent, COALESCE(SUM(status = 'delivered'), 0) delivered,
      COALESCE(SUM(status = 'bounced'), 0) bounced, COALESCE(SUM(status = 'complained'), 0) complained,
      COALESCE(SUM(status = 'failed'), 0) failed, COALESCE(SUM(status = 'skipped'), 0) skipped,
      COALESCE(SUM(status = 'unknown'), 0) unknown, COALESCE(SUM(opened_at IS NOT NULL), 0) opens,
      COALESCE(SUM(clicked_at IS NOT NULL), 0) clicks, COALESCE(SUM(unsubscribed_at IS NOT NULL), 0) unsubscribes
      FROM deliveries WHERE campaign_id = ?`, campaignId)!
    const stats = { ...current, ...counts,
      softBounces: ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE campaign_id = ? AND type = 'soft_bounce'", campaignId)!.n,
      deferred: ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM provider_events p JOIN deliveries d ON d.id = p.delivery_id WHERE d.campaign_id = ? AND p.type = 'deferred'", campaignId)!.n }
    ctx.db.run('UPDATE campaigns SET stats = ? WHERE id = ? AND newsletter_id = ?', JSON.stringify(stats), campaignId, campaign.newsletter_id)
    const start = campaign.send_started_at ?? campaign.created_at
    const timeline = emptyTimeline()
    for (const key of ['sent', 'delivered', 'opens', 'clicks', 'bounces', 'complaints', 'unsubscribes'] as const) {
      const column = { sent: 'sent_at', delivered: 'delivered_at', opens: 'opened_at', clicks: 'clicked_at', bounces: 'bounced_at', complaints: 'complained_at', unsubscribes: 'unsubscribed_at' }[key]
      const rows = ctx.db.all<{ hour: number; n: number }>(`SELECT CAST((${column} - ?) / 3600000 AS INTEGER) hour, COUNT(*) n FROM deliveries WHERE campaign_id = ? AND ${column} >= ? AND ${column} < ? GROUP BY hour`, start, campaignId, start, start + 48 * 3_600_000)
      for (const row of rows) if (timeline[row.hour]) timeline[row.hour][key] = row.n
    }
    const providers = ctx.db.all<Omit<ProviderPoint, 'openRate' | 'clickRate'>>(`SELECT COALESCE(c.provider, 'other') provider, SUM(d.sent_at IS NOT NULL) sent,
      SUM(d.status = 'delivered') delivered, SUM(d.opened_at IS NOT NULL) opens, SUM(d.clicked_at IS NOT NULL) clicks,
      SUM(d.status = 'bounced') bounces, SUM(d.status = 'complained') complaints, SUM(d.unsubscribed_at IS NOT NULL) unsubscribes
      FROM deliveries d LEFT JOIN contacts c ON c.id = d.contact_id AND c.newsletter_id = ? WHERE d.campaign_id = ? GROUP BY COALESCE(c.provider, 'other') ORDER BY sent DESC, provider`, campaign.newsletter_id, campaignId).map((p) => ({ ...p, openRate: rate(p.opens, p.sent), clickRate: rate(p.clicks, p.sent) }))
    ctx.db.run('INSERT INTO stats_reports (campaign_id, newsletter_id, timeline, providers, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(campaign_id) DO UPDATE SET timeline = excluded.timeline, providers = excluded.providers, updated_at = excluded.updated_at', campaignId, campaign.newsletter_id, JSON.stringify(timeline), JSON.stringify(providers), ctx.now())
    return stats
  })
}

/** Days the recurring rollup repairs; older days only change through a full `rebuild`. */
export const ROLLUP_WINDOW_DAYS = 3

/** Recount daily rows from `since` (ms) on, or all history when omitted. Live bumps keep today current; this repairs. */
export function rebuildDaily(ctx: StoreCtx, newsletterId: string, since = 0) {
  const day = dayOf(since)
  ctx.db.tx(() => {
    ctx.db.run('DELETE FROM daily_stats WHERE newsletter_id = ? AND day >= ?', newsletterId, day)
    ctx.db.run(`INSERT INTO daily_stats (newsletter_id, day, subscribed, unsubscribed, bounces, complaints)
      SELECT newsletter_id, strftime('%Y-%m-%d', at / 1000, 'unixepoch'),
        SUM(type IN ('signup','confirm') AND COALESCE(json_extract(data, '$.pending'), 0) = 0), SUM(type IN ('unsubscribe','cleaned')), SUM(type = 'bounce'), SUM(type = 'complaint')
      FROM events WHERE newsletter_id = ? AND at >= ? GROUP BY 1, 2`, newsletterId, since)
    for (const [column, timestamp] of [['sent', 'sent_at'], ['delivered', 'delivered_at'], ['opens', 'opened_at'], ['clicks', 'clicked_at']] as const) ctx.db.run(`INSERT INTO daily_stats (newsletter_id, day, ${column})
      SELECT c.newsletter_id, strftime('%Y-%m-%d', d.${timestamp} / 1000, 'unixepoch'), COUNT(*) FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE c.newsletter_id = ? AND c.kind != 'welcome' AND d.${timestamp} >= ? GROUP BY 1, 2
      ON CONFLICT(newsletter_id, day) DO UPDATE SET ${column} = excluded.${column}`, newsletterId, since)
    ctx.db.run(`INSERT INTO daily_stats (newsletter_id, day, page_views) SELECT newsletter_id, strftime('%Y-%m-%d', at / 1000, 'unixepoch'), COUNT(*) FROM page_views WHERE newsletter_id = ? AND at >= ? GROUP BY 1, 2 ON CONFLICT(newsletter_id, day) DO UPDATE SET page_views = excluded.page_views`, newsletterId, since)
    ctx.db.run('DELETE FROM stats_sources WHERE newsletter_id = ? AND day >= ?', newsletterId, day)
    ctx.db.run(`INSERT INTO stats_sources (newsletter_id, day, source, added, removed)
      SELECT e.newsletter_id, strftime('%Y-%m-%d', e.at / 1000, 'unixepoch'), COALESCE(json_extract(e.data, '$.source'), c.source, 'unknown'),
      SUM(e.type IN ('signup','confirm') AND COALESCE(json_extract(e.data, '$.pending'), 0) = 0), SUM(e.type IN ('unsubscribe','cleaned','bounce','complaint'))
      FROM events e LEFT JOIN contacts c ON c.id = e.contact_id AND c.newsletter_id = e.newsletter_id WHERE e.newsletter_id = ? AND e.at >= ? AND e.type IN ('signup','confirm','unsubscribe','cleaned','bounce','complaint') GROUP BY 1, 2, 3`, newsletterId, since)
    ctx.db.run('DELETE FROM stats_website WHERE newsletter_id = ? AND day >= ?', newsletterId, day)
    for (const [dimension, column] of [['path', 'path'], ['referrer', 'referrer_host'], ['country', 'country']] as const) ctx.db.run(`INSERT INTO stats_website (newsletter_id, day, dimension, value, views) SELECT newsletter_id, strftime('%Y-%m-%d', at / 1000, 'unixepoch'), ?, ${column}, COUNT(*) FROM page_views WHERE newsletter_id = ? AND at >= ? GROUP BY 1, 2, 3, 4`, dimension, newsletterId, since)
  })
}

/** Campaigns the recurring rollup rebuilds: in flight, sent within the window, or never cached. */
export function campaignsToRoll(ctx: StoreCtx, newsletterId: string, now: number): string[] {
  return ctx.db.all<{ id: string }>(`SELECT c.id FROM campaigns c LEFT JOIN stats_reports r ON r.campaign_id = c.id
    WHERE c.newsletter_id = ? AND (c.status IN ('sending', 'paused', 'scheduled') OR c.sent_at >= ? OR r.campaign_id IS NULL)`, newsletterId, now - ROLLUP_WINDOW_DAYS * DAY).map((r) => r.id)
}

export function rebuild(ctx: StoreCtx, newsletterId: string) {
  rebuildDaily(ctx, newsletterId)
  for (const row of ctx.db.all<{ id: string }>('SELECT id FROM campaigns WHERE newsletter_id = ?', newsletterId)) rebuildCampaign(ctx, row.id)
}
