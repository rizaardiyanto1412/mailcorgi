import type { StoreCtx } from '../../core/store.ts'
import { AppError } from '../../core/http.ts'
import type { AccountRegistrar } from '../rpc.ts'

export type ContactStatus = 'unconfirmed' | 'subscribed' | 'unsubscribed' | 'bounced' | 'complained' | 'cleaned'

export interface Contact {
  id: string
  newsletterId: string
  email: string
  name: string
  status: ContactStatus
  source: string
  fields: Record<string, unknown>
  subscribedAt: number | null
  confirmedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface SubscribeInput {
  newsletterId: string
  email: string
  name?: string
  fields?: Record<string, unknown>
  tags?: string[]
  source: string
  consent: 'asserted' | 'confirmed' | 'pending'
  at?: number
}
export type SubscribeOutcome = 'subscribed' | 'pending' | 'suppressed' | 'limit' | 'exists'

const notBuilt = () => new AppError('not_built', 'Contacts are not built yet.', 501)

/** The only writers of subscription state. Built by the contacts unit. */
export function subscribe(_ctx: StoreCtx, _input: SubscribeInput): { contact: Contact; created: boolean; outcome: SubscribeOutcome } {
  throw notBuilt()
}
export function unsubscribe(_ctx: StoreCtx, _input: { contactId: string; reason?: string; campaignId?: string }): void {
  throw notBuilt()
}
export function suppress(_ctx: StoreCtx, _input: { email: string; newsletterId: string | null; reason: string }): void {
  throw notBuilt()
}
export function isSuppressed(_ctx: StoreCtx, _email: string, _newsletterId: string): boolean {
  throw notBuilt()
}
export function setContactStatus(_ctx: StoreCtx, _contactId: string, _status: ContactStatus, _detail?: Record<string, unknown>): void {
  throw notBuilt()
}

export const contactsModule = {
  name: 'contacts',
  register(reg: AccountRegistrar) {
    reg.resolver('contact', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM contacts WHERE id = ?', id)?.newsletter_id ?? null)
    reg.resolver('tag', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM tags WHERE id = ?', id)?.newsletter_id ?? null)
  },
}
