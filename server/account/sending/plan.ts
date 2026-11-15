import { insertMany } from '../../core/db.ts'
import { AppError } from '../../core/http.ts'
import { newId } from '../../core/ids.ts'
import type { StoreCtx } from '../../core/store.ts'
import { audienceSchema, transitionCampaign, type CampaignRow } from '../campaigns/index.ts'
import { audienceQuery } from '../segments/index.ts'
import { limits } from '../usage/index.ts'
import { EMPTY_STATS, writeStats } from './stats.ts'

export interface SendOptions {
  gradual: boolean
  engagedFirst: boolean
}
export const WARMUP_GAP_MS = 30 * 60_000
export const REST_LATER_MS = 24 * 60 * 60_000
/** Below this many never-emailed contacts a warm-up would send single emails, so it is skipped. */
export const WARMUP_MIN_FRESH = 50
const ENGAGED_WINDOW_MS = 90 * 86_400_000

interface AudienceRow {
  id: string
  email: string
  fresh: number
  engaged: number
}

export const parseAudience = (row: CampaignRow) => audienceSchema.parse(JSON.parse(row.audience === '{}' ? '{"all":true}' : row.audience))

function audienceRows(ctx: StoreCtx, row: CampaignRow): AudienceRow[] {
  const q = audienceQuery(ctx, row.newsletter_id, parseAudience(row))
  const since = ctx.now() - ENGAGED_WINDOW_MS
  return ctx.db.all<AudienceRow>(`SELECT c.id, c.email,
      NOT EXISTS (SELECT 1 FROM contacts o WHERE o.email = c.email AND o.sent_count > 0) AS fresh,
      (COALESCE(c.last_opened_at, 0) >= ? OR COALESCE(c.last_clicked_at, 0) >= ?) AS engaged
    FROM contacts c WHERE ${q.where} ORDER BY random()`, since, since, ...q.params)
}

/** What the Review step shows: how many will get the issue, and how the gradual and engaged options would split them. */
export function audienceCount(ctx: StoreCtx, row: CampaignRow): { total: number; fresh: number; engaged: number } {
  const rows = audienceRows(ctx, row)
  return { total: rows.length, fresh: rows.filter((r) => r.fresh).length, engaged: rows.filter((r) => r.engaged).length }
}

interface Step {
  kind: 'warmup' | 'main' | 'more'
  releaseAt: number | null
  contacts: AudienceRow[]
}

/** Split the audience into released steps per architecture 6: warm-up for never-emailed contacts, most engaged first. */
export function planSteps(rows: AudienceRow[], options: SendOptions, now: number): Step[] {
  const byEngagement = (list: AudienceRow[]) => options.engagedFirst ? [...list].sort((a, b) => b.engaged - a.engaged) : list
  const fresh = rows.filter((r) => r.fresh)
  const known = rows.filter((r) => !r.fresh)
  if (options.gradual && fresh.length >= WARMUP_MIN_FRESH) {
    const first = Math.ceil(fresh.length * 0.02)
    const second = Math.ceil(fresh.length * 0.05)
    const plan: Step[] = [
      { kind: 'warmup', releaseAt: now, contacts: byEngagement([...known, ...fresh.slice(0, first)]) },
      { kind: 'warmup', releaseAt: now + WARMUP_GAP_MS, contacts: fresh.slice(first, first + second) },
      { kind: 'main', releaseAt: now + 2 * WARMUP_GAP_MS, contacts: byEngagement(fresh.slice(first + second)) },
    ]
    return plan.filter((s) => s.contacts.length)
  }
  if (options.engagedFirst) {
    const engaged = rows.filter((r) => r.engaged)
    const rest = rows.filter((r) => !r.engaged)
    if (engaged.length && rest.length) return [{ kind: 'main', releaseAt: now, contacts: engaged }, { kind: 'more', releaseAt: now + REST_LATER_MS, contacts: rest }]
  }
  return [{ kind: 'main', releaseAt: now, contacts: byEngagement(rows) }]
}

/** Move a scheduled campaign to sending: build steps and delivery rows, then queue the batch job. Runs in one transaction. */
export function startSending(ctx: StoreCtx, row: CampaignRow, options: SendOptions): { planned: number } {
  return ctx.db.tx(() => {
    const now = ctx.now()
    const rows = audienceRows(ctx, row)
    if (!rows.length) throw new AppError('empty_audience', 'Nobody is subscribed in this audience yet.', 400)
    const max = limits(ctx).maxEmailsPerMonth
    if (max !== Infinity) {
      const used = ctx.db.get<{ n: number }>('SELECT emails_sent AS n FROM usage WHERE period = ?', new Date(now).toISOString().slice(0, 7))?.n ?? 0
      if (used + rows.length > max) throw new AppError('limit_reached', `This send needs ${rows.length} emails but only ${Math.max(0, max - used)} are left this month.`, 403)
    }
    transitionCampaign(ctx, row.id, 'sending')
    ctx.db.run('DELETE FROM campaign_sends WHERE campaign_id = ?', row.id)
    const steps = planSteps(rows, options, now)
    const deliveries: (string | number | null)[][] = []
    steps.forEach((step, index) => {
      const id = newId('snd')
      const released = step.releaseAt !== null && step.releaseAt <= now
      ctx.db.run('INSERT INTO campaign_sends (id, campaign_id, step, kind, planned, release_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, row.id, index + 1, step.kind, step.contacts.length, step.releaseAt, released ? 'released' : 'pending', now)
      for (const c of step.contacts) deliveries.push([row.id, id, c.id, c.email, 'queued', now])
    })
    insertMany(ctx.db, 'deliveries', ['campaign_id', 'send_id', 'contact_id', 'email', 'status', 'queued_at'], deliveries, 'IGNORE')
    writeStats(ctx, row.id, { ...EMPTY_STATS, planned: deliveries.length })
    ctx.jobs.enqueue('send.batch', { campaignId: row.id }, { dedupeKey: `send.batch:${row.id}` })
    return { planned: deliveries.length }
  })
}
