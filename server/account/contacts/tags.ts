/**
 * The one place that writes `contact_tags`. Every path that tags or untags a contact (contacts.create,
 * contacts.update, contacts.bulk, imports, the signup form, tags.delete, contact deletion) goes
 * through here, so a listener sees every tag a contact newly gains, whichever path added it.
 *
 * Listeners run synchronously inside the transaction that wrote the tags. What a listener writes
 * commits or rolls back with them, and a listener that throws undoes the tag write.
 */
import type { StoreCtx } from '../../core/store.ts'

/** Which write path added the tags. `manual` is the dashboard; `api` and `mcp` are key or token callers. */
export type TagSource = 'manual' | 'api' | 'mcp' | 'bulk' | 'import' | 'signup'
export interface ContactTagsAdded {
  newsletterId: string
  contactId: string
  /** Only the tags the contact did not have before this write. Never empty. */
  tagIds: string[]
  source: TagSource
}
export type ContactTagsListener = (ctx: StoreCtx, event: ContactTagsAdded) => void

const listeners = new Set<ContactTagsListener>()

/** Hear about tags a contact newly gains. Other modules register here so contacts never imports them. Returns a function that removes the listener. */
export function onContactTagsAdded(listener: ContactTagsListener): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
export const contactTagsListeners = (): readonly ContactTagsListener[] => [...listeners]

/** How a dashboard, API key or MCP caller shows up as a tag source. */
export const tagSourceOf = (actor: { via: 'web' | 'api' | 'mcp' }): TagSource => (actor.via === 'web' ? 'manual' : actor.via)

interface TagWrite { newsletterId: string; contactId: string; tagIds: readonly string[] }

/** Tag a contact. The caller has checked that the contact and the tags belong to the newsletter. Returns the tags that were not there before. */
export function addContactTags(ctx: StoreCtx, input: TagWrite & { source: TagSource }): string[] {
  if (!input.tagIds.length) return []
  return ctx.db.tx(() => {
    const added = [...new Set(input.tagIds)].filter((tagId) => ctx.db.run('INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)', input.contactId, tagId).changes > 0)
    if (added.length) for (const listener of listeners) listener(ctx, { newsletterId: input.newsletterId, contactId: input.contactId, tagIds: added, source: input.source })
    return added
  })
}

/** Untag a contact. Returns the tags that were removed. No listener hears about removals. */
export function removeContactTags(ctx: StoreCtx, input: TagWrite): string[] {
  return ctx.db.tx(() => [...new Set(input.tagIds)].filter((tagId) => ctx.db.run('DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?', input.contactId, tagId).changes > 0))
}

/** A tag is being deleted: take it off every contact of its newsletter. */
export function removeTagFromContacts(ctx: StoreCtx, input: { newsletterId: string; tagId: string }): number {
  return ctx.db.run('DELETE FROM contact_tags WHERE tag_id IN (SELECT id FROM tags WHERE id = ? AND newsletter_id = ?)', input.tagId, input.newsletterId).changes
}

/** A contact is being deleted: drop all of its tags. */
export function clearContactTags(ctx: StoreCtx, contactId: string): number {
  return ctx.db.run('DELETE FROM contact_tags WHERE contact_id = ?', contactId).changes
}
