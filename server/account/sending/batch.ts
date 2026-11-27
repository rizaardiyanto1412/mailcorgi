import type { Budget, JobResult } from '../../core/jobs.ts'
import type { StoreCtx } from '../../core/store.ts'
import { randomToken } from '../../core/crypto.ts'
import type { EmailProvider, SendResult } from '../../email/index.ts'
import { checkProtection, globalSuppressions, hygieneEpoch, keepDeliveryAllowed, recordHygieneSend, protectionState, queueHygiene } from '../hygiene/index.ts'
import { isSuppressed } from '../contacts/index.ts'
import { getCampaignRow, transitionCampaign, type CampaignRow } from '../campaigns/index.ts'
import { countEmails, getPolicy } from '../usage/index.ts'
import { classifyError } from '../../email/http.ts'
import { capturesKind, keepContent, neverAttempted, snapshotOf, type ContentSnapshot } from './content.ts'
import { buildMessage, recordLinks, sendContext, type SendContext } from './message.ts'
import { sendProvider, sendSettings } from './provider.ts'
import { AUTO_PAUSE_MIN_SENT, bumpStat, daily, notify, pauseCampaign, rateBreach, readStats, recountStats, stepGate } from './stats.ts'
import { replayPending, unsubscribePending } from '../tracking/pending.ts'

export const STUCK_AFTER_MS = 10 * 60_000
/**
 * Queued and sending rows live in the partial index `deliveries_open`; a sent row leaves it. SQLite
 * uses a partial index only when the query repeats the index's own WHERE term, so every query on
 * open rows carries this term next to the status it wants.
 */
export const OPEN_ROWS = "status IN ('queued', 'sending')"
const MAX_TEMPORARY_ATTEMPTS = 3
const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4))
const temporaryBackoff = (attempts: number) => jitter(Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1)))

interface DeliveryRow {
  id: number
  campaign_id: string
  contact_id: string
  email: string
  status: string
  attempt_token: string | null
  attempts: number
}

/** Counters a send batch updates once at the end instead of once per email. */
export interface SentTally {
  days: Map<string, number>
  sent: number
}
export const newTally = (): SentTally => ({ days: new Map(), sent: 0 })
export function flushTally(ctx: StoreCtx, campaignId: string, newsletterId: string, tally: SentTally) {
  if (!tally.sent) return
  // All or nothing: a crash here leaves the counters behind by one batch, and the rollup and the
  // hourly usage job recount them from the delivery rows.
  ctx.db.tx(() => {
    for (const [at, n] of tally.days) daily(ctx, newsletterId, 'sent', Number(at), n)
    bumpStat(ctx, campaignId, 'sent', tally.sent)
    countEmails(ctx, tally.sent)
  })
  tally.days.clear()
  tally.sent = 0
}

/**
 * A delivery that just went out: the contact's counters and score in one row, the hygiene reminder
 * bookkeeping, and the daily, campaign and usage counters (or a tally of them). The delivery row
 * itself is the record of the send (the timeline reads `deliveries.sent_at`); no `events` row is written.
 */
export function markSentEffects(ctx: StoreCtx, d: Pick<DeliveryRow, 'id' | 'campaign_id' | 'contact_id'>, newsletterId: string, at: number, tally?: SentTally) {
  const campaign = getCampaignRow(ctx, d.campaign_id)
  // A plain send carries no open pixel or tracked link, so silence after it says nothing about the reader.
  const issue = campaign.kind === 'issue' && campaign.send_format !== 'plain'
  ctx.db.run('UPDATE contacts SET sent_count = sent_count + 1, ignored_streak = ignored_streak + ?, strict_ignored_streak = strict_ignored_streak + ?, last_sent_at = ?, updated_at = ?, engaged_score = ROUND((open_count + 3.0 * click_count) / (sent_count + 1), 3) WHERE id = ?', issue ? 1 : 0, issue ? 1 : 0, at, at, d.contact_id)
  recordHygieneSend(ctx, d.campaign_id, d.contact_id, at)
  if (tally) {
    const day = String(at - (at % 86_400_000))
    tally.days.set(day, (tally.days.get(day) ?? 0) + 1)
    tally.sent++
    return
  }
  daily(ctx, newsletterId, 'sent', at)
  bumpStat(ctx, d.campaign_id, 'sent')
  countEmails(ctx, 1)
}

/** Rows left in `sending` for over ten minutes never had their result stored (architecture 11.5). */
function reconcileStuck(ctx: StoreCtx, campaignId: string, idempotent: boolean, now: number) {
  const next = idempotent ? 'queued' : 'unknown'
  const changes = ctx.db.run(`UPDATE deliveries SET status = ?, queued_at = ?, error = COALESCE(error, ?) WHERE campaign_id = ? AND ${OPEN_ROWS} AND status = 'sending' AND attempt_at <= ?`, next, now, 'The result of the send attempt was never learned.', campaignId, now - STUCK_AFTER_MS).changes
  if (changes && !idempotent) bumpStat(ctx, campaignId, 'unknown', changes)
}

/** Release steps whose time has come, as long as this campaign's rates stay under the limits. */
function releaseDueSteps(ctx: StoreCtx, row: CampaignRow, now: number): 'paused' | 'ok' {
  const due = ctx.db.all<{ id: string }>("SELECT id FROM campaign_sends WHERE campaign_id = ? AND state = 'pending' AND release_at IS NOT NULL AND release_at <= ?", row.id, now)
  if (!due.length) return 'ok'
  const breach = stepGate(readStats(ctx, row.id))
  if (breach) {
    pauseCampaign(ctx, row, breach.reason)
    return 'paused'
  }
  for (const step of due) ctx.db.run("UPDATE campaign_sends SET state = 'released' WHERE id = ?", step.id)
  return 'ok'
}

/** Mark the campaign sent with final stats, refresh engagement scores and tell the owner. */
export function finishCampaign(ctx: StoreCtx, row: CampaignRow) {
  ctx.db.tx(() => {
    const stats = recountStats(ctx, row.id)
    ctx.db.run("UPDATE campaign_sends SET state = 'done' WHERE campaign_id = ?", row.id)
    transitionCampaign(ctx, row.id, 'sent')
    if (row.kind === 'issue') queueHygiene(ctx, row.newsletter_id)
    if (row.kind === 'issue') notify(ctx, { kind: 'campaign_sent', tone: 'ok', title: `“${row.subject || 'Untitled issue'}” was sent`, body: `${stats.sent} emails went out.`, href: `/campaigns/${row.id}/report` })
  })
}

function claimDelivery(ctx: StoreCtx, id: number, newsletterId: string, now: number): (DeliveryRow & { name: string; fields: string; fresh: boolean }) | null {
  return ctx.db.tx(() => {
    const d = ctx.db.get<DeliveryRow & { name: string | null; fields: string | null; contact_status: string | null }>(`SELECT d.*, c.name, c.fields, c.status AS contact_status FROM deliveries d LEFT JOIN contacts c ON c.id = d.contact_id AND c.newsletter_id = ? WHERE d.id = ? AND d.status = 'queued'`, newsletterId, id)
    if (!d) return null
    const keepAllowed = getCampaignRow(ctx, d.campaign_id).kind !== 'keep' || keepDeliveryAllowed(ctx, newsletterId, d.contact_id)
    if (!keepAllowed || d.contact_status !== 'subscribed' || unsubscribePending(ctx, d.contact_id) || isSuppressed(ctx, d.email, newsletterId)) {
      ctx.db.run("UPDATE deliveries SET status = 'skipped', error = ? WHERE id = ? AND status = 'queued'", d.contact_status === 'subscribed' ? 'Suppressed before sending.' : 'No longer subscribed.', id)
      bumpStat(ctx, d.campaign_id, 'skipped')
      return null
    }
    const fresh = neverAttempted(d)
    const token = randomToken(12)
    ctx.db.run("UPDATE deliveries SET status = 'sending', attempt_token = ?, attempt_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'queued'", token, now, id)
    return { ...d, status: 'sending', attempt_token: token, attempts: d.attempts + 1, name: d.name ?? '', fields: d.fields ?? '{}', fresh }
  })
}

/** Store a send result against the attempt that made it. Returns when the batch must stop and resume. */
function recordResult(ctx: StoreCtx, d: DeliveryRow, newsletterId: string, result: SendResult, idempotent: boolean, now: number, tally?: SentTally): number | null {
  return ctx.db.tx(() => {
    const own = (sql: string, ...params: (string | number | null)[]) => ctx.db.run(`${sql} WHERE id = ? AND status = 'sending' AND attempt_token = ?`, ...params, d.id, d.attempt_token).changes
    if (result.ok) {
      if (own('UPDATE deliveries SET status = ?, provider_message_id = ?, sent_at = ?, error = NULL, hygiene_epoch = ?', 'sent', result.id, now, hygieneEpoch(ctx))) markSentEffects(ctx, d, newsletterId, now, tally)
      else ctx.db.run('UPDATE deliveries SET provider_message_id = COALESCE(provider_message_id, ?) WHERE id = ?', result.id, d.id)
      return null
    }
    const message = result.message.slice(0, 500)
    switch (result.kind) {
      case 'permanent':
        ctx.jobs.enqueue('alerts.raise', { kind: 'provider_refusing', title: 'Email provider refused a send', body: 'Check provider configuration and campaign delivery failures.' }, { dedupeKey: 'alerts.provider_refusing' })
        if (own('UPDATE deliveries SET status = ?, error = ?', 'failed', message)) bumpStat(ctx, d.campaign_id, 'failed')
        return null
      case 'temporary': {
        if (d.attempts >= MAX_TEMPORARY_ATTEMPTS) {
          if (own('UPDATE deliveries SET status = ?, error = ?', 'failed', message)) bumpStat(ctx, d.campaign_id, 'failed')
          return null
        }
        const at = now + temporaryBackoff(d.attempts)
        own('UPDATE deliveries SET status = ?, queued_at = ?, error = ?', 'queued', at, message)
        return null
      }
      case 'throttled': {
        const at = now + jitter(result.retryAfterMs ?? 30_000)
        own('UPDATE deliveries SET status = ?, queued_at = ?, attempts = attempts - 1, error = ?', 'queued', now, message)
        return at
      }
      default:
        if (idempotent) own('UPDATE deliveries SET status = ?, queued_at = ?, error = ?', 'queued', now + jitter(60_000), message)
        else if (own('UPDATE deliveries SET status = ?, error = ?', 'unknown', message)) bumpStat(ctx, d.campaign_id, 'unknown')
        return null
    }
  })
}

/**
 * Send one queued delivery, per architecture 11.5: claim it (which checks again that the contact is
 * subscribed and not suppressed), render, hand it to the provider and store the result against the
 * attempt. Campaign batches and sequence steps both send through here. Returns when the caller must
 * stop and resume (the provider throttled), or null. A row that is no longer queued is left alone.
 * Without a tally the counters are written with the result, in its transaction.
 */
export async function sendDelivery(ctx: StoreCtx, send: SendContext, provider: EmailProvider, id: number, tally?: SentTally): Promise<number | null> {
  const newsletterId = send.row.newsletter_id
  const d = claimDelivery(ctx, id, newsletterId, ctx.now())
  if (!d) return null
  const keeps = capturesKind(ctx, send.row.kind)
  let snapshot: ContentSnapshot | null = null
  let result: SendResult
  try {
    const message = await buildMessage(ctx, send, { deliveryId: d.id, contact: { id: d.contact_id, email: d.email, name: d.name, fields: d.fields } })
    if (keeps) {
      message.safeDiagnostics = true
      if (d.fresh) snapshot = snapshotOf(message)
    }
    result = await provider.send(message)
  } catch (err) {
    result = { ok: false, kind: 'unknown', message: keeps ? `The send attempt failed (${classifyError(err)}).` : err instanceof Error ? err.message : String(err) }
  }
  const at = ctx.now()
  const stop = recordResult(ctx, d, newsletterId, result, provider.capabilities.idempotency, at, tally)
  if (snapshot && result.ok) keepContent(ctx, d, newsletterId, snapshot, at)
  return stop
}

/** One run of the send loop for a campaign, per architecture 11.5. Idempotent: every write is conditional on row state. */
export async function sendBatch(ctx: StoreCtx, campaignId: string, budget: Budget): Promise<JobResult> {
  const now = ctx.now()
  let row: CampaignRow
  try { row = getCampaignRow(ctx, campaignId) } catch { return 'done' }
  if (row.status !== 'sending') return 'done'
  // Nothing goes out while an unsubscribe or a complaint waits to be written (or cannot be looked up).
  try {
    if (await replayPending(ctx)) return { again: now + 60_000 }
  } catch {
    return { again: now + 60_000 }
  }
  if (checkProtection(ctx)) return 'done'
  if (getPolicy(ctx).status !== 'active') {
    pauseCampaign(ctx, row, 'account_blocked')
    return 'done'
  }
  const send = sendContext(ctx, row)
  if (!send) {
    pauseCampaign(ctx, row, 'sender_unverified')
    return 'done'
  }
  if (budget.take(1) < 1) return { again: now + 1000 }
  const settings = await sendSettings(ctx)
  if (settings.sending_enabled === 'false') {
    pauseCampaign(ctx, row, 'sending_disabled')
    return 'done'
  }
  const provider = await sendProvider(ctx, settings)
  const idempotent = provider.capabilities.idempotency
  reconcileStuck(ctx, campaignId, idempotent, now)
  ctx.db.run("UPDATE campaign_sends SET state = 'done' WHERE campaign_id = ? AND state = 'released' AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.send_id = campaign_sends.id AND d.status IN ('queued', 'sending'))", campaignId)
  if (releaseDueSteps(ctx, row, now) === 'paused') return 'done'
  const breach = rateBreach(readStats(ctx, campaignId), AUTO_PAUSE_MIN_SENT)
  if (breach) {
    pauseCampaign(ctx, row, breach)
    return 'done'
  }
  const releasedWhere = `d.campaign_id = ? AND d.${OPEN_ROWS} AND d.status = 'queued' AND d.send_id IN (SELECT id FROM campaign_sends WHERE campaign_id = ? AND state = 'released')`
  const queued = ctx.db.get<{ n: number; next: number | null }>(`SELECT COUNT(*) AS n, MIN(queued_at) AS next FROM deliveries d WHERE ${releasedWhere}`, campaignId, campaignId)!
  const ready = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM deliveries d WHERE ${releasedWhere} AND d.queued_at <= ?`, campaignId, campaignId, now)!.n
  if (!ready) {
    if (queued.n) return { again: queued.next ?? now + 1000 }
    const inFlight = ctx.db.get<{ n: number; oldest: number | null }>(`SELECT COUNT(*) AS n, MIN(attempt_at) AS oldest FROM deliveries WHERE campaign_id = ? AND ${OPEN_ROWS} AND status = 'sending'`, campaignId)!
    if (inFlight.n) return { again: (inFlight.oldest ?? now) + STUCK_AFTER_MS }
    const pending = ctx.db.get<{ n: number; next: number | null }>("SELECT COUNT(*) AS n, MIN(release_at) AS next FROM campaign_sends WHERE campaign_id = ? AND state = 'pending'", campaignId)!
    if (pending.n) return pending.next === null ? 'done' : { again: pending.next }
    finishCampaign(ctx, row)
    return 'done'
  }
  recordLinks(ctx, send)
  const candidates = ctx.db.all<{ id: number; email: string }>(`SELECT d.id, d.email FROM deliveries d WHERE ${releasedWhere} AND d.queued_at <= ? ORDER BY d.id LIMIT ?`, campaignId, campaignId, now, Math.min(row.kind === 'keep' ? 10 : ctx.config.sendBatchSize, ready, 1000))
  const suppressed = await globalSuppressions(ctx, candidates.map((d) => d.email), budget)
  if (!suppressed) return { again: now + 1000 }
  if (protectionState(ctx)) return 'done'
  for (const d of candidates) if (suppressed.has(d.email)) {
    if (ctx.db.run("UPDATE deliveries SET status = 'skipped', error = 'Globally suppressed.' WHERE id = ? AND status = 'queued'", d.id).changes) bumpStat(ctx, campaignId, 'skipped')
  }
  const allowed = candidates.filter((d) => !suppressed.has(d.email))
  if (!allowed.length) return { again: now + 1000 }
  const want = Math.min(allowed.length, budget.left() - 1)
  if (want < 1) return { again: now + 1000 }
  budget.take(1)
  const permits = await ctx.stores.control.takeSendPermits({ accountId: ctx.accountId!, want })
  if (permits.granted < 1) return { again: permits.retryAt ?? now + 1000 }
  const ids = allowed.slice(0, Math.min(permits.granted, budget.take(permits.granted))).map((d) => d.id)
  // Daily, campaign and usage counters are written once per batch; the rollup repairs them if a
  // crash loses the last batch's tally.
  const tally = newTally()
  try {
    for (const id of ids) {
      if (budget.expired() || protectionState(ctx) || getPolicy(ctx).status !== 'active') break
      const resumeAt = await sendDelivery(ctx, send, provider, id, tally)
      if (resumeAt !== null) return { again: resumeAt }
    }
  } finally {
    flushTally(ctx, campaignId, row.newsletter_id, tally)
  }
  return { again: permits.retryAt ?? ctx.now() }
}
