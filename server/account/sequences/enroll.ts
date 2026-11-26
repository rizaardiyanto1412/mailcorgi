/**
 * Enrollments: one contact's run through one sequence, at most once ever (docs/decisions/sequences-send.md).
 *
 * `active` waits for `next_step_id` at `next_run_at`; `paused` keeps the step and drops the time;
 * `completed` and `exited` are final. Every change is a conditional update on the state it expects,
 * so a job that runs twice, or two that overlap, move an enrollment once.
 *
 * Contacts enter through the listeners below (a new tag, a confirmed signup) or by hand, and leave
 * when an exit tag arrives, when they stop being subscribed, or when the sequence is archived.
 */
import type { StoreCtx } from '../../core/store.ts'
import { AppError } from '../../core/http.ts'
import { ID_PREFIX, newId } from '../../core/ids.ts'
import { isSuppressed, type ContactStatusChanged, type ContactTagsAdded } from '../contacts/index.ts'
import { audienceQuery } from '../segments/index.ts'
import { bumpStat } from '../sending/index.ts'
import { DAY_MS, entrySchema, exitSchema, type SequenceEntry, type SequenceExit, type SequenceStatus, type StepRow } from './model.ts'

export const TICK = 'sequences.tick'

export type EnrollmentStatus = 'active' | 'paused' | 'completed' | 'exited'
export interface EnrollmentRow {
  id: string; sequence_id: string; contact_id: string; status: EnrollmentStatus; source: string; enrolled_at: number
  last_step_id: string | null; next_step_id: string | null; next_run_at: number | null
  exit_reason: string | null; paused_at: number | null; finished_at: number | null
}

/** When a step is due for an enrollment: whole days after the contact entered, never after the previous step. */
export const dueAt = (enrolledAt: number, step: Pick<StepRow, 'delay_days'>) => enrolledAt + step.delay_days * DAY_MS
export const stepRows = (ctx: StoreCtx, sequenceId: string) => ctx.db.all<StepRow>('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY position', sequenceId)

/** When the newsletter's earliest waiting enrollment is due, or null. Walks the scheduler's partial index in time order. */
export function nextRunAt(ctx: StoreCtx, newsletterId: string): number | null {
  return ctx.db.get<{ at: number }>(`SELECT e.next_run_at AS at FROM sequence_enrollments e INDEXED BY sequence_enrollments_due
    WHERE e.status = 'active' AND e.next_run_at IS NOT NULL AND e.sequence_id IN (SELECT id FROM sequences WHERE newsletter_id = ? AND status = 'active')
    ORDER BY e.next_run_at LIMIT 1`, newsletterId)?.at ?? null
}

/**
 * Make sure the newsletter's one tick job runs by `at`. A job already due sooner is left alone, so
 * enrolling a thousand contacts costs one job row. A tick that is running re-arms itself when it ends.
 */
export function armTick(ctx: StoreCtx, newsletterId: string, at: number) {
  const key = `${TICK}:${newsletterId}`
  const job = ctx.db.get<{ run_at: number }>('SELECT run_at FROM jobs WHERE dedupe_key = ?', key)
  if (job && job.run_at <= at) return
  ctx.jobs.cancelByKey(key)
  ctx.jobs.enqueue(TICK, { newsletterId }, { runAt: at, dedupeKey: key })
}
/** Arm the tick to the earliest waiting enrollment, after a sequence or an enrollment starts running again. */
export function rearmTick(ctx: StoreCtx, newsletterId: string) {
  const at = nextRunAt(ctx, newsletterId)
  if (at !== null) armTick(ctx, newsletterId, at)
}
/**
 * The policy hook: the account may send again or send more (unblocked, plan or limits changed), so a
 * tick sleeping out a hold or the monthly limit is brought forward for every newsletter with a waiting enrollment.
 */
export function rearmAllTicks(ctx: StoreCtx) {
  const newsletters = ctx.db.all<{ newsletter_id: string }>(`SELECT DISTINCT s.newsletter_id FROM sequences s WHERE s.status = 'active'
    AND EXISTS (SELECT 1 FROM sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'active' AND e.next_run_at IS NOT NULL)`)
  for (const { newsletter_id } of newsletters) rearmTick(ctx, newsletter_id)
}

export interface LiveSequence { id: string; newsletter_id: string; name: string; status: SequenceStatus; entry: SequenceEntry; exit: SequenceExit }
/** A newsletter's sequences in the given states with their rules parsed: one indexed read (`sequences_newsletter`). */
export function sequencesIn(ctx: StoreCtx, newsletterId: string, statuses: readonly SequenceStatus[]): LiveSequence[] {
  return ctx.db.all<{ id: string; newsletter_id: string; name: string; status: SequenceStatus; entry: string; exit: string }>(`SELECT id, newsletter_id, name, status, entry, exit FROM sequences WHERE newsletter_id = ? AND status IN (${statuses.map(() => '?').join(', ')})`, newsletterId, ...statuses)
    .map((r) => ({ ...r, entry: entrySchema.parse(JSON.parse(r.entry)), exit: exitSchema.parse(JSON.parse(r.exit)) }))
}

const hasExitTag = (ctx: StoreCtx, contactId: string, exit: SequenceExit) =>
  !!exit.tagIds?.length && !!ctx.db.get(`SELECT 1 FROM contact_tags WHERE contact_id = ? AND tag_id IN (${exit.tagIds.map(() => '?').join(', ')}) LIMIT 1`, contactId, ...exit.tagIds)

function inSegment(ctx: StoreCtx, newsletterId: string, segmentId: string, contactId: string): boolean {
  try {
    const q = audienceQuery(ctx, newsletterId, { segmentId })
    return !!ctx.db.get(`SELECT 1 FROM contacts c WHERE c.id = ? AND ${q.where}`, contactId, ...q.params)
  } catch (err) {
    // A segment deleted from under the rule matches nobody.
    if (err instanceof AppError && err.status === 404) return false
    throw err
  }
}

/**
 * Why a contact may not be in this sequence right now, or null. The answer is the exit reason:
 * `deleted`, the contact's status when it is not `subscribed`, `suppressed`, `tag` or `segment`.
 * The segment rule is only read where `segment` is set: right before a step is sent.
 */
export function blockedReason(ctx: StoreCtx, sequence: Pick<LiveSequence, 'newsletter_id' | 'exit'>, contactId: string, opts: { segment?: boolean } = {}): string | null {
  const contact = ctx.db.get<{ status: string; email: string }>('SELECT status, email FROM contacts WHERE id = ? AND newsletter_id = ?', contactId, sequence.newsletter_id)
  if (!contact) return 'deleted'
  if (contact.status !== 'subscribed') return contact.status
  if (isSuppressed(ctx, contact.email, sequence.newsletter_id)) return 'suppressed'
  if (hasExitTag(ctx, contactId, sequence.exit)) return 'tag'
  if (opts.segment && sequence.exit.segmentId && inSegment(ctx, sequence.newsletter_id, sequence.exit.segmentId, contactId)) return 'segment'
  return null
}

/**
 * Enter a contact into a sequence, measured from now. A contact who was ever in it stays out
 * (`UNIQUE(sequence_id, contact_id)`). Returns whether a row was written. The caller has checked
 * that the sequence is active and the contact may enter.
 */
export function enroll(ctx: StoreCtx, sequence: Pick<LiveSequence, 'id' | 'newsletter_id'>, contactId: string, source: string): boolean {
  const first = ctx.db.get<StepRow>('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY position LIMIT 1', sequence.id)
  if (!first) return false
  const now = ctx.now()
  const runAt = dueAt(now, first)
  const inserted = ctx.db.run("INSERT OR IGNORE INTO sequence_enrollments (id, sequence_id, contact_id, status, source, enrolled_at, next_step_id, next_run_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)", newId(ID_PREFIX.enrollment), sequence.id, contactId, source, now, first.id, runAt).changes > 0
  if (inserted) armTick(ctx, sequence.newsletter_id, runAt)
  return inserted
}
const enrollIfAllowed = (ctx: StoreCtx, sequence: LiveSequence, contactId: string, source: string) => !blockedReason(ctx, sequence, contactId) && enroll(ctx, sequence, contactId, source)

/** A step that will not be sent to this contact: its delivery row says so, and holds the place so it never is. */
export function skipStep(ctx: StoreCtx, step: Pick<StepRow, 'campaign_id'>, contact: { id: string; email: string }, why: string) {
  const inserted = ctx.db.run("INSERT OR IGNORE INTO deliveries (campaign_id, contact_id, email, status, error, queued_at) VALUES (?, ?, ?, 'skipped', ?, ?)", step.campaign_id, contact.id, contact.email, why, ctx.now()).changes
  const requeued = inserted ? 0 : ctx.db.run("UPDATE deliveries SET status = 'skipped', error = ? WHERE campaign_id = ? AND contact_id = ? AND status = 'queued'", why, step.campaign_id, contact.id).changes
  if (inserted || requeued) bumpStat(ctx, step.campaign_id, 'skipped')
}

/**
 * End the active and paused enrollments of a sequence, or of one contact in it. A step that waited
 * for a retry is marked skipped, so no queued delivery outlives its enrollment. Returns how many ended.
 */
export function exitEnrollments(ctx: StoreCtx, where: { sequenceId: string; contactId?: string }, reason: string): number {
  const one = where.contactId === undefined ? '' : ' AND contact_id = ?'
  const params = where.contactId === undefined ? [where.sequenceId] : [where.sequenceId, where.contactId]
  const changes = ctx.db.run(`UPDATE sequence_enrollments SET status = 'exited', exit_reason = ?, next_run_at = NULL, finished_at = ? WHERE sequence_id = ?${one} AND status IN ('active', 'paused')`, reason, ctx.now(), ...params).changes
  if (!changes) return 0
  const queued = ctx.db.all<{ id: number; campaign_id: string }>(`SELECT id, campaign_id FROM deliveries WHERE campaign_id IN (SELECT campaign_id FROM sequence_steps WHERE sequence_id = ?)${one} AND status = 'queued'`, ...params)
  for (const d of queued) if (ctx.db.run("UPDATE deliveries SET status = 'skipped', error = 'Left the sequence.' WHERE id = ? AND status = 'queued'", d.id).changes) bumpStat(ctx, d.campaign_id, 'skipped')
  return changes
}

/**
 * Move an enrollment past `step` to the next one by position, or complete it after the last.
 * Conditional on the enrollment still waiting for `step`, so it happens once.
 */
export function advance(ctx: StoreCtx, e: Pick<EnrollmentRow, 'id' | 'sequence_id' | 'enrolled_at'>, step: Pick<StepRow, 'id' | 'position'>): boolean {
  const next = ctx.db.get<StepRow>('SELECT * FROM sequence_steps WHERE sequence_id = ? AND position > ? ORDER BY position LIMIT 1', e.sequence_id, step.position)
  const waiting = "WHERE id = ? AND status = 'active' AND next_step_id = ?"
  if (next) return ctx.db.run(`UPDATE sequence_enrollments SET last_step_id = ?, next_step_id = ?, next_run_at = ? ${waiting}`, step.id, next.id, dueAt(e.enrolled_at, next), e.id, step.id).changes > 0
  return ctx.db.run(`UPDATE sequence_enrollments SET last_step_id = ?, next_step_id = NULL, next_run_at = NULL, status = 'completed', finished_at = ? ${waiting}`, step.id, ctx.now(), e.id, step.id).changes > 0
}

/**
 * The tag hook: the contacts module calls this, inside the transaction that wrote the tags, for every
 * tag a contact newly gains, on every write path (contacts.create for new and existing contacts,
 * contacts.update, contacts.bulk, imports). It never hears about a tag the contact already had.
 *
 * It runs on every tag write, so it stays one indexed read and filters the few live sequences in
 * memory. A new exit tag ends the contact's enrollments first; then each active sequence the new tags
 * start enrolls the contact, if they are subscribed, not suppressed, hold no exit tag and were never
 * in it. Returns the sequences entered.
 */
export function syncContactTags(ctx: StoreCtx, event: ContactTagsAdded): string[] {
  const live = sequencesIn(ctx, event.newsletterId, ['active', 'paused'])
  for (const s of live) if (s.exit.tagIds?.some((id) => event.tagIds.includes(id))) exitEnrollments(ctx, { sequenceId: s.id, contactId: event.contactId }, 'tag')
  return live.filter((s) => s.status === 'active' && s.entry.type === 'tag' && event.tagIds.includes(s.entry.tagId) && enrollIfAllowed(ctx, s, event.contactId, event.source)).map((s) => s.id)
}

/**
 * The status hook. A contact who stops being subscribed leaves every sequence, with the new status as
 * the reason; a deleted contact's enrollments go with them. A contact who confirms (`unconfirmed →
 * subscribed`) enters the active tag sequences whose tag they already hold: the tag hook passed them
 * over only because they were not subscribed yet. No other change to `subscribed` enrolls anyone.
 */
export function syncContactStatus(ctx: StoreCtx, event: ContactStatusChanged) {
  const mine = 'sequence_id IN (SELECT id FROM sequences WHERE newsletter_id = ?) AND contact_id = ?'
  if (event.to === 'deleted') return void ctx.db.run(`DELETE FROM sequence_enrollments WHERE ${mine}`, event.newsletterId, event.contactId)
  if (event.to === 'subscribed') {
    if (event.from !== 'unconfirmed') return
    const entries = sequencesIn(ctx, event.newsletterId, ['active']).filter((s) => s.entry.type === 'tag')
    if (!entries.length) return
    const tags = new Set(ctx.db.all<{ tag_id: string }>('SELECT tag_id FROM contact_tags WHERE contact_id = ?', event.contactId).map((r) => r.tag_id))
    for (const s of entries) if (s.entry.type === 'tag' && tags.has(s.entry.tagId)) enrollIfAllowed(ctx, s, event.contactId, 'confirm')
    return
  }
  for (const row of ctx.db.all<{ sequence_id: string }>(`SELECT sequence_id FROM sequence_enrollments WHERE ${mine} AND status IN ('active', 'paused')`, event.newsletterId, event.contactId)) exitEnrollments(ctx, { sequenceId: row.sequence_id, contactId: event.contactId }, event.to)
}

/** The public signup form calls this where it queues the welcome email: single opt-in on submit, double opt-in on confirm. Imports and API calls never do. */
export function enrollSignup(ctx: StoreCtx, newsletterId: string, contactId: string) {
  for (const s of sequencesIn(ctx, newsletterId, ['active'])) if (s.entry.type === 'signup') enrollIfAllowed(ctx, s, contactId, 'signup')
}

/** Refuses deleting a tag that a sequence still enters or exits by (the guard for `tags.delete`). */
export function assertTagUnused(ctx: StoreCtx, tag: { newsletterId: string; tagId: string }) {
  const sequences = sequencesIn(ctx, tag.newsletterId, ['draft', 'active', 'paused']).flatMap((s) => {
    const uses = [...(s.entry.type === 'tag' && s.entry.tagId === tag.tagId ? ['entry' as const] : []), ...(s.exit.tagIds?.includes(tag.tagId) ? ['exit' as const] : [])]
    return uses.length ? [{ id: s.id, name: s.name, status: s.status, uses }] : []
  })
  if (sequences.length) throw new AppError('tag_in_use', `This tag is used by ${sequences.length === 1 ? `the sequence “${sequences[0].name}”` : `${sequences.length} sequences`}. Change or archive ${sequences.length === 1 ? 'it' : 'them'} first.`, 409, { sequences })
}
