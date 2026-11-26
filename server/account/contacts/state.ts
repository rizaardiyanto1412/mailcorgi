import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { AppError, notFound } from '../../core/http.ts'
import { newId } from '../../core/ids.ts'
import { contactLimitError, reserveContacts } from '../usage/index.ts'
import { emailHash } from './hash.ts'
import { addContactTags, clearContactTags, type TagSource } from './tags.ts'

export const statusSchema = z.enum(['unconfirmed', 'subscribed', 'unsubscribed', 'bounced', 'complained', 'cleaned'])
export type ContactStatus = z.infer<typeof statusSchema>
export const fieldValuesSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.union([z.string().max(10000), z.number().finite(), z.boolean()]))
export type FieldValues = z.infer<typeof fieldValuesSchema>
export const emailSchema = z.string().trim().toLowerCase().email().max(320)
export interface ContactRow {
  id: string; newsletter_id: string; email: string; name: string; status: ContactStatus; source: string; fields: string
  subscribed_at: number | null; confirmed_at: number | null; created_at: number; updated_at: number
  provider: string; unsubscribed_at: number | null; unsubscribe_reason: string | null
  last_sent_at: number | null; last_opened_at: number | null; last_clicked_at: number | null
}
export const serializeContact = (r: ContactRow) => ({ id: r.id, newsletterId: r.newsletter_id, email: r.email, name: r.name, status: r.status, source: r.source, fields: fieldValuesSchema.parse(JSON.parse(r.fields)), subscribedAt: r.subscribed_at, confirmedAt: r.confirmed_at, createdAt: r.created_at, updatedAt: r.updated_at, provider: r.provider, unsubscribedAt: r.unsubscribed_at, unsubscribeReason: r.unsubscribe_reason, lastSentAt: r.last_sent_at, lastOpenedAt: r.last_opened_at, lastClickedAt: r.last_clicked_at })
export type Contact = ReturnType<typeof serializeContact>
export interface SubscribeInput { newsletterId: string; email: string; name?: string; fields?: Record<string, unknown>; tags?: string[]; source: string; consent: 'asserted' | 'confirmed' | 'pending'; at?: number; /** Which write path this is, for tag listeners. `source` is free text the caller chooses, so it is not trusted for this. */ tagSource?: TagSource }
export type SubscribeOutcome = 'subscribed' | 'pending' | 'suppressed' | 'limit' | 'exists'
export function contactRow(ctx: StoreCtx, id: string, newsletterId?: string): ContactRow {
  const r = ctx.db.get<ContactRow>('SELECT * FROM contacts WHERE id = ?' + (newsletterId ? ' AND newsletter_id = ?' : ''), ...[id, ...(newsletterId ? [newsletterId] : [])])
  if (!r) throw notFound('That contact')
  return r
}
export function validateFields(ctx: StoreCtx, newsletterId: string, raw: Record<string, unknown>): FieldValues {
  const parsed = fieldValuesSchema.safeParse(raw)
  if (!parsed.success) throw new AppError('invalid_input', 'Custom fields must contain text, numbers or booleans.', 400)
  const definitions = ctx.db.all<{ key: string; type: string }>('SELECT key, type FROM contact_fields WHERE newsletter_id = ?', newsletterId)
  for (const [key, value] of Object.entries(parsed.data)) {
    const def = definitions.find((d) => d.key === key)
    const valid = def && (def.type === 'date' ? typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value : typeof value === (def.type === 'text' ? 'string' : def.type))
    if (!valid) throw new AppError('invalid_input', `Invalid value for custom field ${key}.`, 400)
  }
  return parsed.data
}
export function validateTags(ctx: StoreCtx, newsletterId: string, tags: string[]) {
  for (const id of tags) if (!ctx.db.get('SELECT id FROM tags WHERE id = ? AND newsletter_id = ?', id, newsletterId)) throw notFound('That tag')
}
export function inboxProvider(email: string): string {
  const domain = email.split('@')[1]
  if (['gmail.com', 'googlemail.com'].includes(domain)) return 'gmail'
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook'
  if (['yahoo.com', 'ymail.com', 'aol.com'].includes(domain)) return 'yahoo'
  if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) return 'icloud'
  return 'other'
}
function event(ctx: StoreCtx, contact: ContactRow, type: string, detail: Record<string, unknown>, at: number) {
  ctx.db.run('INSERT INTO events (type, newsletter_id, contact_id, campaign_id, data, at) VALUES (?, ?, ?, ?, ?, ?)', type, contact.newsletter_id, contact.id, typeof detail.campaignId === 'string' ? detail.campaignId : null, JSON.stringify(detail), at)
}
type DailyColumn = 'subscribed' | 'unsubscribed' | 'bounces' | 'complaints'
const DAILY_TALLY = 'contacts.dailyTally'
function daily(ctx: StoreCtx, newsletterId: string, column: DailyColumn, at: number, n = 1) {
  const tally = ctx.memory.get(DAILY_TALLY) as Map<string, number> | undefined
  const day = new Date(at).toISOString().slice(0, 10)
  if (tally) {
    const key = `${newsletterId}\n${day}\n${column}`
    tally.set(key, (tally.get(key) ?? 0) + n)
    return
  }
  ctx.db.run(`INSERT INTO daily_stats (newsletter_id, day, ${column}) VALUES (?, ?, ?) ON CONFLICT(newsletter_id, day) DO UPDATE SET ${column} = ${column} + excluded.${column}`, newsletterId, day, n)
}
/**
 * Run a bulk step (an import batch) with the daily counters collected in memory and written once per
 * newsletter, day and column at the end, inside the same transaction. Nested calls share the outer tally.
 */
export function withDailyTally<T>(ctx: StoreCtx, fn: () => T): T {
  if (ctx.memory.has(DAILY_TALLY)) return fn()
  const tally = new Map<string, number>()
  ctx.memory.set(DAILY_TALLY, tally)
  try {
    return ctx.db.tx(() => {
      const result = fn()
      ctx.memory.delete(DAILY_TALLY)
      for (const [key, n] of tally) {
        const [newsletterId, day, column] = key.split('\n')
        daily(ctx, newsletterId, column as DailyColumn, Date.parse(day), n)
      }
      return result
    })
  } finally {
    ctx.memory.delete(DAILY_TALLY)
  }
}
export function isSuppressed(ctx: StoreCtx, email: string, newsletterId: string): boolean {
  return !!ctx.db.get('SELECT id FROM suppressions WHERE email = ? AND (newsletter_id IS NULL OR newsletter_id = ?) LIMIT 1', email.trim().toLowerCase(), newsletterId)
}
function addSuppression(ctx: StoreCtx, email: string, newsletterId: string | null, reason: string) {
  ctx.db.run('INSERT OR IGNORE INTO suppressions (id, email, newsletter_id, reason, created_at) VALUES (?, ?, ?, ?, ?)', newId('sup'), email, newsletterId, reason, ctx.now())
}
/** The timeline event and daily counter every status change writes (architecture 5.3). */
function recordStatusChange(ctx: StoreCtx, c: ContactRow, status: ContactStatus, detail: Record<string, unknown>, at: number) {
  const confirmed = detail.consent === 'confirmed'
  const type = status === 'subscribed' ? (confirmed ? 'confirm' : 'signup') : status === 'unsubscribed' ? 'unsubscribe' : status === 'bounced' ? 'bounce' : status === 'complained' ? 'complaint' : 'cleaned'
  event(ctx, c, type, detail, at)
  daily(ctx, c.newsletter_id, status === 'subscribed' ? 'subscribed' : status === 'bounced' ? 'bounces' : status === 'complained' ? 'complaints' : 'unsubscribed', at)
}
export function setContactStatus(ctx: StoreCtx, contactId: string, status: ContactStatus, detail: Record<string, unknown> = {}): void {
  ctx.db.tx(() => {
    const c = contactRow(ctx, contactId)
    if (c.status === status) return
    const active = (s: ContactStatus) => s === 'subscribed' || s === 'unconfirmed'
    const confirmed = detail.consent === 'confirmed'
    if (status === 'unconfirmed' || (status === 'subscribed' && c.status !== 'unconfirmed' && !confirmed)) throw new AppError('invalid_transition', 'A suppressed contact must confirm their subscription.', 409)
    if (status === 'subscribed' && isSuppressed(ctx, c.email, c.newsletter_id)) throw new AppError('suppressed', 'This address is suppressed.', 409)
    if (active(status) && !active(c.status) && !reserveContacts(ctx, 1)) throw contactLimitError(ctx)
    const at = typeof detail.at === 'number' ? detail.at : ctx.now()
    const timeColumn = status === 'subscribed' ? 'subscribed_at' : status === 'bounced' ? 'bounced_at' : status === 'complained' ? 'complained_at' : 'unsubscribed_at'
    // One statement: the streak reset for a (re)subscription rides along instead of a second row write.
    const streaks = status === 'subscribed' ? ', ignored_streak = 0, strict_ignored_streak = 0, keep_asked_at = NULL' : ''
    ctx.db.run(`UPDATE contacts SET status = ?, ${timeColumn} = ?, updated_at = ?, confirmed_at = CASE WHEN ? THEN ? ELSE confirmed_at END, unsubscribe_reason = CASE WHEN ? THEN ? ELSE unsubscribe_reason END${streaks} WHERE id = ? AND newsletter_id = ?`, status, at, ctx.now(), confirmed, at, status === 'unsubscribed', typeof detail.reason === 'string' ? detail.reason : '', c.id, c.newsletter_id)
    recordStatusChange(ctx, c, status, detail, at)
    if (status === 'unsubscribed' || status === 'cleaned') addSuppression(ctx, c.email, c.newsletter_id, status)
    if (status === 'bounced' || status === 'complained') {
      addSuppression(ctx, c.email, null, status === 'bounced' ? 'hard_bounce' : 'complaint')
      for (const other of ctx.db.all<{ id: string }>("SELECT id FROM contacts WHERE email = ? AND id != ? AND status IN ('subscribed', 'unconfirmed')", c.email, c.id)) setContactStatus(ctx, other.id, status, detail)
    }
  })
}
export function unsubscribe(ctx: StoreCtx, input: { contactId: string; reason?: string; campaignId?: string }): void {
  const c = contactRow(ctx, input.contactId)
  if (c.status === 'bounced' || c.status === 'complained' || c.status === 'cleaned') return
  setContactStatus(ctx, input.contactId, 'unsubscribed', { reason: input.reason ?? '', campaignId: input.campaignId })
}
export function suppress(ctx: StoreCtx, input: { email: string; newsletterId: string | null; reason: string }): void {
  const email = emailSchema.parse(input.email)
  ctx.db.tx(() => {
    addSuppression(ctx, email, input.newsletterId, input.reason)
    const rows = ctx.db.all<{ id: string }>("SELECT id FROM contacts WHERE email = ? AND status IN ('subscribed', 'unconfirmed')" + (input.newsletterId ? ' AND newsletter_id = ?' : ''), email, ...(input.newsletterId ? [input.newsletterId] : []))
    for (const row of rows) setContactStatus(ctx, row.id, input.reason === 'hard_bounce' ? 'bounced' : input.reason === 'complaint' ? 'complained' : input.reason === 'cleaned' ? 'cleaned' : 'unsubscribed', { reason: input.reason })
  })
}
export function subscribe(ctx: StoreCtx, input: SubscribeInput): { contact: Contact; created: boolean; outcome: SubscribeOutcome } {
  const email = emailSchema.parse(input.email)
  if (!ctx.db.get('SELECT id FROM newsletters WHERE id = ? AND archived_at IS NULL', input.newsletterId)) throw notFound('That active newsletter')
  const fields = validateFields(ctx, input.newsletterId, input.fields ?? {})
  validateTags(ctx, input.newsletterId, input.tags ?? [])
  return ctx.db.tx(() => {
    const existing = ctx.db.get<ContactRow>('SELECT * FROM contacts WHERE newsletter_id = ? AND email = ?', input.newsletterId, email)
    const at = input.at ?? ctx.now()
    const candidate: ContactRow = existing ?? { id: newId('ct'), newsletter_id: input.newsletterId, email, name: input.name ?? '', status: 'unconfirmed', source: input.source, fields: JSON.stringify(fields), subscribed_at: null, confirmed_at: null, created_at: at, updated_at: at, provider: inboxProvider(email), unsubscribed_at: null, unsubscribe_reason: null, last_sent_at: null, last_opened_at: null, last_clicked_at: null }
    const result = (outcome: SubscribeOutcome, created = false) => ({ contact: serializeContact(ctx.db.get<ContactRow>('SELECT * FROM contacts WHERE id = ?', candidate.id) ?? candidate), created, outcome })
    const hash = emailHash(email)
    const deleted = !!ctx.db.get('SELECT 1 FROM deleted_contacts WHERE email_hash = ? AND newsletter_id = ?', hash, input.newsletterId)
    const accountSuppressed = !!ctx.db.get('SELECT id FROM suppressions WHERE email = ? AND newsletter_id IS NULL', email)
    const inactive = existing && !['subscribed', 'unconfirmed'].includes(existing.status)
    // A deleted or opted-out address may ask for a new confirmation email (its own action); only confirming revives it.
    const rejoining = input.consent === 'pending' && !existing
    if (accountSuppressed || (input.consent === 'asserted' && (deleted || inactive || isSuppressed(ctx, email, input.newsletterId))) || (input.consent === 'pending' && !rejoining && (inactive || isSuppressed(ctx, email, input.newsletterId)))) return result('suppressed')
    if ((!existing || inactive) && !reserveContacts(ctx, 1)) return result('limit')
    if (input.consent === 'confirmed') {
      ctx.db.run('DELETE FROM suppressions WHERE email = ? AND newsletter_id = ?', email, input.newsletterId)
      ctx.db.run('DELETE FROM deleted_contacts WHERE email_hash = ? AND newsletter_id = ?', hash, input.newsletterId)
    }
    if (!existing) {
      // A new contact with consent is inserted already subscribed: one row with its index entries,
      // instead of an unconfirmed insert followed by a status update that rewrites them.
      const direct = input.consent !== 'pending'
      const detail = { consent: input.consent, at, source: input.source }
      ctx.db.run('INSERT INTO contacts (id, newsletter_id, email, name, source, fields, provider, created_at, updated_at, status, subscribed_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', candidate.id, input.newsletterId, email, candidate.name, input.source, JSON.stringify(fields), candidate.provider, at, ctx.now(), direct ? 'subscribed' : 'unconfirmed', direct ? at : null, direct && input.consent === 'confirmed' ? at : null)
      if (direct) recordStatusChange(ctx, { ...candidate, status: 'subscribed' }, 'subscribed', detail, at)
      else event(ctx, candidate, 'signup', { source: input.source, pending: true }, at)
    } else {
      ctx.db.run('UPDATE contacts SET name = ?, fields = ?, updated_at = ? WHERE id = ? AND newsletter_id = ?', input.name ?? existing.name, JSON.stringify({ ...fieldValuesSchema.parse(JSON.parse(existing.fields)), ...fields }), ctx.now(), existing.id, input.newsletterId)
    }
    if (input.consent !== 'pending' && existing && existing.status !== 'subscribed') setContactStatus(ctx, candidate.id, 'subscribed', { consent: input.consent, at, source: input.source })
    if (input.consent === 'confirmed' && existing?.status === 'subscribed' && !existing.confirmed_at) ctx.db.run('UPDATE contacts SET confirmed_at = ? WHERE id = ? AND newsletter_id = ?', at, candidate.id, input.newsletterId)
    // Last, so a tag listener reads the contact as this call leaves it. New and existing contacts alike.
    addContactTags(ctx, { newsletterId: input.newsletterId, contactId: candidate.id, tagIds: input.tags ?? [], source: input.tagSource ?? 'manual' })
    return result(existing?.status === 'subscribed' ? 'exists' : input.consent === 'pending' ? 'pending' : 'subscribed', !existing)
  })
}
export function deleteContact(ctx: StoreCtx, contactId: string, newsletterId: string): void {
  ctx.db.tx(() => {
    const c = contactRow(ctx, contactId, newsletterId)
    ctx.db.run('INSERT INTO deleted_contacts (email_hash, newsletter_id, deleted_at) VALUES (?, ?, ?) ON CONFLICT(email_hash, newsletter_id) DO UPDATE SET deleted_at = excluded.deleted_at', emailHash(c.email), newsletterId, ctx.now())
    unsubscribe(ctx, { contactId, reason: 'deleted' })
    clearContactTags(ctx, c.id)
    ctx.db.run('DELETE FROM contacts WHERE id = ? AND newsletter_id = ?', c.id, newsletterId)
  })
}
