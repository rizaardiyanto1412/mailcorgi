import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { parseJson } from '../../core/db.ts'
import { getCampaignRow } from '../campaigns/index.ts'
import { EMPTY_STATS, type CampaignStats } from '../sending/index.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { migrations } from './migrations.ts'
import { DAY, ROLLUP_WINDOW_DAYS, campaignsToRoll, dayOf, metrics, rebuildDaily, rebuildCampaign, report } from './model.ts'
export { rebuild, rebuildCampaign } from './model.ts'

const newsletterId = z.string().min(1).describe('The newsletter id.')
const campaignId = z.string().min(1).describe('The campaign id.')
const range = z.enum(['7', '30', '90', 'all']).default('30').describe('The number of days to show, or all history.')
const recipientStatus = z.enum(['all', 'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'skipped', 'unknown', 'opened', 'clicked', 'unsubscribed']).default('all').describe('Filter recipients by delivery or engagement status.')
const recipientInput = z.object({ campaignId, status: recipientStatus, after: z.number().int().nonnegative().default(0).describe('Return delivery ids after this cursor.'), limit: z.number().int().min(1).max(500).default(50).describe('The maximum number of recipients in this page.') })
const recipientWhere = (status: z.output<typeof recipientStatus>) => status === 'all' ? '1 = 1' : status === 'opened' ? 'd.opened_at IS NOT NULL' : status === 'clicked' ? 'd.clicked_at IS NOT NULL' : status === 'unsubscribed' ? 'd.unsubscribed_at IS NOT NULL' : 'd.status = ?'
const csv = (value: string | number | null) => '"' + String(value ?? '').replace(/^[\s]*[=+\-@\t\r]/, (match) => "'" + match).replaceAll('"', '""') + '"'

const ROLLUP_EVERY_MS = 5 * 60_000
const ROLLUP_IDLE_MS = 30 * 60_000

export const statsModule = {
  name: 'stats',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    reg.maintenance((ctx) => { if (ctx.db.get("SELECT 1 FROM account_meta WHERE key = 'policy' AND json_extract(value, '$.status') != 'deleting'")) ctx.jobs.enqueue('stats.rollup', {}, { dedupeKey: 'stats.rollup' }) })
    reg.job('stats.rollup', async (ctx, _input, budget) => {
      // Nothing to repair when nothing changed since the last run: the store stays idle and the
      // next check waits longer. The marker lives in memory, so a restart costs one extra run.
      const mark = ctx.db.get<{ m: string }>(`SELECT (SELECT COALESCE(MAX(id), 0) FROM events) || ':' || (SELECT COALESCE(MAX(id), 0) FROM page_views) || ':' || (SELECT COALESCE(MAX(id), 0) FROM deliveries) || ':' || (SELECT COUNT(*) FROM campaigns WHERE status IN ('sending', 'paused', 'scheduled')) || ':' || (SELECT COUNT(*) FROM provider_events) AS m`)!.m
      if (ctx.memory.get('stats.rollup') === mark) return { again: ctx.now() + ROLLUP_IDLE_MS }
      const newsletters = ctx.db.all<{ id: string }>('SELECT id FROM newsletters WHERE archived_at IS NULL')
      for (const n of newsletters) ctx.jobs.enqueue('stats.newsletter', { newsletterId: n.id }, { dedupeKey: `stats.newsletter:${n.id}` })
      ctx.memory.set('stats.rollup', mark)
      return { again: ctx.now() + (budget.expired() ? 1000 : ROLLUP_EVERY_MS) }
    })
    reg.job<{ newsletterId: string }>('stats.newsletter', async (ctx, { newsletterId }) => {
      rebuildDaily(ctx, newsletterId, ctx.now() - ROLLUP_WINDOW_DAYS * DAY)
      for (const id of campaignsToRoll(ctx, newsletterId, ctx.now())) ctx.jobs.enqueue('stats.campaign', { campaignId: id }, { dedupeKey: `stats.campaign:${id}` })
      return 'done'
    })
    reg.job<{ campaignId: string }>('stats.campaign', async (ctx, { campaignId }) => {
      if (ctx.db.get('SELECT id FROM campaigns WHERE id = ?', campaignId)) rebuildCampaign(ctx, campaignId)
      return 'done'
    })
    return reg.actions(
      defineAction({ name: 'stats.overview', description: 'Read subscriber growth, recent campaigns, traffic and setup progress.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, range }), rest: { method: 'GET', path: '/newsletters/:newsletterId/stats' }, mcp: { title: 'Read newsletter overview', destructive: false }, handler: (ctx, input) => {
        const first = input.range === 'all' ? '0000-01-01' : dayOf(ctx.now() - (Number(input.range) - 1) * DAY)
        const today = dayOf(ctx.now())
        const days = ctx.db.all<{ day: string; subscribed: number; unsubscribed: number; bounces: number; complaints: number; sent: number; delivered: number; opens: number; clicks: number; page_views: number }>('SELECT day, subscribed, unsubscribed, bounces, complaints, sent, delivered, opens, clicks, page_views FROM daily_stats WHERE newsletter_id = ? AND day >= ? AND day <= ? ORDER BY day', input.newsletterId, first, today)
        const subscribers = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM contacts WHERE newsletter_id = ? AND status = 'subscribed'", input.newsletterId)!.n
        const recent = ctx.db.all<{ id: string; subject: string; status: string; sent_at: number | null; stats: string }>("SELECT id, subject, status, sent_at, stats FROM campaigns WHERE newsletter_id = ? AND kind = 'issue' AND status != 'draft' ORDER BY created_at DESC, id DESC LIMIT 5", input.newsletterId).map((c) => ({ id: c.id, subject: c.subject, status: c.status, sentAt: c.sent_at, counts: metrics({ ...EMPTY_STATS, ...parseJson<Partial<CampaignStats>>(c.stats, {}) }) }))
        const sources = ctx.db.all<{ source: string; added: number; removed: number; net: number }>('SELECT source, SUM(added) added, SUM(removed) removed, SUM(added - removed) net FROM stats_sources WHERE newsletter_id = ? AND day >= ? AND day <= ? GROUP BY source ORDER BY net DESC, source', input.newsletterId, first, today)
        const website = ctx.db.all<{ dimension: string; value: string; views: number }>('SELECT dimension, value, SUM(views) views FROM stats_website WHERE newsletter_id = ? AND day >= ? AND day <= ? GROUP BY dimension, value ORDER BY views DESC LIMIT 60', input.newsletterId, first, today)
        const checklist = ctx.db.get<{ domain: number; imported: number; campaign: number }>(`SELECT EXISTS(SELECT 1 FROM newsletters n JOIN domains d ON d.id = n.domain_id WHERE n.id = ? AND d.status = 'verified') domain,
          EXISTS(SELECT 1 FROM imports WHERE newsletter_id = ? AND status IN ('done','finished','completed')) imported,
          EXISTS(SELECT 1 FROM campaigns WHERE newsletter_id = ? AND kind = 'issue' AND status = 'sent') campaign`, input.newsletterId, input.newsletterId, input.newsletterId)!
        const netNew = days.reduce((sum, d) => sum + d.subscribed - d.unsubscribed - d.bounces - d.complaints, 0)
        const points = []
        let count = subscribers
        const byDay = new Map(days.map((d) => [d.day, d]))
        const start = input.range === 'all' ? days[0]?.day ?? today : first
        for (let at = Date.parse(today); at >= Date.parse(start); at -= DAY) {
          const day = dayOf(at)
          const d = byDay.get(day)
          points.push({ day, subscribers: Math.max(0, count), added: d?.subscribed ?? 0, removed: (d?.unsubscribed ?? 0) + (d?.bounces ?? 0) + (d?.complaints ?? 0), pageViews: d?.page_views ?? 0 })
          if (d) count -= d.subscribed - d.unsubscribed - d.bounces - d.complaints
        }
        return { subscribers, netNew, pageViews: days.reduce((n, d) => n + d.page_views, 0), growth: points.reverse(), sources, campaigns: recent, website, checklist: { domain: !!checklist.domain, imported: !!checklist.imported, campaign: !!checklist.campaign } }
      } }),
      defineAction({ name: 'stats.report', description: 'Read a campaign report with unique engagement, links and cached breakdowns.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'campaign', param: 'campaignId' }, input: z.object({ campaignId }), rest: { method: 'GET', path: '/campaigns/:campaignId/report' }, mcp: { title: 'Read campaign report', destructive: false }, handler: (ctx, input) => report(ctx, input.campaignId) }),
      defineAction({ name: 'stats.recipients', description: 'Read a page of campaign recipients filtered by delivery or engagement status.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'campaign', param: 'campaignId' }, input: recipientInput, rest: { method: 'GET', path: '/campaigns/:campaignId/recipients' }, mcp: { title: 'Read campaign recipients', destructive: false }, handler: (ctx, input) => {
        const campaign = getCampaignRow(ctx, input.campaignId)
        const statusParams = ['all', 'opened', 'clicked', 'unsubscribed'].includes(input.status) ? [] : [input.status]
        const rows = ctx.db.all<{ id: number; email: string; status: string; sent_at: number | null; delivered_at: number | null; opened_at: number | null; clicked_at: number | null; bounced_at: number | null; complained_at: number | null; unsubscribed_at: number | null }>(`SELECT d.id, d.email, d.status, d.sent_at, d.delivered_at, d.opened_at, d.clicked_at, d.bounced_at, d.complained_at, d.unsubscribed_at FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE d.campaign_id = ? AND c.newsletter_id = ? AND d.id > ? AND ${recipientWhere(input.status)} ORDER BY d.id LIMIT ?`, input.campaignId, campaign.newsletter_id, input.after, ...statusParams, input.limit + 1)
        return { items: rows.slice(0, input.limit), next: rows.length > input.limit ? rows[input.limit - 1].id : null }
      } }),
      defineAction({ name: 'stats.exportRecipients', description: 'Export one formula-safe CSV page of campaign recipients; follow next until null.', scope: 'account', role: 'admin', effect: 'read', resource: { type: 'campaign', param: 'campaignId' }, input: recipientInput, rest: { method: 'GET', path: '/campaigns/:campaignId/recipients.csv' }, mcp: { title: 'Export campaign recipients', destructive: false }, handler: (ctx, input) => {
        const campaign = getCampaignRow(ctx, input.campaignId)
        const statusParams = ['all', 'opened', 'clicked', 'unsubscribed'].includes(input.status) ? [] : [input.status]
        const rows = ctx.db.all<{ id: number; email: string; status: string; sent_at: number | null; opened_at: number | null; clicked_at: number | null }>(`SELECT d.id, d.email, d.status, d.sent_at, d.opened_at, d.clicked_at FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE d.campaign_id = ? AND c.newsletter_id = ? AND d.id > ? AND ${recipientWhere(input.status)} ORDER BY d.id LIMIT ?`, input.campaignId, campaign.newsletter_id, input.after, ...statusParams, input.limit + 1)
        return { csv: ['Email,Status,Sent at,Opened at,Clicked at', ...rows.slice(0, input.limit).map((r) => [r.email, r.status, r.sent_at, r.opened_at, r.clicked_at].map(csv).join(','))].join('\r\n') + '\r\n', next: rows.length > input.limit ? rows[input.limit - 1].id : null }
      } }),
    )
  },
}
