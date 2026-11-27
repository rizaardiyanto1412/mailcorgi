import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { AppError, notFound } from '../../core/http.ts'
import { ID_PREFIX, newId } from '../../core/ids.ts'
import { draftFields, hideUnsubscribeFooterSchema, senderOverrideInput, type CampaignRow } from '../campaigns/index.ts'
import { assertSenderOverride, nextSenderOverride } from '../domains/index.ts'
import { emptyDoc, parseDoc, type DocNode } from '../render/index.ts'

export const MAX_STEPS = 50
export const MAX_DELAY_DAYS = 730
export const DAY_MS = 86_400_000

export const statusSchema = z.enum(['draft', 'active', 'paused', 'archived'])
export type SequenceStatus = z.infer<typeof statusSchema>

const id = (what: string) => z.string().min(1).describe(what)
export const entrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('signup').describe('Readers who subscribe through the public signup form (after confirming, with double opt-in). Imported and API-created contacts do not enter.') }),
  z.object({ type: z.literal('tag').describe('Contacts who newly gain a tag, by any path: contacts.create, contacts.update, contacts.bulk, imports or the dashboard'), tagId: id('The tag of this newsletter that starts the sequence') }),
  z.object({ type: z.literal('segment').describe('Contacts who match a saved segment'), segmentId: id('The saved segment of this newsletter') }),
  z.object({ type: z.literal('manual').describe('Only contacts added to the sequence by hand') }),
])
export type SequenceEntry = z.infer<typeof entrySchema>
export const exitSchema = z.object({
  tagIds: z.array(id('A tag id of this newsletter')).max(50).optional().describe('A contact who has any of these tags leaves the sequence'),
  segmentId: id('A saved segment id of this newsletter').optional().describe('A contact who matches this segment leaves the sequence'),
})
export type SequenceExit = z.infer<typeof exitSchema>
export const delayDaysSchema = z.number().int().min(1).max(MAX_DELAY_DAYS)
export const stepInputSchema = z.object({
  delayDays: delayDaysSchema.describe('Whole days after the contact entered the sequence (not after the previous step) at which this email goes out. Day 0 is the welcome email, so the first step is at least 1.'),
  subject: draftFields.subject.default('').describe('The email subject'),
  doc: draftFields.doc.optional().describe('The email body as a TipTap document. Omit for an empty email to fill in later.'),
  sendFormat: draftFields.sendFormat.default('html').describe('How the email is sent: html (themed, the default) or plain (plain text like a personally written email: no theme, no tracking, one unsubscribe line)'),
  hideUnsubscribeFooter: hideUnsubscribeFooterSchema.default(false).describe('Only for sendFormat plain: leave out the closing -- and Unsubscribe: lines. The List-Unsubscribe headers are always sent. No effect on an html email.'),
  ...senderOverrideInput.create,
})
export type StepInput = z.infer<typeof stepInputSchema>

export interface SequenceRow {
  id: string; newsletter_id: string; name: string; status: SequenceStatus; entry: string; exit: string
  delay_anchor: 'enrolled_at'; created_by: string; created_at: number; updated_at: number; archived_at: number | null
}
export interface StepRow { id: string; sequence_id: string; position: number; delay_days: number; campaign_id: string; created_at: number; updated_at: number }
type StepWithCampaign = StepRow & Pick<CampaignRow, 'subject' | 'preview_text' | 'doc' | 'revision' | 'send_format' | 'hide_unsubscribe_footer' | 'from_domain_id' | 'from_local' | 'from_name'> & { campaign_updated_at: number }

export function getSequenceRow(ctx: StoreCtx, sequenceId: string, newsletterId: string): SequenceRow {
  const row = ctx.db.get<SequenceRow>('SELECT * FROM sequences WHERE id = ? AND newsletter_id = ?', sequenceId, newsletterId)
  if (!row) throw notFound('That sequence')
  return row
}
/** Any change to a sequence or its steps needs it not archived. */
export function assertOpen(row: SequenceRow) {
  if (row.status === 'archived') throw new AppError('sequence_archived', 'This sequence is archived and can no longer be changed.', 409)
}
export const hasEnrollments = (ctx: StoreCtx, sequenceId: string) => !!ctx.db.get('SELECT 1 FROM sequence_enrollments WHERE sequence_id = ? LIMIT 1', sequenceId)

/** Tags and segments named by entry and exit rules must belong to the sequence's newsletter. */
export function validateRules(ctx: StoreCtx, newsletterId: string, entry: SequenceEntry | undefined, exit: SequenceExit | undefined) {
  const tags = [...entry?.type === 'tag' ? [entry.tagId] : [], ...exit?.tagIds ?? []]
  const segments = [...entry?.type === 'segment' ? [entry.segmentId] : [], ...exit?.segmentId ? [exit.segmentId] : []]
  for (const tagId of tags) if (!ctx.db.get('SELECT id FROM tags WHERE id = ? AND newsletter_id = ?', tagId, newsletterId)) throw notFound('That tag')
  for (const segmentId of segments) if (!ctx.db.get('SELECT id FROM segments WHERE id = ? AND newsletter_id = ?', segmentId, newsletterId)) throw notFound('That segment')
}

const STEP_SELECT = 'SELECT st.*, c.subject, c.preview_text, c.doc, c.send_format, c.hide_unsubscribe_footer, c.from_domain_id, c.from_local, c.from_name, c.revision, c.updated_at AS campaign_updated_at FROM sequence_steps st JOIN campaigns c ON c.id = st.campaign_id'
const serializeStep = (r: StepWithCampaign) => ({
  id: r.id, sequenceId: r.sequence_id, position: r.position, delayDays: r.delay_days, campaignId: r.campaign_id,
  subject: r.subject, previewText: r.preview_text, sendFormat: r.send_format, hideUnsubscribeFooter: !!r.hide_unsubscribe_footer, fromDomainId: r.from_domain_id, fromLocal: r.from_local, fromName: r.from_name, doc: (r.doc ? parseDoc(r.doc) : emptyDoc) as DocNode, revision: r.revision,
  createdAt: r.created_at, updatedAt: Math.max(r.updated_at, r.campaign_updated_at),
})
export type SequenceStep = ReturnType<typeof serializeStep>
export const listSteps = (ctx: StoreCtx, sequenceId: string) => ctx.db.all<StepWithCampaign>(`${STEP_SELECT} WHERE st.sequence_id = ? ORDER BY st.position`, sequenceId).map(serializeStep)
export function getStepRow(ctx: StoreCtx, sequenceId: string, stepId: string): StepRow {
  const row = ctx.db.get<StepRow>('SELECT * FROM sequence_steps WHERE id = ? AND sequence_id = ?', stepId, sequenceId)
  if (!row) throw notFound('That step')
  return row
}
export function getStep(ctx: StoreCtx, sequenceId: string, stepId: string): SequenceStep {
  const row = ctx.db.get<StepWithCampaign>(`${STEP_SELECT} WHERE st.id = ? AND st.sequence_id = ?`, stepId, sequenceId)
  if (!row) throw notFound('That step')
  return serializeStep(row)
}

/** A sequence with its step and enrollment counts. */
export function serializeSequence(ctx: StoreCtx, r: SequenceRow) {
  const byStatus = ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM sequence_enrollments WHERE sequence_id = ? GROUP BY status', r.id)
  const count = (status: string) => byStatus.find((s) => s.status === status)?.n ?? 0
  return {
    id: r.id, newsletterId: r.newsletter_id, name: r.name, status: r.status,
    entry: entrySchema.parse(JSON.parse(r.entry)), exit: exitSchema.parse(JSON.parse(r.exit)), delayAnchor: r.delay_anchor,
    stepCount: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sequence_steps WHERE sequence_id = ?', r.id)!.n,
    enrollments: { total: byStatus.reduce((n, s) => n + s.n, 0), active: count('active'), paused: count('paused'), completed: count('completed'), exited: count('exited') },
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at,
  }
}
export type Sequence = ReturnType<typeof serializeSequence>
export const getSequence = (ctx: StoreCtx, sequenceId: string, newsletterId: string) => {
  const row = getSequenceRow(ctx, sequenceId, newsletterId)
  return { ...serializeSequence(ctx, row), steps: listSteps(ctx, row.id) }
}

/** Append a step with its hidden campaign: a draft that is never listed, sent as a campaign or shown on the website. */
export function insertStep(ctx: StoreCtx, sequence: SequenceRow, input: StepInput, userId: string): string {
  const count = ctx.db.get<{ n: number; last: number | null }>('SELECT COUNT(*) AS n, MAX(position) AS last FROM sequence_steps WHERE sequence_id = ?', sequence.id)!
  if (count.n >= MAX_STEPS) throw new AppError('limit_reached', `A sequence can have at most ${MAX_STEPS} steps.`, 400)
  const sender = nextSenderOverride({}, input)
  assertSenderOverride(ctx, sequence.newsletter_id, sender)
  const now = ctx.now()
  const campaignId = newId(ID_PREFIX.campaign)
  const stepId = newId(ID_PREFIX.sequenceStep)
  ctx.db.run("INSERT INTO campaigns (id, newsletter_id, kind, subject, doc, format, send_format, hide_unsubscribe_footer, from_domain_id, from_local, from_name, web_visible, created_by, created_at, updated_at) VALUES (?, ?, 'sequence', ?, ?, 'doc', ?, ?, ?, ?, ?, 0, ?, ?, ?)", campaignId, sequence.newsletter_id, input.subject, JSON.stringify(input.doc ?? emptyDoc), input.sendFormat, input.hideUnsubscribeFooter ? 1 : 0, sender.fromDomainId, sender.fromLocal, sender.fromName, userId, now, now)
  ctx.db.run('INSERT INTO sequence_steps (id, sequence_id, position, delay_days, campaign_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', stepId, sequence.id, (count.last ?? 0) + 1, input.delayDays, campaignId, now, now)
  return stepId
}

/** Number the steps 1..n in the given order. Two passes, because `(sequence_id, position)` is unique at every row write. */
export function renumberSteps(ctx: StoreCtx, sequenceId: string, orderedStepIds: readonly string[]) {
  orderedStepIds.forEach((stepId, index) => ctx.db.run('UPDATE sequence_steps SET position = ? WHERE id = ? AND sequence_id = ?', -(index + 1), stepId, sequenceId))
  orderedStepIds.forEach((stepId, index) => ctx.db.run('UPDATE sequence_steps SET position = ? WHERE id = ? AND sequence_id = ?', index + 1, stepId, sequenceId))
}
export const touchSequence = (ctx: StoreCtx, sequenceId: string) => void ctx.db.run('UPDATE sequences SET updated_at = ? WHERE id = ?', ctx.now(), sequenceId)

/**
 * Steps go out in position order, each at its own delay from enrollment, so a later step may never
 * have a shorter delay than the one before it. Call after changing steps, inside the transaction.
 */
export function assertDelayOrder(ctx: StoreCtx, sequenceId: string) {
  const steps = ctx.db.all<StepRow>('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY position', sequenceId)
  const bad = steps.find((step, index) => index > 0 && step.delay_days < steps[index - 1].delay_days)
  if (bad) throw new AppError('step_delay_order', `Step ${bad.position} is set to day ${bad.delay_days}, earlier than the step before it. Steps are sent in order, so each delay must be the same as or longer than the one before.`, 409, { stepId: bad.id, position: bad.position, delayDays: bad.delay_days })
}
