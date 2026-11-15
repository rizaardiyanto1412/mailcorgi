import type { StoreCtx } from '../../core/store.ts'
import { parseJson } from '../../core/db.ts'
import { notify } from '../notifications/index.ts'
export { notify } from '../notifications/index.ts'
import { transitionCampaign, type CampaignRow } from '../campaigns/index.ts'

/** Cached counters on `campaigns.stats`. Opens, clicks and unsubscribes count unique deliveries. */
export interface CampaignStats {
  planned: number
  sent: number
  delivered: number
  bounced: number
  softBounces: number
  complained: number
  failed: number
  skipped: number
  unknown: number
  opens: number
  clicks: number
  unsubscribes: number
  deferred: number
  /** Counters at the last resume, so a resumed send is judged on what happens after it. */
  baseAttempted: number
  baseBounced: number
  baseComplained: number
}
export const EMPTY_STATS: CampaignStats = { planned: 0, sent: 0, delivered: 0, bounced: 0, softBounces: 0, complained: 0, failed: 0, skipped: 0, unknown: 0, opens: 0, clicks: 0, unsubscribes: 0, deferred: 0, baseAttempted: 0, baseBounced: 0, baseComplained: 0 }
export const readStats = (ctx: StoreCtx, campaignId: string): CampaignStats => ({ ...EMPTY_STATS, ...parseJson<Partial<CampaignStats>>(ctx.db.get<{ stats: string }>('SELECT stats FROM campaigns WHERE id = ?', campaignId)?.stats, {}) })
export const bumpStat = (ctx: StoreCtx, campaignId: string, key: keyof CampaignStats, n = 1) =>
  ctx.db.run(`UPDATE campaigns SET stats = json_set(CASE WHEN json_valid(stats) THEN stats ELSE '{}' END, '$.${key}', COALESCE(json_extract(stats, '$.${key}'), 0) + ?) WHERE id = ?`, n, campaignId)
export const writeStats = (ctx: StoreCtx, campaignId: string, stats: CampaignStats) => ctx.db.run('UPDATE campaigns SET stats = ? WHERE id = ?', JSON.stringify(stats), campaignId)

/** Rebuild the status counters from the delivery rows; engagement counters are kept. */
export function recountStats(ctx: StoreCtx, campaignId: string): CampaignStats {
  const current = readStats(ctx, campaignId)
  const rows = ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM deliveries WHERE campaign_id = ? GROUP BY status', campaignId)
  const by = (status: string) => rows.find((r) => r.status === status)?.n ?? 0
  const stats: CampaignStats = { ...current, planned: rows.reduce((n, r) => n + r.n, 0), sent: ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM deliveries WHERE campaign_id = ? AND sent_at IS NOT NULL', campaignId)!.n, delivered: by('delivered'), bounced: by('bounced'), complained: by('complained'), failed: by('failed'), skipped: by('skipped'), unknown: by('unknown') }
  writeStats(ctx, campaignId, stats)
  return stats
}

export const attempted = (s: CampaignStats) => s.sent
export const HARD_BOUNCE_LIMIT = 0.025
export const COMPLAINT_LIMIT = 0.0008
export const AUTO_PAUSE_MIN_SENT = 200
export const GATE_MIN_SENT = 20

/** Which rate crossed its limit once at least `min` emails went out, or null. */
export function rateBreach(stats: CampaignStats, min: number): 'bounce_rate' | 'complaint_rate' | null {
  const total = attempted(stats) - stats.baseAttempted
  if (total < Math.max(1, min)) return null
  if ((stats.bounced - stats.baseBounced) / total > HARD_BOUNCE_LIMIT) return 'bounce_rate'
  if ((stats.complained - stats.baseComplained) / total > COMPLAINT_LIMIT) return 'complaint_rate'
  return null
}

/** Called on resume: rates are measured from here on. */
export function resetRateBaseline(ctx: StoreCtx, campaignId: string) {
  const s = readStats(ctx, campaignId)
  writeStats(ctx, campaignId, { ...s, baseAttempted: attempted(s), baseBounced: s.bounced, baseComplained: s.complained })
}

export const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10)
export function daily(ctx: StoreCtx, newsletterId: string, column: 'sent' | 'delivered' | 'opens' | 'clicks' | 'bounces' | 'complaints' | 'unsubscribed', at: number, n = 1) {
  ctx.db.run(`INSERT INTO daily_stats (newsletter_id, day, ${column}) VALUES (?, ?, ?) ON CONFLICT(newsletter_id, day) DO UPDATE SET ${column} = ${column} + excluded.${column}`, newsletterId, dayOf(at), n)
}

export const PAUSE_MESSAGES: Record<string, string> = {
  manual: 'Paused by you.',
  bounce_rate: 'Paused: more than 2.5% of emails bounced.',
  complaint_rate: 'Paused: more than 0.08% of recipients marked it as spam.',
  account_blocked: 'Paused: this account cannot send right now.',
  sending_disabled: 'Paused: sending is turned off for this install.',
  sender_unverified: 'Paused: the sender domain is no longer verified.',
}

/** Pause a sending campaign with a reason and tell the owner. A campaign that is not sending is left alone. */
export function pauseCampaign(ctx: StoreCtx, row: Pick<CampaignRow, 'id' | 'subject' | 'status'>, reason: string): boolean {
  if (row.status !== 'sending') return false
  ctx.db.tx(() => {
    transitionCampaign(ctx, row.id, 'paused', { reason })
    notify(ctx, { kind: 'campaign_paused', tone: reason === 'manual' ? 'info' : 'warn', title: `“${row.subject || 'Untitled issue'}” was paused`, body: PAUSE_MESSAGES[reason] ?? reason, href: `/campaigns/${row.id}` })
  })
  return true
}
