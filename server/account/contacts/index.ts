import { z } from 'zod'
import { newId } from '../../core/ids.ts'
import { defineAction, runAction } from '../../core/actions.ts'
import type { StoreCtx } from '../../core/store.ts'
import { AppError, unauthorized } from '../../core/http.ts'
import { decodeJsonUrl, encodeJsonUrl } from '../../core/crypto.ts'
import { compileFilter, filterSchema, type Filter } from '../segments/index.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { contactRow, deleteContact, emailSchema, fieldValuesSchema, serializeContact, statusSchema, subscribe, unsubscribe, validateFields, validateTags, type ContactRow } from './state.ts'
import { taxonomyActions } from './taxonomy.ts'
import { addContactTags, removeContactTags, tagSourceOf } from './tags.ts'
import { contactLimitError } from '../usage/index.ts'
import { emailHash } from './hash.ts'
import { migrations } from './migrations.ts'
export { subscribe, unsubscribe, suppress, isSuppressed, setContactStatus, inboxProvider, validateFields, withDailyTally, onContactStatusChanged } from './state.ts'
export type { Contact, ContactStatus, ContactStatusChanged, SubscribeInput, SubscribeOutcome } from './state.ts'
export { addContactTags, removeContactTags, onContactTagsAdded, contactTagsListeners, onTagDelete } from './tags.ts'
export type { ContactTagsAdded, ContactTagsListener, TagSource } from './tags.ts'

/** An API or MCP call (`contacts.create`) newly subscribed a contact. Runs in the call's transaction; the callback it returns runs after commit. */
export type ApiSubscribeListener = (ctx: StoreCtx, subscribed: { newsletterId: string; contactId: string; subscribedAt: number | null }) => (() => Promise<void>) | void
const apiSubscribeListeners = new Set<ApiSubscribeListener>()
/** Hear about contacts newly subscribed through the API, so the welcome email can follow without contacts importing signup. */
export function onApiSubscribe(listener: ApiSubscribeListener): () => void {
  apiSubscribeListeners.add(listener)
  return () => void apiSubscribeListeners.delete(listener)
}

export function isDeleted(ctx: StoreCtx, email: string, newsletterId: string): boolean {
  return !!ctx.db.get('SELECT 1 FROM deleted_contacts WHERE email_hash = ? AND newsletter_id = ?', emailHash(email.trim().toLowerCase()), newsletterId)
}

export function ensureTags(ctx: StoreCtx, newsletterId: string, rawNames: string[]): string[] {
  const names = z.array(z.string().trim().min(1).max(120)).max(100).parse(rawNames)
  return ctx.db.tx(() => names.map((name) => {
    const existing = ctx.db.get<{ id: string }>('SELECT id FROM tags WHERE newsletter_id = ? AND name = ?', newsletterId, name)
    if (existing) return existing.id
    const id = newId('tag')
    ctx.db.run('INSERT INTO tags (id, newsletter_id, name) VALUES (?, ?, ?)', id, newsletterId, name)
    return id
  }))
}

export const newsletterIdSchema = z.string().min(1).describe('The newsletter id')
const contactId = z.string().min(1).describe('The contact id')
const listShape = {
  newsletterId: newsletterIdSchema,
  search: z.string().trim().max(320).optional().describe('Find an email address or name containing this text'),
  status: statusSchema.optional().describe('Subscription status to include'),
  tagId: z.string().optional().describe('Only include contacts with this tag'),
  filter: filterSchema.nullable().optional().describe('Additional contact conditions'),
  sort: z.enum(['createdAt', 'email', 'name']).default('createdAt').describe('Field used to order contacts'),
  direction: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
  cursor: z.string().max(2000).optional().describe('Next cursor from the previous page'),
  limit: z.number().int().min(1).max(200).default(50).describe('Maximum contacts in one page'),
}
const listSchema = z.object(listShape)
type ListInput = z.output<typeof listSchema>
const cursorSchema = z.object({ value: z.union([z.string(), z.number()]), id: z.string(), sort: z.enum(['createdAt', 'email', 'name']), direction: z.enum(['asc', 'desc']), newsletterId: z.string() })
function listContacts(ctx: StoreCtx, i: ListInput) {
  const all: Filter[] = []
  if (i.filter) all.push(i.filter)
  if (i.status) all.push({ field: 'status', in: [i.status] })
  if (i.tagId) { validateTags(ctx, i.newsletterId, [i.tagId]); all.push({ field: 'tag', id: i.tagId }) }
  const q = compileFilter({ all }, i.newsletterId)
  const clauses = [q.where]
  if (i.search) { clauses.push('(instr(c.email, ?) > 0 OR instr(lower(c.name), ?) > 0)'); q.params.push(i.search.toLowerCase(), i.search.toLowerCase()) }
  const col = { createdAt: 'created_at', email: 'email', name: 'name' }[i.sort]
  if (i.cursor) {
    const cursor = cursorSchema.safeParse(decodeJsonUrl(i.cursor))
    if (!cursor.success || cursor.data.newsletterId !== i.newsletterId || cursor.data.sort !== i.sort || cursor.data.direction !== i.direction) throw new AppError('invalid_input', 'That page cursor is invalid for this list.', 400)
    clauses.push(`(c.${col}, c.id) ${i.direction === 'asc' ? '>' : '<'} (?, ?)`)
    q.params.push(cursor.data.value, cursor.data.id)
  }
  const direction = i.direction === 'asc' ? 'ASC' : 'DESC'
  const rows = ctx.db.all<ContactRow>(`SELECT c.* FROM contacts c WHERE ${clauses.join(' AND ')} ORDER BY c.${col} ${direction}, c.id ${direction} LIMIT ?`, ...q.params, i.limit + 1)
  const page = rows.slice(0, i.limit)
  const last = page.at(-1)
  return { contacts: page.map(serializeContact), nextCursor: rows.length > i.limit && last ? encodeJsonUrl({ value: i.sort === 'createdAt' ? last.created_at : i.sort === 'email' ? last.email : last.name, id: last.id, sort: i.sort, direction: i.direction, newsletterId: i.newsletterId }) : null }
}
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const meaningful = Array.from(text).find((c) => c.charCodeAt(0) > 32 && c.trim() !== '') ?? ''
  if (['=', '+', '-', '@'].includes(meaningful) || ['\t', '\r', '\n'].some((c) => text.startsWith(c))) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}
const csvHeader = ['Email', 'Name', 'Status', 'Source', 'Subscribed at', 'Fields', 'Tags'].map(csvCell).join(',') + '\r\n'
function exportPage(ctx: StoreCtx, i: ListInput) {
  const page = listContacts(ctx, i)
  return { csv: (i.cursor ? '' : csvHeader) + page.contacts.map((c) => {
    const tags = ctx.db.all<{ name: string }>('SELECT t.name FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = ? AND t.newsletter_id = ? ORDER BY t.name', c.id, i.newsletterId)
    return [c.email, c.name, c.status, c.source, c.subscribedAt === null ? '' : new Date(c.subscribedAt).toISOString(), c.fields, tags.map((t) => t.name).join('; ')].map(csvCell).join(',') + '\r\n'
  }).join(''), nextCursor: page.nextCursor }
}
export const contactsModule = {
  name: 'contacts',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    reg.resolver('contact', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM contacts WHERE id = ?', id)?.newsletter_id ?? null)
    reg.resolver('tag', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM tags WHERE id = ?', id)?.newsletter_id ?? null)
    reg.routes((app) => {
      app.get('/api/actions/contacts.export', async (c) => {
        const actor = c.get('actor')
        if (!actor) throw unauthorized()
        const ctx = c.get('ctx')
        const input = listSchema.parse({ newsletterId: c.req.query('newsletterId'), sort: 'email', direction: 'asc', limit: 200 })
        await runAction(ctx, 'contacts.export', input, actor)
        let cursor: string | undefined
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              await runAction(ctx, 'newsletters.get', { newsletterId: input.newsletterId }, actor)
              const page = exportPage(ctx, { ...input, cursor })
              controller.enqueue(new TextEncoder().encode(page.csv))
              if (!page.nextCursor) controller.close()
              else cursor = page.nextCursor
            } catch (error) { controller.error(error) }
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="contacts.csv"', 'cache-control': 'no-store' } })
      })
    })
    return reg.actions(
      ...taxonomyActions,
      defineAction({ name: 'contacts.list', description: 'Search and page through contacts in a newsletter.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: listSchema, rest: { method: 'GET', path: '/newsletters/:newsletterId/contacts' }, mcp: { title: 'List contacts', destructive: false }, handler: listContacts }),
      defineAction({ name: 'contacts.create', description: 'Add a contact with asserted consent, or update the one that already has this email (outcome exists): its name and fields are merged and the given tags are added. Adding a tag can start a tag-triggered email sequence, for new and existing contacts alike. Suppressed addresses stay suppressed (outcome suppressed) and get no tags. Past the plan contact limit the call fails with limit_reached and nothing is added. When this call newly subscribes the contact (outcome subscribed) and the newsletter has its welcome email turned on, that welcome is sent once, even with double opt-in on (this call asserts consent; it does not wait for a confirmation click). Repeat calls (outcome exists) never send another. Pass sendWelcome false for imports and migrations.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId: newsletterIdSchema, email: emailSchema.describe('The email address'), name: z.string().trim().max(200).optional().describe('The contact name'), fields: fieldValuesSchema.optional().describe('Typed custom field values'), tags: z.array(z.string()).max(100).optional().describe('Tag ids from this newsletter to add to the contact. Tags the contact already has are left alone.'), source: z.string().max(100).default('manual').describe('How the contact was added'), sendWelcome: z.boolean().default(true).describe("Send the newsletter's welcome email when this call newly subscribes the contact and the welcome is turned on. Default true. Use false to import or migrate contacts silently. A contact who already exists as subscribed (outcome exists) never gets a welcome from this call, whatever this says.") }), rest: { method: 'POST', path: '/newsletters/:newsletterId/contacts' }, mcp: { title: 'Add a contact (sends the welcome email to new subscribers unless sendWelcome is false)', destructive: false }, handler: async (ctx, { sendWelcome, ...i }, actor) => {
        const after: (() => Promise<void>)[] = []
        // One transaction: the welcome is queued only with the subscription that earned it.
        const result = ctx.db.tx(() => {
          const result = subscribe(ctx, { ...i, consent: 'asserted', tagSource: tagSourceOf(actor) })
          if (result.outcome === 'limit') throw contactLimitError(ctx)
          if (result.outcome === 'subscribed' && sendWelcome) for (const listener of apiSubscribeListeners) { const next = listener(ctx, { newsletterId: i.newsletterId, contactId: result.contact.id, subscribedAt: result.contact.subscribedAt }); if (next) after.push(next) }
          return result
        })
        for (const run of after) { try { await run() } catch { /* The durable signup.mail job retries safe failures. */ } }
        return result
      } }),
      defineAction({ name: 'contacts.get', description: 'Read a contact with their tags, the email sequences they are or were in, and recent timeline.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'contact', param: 'contactId' }, input: z.object({ newsletterId: newsletterIdSchema, contactId, beforeEventId: z.number().int().positive().optional().describe('Load events older than this event id') }), rest: { method: 'GET', path: '/newsletters/:newsletterId/contacts/:contactId' }, mcp: { title: 'Get a contact', destructive: false }, handler: (ctx, i) => {
        const row = contactRow(ctx, i.contactId, i.newsletterId)
        const events = ctx.db.all<{ id: number; type: string; data: string; at: number; campaign_id: string | null }>('SELECT id, type, data, at, campaign_id FROM events WHERE newsletter_id = ? AND contact_id = ? AND id < ? ORDER BY id DESC LIMIT 101', i.newsletterId, row.id, i.beforeEventId ?? Number.MAX_SAFE_INTEGER)
        // Sends and first opens are read from the delivery rows (one per campaign), not from `events`.
        // The campaign list keeps the lookup on the (campaign_id, contact_id) key.
        const deliveries = ctx.db.all<{ campaign_id: string; subject: string; sent_at: number | null; opened_at: number | null; clicked_at: number | null }>('SELECT d.campaign_id, c.subject, d.sent_at, d.opened_at, d.clicked_at FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE d.campaign_id IN (SELECT id FROM campaigns WHERE newsletter_id = ?) AND d.contact_id = ? AND d.sent_at IS NOT NULL ORDER BY d.sent_at DESC LIMIT 500', i.newsletterId, row.id).map((d) => ({ campaignId: d.campaign_id, subject: d.subject, sentAt: d.sent_at!, openedAt: d.opened_at, clickedAt: d.clicked_at }))
        // Read through the newsletter's few sequences and the (sequence_id, contact_id) key.
        const enrollments = ctx.db.all<{ sequence_id: string; name: string; sequence_status: string; status: string; enrolled_at: number; next_run_at: number | null; exit_reason: string | null }>('SELECT e.sequence_id, s.name, s.status AS sequence_status, e.status, e.enrolled_at, e.next_run_at, e.exit_reason FROM sequences s JOIN sequence_enrollments e ON e.sequence_id = s.id AND e.contact_id = ? WHERE s.newsletter_id = ? ORDER BY e.enrolled_at DESC, e.id', row.id, i.newsletterId).map((e) => ({ sequenceId: e.sequence_id, name: e.name, sequenceStatus: e.sequence_status, status: e.status, enrolledAt: e.enrolled_at, nextRunAt: e.next_run_at, exitReason: e.exit_reason }))
        return { contact: serializeContact(row), deliveries, enrollments, tags: ctx.db.all<{ id: string; name: string }>('SELECT t.id, t.name FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = ? AND t.newsletter_id = ? ORDER BY t.name', row.id, i.newsletterId), events: events.slice(0, 100).map((e) => ({ id: e.id, type: e.type, at: e.at, campaignId: e.campaign_id, data: JSON.parse(e.data) as unknown })), nextEventId: events.length > 100 ? events[99].id : null }
      } }),
      defineAction({ name: 'contacts.update', description: 'Edit a contact name, typed custom fields and tags. Adding a tag the contact does not have yet can start a tag-triggered email sequence.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'contact', param: 'contactId' }, input: z.object({ newsletterId: newsletterIdSchema, contactId, name: z.string().trim().max(200).optional().describe('The new contact name'), fields: fieldValuesSchema.optional().describe('Custom field values to merge with existing values'), unsetFields: z.array(z.string()).max(100).optional().describe('Custom field keys to clear'), addTagIds: z.array(z.string().min(1)).max(100).optional().describe('Tag ids from this newsletter to add. Tags the contact already has are left alone.'), removeTagIds: z.array(z.string().min(1)).max(100).optional().describe('Tag ids from this newsletter to remove. Tags the contact does not have are ignored.') }), rest: { method: 'PATCH', path: '/newsletters/:newsletterId/contacts/:contactId' }, mcp: { title: 'Edit a contact', destructive: false }, handler: (ctx, i, actor) => ctx.db.tx(() => {
        const c = serializeContact(contactRow(ctx, i.contactId, i.newsletterId))
        const fields = { ...c.fields, ...validateFields(ctx, i.newsletterId, i.fields ?? {}) }
        for (const key of i.unsetFields ?? []) delete fields[key]
        const addTagIds = i.addTagIds ?? []
        const removeTagIds = i.removeTagIds ?? []
        if (addTagIds.some((id) => removeTagIds.includes(id))) throw new AppError('invalid_input', 'A tag cannot be added and removed in the same call.', 400)
        validateTags(ctx, i.newsletterId, [...addTagIds, ...removeTagIds])
        ctx.db.run('UPDATE contacts SET name = ?, fields = ?, updated_at = ? WHERE id = ? AND newsletter_id = ?', i.name ?? c.name, JSON.stringify(fields), ctx.now(), c.id, i.newsletterId)
        removeContactTags(ctx, { newsletterId: i.newsletterId, contactId: c.id, tagIds: removeTagIds })
        addContactTags(ctx, { newsletterId: i.newsletterId, contactId: c.id, tagIds: addTagIds, source: tagSourceOf(actor) })
        return serializeContact(contactRow(ctx, c.id, i.newsletterId))
      }) }),
      defineAction({ name: 'contacts.unsubscribe', description: 'Unsubscribe a contact from this newsletter.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'contact', param: 'contactId' }, input: z.object({ newsletterId: newsletterIdSchema, contactId, reason: z.string().max(500).optional().describe('Why the contact is leaving') }), rest: { method: 'POST', path: '/newsletters/:newsletterId/contacts/:contactId/unsubscribe' }, mcp: { title: 'Unsubscribe a contact', destructive: true }, handler: (ctx, i) => { contactRow(ctx, i.contactId, i.newsletterId); unsubscribe(ctx, i); return serializeContact(contactRow(ctx, i.contactId, i.newsletterId)) } }),
      defineAction({ name: 'contacts.delete', description: 'Delete a contact and remember their opt-out against future imports.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'contact', param: 'contactId' }, input: z.object({ newsletterId: newsletterIdSchema, contactId }), rest: { method: 'DELETE', path: '/newsletters/:newsletterId/contacts/:contactId' }, mcp: { title: 'Delete a contact', destructive: true }, handler: (ctx, i) => { deleteContact(ctx, i.contactId, i.newsletterId); return { deleted: true } } }),
      defineAction({ name: 'contacts.bulk', description: 'Tag, untag, unsubscribe or delete up to 100 contacts atomically. Adding a tag a contact does not have yet can start a tag-triggered email sequence.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId: newsletterIdSchema, contactIds: z.array(z.string()).min(1).max(100).describe('Contacts from this newsletter'), operation: z.enum(['tag', 'untag', 'unsubscribe', 'delete']).describe('The operation to apply'), tagIds: z.array(z.string()).max(100).default([]).describe('Tags to add or remove') }), rest: { method: 'POST', path: '/newsletters/:newsletterId/contacts/bulk' }, mcp: { title: 'Change contacts in bulk', destructive: true }, handler: (ctx, i) => ctx.db.tx(() => {
        for (const id of i.contactIds) contactRow(ctx, id, i.newsletterId)
        validateTags(ctx, i.newsletterId, i.tagIds)
        for (const id of new Set(i.contactIds)) {
          if (i.operation === 'delete') deleteContact(ctx, id, i.newsletterId)
          else if (i.operation === 'unsubscribe') unsubscribe(ctx, { contactId: id, reason: 'bulk' })
          else if (i.operation === 'tag') addContactTags(ctx, { newsletterId: i.newsletterId, contactId: id, tagIds: i.tagIds, source: 'bulk' })
          else removeContactTags(ctx, { newsletterId: i.newsletterId, contactId: id, tagIds: i.tagIds })
        }
        return { changed: new Set(i.contactIds).size }
      }) }),
      defineAction({ name: 'contacts.export', description: 'Export a formula-safe CSV page. Follow nextCursor until null or download the streamed CSV endpoint.', scope: 'account', role: 'admin', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: listSchema, rest: { method: 'POST', path: '/newsletters/:newsletterId/contacts/export' }, mcp: { title: 'Export contacts', destructive: false }, handler: exportPage }),
    )
  },
}
