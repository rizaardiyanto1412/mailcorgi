import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { hmac, toHex } from '../../core/crypto.ts'
import { providerSettings, providerFromSettings } from '../../email/index.ts'
import { renderEmail, parseTheme, type RenderCampaign } from '../render/index.ts'
import { getPolicy } from '../usage/index.ts'
import { isSuppressed } from '../contacts/index.ts'
import { getNewsletter, welcomeCampaign, welcomeEnabled } from './settings.ts'
import { transactionalWelcome } from '../newsletters/index.ts'
import { signToken } from '../tracking/index.ts'
import { hasSenderOverride, verifiedSenderFor } from '../domains/index.ts'

interface MailRow {
  id: string
  newsletter_id: string
  contact_id: string
  kind: 'confirm' | 'welcome'
  token: string
  message: string | null
  provider: string | null
  state: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown'
  attempt_at: number | null
  created_at: number
  consumed_at: number | null
}
const messageSchema = z.object({
  from: z.string(), to: z.string(), replyTo: z.string().optional(), subject: z.string(), html: z.string(), text: z.string(), textOnly: z.boolean().optional(),
  headers: z.record(z.string(), z.string()), meta: z.object({ accountId: z.string(), deliveryId: z.null(), kind: z.literal('system') }), idempotencyKey: z.string(),
})
export function queueMail(ctx: StoreCtx, input: { id: string; newsletterId: string; contactId: string } & ({ kind: 'confirm'; token: string } | { kind: 'welcome' })) {
  const inserted = ctx.db.run('INSERT OR IGNORE INTO signup_mail (id, newsletter_id, contact_id, kind, token, created_at) VALUES (?, ?, ?, ?, ?, ?)', input.id, input.newsletterId, input.contactId, input.kind, input.kind === 'confirm' ? input.token : '', ctx.now()).changes
  if (inserted) ctx.jobs.enqueue('signup.mail', { mailId: input.id }, { dedupeKey: `signup:${input.id}` })
}
/** A reader subscribed through the public form (single opt-in on submit, double opt-in on confirm). Called where the welcome email is queued, in the same transaction. */
export type PublicSignupListener = (ctx: StoreCtx, newsletterId: string, contactId: string) => void
const signupListeners = new Set<PublicSignupListener>()
/** Hear about public signups. Other modules register here so signup never imports them. Returns a function that removes the listener. */
export function onPublicSignup(listener: PublicSignupListener): () => void {
  signupListeners.add(listener)
  return () => void signupListeners.delete(listener)
}
export function publicSignup(ctx: StoreCtx, newsletterId: string, contactId: string) {
  for (const listener of signupListeners) listener(ctx, newsletterId, contactId)
}
export function queueWelcome(ctx: StoreCtx, newsletterId: string, contactId: string, subscribedAt: number | null) {
  const id = `welcome:${contactId}:${subscribedAt}`
  if (welcomeEnabled(getNewsletter(ctx, newsletterId).welcome)) queueMail(ctx, { id, newsletterId, contactId, kind: 'welcome' })
  return id
}
export async function deliverMail(ctx: StoreCtx, mailId: string): Promise<void> {
  let row = ctx.db.get<MailRow>('SELECT * FROM signup_mail WHERE id = ?', mailId)
  if (!row || ['sent', 'failed', 'unknown'].includes(row.state)) return
  if (row.state === 'sending' && (row.attempt_at ?? 0) + 600_000 > ctx.now()) throw new Error('Signup email is already being sent.')
  const nl = getNewsletter(ctx, row.newsletter_id)
  const contact = ctx.db.get<{ id: string; name: string; email: string; fields: string; status: string; created_at: number }>('SELECT id, name, email, fields, status, created_at FROM contacts WHERE id = ? AND newsletter_id = ?', row.contact_id, nl.id)
  const stop = () => { ctx.db.run("UPDATE signup_mail SET state = 'failed' WHERE id = ? AND newsletter_id = ?", mailId, nl.id) }
  if (row.kind === 'confirm' && (row.consumed_at !== null || ctx.now() - row.created_at > 7 * 86_400_000)) return stop()
  if (!contact || contact.created_at > row.created_at || (row.kind === 'welcome' && (contact.status !== 'subscribed' || isSuppressed(ctx, contact.email, nl.id) || !welcomeEnabled(nl.welcome)))) return stop()
  if (ctx.db.get('SELECT id FROM suppressions WHERE email = ? AND newsletter_id IS NULL', contact.email)) return stop()
  const emailHash = toHex(await hmac(ctx.keys.suppression, contact.email))
  if ((await ctx.stores.control.checkSuppressed({ emailHashes: [emailHash] })).suppressed.length) return stop()
  const settings = await providerSettings(ctx)
  if (settings.sending_enabled === 'false' || getPolicy(ctx).status !== 'active') throw new Error('Signup email sending is paused.')
  const provider = await providerFromSettings(ctx, settings)
  row = ctx.db.get<MailRow>('SELECT * FROM signup_mail WHERE id = ?', mailId)
  if (!row || ['sent', 'failed', 'unknown'].includes(row.state)) return
  if ((row.provider && row.provider !== provider.name) || (row.state === 'sending' && !provider.capabilities.idempotency)) {
    ctx.db.run("UPDATE signup_mail SET state = 'unknown' WHERE id = ? AND newsletter_id = ?", mailId, nl.id)
    return
  }
  if (row.state === 'sending' && (row.attempt_at ?? 0) + 600_000 > ctx.now()) throw new Error('Signup email is already being sent.')
  const base = ctx.config.appUrl
  const links = {
    unsubscribe: `${base}/u/${await signToken(ctx, 'u', [contact.id, 0])}`,
    preferences: `${base}/u/${await signToken(ctx, 'p', [contact.id])}`,
    web: `${base}/f/${nl.key}`,
  }
  let campaign: RenderCampaign
  let welcome: ReturnType<typeof welcomeCampaign> = null
  if (row.kind === 'confirm') {
    campaign = { subject: `Confirm your subscription to ${nl.name}`, format: 'doc', doc: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: `Please confirm that you want to receive ${nl.name}. This link expires in 7 days. If you did not request this, ignore this email.` }] },
      { type: 'button', attrs: { label: 'Confirm subscription', href: `${base}/confirm/${row.token}`, align: 'left' } },
    ] } }
  } else {
    welcome = welcomeCampaign(ctx, nl.id)
    if (!welcome) return stop()
    campaign = welcome
  }
  // The confirmation email is never transactional here: it keeps its unsubscribe link and headers.
  const rendered = renderEmail({ campaign, newsletter: nl, theme: parseTheme(nl.theme), recipient: { contact, links }, transactional: transactionalWelcome(row.kind, nl) })
  const current = ctx.db.get<{ status: string; subscribed_at: number | null }>('SELECT status, subscribed_at FROM contacts WHERE id = ? AND newsletter_id = ?', contact.id, nl.id)
  if (!current || ctx.db.get('SELECT id FROM suppressions WHERE email = ? AND newsletter_id IS NULL', contact.email)) return stop()
  if (row.kind === 'welcome' && (current.status !== 'subscribed' || isSuppressed(ctx, contact.email, nl.id) || (current.subscribed_at ?? 0) > row.created_at || !welcomeEnabled(getNewsletter(ctx, nl.id).welcome))) return stop()
  if (getPolicy(ctx).status !== 'active') throw new Error('Signup email sending is paused.')
  // The welcome email can carry a sender override (signup.saveWelcome). With one, it goes out from the effective sender, looked up now
  // and refused when that is not verified; without one, the install's system address as before. The confirmation email never has one.
  const override = welcome && hasSenderOverride(welcome) ? welcome : null
  const sender = override ? verifiedSenderFor(ctx, nl.id, override) : null
  if (override && !sender) return stop()
  const fromAddress = settings.email_from || `mailcorgi@${new URL(base).hostname}`
  const message = row.message ? messageSchema.parse(JSON.parse(row.message)) : messageSchema.parse({
    from: sender?.from ?? `${nl.from_name.replace(/[<>"\r\n]/g, '') || 'MailCorgi'} <${fromAddress}>`, to: contact.email, replyTo: sender ? sender.replyTo : nl.reply_to || undefined, ...rendered,
    headers: { ...rendered.headers, 'X-MC-Account': ctx.accountId!, 'Auto-Submitted': 'auto-generated' },
    meta: { accountId: ctx.accountId!, deliveryId: null, kind: 'system' }, idempotencyKey: mailId,
  })
  // Claim and snapshot after awaited preparation: retries must send identical content with the same key.
  const claimed = ctx.db.run("UPDATE signup_mail SET state = 'sending', attempt_at = ?, message = COALESCE(message, ?), provider = ? WHERE id = ? AND newsletter_id = ? AND consumed_at IS NULL AND (state = 'pending' OR (state = 'sending' AND attempt_at <= ?))", ctx.now(), JSON.stringify(message), provider.name, mailId, nl.id, ctx.now() - 600_000).changes
  if (!claimed) return
  let result
  try {
    result = await provider.send(message)
  } catch {
    ctx.db.run('UPDATE signup_mail SET state = ? WHERE id = ? AND newsletter_id = ?', provider.capabilities.idempotency ? 'pending' : 'unknown', mailId, nl.id)
    throw new Error('The signup email outcome is unknown.')
  }
  const retry = !result.ok && (result.kind === 'temporary' || result.kind === 'throttled' || (result.kind === 'unknown' && provider.capabilities.idempotency))
  ctx.db.run('UPDATE signup_mail SET state = ? WHERE id = ? AND newsletter_id = ?', result.ok ? 'sent' : retry ? 'pending' : result.kind === 'unknown' ? 'unknown' : 'failed', mailId, nl.id)
  if (retry) throw new Error('The signup email provider asked us to retry.')
}
