/**
 * Email sequences (drips): a series of emails each contact receives on their own clock, counted
 * from the moment they entered. `model.ts` holds the sequence and its steps, `enroll.ts` the
 * enrollment state machine and the hooks that enter and exit contacts, `tick.ts` the scheduler that
 * sends due steps. The rules are written down in docs/decisions/sequences-send.md.
 */
import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { decodeJsonUrl, encodeJsonUrl } from '../../core/crypto.ts'
import { AppError, notFound } from '../../core/http.ts'
import { ID_PREFIX, newId } from '../../core/ids.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { assertRevision, draftFields, hideUnsubscribeFooterSchema, senderOverrideInput, getCampaignRow, reviewChecks, serializeCampaign, type CampaignRow } from '../campaigns/index.ts'
import { onContactStatusChanged, onContactTagsAdded, onTagDelete } from '../contacts/index.ts'
import { assertSenderOverride, nextSenderOverride, senderOverrideOf, verifiedSenderFor } from '../domains/index.ts'
import { assertSendingAllowed } from '../hygiene/index.ts'
import { getNewsletterRow } from '../newsletters/index.ts'
import { parseTheme } from '../render/index.ts'
import { readStats, sendSettings } from '../sending/index.ts'
import { onPublicSignup } from '../signup/index.ts'
import { getPolicy, onPolicyChanged } from '../usage/index.ts'
import { migrations } from './migrations.ts'
import { DAY_MS, MAX_STEPS, assertDelayOrder, assertOpen, delayDaysSchema, entrySchema, exitSchema, getSequence, getSequenceRow, getStep, getStepRow, hasEnrollments, insertStep, listSteps, renumberSteps, serializeSequence, stepInputSchema, touchSequence, validateRules, type SequenceRow, type StepRow } from './model.ts'
import { TICK, armTick, assertTagUnused, blockedReason, dueAt, enroll, enrollSignup, exitEnrollments, rearmAllTicks, rearmTick, syncContactStatus, syncContactTags, type EnrollmentRow } from './enroll.ts'
import { tick } from './tick.ts'
export { getSequence, entrySchema, exitSchema } from './model.ts'
export { syncContactTags, syncContactStatus, enrollSignup } from './enroll.ts'
export { GRACE_MS, HOLD_MS, MAX_ATTEMPTS } from './tick.ts'
export type { Sequence, SequenceStep, SequenceEntry, SequenceExit, SequenceStatus } from './model.ts'

const newsletterId = z.string().min(1).describe('The newsletter id')
const sequenceId = z.string().min(1).describe('The sequence id')
const stepId = z.string().min(1).describe('The step id, from the sequence’s steps')
// `.optional()` and `.default()` make a new schema without the description, so each use describes itself.
const nameSchema = z.string().trim().min(1).max(120)
const NAME = 'The sequence name, shown only to the team'
const ENTRY = 'Who enters the sequence. One of {type:"tag",tagId} (contacts who newly gain that tag, including API-created ones), {type:"signup"} (public signup form only), {type:"segment",segmentId} or {type:"manual"}.'
const EXIT = 'Who leaves the sequence early: contacts with any of tagIds, or matching segmentId. Unsubscribed and bounced contacts always leave.'
const newsletterResource = { type: 'newsletter', param: 'newsletterId' } as const
const sequenceResource = { type: 'sequence', param: 'sequenceId' } as const
const contactId = z.string().min(1).describe('The contact id, from contacts.list or contacts.create')
const enrollmentInput = z.object({ newsletterId, sequenceId, contactId })
const enrollmentStatus = z.enum(['active', 'paused', 'completed', 'exited'])

/**
 * Everything a sequence needs to run, checked on activate and on resume: an account and install that
 * may send, a newsletter that is not archived, an entry rule that works, at least one step, delays in
 * order, and every step passing the campaign review. Throws the first problem.
 */
async function assertRunnable(ctx: StoreCtx, row: SequenceRow) {
  assertSendingAllowed(ctx)
  if (getPolicy(ctx).status !== 'active') throw new AppError('account_blocked', 'This account cannot send right now.', 403)
  const nl = getNewsletterRow(ctx, row.newsletter_id)
  if (!nl || nl.archived_at) throw new AppError('newsletter_archived', 'This newsletter is archived.', 409)
  const entry = entrySchema.parse(JSON.parse(row.entry))
  if (entry.type === 'segment') throw new AppError('not_supported_yet', 'A sequence that starts from a segment cannot run yet. Start it from a tag, the signup form or by hand.', 409)
  validateRules(ctx, row.newsletter_id, entry, exitSchema.parse(JSON.parse(row.exit)))
  const steps = ctx.db.all<CampaignRow & { step_id: string; step_position: number }>('SELECT c.*, st.id AS step_id, st.position AS step_position FROM sequence_steps st JOIN campaigns c ON c.id = st.campaign_id WHERE st.sequence_id = ? ORDER BY st.position', row.id)
  if (!steps.length) throw new AppError('no_steps', 'Add at least one step before starting the sequence.', 409)
  assertDelayOrder(ctx, row.id)
  for (const step of steps) {
    // Each step may carry its own sender override.
    const domainVerified = !!verifiedSenderFor(ctx, row.newsletter_id, senderOverrideOf(step))
    const checks = reviewChecks({ campaign: serializeCampaign(step), newsletter: { ...nl }, theme: parseTheme(nl.theme), domainVerified })
    const errors = checks.filter((c) => c.level === 'error')
    if (errors.length) throw new AppError('review_failed', `Step ${step.step_position}: ${errors[0].message}`, 400, { stepId: step.step_id, position: step.step_position, checks })
  }
  if ((await sendSettings(ctx)).sending_enabled === 'false') throw new AppError('sending_disabled', 'Email sending is paused for this install.', 403)
}

type EnrollmentView = EnrollmentRow & { email: string; name: string; next_position: number | null; next_delay: number | null; last_position: number | null }
const ENROLLMENT_SELECT = 'SELECT e.*, c.email, c.name, ns.position AS next_position, ns.delay_days AS next_delay, ls.position AS last_position FROM sequence_enrollments e JOIN contacts c ON c.id = e.contact_id LEFT JOIN sequence_steps ns ON ns.id = e.next_step_id LEFT JOIN sequence_steps ls ON ls.id = e.last_step_id'
const serializeEnrollment = (r: EnrollmentView) => ({
  id: r.id, sequenceId: r.sequence_id, contactId: r.contact_id, email: r.email, name: r.name, status: r.status, source: r.source, enrolledAt: r.enrolled_at,
  nextStep: r.next_step_id !== null && r.next_position !== null && r.next_delay !== null ? { id: r.next_step_id, position: r.next_position, delayDays: r.next_delay } : null, nextRunAt: r.next_run_at,
  lastStep: r.last_step_id !== null && r.last_position !== null ? { id: r.last_step_id, position: r.last_position } : null,
  exitReason: r.exit_reason, pausedAt: r.paused_at, finishedAt: r.finished_at,
})
/** One contact's enrollment in a sequence of this newsletter. 404 for a contact of another newsletter or one who never entered. */
function getEnrollment(ctx: StoreCtx, i: { newsletterId: string; sequenceId: string; contactId: string }) {
  const row = ctx.db.get<EnrollmentView>(`${ENROLLMENT_SELECT} WHERE e.sequence_id = ? AND e.contact_id = ? AND c.newsletter_id = ?`, i.sequenceId, i.contactId, i.newsletterId)
  if (!row) throw new AppError('not_enrolled', 'That contact is not in this sequence.', 404)
  return row
}

export const sequencesModule = {
  name: 'sequences',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    reg.resolver('sequence', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM sequences WHERE id = ?', id)?.newsletter_id ?? null)
    // Every tag a contact newly gains passes through here, whichever path wrote it (see contacts/tags.ts).
    onContactTagsAdded(syncContactTags)
    // Unsubscribes, bounces, complaints, cleaning and deletion end a contact's enrollments; confirming can start one.
    onContactStatusChanged(syncContactStatus)
    // The public signup form starts `signup` sequences where it queues the welcome email.
    onPublicSignup(enrollSignup)
    onTagDelete(assertTagUnused)
    // A lifted block or a changed plan wakes the ticks that sleep until the hold or the month ends.
    onPolicyChanged(rearmAllTicks)
    reg.job<{ newsletterId: string }>(TICK, (ctx, { newsletterId }, budget) => tick(ctx, newsletterId, budget))
    return reg.actions(
      defineAction({
        name: 'sequences.list', description: 'List the email sequences (drips) of a newsletter with their step and enrollment counts. Archived sequences are left out unless asked for.', scope: 'account', role: 'member', effect: 'read', resource: newsletterResource,
        input: z.object({ newsletterId, includeArchived: z.boolean().default(false).describe('Also list archived sequences') }),
        rest: { method: 'GET', path: '/newsletters/:newsletterId/sequences' }, mcp: { title: 'List email sequences', destructive: false },
        handler: (ctx, i) => ({ sequences: ctx.db.all<SequenceRow>(`SELECT * FROM sequences WHERE newsletter_id = ? ${i.includeArchived ? '' : "AND status != 'archived'"} ORDER BY created_at DESC, id DESC`, i.newsletterId).map((row) => serializeSequence(ctx, row)) }),
      }),
      defineAction({
        name: 'sequences.get', description: 'Read one email sequence: its entry and exit rules, enrollment counts and every step in order with its delay, subject, body and revision.', scope: 'account', role: 'member', effect: 'read', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId }),
        rest: { method: 'GET', path: '/newsletters/:newsletterId/sequences/:sequenceId' }, mcp: { title: 'Get an email sequence', destructive: false },
        handler: (ctx, i) => getSequence(ctx, i.sequenceId, i.newsletterId),
      }),
      defineAction({
        name: 'sequences.create', description: 'Create an email sequence (drip) as a draft: a series of emails each contact gets a set number of days after entering. Each step’s delay counts from the moment the contact entered, and steps must be in order of delay (409 step_delay_order). A draft sends nothing: start it with sequences.activate. To run a sequence for contacts your app creates, use a tag entry and add that tag with contacts.create or contacts.update.', scope: 'account', role: 'admin', effect: 'write', resource: newsletterResource,
        input: z.object({ newsletterId, name: nameSchema.describe(NAME), entry: entrySchema.describe(ENTRY), exit: exitSchema.default({}).describe(EXIT), steps: z.array(stepInputSchema).max(MAX_STEPS).default([]).describe('The emails in order. More can be added later with sequences.addStep.') }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences' }, mcp: { title: 'Create an email sequence', destructive: false },
        handler: (ctx, i, actor) => ctx.db.tx(() => {
          validateRules(ctx, i.newsletterId, i.entry, i.exit)
          const id = newId(ID_PREFIX.sequence)
          const now = ctx.now()
          ctx.db.run("INSERT INTO sequences (id, newsletter_id, name, status, entry, exit, created_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)", id, i.newsletterId, i.name, JSON.stringify(i.entry), JSON.stringify(i.exit), actor.userId, now, now)
          const row = getSequenceRow(ctx, id, i.newsletterId)
          for (const step of i.steps) insertStep(ctx, row, step, actor.userId)
          assertDelayOrder(ctx, id)
          return getSequence(ctx, id, i.newsletterId)
        }),
      }),
      defineAction({
        name: 'sequences.update', description: 'Rename an email sequence or change its entry and exit rules. Omitted fields stay as they are. The entry rule cannot change once any contact has entered (409 entry_locked).', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId, name: nameSchema.optional().describe(NAME), entry: entrySchema.optional().describe(ENTRY), exit: exitSchema.optional().describe(EXIT + ' Replaces the whole exit rule.') }),
        rest: { method: 'PATCH', path: '/newsletters/:newsletterId/sequences/:sequenceId' }, mcp: { title: 'Update an email sequence', destructive: false },
        handler: (ctx, i) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          validateRules(ctx, i.newsletterId, i.entry, i.exit)
          const nextEntry = i.entry ? JSON.stringify(i.entry) : row.entry
          if (nextEntry !== JSON.stringify(entrySchema.parse(JSON.parse(row.entry))) && hasEnrollments(ctx, row.id)) throw new AppError('entry_locked', 'Contacts have already entered this sequence, so its entry rule cannot change. Create a new sequence instead.', 409)
          ctx.db.run('UPDATE sequences SET name = ?, entry = ?, exit = ?, updated_at = ? WHERE id = ? AND newsletter_id = ?', i.name ?? row.name, nextEntry, i.exit ? JSON.stringify(i.exit) : row.exit, ctx.now(), row.id, i.newsletterId)
          return getSequence(ctx, row.id, i.newsletterId)
        }),
      }),
      defineAction({
        name: 'sequences.archive', description: 'Archive an email sequence: it stops for good, leaves the default list and can no longer be edited. Every contact still in it leaves (exit reason archived) and gets no further step. Its history stays. Sequences are never deleted, and archiving cannot be undone.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/archive' }, mcp: { title: 'Archive an email sequence', destructive: true },
        handler: (ctx, i) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          if (row.status !== 'archived') {
            ctx.db.run("UPDATE sequences SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ? AND newsletter_id = ?", ctx.now(), ctx.now(), row.id, i.newsletterId)
            exitEnrollments(ctx, { sequenceId: row.id }, 'archived')
          }
          return getSequence(ctx, row.id, i.newsletterId)
        }),
      }),
      defineAction({
        name: 'sequences.addStep', description: `Add an email to the end of a sequence. Its delay must be the same as or longer than the last step’s (409 step_delay_order). Returns the step with the revision to pass to sequences.updateStep. A sequence holds at most ${MAX_STEPS} steps. In a running sequence, contacts who have not finished get the new step; contacts who completed it do not.`, scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId, ...stepInputSchema.shape }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/steps' }, mcp: { title: 'Add a sequence step', destructive: false },
        handler: (ctx, i, actor) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          const id = insertStep(ctx, row, i, actor.userId)
          assertDelayOrder(ctx, row.id)
          touchSequence(ctx, row.id)
          return getStep(ctx, row.id, id)
        }),
      }),
      defineAction({
        name: 'sequences.updateStep', description: 'Change a step’s delay, subject or body, only if its revision is still current. Omitted fields stay as they are. A stale revision returns 409 revision_conflict with the current revision: read the sequence again before saving. The delay must stay in order with the steps around it (409 step_delay_order). In a running sequence the change applies to every contact who has not received the step yet, and the subject cannot be emptied.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({
          newsletterId, sequenceId, stepId,
          revision: z.number().int().min(1).describe('The step revision last read. Stale saves return 409 with the current revision.'),
          delayDays: delayDaysSchema.optional().describe('Whole days after the contact entered the sequence at which this email goes out'),
          subject: draftFields.subject.optional().describe('The email subject'), previewText: draftFields.previewText.optional().describe('Inbox preview text'),
          doc: draftFields.doc.optional().describe('The email body as a TipTap document'), sendFormat: draftFields.sendFormat.optional().describe('How the email is sent: html (themed) or plain (plain text like a personally written email). Omit to keep the current value.'), hideUnsubscribeFooter: hideUnsubscribeFooterSchema.optional().describe('Only for sendFormat plain: leave out the closing -- and Unsubscribe: lines. The List-Unsubscribe headers are always sent. No effect on an html email. Omit to keep the current value.'), ...senderOverrideInput.update,
        }),
        rest: { method: 'PATCH', path: '/newsletters/:newsletterId/sequences/:sequenceId/steps/:stepId' }, mcp: { title: 'Update a sequence step', destructive: false },
        handler: (ctx, i) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          const step = getStepRow(ctx, row.id, i.stepId)
          const campaign = getCampaignRow(ctx, step.campaign_id)
          assertRevision(campaign, i.revision)
          const now = ctx.now()
          const sender = nextSenderOverride(senderOverrideOf(campaign), i)
          if (i.fromDomainId !== undefined || i.fromLocal !== undefined || i.fromName !== undefined) assertSenderOverride(ctx, i.newsletterId, sender)
          ctx.db.run('UPDATE campaigns SET send_format = ?, hide_unsubscribe_footer = ?, from_domain_id = ?, from_local = ?, from_name = ?, subject = ?, preview_text = ?, doc = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND newsletter_id = ? AND revision = ?', i.sendFormat ?? campaign.send_format, (i.hideUnsubscribeFooter ?? !!campaign.hide_unsubscribe_footer) ? 1 : 0, sender.fromDomainId, sender.fromLocal, sender.fromName, i.subject ?? campaign.subject, i.previewText ?? campaign.preview_text, i.doc ? JSON.stringify(i.doc) : campaign.doc, now, campaign.id, i.newsletterId, i.revision)
          if (row.status !== 'draft' && !(i.subject ?? campaign.subject).trim()) throw new AppError('review_failed', 'A step of a running sequence needs a subject.', 400)
          const delayDays = i.delayDays ?? step.delay_days
          ctx.db.run('UPDATE sequence_steps SET delay_days = ?, updated_at = ? WHERE id = ? AND sequence_id = ?', delayDays, now, step.id, row.id)
          if (delayDays !== step.delay_days) {
            assertDelayOrder(ctx, row.id)
            // Contacts waiting for this step follow its new delay.
            ctx.db.run("UPDATE sequence_enrollments SET next_run_at = enrolled_at + ? WHERE sequence_id = ? AND next_step_id = ? AND status = 'active'", delayDays * DAY_MS, row.id, step.id)
            rearmTick(ctx, row.newsletter_id)
          }
          touchSequence(ctx, row.id)
          return getStep(ctx, row.id, step.id)
        }),
      }),
      defineAction({
        name: 'sequences.deleteStep', description: 'Remove a step and its email from a sequence. Refused once the step has been sent to anyone (409 step_sent), so reports keep their history, and for the only step of a sequence that is active or paused (409 last_step). Contacts waiting for the step move on to the one after it.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId, stepId }),
        rest: { method: 'DELETE', path: '/newsletters/:newsletterId/sequences/:sequenceId/steps/:stepId' }, mcp: { title: 'Delete a sequence step', destructive: true },
        handler: (ctx, i) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          const step = getStepRow(ctx, row.id, i.stepId)
          if (ctx.db.get('SELECT 1 FROM deliveries WHERE campaign_id = ? LIMIT 1', step.campaign_id)) throw new AppError('step_sent', 'This step has already been sent to someone, so it cannot be deleted.', 409)
          const next = ctx.db.get<StepRow>('SELECT * FROM sequence_steps WHERE sequence_id = ? AND position > ? ORDER BY position LIMIT 1', row.id, step.position)
          if (row.status !== 'draft' && !next && step.position === 1) throw new AppError('last_step', 'A sequence that is active or paused needs at least one step. Archive the sequence instead.', 409)
          // Contacts waiting for this step wait for the one after it, or are done.
          if (next) ctx.db.run("UPDATE sequence_enrollments SET next_step_id = ?, next_run_at = CASE WHEN status = 'active' THEN enrolled_at + ? END WHERE sequence_id = ? AND next_step_id = ?", next.id, next.delay_days * DAY_MS, row.id, step.id)
          else ctx.db.run("UPDATE sequence_enrollments SET next_step_id = NULL, next_run_at = NULL, status = 'completed', finished_at = ? WHERE sequence_id = ? AND next_step_id = ?", ctx.now(), row.id, step.id)
          ctx.db.run('DELETE FROM sequence_steps WHERE id = ? AND sequence_id = ?', step.id, row.id)
          ctx.db.run("DELETE FROM campaigns WHERE id = ? AND newsletter_id = ? AND kind = 'sequence'", step.campaign_id, i.newsletterId)
          renumberSteps(ctx, row.id, listSteps(ctx, row.id).map((s) => s.id))
          touchSequence(ctx, row.id)
          return { deleted: true, steps: listSteps(ctx, row.id) }
        }),
      }),
      defineAction({
        name: 'sequences.reorderSteps', description: 'Put the steps of a sequence in a new order. Pass every step id of the sequence exactly once. Each step keeps its own delay, and the delays must not decrease along the new order (409 step_delay_order): change the delays with sequences.updateStep first.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId, stepIds: z.array(z.string().min(1)).min(1).max(MAX_STEPS).describe('Every step id of the sequence, in the new order') }),
        rest: { method: 'PUT', path: '/newsletters/:newsletterId/sequences/:sequenceId/steps/order' }, mcp: { title: 'Reorder sequence steps', destructive: false },
        handler: (ctx, i) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          const current = listSteps(ctx, row.id).map((s) => s.id)
          // A foreign id is a 404 like any other id; a wrong list of this sequence's own steps is a bad request.
          for (const id of i.stepIds) getStepRow(ctx, row.id, id)
          if (new Set(i.stepIds).size !== i.stepIds.length || i.stepIds.length !== current.length) throw new AppError('invalid_input', 'Pass every step of the sequence exactly once.', 400)
          renumberSteps(ctx, row.id, i.stepIds)
          assertDelayOrder(ctx, row.id)
          touchSequence(ctx, row.id)
          return { steps: listSteps(ctx, row.id) }
        }),
      }),
      defineAction({
        name: 'sequences.activate', description: 'Start a draft email sequence. From now on contacts who meet its entry rule enter and receive each step at its delay. Contacts who already had the entry tag before this call are not entered. Needs at least one step, a subject on every step, delays in order, a verified sender and a postal address (400 review_failed names the step); a segment entry cannot run yet (409 not_supported_yet).', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/activate' }, mcp: { title: 'Start an email sequence', destructive: false },
        handler: async (ctx, i) => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          if (row.status !== 'draft') throw new AppError('invalid_transition', row.status === 'paused' ? 'This sequence is paused. Resume it instead.' : 'This sequence is already active.', 409)
          await assertRunnable(ctx, row)
          ctx.db.run("UPDATE sequences SET status = 'active', updated_at = ? WHERE id = ? AND newsletter_id = ? AND status = 'draft'", ctx.now(), row.id, i.newsletterId)
          return getSequence(ctx, row.id, i.newsletterId)
        },
      }),
      defineAction({
        name: 'sequences.pause', description: 'Pause an active email sequence: no step is sent and nobody enters while it is paused. Contacts already in it keep their place.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/pause' }, mcp: { title: 'Pause an email sequence', destructive: false },
        handler: (ctx, i) => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          if (row.status !== 'active') throw new AppError('invalid_transition', 'Only an active sequence can be paused.', 409)
          ctx.db.run("UPDATE sequences SET status = 'paused', updated_at = ? WHERE id = ? AND newsletter_id = ? AND status = 'active'", ctx.now(), row.id, i.newsletterId)
          return getSequence(ctx, row.id, i.newsletterId)
        },
      }),
      defineAction({
        name: 'sequences.resume', description: 'Resume a paused email sequence. Each contact continues from their own clock: a step that came due during the pause is sent now, and when several came due a day or more ago only the latest is sent and the earlier ones are skipped. Contacts who gained the entry tag during the pause are not entered.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/resume' }, mcp: { title: 'Resume an email sequence', destructive: false },
        handler: async (ctx, i) => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          if (row.status !== 'paused') throw new AppError('invalid_transition', 'Only a paused sequence can be resumed.', 409)
          await assertRunnable(ctx, row)
          return ctx.db.tx(() => {
            ctx.db.run("UPDATE sequences SET status = 'active', updated_at = ? WHERE id = ? AND newsletter_id = ? AND status = 'paused'", ctx.now(), row.id, i.newsletterId)
            rearmTick(ctx, i.newsletterId)
            return getSequence(ctx, row.id, i.newsletterId)
          })
        },
      }),
      defineAction({
        name: 'sequences.enroll', description: 'Enter one contact into an active email sequence by hand, counted from now. Works for any entry rule. Refused for a contact who was ever in this sequence (409 already_enrolled), who is not subscribed (409 not_subscribed) or suppressed (409 suppressed), or who matches the exit rule (409 exit_rule).', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: enrollmentInput,
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/enrollments' }, mcp: { title: 'Enter a contact into a sequence', destructive: false },
        handler: (ctx, i, actor) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          if (!ctx.db.get('SELECT 1 FROM contacts WHERE id = ? AND newsletter_id = ?', i.contactId, i.newsletterId)) throw notFound('That contact')
          if (row.status !== 'active') throw new AppError('sequence_not_active', 'Contacts can only enter an active sequence. Start it with sequences.activate first.', 409)
          if (ctx.db.get('SELECT 1 FROM sequence_enrollments WHERE sequence_id = ? AND contact_id = ?', row.id, i.contactId)) throw new AppError('already_enrolled', 'This contact has already been in this sequence. A contact enters a sequence once.', 409)
          const reason = blockedReason(ctx, { newsletter_id: row.newsletter_id, exit: exitSchema.parse(JSON.parse(row.exit)) }, i.contactId, { segment: true })
          if (reason === 'tag' || reason === 'segment') throw new AppError('exit_rule', 'This contact matches the sequence’s exit rule, so they would leave it at once.', 409)
          if (reason === 'suppressed') throw new AppError('suppressed', 'This address is suppressed.', 409)
          if (reason) throw new AppError('not_subscribed', 'Only a subscribed contact can enter a sequence.', 409)
          enroll(ctx, row, i.contactId, actor.via === 'web' ? 'manual' : actor.via)
          return serializeEnrollment(getEnrollment(ctx, i))
        }),
      }),
      defineAction({
        name: 'sequences.exit', description: 'Take one contact out of an email sequence for good: they get no further step and cannot enter it again. 404 not_enrolled when they were never in it, 409 when they already finished or left.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: enrollmentInput.extend({ reason: z.string().trim().max(100).optional().describe('Why the contact is leaving, kept as the exit reason. Defaults to manual.') }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/enrollments/:contactId/exit' }, mcp: { title: 'Take a contact out of a sequence', destructive: true },
        handler: (ctx, i) => ctx.db.tx(() => {
          getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          const row = getEnrollment(ctx, i)
          if (row.status !== 'active' && row.status !== 'paused') throw new AppError('invalid_transition', 'This contact has already finished or left the sequence.', 409)
          exitEnrollments(ctx, { sequenceId: i.sequenceId, contactId: i.contactId }, i.reason ? `manual: ${i.reason}` : 'manual')
          return serializeEnrollment(getEnrollment(ctx, i))
        }),
      }),
      defineAction({
        name: 'sequences.pauseEnrollment', description: 'Hold one contact where they are in an email sequence: they get no step until sequences.resumeEnrollment. Their clock keeps running.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: enrollmentInput,
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/enrollments/:contactId/pause' }, mcp: { title: 'Pause a contact in a sequence', destructive: false },
        handler: (ctx, i) => ctx.db.tx(() => {
          getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          const row = getEnrollment(ctx, i)
          if (row.status !== 'active') throw new AppError('invalid_transition', 'Only a contact who is active in the sequence can be paused.', 409)
          ctx.db.run("UPDATE sequence_enrollments SET status = 'paused', paused_at = ?, next_run_at = NULL WHERE id = ? AND status = 'active'", ctx.now(), row.id)
          return serializeEnrollment(getEnrollment(ctx, i))
        }),
      }),
      defineAction({
        name: 'sequences.resumeEnrollment', description: 'Let a paused contact continue an email sequence. Their next step is due at its delay from the day they entered: when that passed during the pause it is sent now, and when several steps came due a day or more ago only the latest is sent and the earlier ones are skipped.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: enrollmentInput,
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/enrollments/:contactId/resume' }, mcp: { title: 'Resume a contact in a sequence', destructive: false },
        handler: (ctx, i) => ctx.db.tx(() => {
          const sequence = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(sequence)
          const row = getEnrollment(ctx, i)
          if (row.status !== 'paused') throw new AppError('invalid_transition', 'Only a paused contact can be resumed.', 409)
          const step = row.next_step_id === null ? undefined : ctx.db.get<StepRow>('SELECT * FROM sequence_steps WHERE id = ? AND sequence_id = ?', row.next_step_id, sequence.id)
          if (!step) ctx.db.run("UPDATE sequence_enrollments SET status = 'completed', paused_at = NULL, next_step_id = NULL, next_run_at = NULL, finished_at = ? WHERE id = ? AND status = 'paused'", ctx.now(), row.id)
          else {
            const runAt = dueAt(row.enrolled_at, step)
            ctx.db.run("UPDATE sequence_enrollments SET status = 'active', paused_at = NULL, next_run_at = ? WHERE id = ? AND status = 'paused'", runAt, row.id)
            if (sequence.status === 'active') armTick(ctx, sequence.newsletter_id, runAt)
          }
          return serializeEnrollment(getEnrollment(ctx, i))
        }),
      }),
      defineAction({
        name: 'sequences.listEnrollments', description: 'Page through the contacts in an email sequence: who they are, where they stand (active, paused, completed, exited), when they entered, the next step and when it is due, the last step handled and why they left. Ordered by contact id; follow nextCursor until null.', scope: 'account', role: 'member', effect: 'read', resource: sequenceResource,
        input: z.object({
          newsletterId, sequenceId,
          status: enrollmentStatus.optional().describe('Only contacts in this state'),
          cursor: z.string().max(2000).optional().describe('Next cursor from the previous page'),
          limit: z.number().int().min(1).max(200).default(50).describe('Maximum contacts in one page'),
        }),
        rest: { method: 'GET', path: '/newsletters/:newsletterId/sequences/:sequenceId/enrollments' }, mcp: { title: 'List contacts in a sequence', destructive: false },
        handler: (ctx, i) => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          const cursor = i.cursor === undefined ? null : z.object({ sequenceId: z.literal(row.id), contactId: z.string() }).safeParse(decodeJsonUrl(i.cursor))
          if (cursor && !cursor.success) throw new AppError('invalid_input', 'That page cursor is invalid for this list.', 400)
          const rows = ctx.db.all<EnrollmentView>(`${ENROLLMENT_SELECT} WHERE e.sequence_id = ? AND e.contact_id > ? ${i.status ? 'AND e.status = ?' : ''} ORDER BY e.contact_id LIMIT ?`, row.id, cursor?.data.contactId ?? '', ...(i.status ? [i.status] : []), i.limit + 1)
          const page = rows.slice(0, i.limit)
          return { enrollments: page.map(serializeEnrollment), nextCursor: rows.length > i.limit ? encodeJsonUrl({ sequenceId: row.id, contactId: page[page.length - 1].contact_id }) : null }
        },
      }),
      defineAction({
        name: 'sequences.stats', description: 'Read how an email sequence is doing: contacts by state, and per step how many contacts wait for it and how many emails were sent, delivered, opened, clicked, bounced, complained about, unsubscribed from, skipped or failed. Each step’s campaignId opens its full report with stats.report and its recipients with stats.recipients.', scope: 'account', role: 'member', effect: 'read', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId }),
        rest: { method: 'GET', path: '/newsletters/:newsletterId/sequences/:sequenceId/stats' }, mcp: { title: 'Read email sequence stats', destructive: false },
        handler: (ctx, i) => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          const waiting = new Map(ctx.db.all<{ step: string; n: number }>("SELECT next_step_id AS step, COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id = ? AND status IN ('active', 'paused') AND next_step_id IS NOT NULL GROUP BY next_step_id", row.id).map((r) => [r.step, r.n]))
          const steps = ctx.db.all<StepRow & { subject: string }>('SELECT st.*, c.subject FROM sequence_steps st JOIN campaigns c ON c.id = st.campaign_id WHERE st.sequence_id = ? ORDER BY st.position', row.id)
          const sequence = serializeSequence(ctx, row)
          return {
            sequenceId: row.id, status: row.status, enrollments: sequence.enrollments,
            steps: steps.map((step) => {
              const s = readStats(ctx, step.campaign_id)
              return { stepId: step.id, position: step.position, delayDays: step.delay_days, subject: step.subject, campaignId: step.campaign_id, waiting: waiting.get(step.id) ?? 0, sent: s.sent, delivered: s.delivered, opens: s.opens, clicks: s.clicks, bounces: s.bounced, complaints: s.complained, unsubscribes: s.unsubscribes, skipped: s.skipped, failed: s.failed }
            }),
          }
        },
      }),
    )
  },
}
