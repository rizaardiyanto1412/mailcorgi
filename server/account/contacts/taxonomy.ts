import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { AppError, notFound } from '../../core/http.ts'
import { newId } from '../../core/ids.ts'
import { emailSchema, suppress } from './state.ts'
import { assertTagDeletable, removeTagFromContacts } from './tags.ts'
const newsletterId = z.string().min(1).describe('The newsletter id')
const tagId = z.string().min(1).describe('The tag id')
const name = z.string().trim().min(1).max(120).describe('The tag name')
const fieldId = z.string().min(1).describe('The custom field id')
const fieldShape = { key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/).describe('The custom field key, used in filters and merge fields'), label: z.string().trim().min(1).max(120).describe('The field label'), type: z.enum(['text', 'number', 'date', 'boolean']).describe('The field value type') }
interface FieldRow { id: string; key: string; label: string; type: 'text' | 'number' | 'date' | 'boolean' }
export const taxonomyActions = [
  defineAction({ name: 'tags.list', description: 'List the tags in a newsletter.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/tags' }, mcp: { title: 'List tags', destructive: false }, handler: (ctx, i) => ({ tags: ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM tags WHERE newsletter_id = ? ORDER BY name, id', i.newsletterId) }) }),
  defineAction({ name: 'tags.create', description: 'Create a tag for contacts.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, name }), rest: { method: 'POST', path: '/newsletters/:newsletterId/tags' }, mcp: { title: 'Create a tag', destructive: false }, handler: (ctx, i) => {
    if (ctx.db.get('SELECT id FROM tags WHERE newsletter_id = ? AND name = ?', i.newsletterId, i.name)) throw new AppError('already_exists', 'A tag with that name already exists.', 409)
    const id = newId('tag'); ctx.db.run('INSERT INTO tags (id, newsletter_id, name) VALUES (?, ?, ?)', id, i.newsletterId, i.name); return { id, name: i.name }
  } }),
  defineAction({ name: 'tags.update', description: 'Rename a tag.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'tag', param: 'tagId' }, input: z.object({ newsletterId, tagId, name }), rest: { method: 'PATCH', path: '/newsletters/:newsletterId/tags/:tagId' }, mcp: { title: 'Rename a tag', destructive: false }, handler: (ctx, i) => {
    if (ctx.db.get('SELECT id FROM tags WHERE newsletter_id = ? AND name = ? AND id != ?', i.newsletterId, i.name, i.tagId)) throw new AppError('already_exists', 'A tag with that name already exists.', 409)
    ctx.db.run('UPDATE tags SET name = ? WHERE id = ? AND newsletter_id = ?', i.name, i.tagId, i.newsletterId); return { id: i.tagId, name: i.name }
  } }),
  defineAction({ name: 'tags.delete', description: 'Delete a tag and remove it from contacts. Refused with 409 tag_in_use (details.sequences lists them) while an email sequence that is not archived uses the tag as its entry or exit rule.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'tag', param: 'tagId' }, input: z.object({ newsletterId, tagId }), rest: { method: 'DELETE', path: '/newsletters/:newsletterId/tags/:tagId' }, mcp: { title: 'Delete a tag', destructive: true }, handler: (ctx, i) => ctx.db.tx(() => { assertTagDeletable(ctx, { newsletterId: i.newsletterId, tagId: i.tagId }); removeTagFromContacts(ctx, { newsletterId: i.newsletterId, tagId: i.tagId });ctx.db.run('DELETE FROM tags WHERE id = ? AND newsletter_id = ?', i.tagId, i.newsletterId); return { deleted: true } }) }),
  defineAction({ name: 'contactFields.list', description: 'List typed custom fields for a newsletter.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/fields' }, mcp: { title: 'List custom fields', destructive: false }, handler: (ctx, i) => ({ fields: ctx.db.all<FieldRow>('SELECT id, key, label, type FROM contact_fields WHERE newsletter_id = ? ORDER BY label, id', i.newsletterId) }) }),
  defineAction({ name: 'contactFields.create', description: 'Create a typed custom field.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, ...fieldShape }), rest: { method: 'POST', path: '/newsletters/:newsletterId/fields' }, mcp: { title: 'Create a custom field', destructive: false }, handler: (ctx, i) => {
    if (ctx.db.get('SELECT id FROM contact_fields WHERE newsletter_id = ? AND key = ?', i.newsletterId, i.key)) throw new AppError('already_exists', 'That field key is already in use.', 409)
    const id = newId('fld'); ctx.db.run('INSERT INTO contact_fields (id, newsletter_id, key, label, type) VALUES (?, ?, ?, ?, ?)', id, i.newsletterId, i.key, i.label, i.type); return { id, key: i.key, label: i.label, type: i.type }
  } }),
  defineAction({ name: 'contactFields.update', description: 'Change a custom field label. Keys and types stay stable for existing contact data.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, fieldId, label: fieldShape.label }), rest: { method: 'PATCH', path: '/newsletters/:newsletterId/fields/:fieldId' }, mcp: { title: 'Rename a custom field', destructive: false }, handler: (ctx, i) => {
    if (!ctx.db.get('SELECT id FROM contact_fields WHERE id = ? AND newsletter_id = ?', i.fieldId, i.newsletterId)) throw notFound('That custom field')
    ctx.db.run('UPDATE contact_fields SET label = ? WHERE id = ? AND newsletter_id = ?', i.label, i.fieldId, i.newsletterId); return { id: i.fieldId, label: i.label }
  } }),
  defineAction({ name: 'contactFields.delete', description: 'Delete a custom field and remove its values from contacts.', scope: 'account', role: 'admin', effect: 'write', resource: { type: 'newsletter', param: 'newsletterId' }, input: z.object({ newsletterId, fieldId }), rest: { method: 'DELETE', path: '/newsletters/:newsletterId/fields/:fieldId' }, mcp: { title: 'Delete a custom field', destructive: true }, handler: (ctx, i) => ctx.db.tx(() => {
    const f = ctx.db.get<FieldRow>('SELECT * FROM contact_fields WHERE id = ? AND newsletter_id = ?', i.fieldId, i.newsletterId)
    if (!f) throw notFound('That custom field')
    ctx.db.run('UPDATE contacts SET fields = json_remove(fields, ?), updated_at = ? WHERE newsletter_id = ? AND json_type(fields, ?) IS NOT NULL', '$.' + f.key, ctx.now(), i.newsletterId, '$.' + f.key)
    ctx.db.run('DELETE FROM contact_fields WHERE id = ? AND newsletter_id = ?', i.fieldId, i.newsletterId); return { deleted: true }
  }) }),
  defineAction({ name: 'suppressions.list', description: 'List account and newsletter suppressions. Only the owner can read account-wide addresses.', scope: 'account', role: 'owner', effect: 'read', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId: z.string().describe('The current account id'), afterId: z.string().optional().describe('The last suppression id from the preceding page'), limit: z.number().int().min(1).max(200).default(100).describe('Maximum rows to return') }), rest: { method: 'GET', path: '/suppressions' }, mcp: { title: 'List suppressions', destructive: false }, handler: (ctx, i) => {
    const rows = ctx.db.all<{ id: string; email: string; newsletter_id: string | null; reason: string; created_at: number }>('SELECT * FROM suppressions WHERE id > ? ORDER BY id LIMIT ?', i.afterId ?? '', i.limit + 1)
    return { suppressions: rows.slice(0, i.limit).map((r) => ({ id: r.id, email: r.email, newsletterId: r.newsletter_id, reason: r.reason, createdAt: r.created_at })), nextId: rows.length > i.limit ? rows[i.limit - 1].id : null }
  } }),
  defineAction({ name: 'suppressions.add', description: 'Manually suppress an address throughout this account.', scope: 'account', role: 'owner', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId: z.string().describe('The current account id'), email: emailSchema.describe('The address to suppress') }), rest: { method: 'POST', path: '/suppressions' }, mcp: { title: 'Suppress an address', destructive: true }, handler: (ctx, i) => { suppress(ctx, { email: i.email, newsletterId: null, reason: 'manual' }); return { suppressed: true } } }),
  defineAction({ name: 'suppressions.remove', description: 'Remove a manual suppression. This does not resubscribe contacts.', scope: 'account', role: 'owner', effect: 'write', resource: { type: 'account', param: 'accountId' }, input: z.object({ accountId: z.string().describe('The current account id'), suppressionId: z.string().describe('The manual suppression id') }), rest: { method: 'DELETE', path: '/suppressions/:suppressionId' }, mcp: { title: 'Remove a manual suppression', destructive: false }, handler: (ctx, i) => {
    if (!ctx.db.run("DELETE FROM suppressions WHERE id = ? AND reason = 'manual'", i.suppressionId).changes) throw notFound('That manual suppression')
    return { removed: true }
  } }),
] as const
