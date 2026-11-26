/**
 * Email sequences (drips): a series of emails each contact receives on their own clock, counted
 * from the moment they entered. This unit holds the data model and the draft-mode editing actions.
 * Activation, enrollment and sending come in later units; until then a sequence is `draft` or
 * `archived` and nothing is sent.
 */
import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import { ID_PREFIX, newId } from '../../core/ids.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { assertRevision, draftFields, getCampaignRow } from '../campaigns/index.ts'
import { onContactTagsAdded } from '../contacts/index.ts'
import { migrations } from './migrations.ts'
import { MAX_STEPS, assertOpen, delayDaysSchema, entrySchema, exitSchema, getSequence, getSequenceRow, getStep, getStepRow, hasEnrollments, insertStep, listSteps, renumberSteps, serializeSequence, stepInputSchema, syncContactTags, touchSequence, validateRules, type SequenceRow } from './model.ts'
export { syncContactTags, getSequence, entrySchema, exitSchema } from './model.ts'
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

export const sequencesModule = {
  name: 'sequences',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    reg.resolver('sequence', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM sequences WHERE id = ?', id)?.newsletter_id ?? null)
    // Every tag a contact newly gains passes through here, whichever path wrote it (see contacts/tags.ts).
    onContactTagsAdded(syncContactTags)
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
        name: 'sequences.create', description: 'Create an email sequence (drip) as a draft: a series of emails each contact gets a set number of days after entering. Each step’s delay counts from the day the contact entered. A draft sends nothing. To run a sequence for contacts your app creates, use a tag entry and add that tag with contacts.create or contacts.update.', scope: 'account', role: 'admin', effect: 'write', resource: newsletterResource,
        input: z.object({ newsletterId, name: nameSchema.describe(NAME), entry: entrySchema.describe(ENTRY), exit: exitSchema.default({}).describe(EXIT), steps: z.array(stepInputSchema).max(MAX_STEPS).default([]).describe('The emails in order. More can be added later with sequences.addStep.') }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences' }, mcp: { title: 'Create an email sequence', destructive: false },
        handler: (ctx, i, actor) => ctx.db.tx(() => {
          validateRules(ctx, i.newsletterId, i.entry, i.exit)
          const id = newId(ID_PREFIX.sequence)
          const now = ctx.now()
          ctx.db.run("INSERT INTO sequences (id, newsletter_id, name, status, entry, exit, created_by, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)", id, i.newsletterId, i.name, JSON.stringify(i.entry), JSON.stringify(i.exit), actor.userId, now, now)
          const row = getSequenceRow(ctx, id, i.newsletterId)
          for (const step of i.steps) insertStep(ctx, row, step, actor.userId)
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
        name: 'sequences.archive', description: 'Archive an email sequence: it stops for good, leaves the default list and can no longer be edited. Its history stays. Sequences are never deleted, and archiving cannot be undone.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/archive' }, mcp: { title: 'Archive an email sequence', destructive: true },
        handler: (ctx, i) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          if (row.status !== 'archived') ctx.db.run("UPDATE sequences SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ? AND newsletter_id = ?", ctx.now(), ctx.now(), row.id, i.newsletterId)
          return getSequence(ctx, row.id, i.newsletterId)
        }),
      }),
      defineAction({
        name: 'sequences.addStep', description: `Add an email to the end of a sequence. Returns the step with the revision to pass to sequences.updateStep. A sequence holds at most ${MAX_STEPS} steps.`, scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId, ...stepInputSchema.shape }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/sequences/:sequenceId/steps' }, mcp: { title: 'Add a sequence step', destructive: false },
        handler: (ctx, i, actor) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          const id = insertStep(ctx, row, i, actor.userId)
          touchSequence(ctx, row.id)
          return getStep(ctx, row.id, id)
        }),
      }),
      defineAction({
        name: 'sequences.updateStep', description: 'Change a step’s delay, subject or body, only if its revision is still current. Omitted fields stay as they are. A stale revision returns 409 revision_conflict with the current revision: read the sequence again before saving.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({
          newsletterId, sequenceId, stepId,
          revision: z.number().int().min(1).describe('The step revision last read. Stale saves return 409 with the current revision.'),
          delayDays: delayDaysSchema.optional().describe('Whole days after the contact entered the sequence at which this email goes out'),
          subject: draftFields.subject.optional().describe('The email subject'), previewText: draftFields.previewText.optional().describe('Inbox preview text'),
          doc: draftFields.doc.optional().describe('The email body as a TipTap document'),
        }),
        rest: { method: 'PATCH', path: '/newsletters/:newsletterId/sequences/:sequenceId/steps/:stepId' }, mcp: { title: 'Update a sequence step', destructive: false },
        handler: (ctx, i) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          const step = getStepRow(ctx, row.id, i.stepId)
          const campaign = getCampaignRow(ctx, step.campaign_id)
          assertRevision(campaign, i.revision)
          const now = ctx.now()
          ctx.db.run('UPDATE campaigns SET subject = ?, preview_text = ?, doc = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND newsletter_id = ? AND revision = ?', i.subject ?? campaign.subject, i.previewText ?? campaign.preview_text, i.doc ? JSON.stringify(i.doc) : campaign.doc, now, campaign.id, i.newsletterId, i.revision)
          ctx.db.run('UPDATE sequence_steps SET delay_days = ?, updated_at = ? WHERE id = ? AND sequence_id = ?', i.delayDays ?? step.delay_days, now, step.id, row.id)
          touchSequence(ctx, row.id)
          return getStep(ctx, row.id, step.id)
        }),
      }),
      defineAction({
        name: 'sequences.deleteStep', description: 'Remove a step and its email from a sequence. Refused once the step has been sent to anyone (409 step_sent), so reports keep their history.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
        input: z.object({ newsletterId, sequenceId, stepId }),
        rest: { method: 'DELETE', path: '/newsletters/:newsletterId/sequences/:sequenceId/steps/:stepId' }, mcp: { title: 'Delete a sequence step', destructive: true },
        handler: (ctx, i) => ctx.db.tx(() => {
          const row = getSequenceRow(ctx, i.sequenceId, i.newsletterId)
          assertOpen(row)
          const step = getStepRow(ctx, row.id, i.stepId)
          if (ctx.db.get('SELECT 1 FROM deliveries WHERE campaign_id = ? LIMIT 1', step.campaign_id)) throw new AppError('step_sent', 'This step has already been sent to someone, so it cannot be deleted.', 409)
          ctx.db.run('DELETE FROM sequence_steps WHERE id = ? AND sequence_id = ?', step.id, row.id)
          ctx.db.run("DELETE FROM campaigns WHERE id = ? AND newsletter_id = ? AND kind = 'sequence'", step.campaign_id, i.newsletterId)
          renumberSteps(ctx, row.id, listSteps(ctx, row.id).map((s) => s.id))
          touchSequence(ctx, row.id)
          return { deleted: true, steps: listSteps(ctx, row.id) }
        }),
      }),
      defineAction({
        name: 'sequences.reorderSteps', description: 'Put the steps of a sequence in a new order. Pass every step id of the sequence exactly once. Each step keeps its own delay.', scope: 'account', role: 'admin', effect: 'write', resource: sequenceResource,
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
          touchSequence(ctx, row.id)
          return { steps: listSteps(ctx, row.id) }
        }),
      }),
    )
  },
}
