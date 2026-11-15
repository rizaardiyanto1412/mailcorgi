import { z } from 'zod'
import { assertSendingAllowed } from '../hygiene/index.ts'
import { defineAction } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import { allowRate } from '../../core/ratelimit.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { getCampaign, getCampaignRow, reviewChecks, serializeCampaign, transitionCampaign, type CampaignRow } from '../campaigns/index.ts'
import { getNewsletterRow } from '../newsletters/index.ts'
import { parseTheme } from '../render/index.ts'
import { verifiedSenderFor } from '../domains/index.ts'
import { migrations } from './migrations.ts'
import { finishCampaign, sendBatch } from './batch.ts'
import { audienceCount, startSending, type SendOptions } from './plan.ts'
import { buildMessage, sendContext } from './message.ts'
import { sendProvider, sendSettings } from './provider.ts'
import { PAUSE_MESSAGES, bumpStat, notify, pauseCampaign, readStats, resetRateBaseline } from './stats.ts'
export { sendHooks } from './provider.ts'
export { readStats, recountStats, bumpStat, daily, notify, pauseCampaign, rateBreach, resetRateBaseline, AUTO_PAUSE_MIN_SENT } from './stats.ts'
export { markSentEffects } from './batch.ts'
export type { CampaignStats } from './stats.ts'

const campaignId = z.string().min(1).describe('The campaign id')
const resource = { type: 'campaign', param: 'campaignId' } as const
const options = {
  gradual: z.boolean().default(false).describe('Warm up contacts this account never emailed: a random 2%, then 5% more, then the rest, 30 minutes apart'),
  engagedFirst: z.boolean().default(false).describe('Send to recently engaged subscribers first and the rest a day later'),
}

/** Everything a send needs: review errors, a verified sender and an install that sends. Throws the first problem. */
async function assertSendable(ctx: StoreCtx, row: CampaignRow) {
  assertSendingAllowed(ctx)
  if (row.kind !== 'issue') throw new AppError('not_issue', 'Only issues can be sent or scheduled.', 409)
  const nl = getNewsletterRow(ctx, row.newsletter_id)
  if (!nl || nl.archived_at) throw new AppError('newsletter_archived', 'This newsletter is archived.', 409)
  const checks = reviewChecks({ campaign: serializeCampaign(row), newsletter: { ...nl }, theme: parseTheme(nl.theme), domainVerified: !!verifiedSenderFor(ctx, row.newsletter_id) })
  const errors = checks.filter((c) => c.level === 'error')
  if (errors.length) throw new AppError('review_failed', errors[0].message, 400, { checks })
  if ((await sendSettings(ctx)).sending_enabled === 'false') throw new AppError('sending_disabled', 'Email sending is paused for this install.', 403)
}

/** Queue the batch job now, even when an earlier run left it sleeping until a later step. */
function wakeBatch(ctx: StoreCtx, campaignId: string) {
  const key = `send.batch:${campaignId}`
  ctx.jobs.cancelByKey(key)
  ctx.jobs.enqueue('send.batch', { campaignId }, { dedupeKey: key })
}

function steps(ctx: StoreCtx, id: string) {
  return ctx.db.all<{ id: string; step: number; kind: 'warmup' | 'main' | 'more'; planned: number; release_at: number | null; state: string }>('SELECT * FROM campaign_sends WHERE campaign_id = ? ORDER BY step', id).map((s) => ({ id: s.id, step: s.step, kind: s.kind, planned: s.planned, releaseAt: s.release_at, state: s.state as 'pending' | 'released' | 'done' }))
}

export const sendingModule = {
  name: 'sending',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    reg.job<{ campaignId: string }>('send.batch', (ctx, { campaignId }, budget) => sendBatch(ctx, campaignId, budget))
    reg.job<{ campaignId: string; options: SendOptions }>('send.start', async (ctx, { campaignId, options }) => {
      let row: CampaignRow
      try { row = getCampaignRow(ctx, campaignId) } catch { return 'done' }
      if (row.status !== 'scheduled' || (row.scheduled_at ?? 0) > ctx.now()) return 'done'
      try {
        await assertSendable(ctx, row)
        startSending(ctx, row, options)
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        ctx.db.tx(() => {
          transitionCampaign(ctx, campaignId, 'canceled', { reason: err.message })
          notify(ctx, { kind: 'campaign_failed', tone: 'danger', title: `“${row.subject || 'Untitled issue'}” could not be sent`, body: err.message, href: `/campaigns/${row.id}` })
        })
      }
      return 'done'
    })
    return reg.actions(
      defineAction({
        name: 'campaigns.send', description: 'Send a draft now. Runs the review checks first.', scope: 'account', role: 'admin', effect: 'send', resource,
        input: z.object({ campaignId, ...options }), rest: { method: 'POST', path: '/campaigns/:campaignId/send' }, mcp: { title: 'Send a campaign now', destructive: true },
        handler: async (ctx, input) => {
          const row = getCampaignRow(ctx, input.campaignId)
          if (row.status !== 'draft') throw new AppError('not_draft', 'Only a draft can be sent.', 409)
          await assertSendable(ctx, row)
          return ctx.db.tx(() => {
            transitionCampaign(ctx, row.id, 'scheduled', { scheduledAt: ctx.now() })
            const { planned } = startSending(ctx, getCampaignRow(ctx, row.id), { gradual: input.gradual, engagedFirst: input.engagedFirst })
            return { campaign: getCampaign(ctx, row.id), planned }
          })
        },
      }),
      defineAction({
        name: 'campaigns.schedule', description: 'Schedule a draft to send at a later time.', scope: 'account', role: 'admin', effect: 'send', resource,
        input: z.object({ campaignId, scheduledAt: z.number().int().positive().describe('When to send, in milliseconds since the epoch (UTC)'), ...options }),
        rest: { method: 'POST', path: '/campaigns/:campaignId/schedule' }, mcp: { title: 'Schedule a campaign', destructive: true },
        handler: async (ctx, input) => {
          const row = getCampaignRow(ctx, input.campaignId)
          if (row.status !== 'draft') throw new AppError('not_draft', 'Only a draft can be scheduled.', 409)
          if (input.scheduledAt < ctx.now() + 60_000) throw new AppError('invalid_schedule', 'Choose a send time at least a minute from now.', 400)
          if (input.scheduledAt > ctx.now() + 365 * 86_400_000) throw new AppError('invalid_schedule', 'Choose a send time within the next year.', 400)
          await assertSendable(ctx, row)
          return ctx.db.tx(() => {
            const campaign = transitionCampaign(ctx, row.id, 'scheduled', { scheduledAt: input.scheduledAt })
            ctx.jobs.enqueue('send.start', { campaignId: row.id, options: { gradual: input.gradual, engagedFirst: input.engagedFirst } }, { runAt: input.scheduledAt, dedupeKey: `send.start:${row.id}` })
            return campaign
          })
        },
      }),
      defineAction({
        name: 'campaigns.cancel', description: 'Cancel a scheduled send, or stop a paused send and skip the rest.', scope: 'account', role: 'admin', effect: 'write', resource,
        input: z.object({ campaignId }), rest: { method: 'POST', path: '/campaigns/:campaignId/cancel' }, mcp: { title: 'Cancel a campaign send', destructive: true },
        handler: (ctx, input) => ctx.db.tx(() => {
          const row = getCampaignRow(ctx, input.campaignId)
          if (row.status === 'draft' || row.status === 'scheduled') {
            ctx.jobs.cancelByKey(`send.start:${row.id}`)
            return transitionCampaign(ctx, row.id, 'canceled')
          }
          if (row.status !== 'paused') throw new AppError('invalid_transition', 'Pause the send before stopping it.', 409)
          const skipped = ctx.db.run("UPDATE deliveries SET status = 'skipped', error = 'Send stopped.' WHERE campaign_id = ? AND status = 'queued'", row.id).changes
          if (skipped) bumpStat(ctx, row.id, 'skipped', skipped)
          ctx.db.run("UPDATE campaign_sends SET state = 'done' WHERE campaign_id = ?", row.id)
          transitionCampaign(ctx, row.id, 'sending')
          finishCampaign(ctx, getCampaignRow(ctx, row.id))
          return getCampaign(ctx, row.id)
        }),
      }),
      defineAction({
        name: 'campaigns.pause', description: 'Pause a send in progress. Emails already handed to the provider still go out.', scope: 'account', role: 'admin', effect: 'write', resource,
        input: z.object({ campaignId }), rest: { method: 'POST', path: '/campaigns/:campaignId/pause' }, mcp: { title: 'Pause a campaign send', destructive: false },
        handler: (ctx, input) => {
          const row = getCampaignRow(ctx, input.campaignId)
          if (row.status !== 'sending') throw new AppError('invalid_transition', 'Only a send in progress can be paused.', 409)
          pauseCampaign(ctx, row, 'manual')
          return getCampaign(ctx, row.id)
        },
      }),
      defineAction({
        name: 'campaigns.resume', description: 'Resume a paused send from where it stopped.', scope: 'account', role: 'admin', effect: 'send', resource,
        input: z.object({ campaignId }), rest: { method: 'POST', path: '/campaigns/:campaignId/resume' }, mcp: { title: 'Resume a paused campaign', destructive: true },
        handler: async (ctx, input) => {
          const row = getCampaignRow(ctx, input.campaignId)
          if (row.status !== 'paused') throw new AppError('invalid_transition', 'Only a paused send can be resumed.', 409)
          if ((await sendSettings(ctx)).sending_enabled === 'false') throw new AppError('sending_disabled', 'Email sending is paused for this install.', 403)
          if (!verifiedSenderFor(ctx, row.newsletter_id)) throw new AppError('sender_unverified', 'Choose a verified sender domain in newsletter settings.', 400)
          return ctx.db.tx(() => {
            resetRateBaseline(ctx, row.id)
            transitionCampaign(ctx, row.id, 'sending')
            wakeBatch(ctx, row.id)
            return getCampaign(ctx, row.id)
          })
        },
      }),
      defineAction({
        name: 'campaigns.sendMore', description: 'Release the next waiting step of a gradual or engaged-first send now.', scope: 'account', role: 'admin', effect: 'send', resource,
        input: z.object({ campaignId }), rest: { method: 'POST', path: '/campaigns/:campaignId/send-more' }, mcp: { title: 'Send a campaign to more subscribers now', destructive: true },
        handler: (ctx, input) => ctx.db.tx(() => {
          const row = getCampaignRow(ctx, input.campaignId)
          if (row.status !== 'sending') throw new AppError('invalid_transition', 'The send must be in progress to send to more subscribers.', 409)
          const next = ctx.db.get<{ id: string }>("SELECT id FROM campaign_sends WHERE campaign_id = ? AND state = 'pending' ORDER BY step LIMIT 1", row.id)
          if (!next) throw new AppError('nothing_pending', 'Every step of this send has been released.', 409)
          ctx.db.run("UPDATE campaign_sends SET state = 'released', release_at = ? WHERE id = ?", ctx.now(), next.id)
          wakeBatch(ctx, row.id)
          return { steps: steps(ctx, row.id) }
        }),
      }),
      defineAction({
        name: 'campaigns.sendTest', description: 'Email the issue to up to five addresses, with the subject marked as a test.', scope: 'account', role: 'member', effect: 'send', resource,
        input: z.object({ campaignId, to: z.array(z.string().trim().toLowerCase().email().max(320)).min(1).max(5).describe('Up to five recipient addresses') }),
        rest: { method: 'POST', path: '/campaigns/:campaignId/test' }, mcp: { title: 'Send a test email', destructive: false },
        handler: async (ctx, input, actor) => {
          const row = getCampaignRow(ctx, input.campaignId)
          const send = sendContext(ctx, row)
          if (!send) throw new AppError('sender_unverified', 'Choose a verified sender domain in newsletter settings.', 400)
          const recipients = [...new Set(input.to)]
          if (!allowRate(ctx.db, `test:${row.id}`, 10, 3_600_000, ctx.now()) || !allowRate(ctx.db, `test:${actor.userId}`, 30, 3_600_000, ctx.now())) throw new AppError('rate_limited', 'Too many test emails. Try again in an hour.', 429)
          const settings = await sendSettings(ctx)
          if (settings.sending_enabled === 'false') throw new AppError('sending_disabled', 'Email sending is paused for this install.', 403)
          const provider = await sendProvider(ctx, settings)
          const sent: string[] = []
          const failed: { to: string; error: string }[] = []
          for (const to of recipients) {
            const message = await buildMessage(ctx, send, { deliveryId: null, contact: { id: 'test', email: to, name: actor.email === to ? 'You' : '', fields: '{}' } }, '[Test] ')
            let result: Awaited<ReturnType<typeof provider.send>>
            try { result = await provider.send(message) } catch (err) { result = { ok: false, kind: 'unknown', message: err instanceof Error ? err.message : String(err) } }
            if (result.ok) sent.push(to)
            else failed.push({ to, error: result.message })
          }
          return { sent, failed }
        },
      }),
      defineAction({
        name: 'campaigns.audienceCount', description: 'Count who would receive this campaign, and how many were never emailed or recently engaged.', scope: 'account', role: 'member', effect: 'read', resource,
        input: z.object({ campaignId }), rest: { method: 'GET', path: '/campaigns/:campaignId/audience-count' }, mcp: { title: 'Count a campaign audience', destructive: false },
        handler: (ctx, input) => audienceCount(ctx, getCampaignRow(ctx, input.campaignId)),
      }),
      defineAction({
        name: 'campaigns.progress', description: 'Live counters of a send: queued, sent, delivered, bounced, opened and the gradual steps.', scope: 'account', role: 'member', effect: 'read', resource,
        input: z.object({ campaignId }), rest: { method: 'GET', path: '/campaigns/:campaignId/progress' }, mcp: { title: 'Read campaign send progress', destructive: false },
        handler: (ctx, input) => {
          const row = getCampaignRow(ctx, input.campaignId)
          const stats = readStats(ctx, row.id)
          const rows = ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM deliveries WHERE campaign_id = ? GROUP BY status', row.id)
          const by = (status: string) => rows.find((r) => r.status === status)?.n ?? 0
          return {
            status: row.status, pauseReason: row.pause_reason, pauseMessage: row.pause_reason ? PAUSE_MESSAGES[row.pause_reason] ?? row.pause_reason : null,
            scheduledAt: row.scheduled_at, sendStartedAt: row.send_started_at, sentAt: row.sent_at,
            counts: { planned: stats.planned, queued: by('queued'), sending: by('sending'), sent: by('sent'), delivered: by('delivered'), bounced: by('bounced'), complained: by('complained'), failed: by('failed'), skipped: by('skipped'), unknown: by('unknown'), opens: stats.opens, clicks: stats.clicks, unsubscribes: stats.unsubscribes, softBounces: stats.softBounces },
            steps: steps(ctx, row.id),
          }
        },
      }),
    )
  },
}
