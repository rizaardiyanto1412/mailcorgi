/**
 * The sequence scheduler: one `sequences.tick` job per newsletter, armed to the earliest waiting
 * enrollment. A run sends the steps that are due, one delivery row per (step campaign, contact), and
 * ends by re-arming itself. See docs/decisions/sequences-send.md for the rules it implements.
 *
 * Nothing here is assumed to run once. Every write is conditional on the state it expects, the
 * delivery's `UNIQUE(campaign_id, contact_id)` key is the idempotency key of a step, and only a
 * claimed delivery is handed to the provider, so two overlapping runs send a step once.
 */
import type { Budget, JobResult } from '../../core/jobs.ts'
import type { StoreCtx } from '../../core/store.ts'
import { getCampaignRow } from '../campaigns/index.ts'
import { verifiedSenderFor } from '../domains/index.ts'
import { checkProtection, globalSuppressions, protectionState } from '../hygiene/index.ts'
import { STUCK_AFTER_MS, bumpStat, recordLinks, sendContext, sendDelivery, sendProvider, sendSettings, type SendContext } from '../sending/index.ts'
import { replayPending } from '../tracking/pending.ts'
import { getPolicy } from '../usage/index.ts'
import { DAY_MS, exitSchema, type SequenceExit, type StepRow } from './model.ts'
import { advance, blockedReason, dueAt, exitEnrollments, nextRunAt, skipStep, stepRows, type EnrollmentRow } from './enroll.ts'

/** A step this late means the sequence fell behind (a pause, sending switched off): the catch-up rule applies. */
export const GRACE_MS = DAY_MS
/** How long a tick sleeps when it may not send at all (account blocked or protected, sending switched off, no verified sender). */
export const HOLD_MS = 60 * 60_000
/** Claims a step's delivery gets before it is marked failed and the enrollment moves on. */
export const MAX_ATTEMPTS = 5
const MAX_PER_RUN = 100

interface Ready { enrollment: EnrollmentRow; step: StepRow; deliveryId: number; email: string; exit: SequenceExit }
type DueRow = EnrollmentRow & { exit: string }

const failDelivery = (ctx: StoreCtx, id: number, campaignId: string, from: 'queued' | 'sending', to: 'failed' | 'unknown', error: string) => {
  if (ctx.db.run(`UPDATE deliveries SET status = ?, error = COALESCE(error, ?) WHERE id = ? AND status = ?`, to, error, id, from).changes) bumpStat(ctx, campaignId, to)
}
/** Look at this enrollment again at `at`; it keeps waiting for the same step. */
const defer = (ctx: StoreCtx, e: EnrollmentRow, step: StepRow, at: number) => void ctx.db.run("UPDATE sequence_enrollments SET next_run_at = ? WHERE id = ? AND status = 'active' AND next_step_id = ?", at, e.id, step.id)

/**
 * Decide what a due enrollment needs, in one transaction. Returns the delivery to send, or null when
 * the enrollment was dealt with here: it left, its step was already settled, or it waits for a retry.
 */
function prepare(ctx: StoreCtx, newsletterId: string, due: DueRow, idempotent: boolean, steps: Map<string, StepRow[]>): Ready | null {
  const now = ctx.now()
  const e = ctx.db.get<EnrollmentRow>("SELECT * FROM sequence_enrollments WHERE id = ? AND status = 'active'", due.id)
  if (!e || e.next_step_id === null || e.next_run_at === null || e.next_run_at > now) return null
  if (!steps.has(e.sequence_id)) steps.set(e.sequence_id, stepRows(ctx, e.sequence_id))
  const all = steps.get(e.sequence_id)!
  let step = all.find((s) => s.id === e.next_step_id)
  if (!step) {
    // The step is gone (deleting a step repoints its enrollments, so this is a repair): nothing is left to wait for.
    ctx.db.run("UPDATE sequence_enrollments SET next_step_id = NULL, next_run_at = NULL, status = 'completed', finished_at = ? WHERE id = ? AND status = 'active'", now, e.id)
    return null
  }
  const exit = exitSchema.parse(JSON.parse(due.exit))
  const reason = blockedReason(ctx, { newsletter_id: newsletterId, exit }, e.contact_id, { segment: true })
  if (reason) {
    exitEnrollments(ctx, { sequenceId: e.sequence_id, contactId: e.contact_id }, reason)
    return null
  }
  const contact = { id: e.contact_id, email: ctx.db.get<{ email: string }>('SELECT email FROM contacts WHERE id = ?', e.contact_id)!.email }
  // Catch-up: behind by a day or more, only the latest step that is due goes out; the ones before it are skipped.
  if (now - dueAt(e.enrolled_at, step) >= GRACE_MS) {
    const from = step.position
    const late = all.filter((s) => s.position >= from && dueAt(e.enrolled_at, s) <= now)
    const latest = late[late.length - 1]
    if (latest.id !== step.id && ctx.db.run("UPDATE sequence_enrollments SET next_step_id = ?, next_run_at = ? WHERE id = ? AND status = 'active' AND next_step_id = ?", latest.id, dueAt(e.enrolled_at, latest), e.id, step.id).changes) {
      for (const skipped of late.slice(0, -1)) skipStep(ctx, skipped, contact, 'Skipped: overdue when the sequence caught up.')
      step = latest
    }
  }
  const d = ctx.db.get<{ id: number; status: string; queued_at: number; attempt_at: number | null; attempts: number }>('SELECT id, status, queued_at, attempt_at, attempts FROM deliveries WHERE campaign_id = ? AND contact_id = ?', step.campaign_id, e.contact_id)
  if (!d) {
    const { id } = ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, queued_at) VALUES (?, ?, ?, 'queued', ?)", step.campaign_id, contact.id, contact.email, now)
    return { enrollment: e, step, deliveryId: id, email: contact.email, exit }
  }
  if (d.status === 'sending') {
    // Another run is sending it, or one crashed mid-send (architecture 11.5).
    if ((d.attempt_at ?? 0) > now - STUCK_AFTER_MS) {
      defer(ctx, e, step, (d.attempt_at ?? now) + STUCK_AFTER_MS)
      return null
    }
    if (!idempotent) {
      failDelivery(ctx, d.id, step.campaign_id, 'sending', 'unknown', 'The result of the send attempt was never learned.')
      advance(ctx, e, step)
      return null
    }
    ctx.db.run("UPDATE deliveries SET status = 'queued', queued_at = ?, error = COALESCE(error, ?) WHERE id = ? AND status = 'sending'", now, 'The result of the send attempt was never learned.', d.id)
    d.status = 'queued'
    d.queued_at = now
  }
  if (d.status === 'queued') {
    if (d.attempts >= MAX_ATTEMPTS) {
      failDelivery(ctx, d.id, step.campaign_id, 'queued', 'failed', 'Gave up after repeated attempts.')
      advance(ctx, e, step)
      return null
    }
    if (d.queued_at > now) {
      defer(ctx, e, step, d.queued_at)
      return null
    }
    return { enrollment: e, step, deliveryId: d.id, email: contact.email, exit }
  }
  // Sent, failed, skipped or unknown: this step is settled for this contact and is never sent again.
  advance(ctx, e, step)
  return null
}

/** After a send attempt: move the enrollment by what became of the delivery. */
function settle(ctx: StoreCtx, newsletterId: string, r: Ready) {
  const d = ctx.db.get<{ status: string; queued_at: number; attempt_at: number | null; attempts: number }>('SELECT status, queued_at, attempt_at, attempts FROM deliveries WHERE id = ?', r.deliveryId)
  if (!d) return
  if (d.status === 'queued') {
    // A temporary refusal, a throttle, or an unknown outcome the provider can deduplicate: try again later.
    if (d.attempts < MAX_ATTEMPTS) return defer(ctx, r.enrollment, r.step, d.queued_at)
    failDelivery(ctx, r.deliveryId, r.step.campaign_id, 'queued', 'failed', 'Gave up after repeated attempts.')
  } else if (d.status === 'sending') return defer(ctx, r.enrollment, r.step, (d.attempt_at ?? ctx.now()) + STUCK_AFTER_MS)
  else if (d.status === 'skipped') return void exitEnrollments(ctx, { sequenceId: r.enrollment.sequence_id, contactId: r.enrollment.contact_id }, blockedReason(ctx, { newsletter_id: newsletterId, exit: r.exit }, r.enrollment.contact_id) ?? 'suppressed')
  advance(ctx, r.enrollment, r.step)
}

export async function tick(ctx: StoreCtx, newsletterId: string, budget: Budget): Promise<JobResult> {
  const now = ctx.now()
  const newsletter = ctx.db.get<{ archived_at: number | null; deleting_at: number | null }>('SELECT archived_at, deleting_at FROM newsletters WHERE id = ?', newsletterId)
  if (!newsletter || newsletter.deleting_at !== null || getPolicy(ctx).status === 'deleting') return 'done'
  /** Sleep until the next enrollment is due, or end the job when none waits. */
  const rest = (soon?: number | null): JobResult => {
    const at = nextRunAt(ctx, newsletterId)
    return at === null ? 'done' : { again: at <= ctx.now() ? soon ?? ctx.now() : at }
  }
  /** Nothing may be sent now: keep the enrollments waiting and look again later. Never fails, so the job cannot die. */
  const hold = (ms = HOLD_MS): JobResult => (nextRunAt(ctx, newsletterId) === null ? 'done' : { again: ctx.now() + ms })
  const due = ctx.db.all<DueRow>(`SELECT e.*, s.exit FROM sequence_enrollments e INDEXED BY sequence_enrollments_due JOIN sequences s ON s.id = e.sequence_id
    WHERE e.status = 'active' AND e.next_run_at IS NOT NULL AND e.next_run_at <= ? AND s.newsletter_id = ? AND s.status = 'active' ORDER BY e.next_run_at LIMIT ?`, now, newsletterId, Math.min(ctx.config.sendBatchSize, MAX_PER_RUN))
  if (!due.length) return rest()
  if (newsletter.archived_at !== null) return hold(DAY_MS)
  // Nothing goes out while an unsubscribe or a complaint waits to be written (or cannot be looked up).
  try {
    if (await replayPending(ctx)) return { again: now + 60_000 }
  } catch {
    return { again: now + 60_000 }
  }
  if (checkProtection(ctx) || getPolicy(ctx).status !== 'active' || !verifiedSenderFor(ctx, newsletterId)) return hold()
  if (budget.take(1) < 1) return { again: now + 1000 }
  const settings = await sendSettings(ctx)
  if (settings.sending_enabled === 'false') return hold()
  const provider = await sendProvider(ctx, settings)

  const steps = new Map<string, StepRow[]>()
  const ready = due.flatMap((e) => ctx.db.tx(() => prepare(ctx, newsletterId, e, provider.capabilities.idempotency, steps)) ?? [])
  if (!ready.length) return rest()
  const suppressed = await globalSuppressions(ctx, ready.map((r) => r.email), budget)
  if (!suppressed) return { again: now + 1000 }
  if (protectionState(ctx)) return hold()
  for (const r of ready) if (suppressed.has(r.email)) ctx.db.tx(() => {
    skipStep(ctx, r.step, { id: r.enrollment.contact_id, email: r.email }, 'Globally suppressed.')
    exitEnrollments(ctx, { sequenceId: r.enrollment.sequence_id, contactId: r.enrollment.contact_id }, 'suppressed')
  })
  const allowed = ready.filter((r) => !suppressed.has(r.email))
  if (!allowed.length) return rest()
  const want = Math.min(allowed.length, budget.left() - 1)
  if (want < 1) return { again: now + 1000 }
  budget.take(1)
  const permits = await ctx.stores.control.takeSendPermits({ accountId: ctx.accountId!, want })
  if (permits.granted < 1) return { again: permits.retryAt ?? now + 1000 }

  const contexts = new Map<string, SendContext | null>()
  for (const r of allowed.slice(0, Math.min(permits.granted, budget.take(permits.granted)))) {
    if (budget.expired() || protectionState(ctx) || getPolicy(ctx).status !== 'active') break
    if (!contexts.has(r.step.campaign_id)) {
      const send = sendContext(ctx, getCampaignRow(ctx, r.step.campaign_id))
      // A step can be edited while the sequence runs, so its links are recorded again on every run; known ones are ignored.
      if (send) {
        send.links = []
        recordLinks(ctx, send)
      }
      contexts.set(r.step.campaign_id, send)
    }
    const send = contexts.get(r.step.campaign_id)
    if (!send) return hold()
    const resumeAt = await sendDelivery(ctx, send, provider, r.deliveryId)
    ctx.db.tx(() => settle(ctx, newsletterId, r))
    if (resumeAt !== null) return { again: resumeAt }
  }
  return rest(permits.retryAt)
}
