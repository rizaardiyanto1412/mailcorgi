import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { defineAction } from '../../core/actions.ts'
import { AppError, notFound } from '../../core/http.ts'
import { withPatch } from '../../core/patch.ts'
import { newId } from '../../core/ids.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { nodeSchema, emptyDoc } from '../render/index.ts'
import { draftFields, senderOverrideInput } from '../campaigns/index.ts'
import { assertSenderOverride, nextSenderOverride } from '../domains/index.ts'
import { hostedForm } from './pages.ts'
import { migrations } from './migrations.ts'
import { getNewsletter, getSettings, settingsSchema, customFields, welcomeCampaign, welcomeEmail, welcomeEnabled } from './settings.ts'
import { welcomeOptions } from '../newsletters/index.ts'
import { deliverMail, queueWelcome } from './mail.ts'
import { isSuppressed, onApiSubscribe } from '../contacts/index.ts'
import { registerRoutes } from './routes.ts'
export { formToken } from './tokens.ts'
export { onPublicSignup } from './mail.ts'

function queueApiWelcome(ctx: StoreCtx, c: { newsletterId: string; contactId: string; subscribedAt: number | null }) {
  const mailId = queueWelcome(ctx, c.newsletterId, c.contactId, c.subscribedAt)
  return () => deliverMail(ctx, mailId)
}

const newsletterId = z.string().min(1).describe('The newsletter id')
const resource = { type: 'newsletter', param: 'newsletterId' } as const
export const signupModule = {
  name: 'signup',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    registerRoutes(reg)
    // contacts.create asserts consent, so its welcome goes out on the subscribed outcome, double opt-in or not (docs/decisions/api-welcome.md).
    onApiSubscribe(queueApiWelcome)
    reg.job<{ mailId: string }>('signup.mail', async (ctx, input, budget) => {
      if (budget.expired() || budget.take(3) < 3) return { again: ctx.now() + 1000 }
      await deliverMail(ctx, input.mailId)
      return 'done'
    })
    return reg.actions(
      defineAction({
        name: 'signup.get', description: 'Read signup form settings, public links and the welcome email.', scope: 'account', role: 'admin', effect: 'read', resource,
        input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/signup' }, mcp: { title: 'Read signup settings', destructive: false },
        handler: (ctx, input) => {
          const nl = getNewsletter(ctx, input.newsletterId)
          const src = `${ctx.config.appUrl}/embed.js?key=${nl.key}`
          return { settings: getSettings(ctx, nl.id), doubleOptIn: !!nl.double_opt_in, welcomeEnabled: welcomeEnabled(nl.welcome), welcome: welcomeEmail(ctx, nl.id), fields: customFields(ctx, nl.id),
            hostedUrl: `${ctx.config.appUrl}/f/${nl.key}`, apiUrl: `${ctx.config.appUrl}/api/public/subscribe/${nl.key}`,
            inlineSnippet: `<script src="${src}" async></script>`, popupSnippet: `<script src="${src}" data-mode="popup" data-label="Subscribe" async></script>` }
        },
      }),
      defineAction({
        name: 'signup.preview', description: 'Preview unsaved form settings with the newsletter theme.', scope: 'account', role: 'admin', effect: 'read', resource,
        input: z.object({ newsletterId, settings: settingsSchema.describe('Form settings to preview; omitted ones show as currently saved') }),
        handler: (ctx, input) => ({ html: hostedForm({ nl: getNewsletter(ctx, input.newsletterId), settings: withPatch(getSettings(ctx, input.newsletterId), input.settings), fields: customFields(ctx, input.newsletterId), formToken: '', base: ctx.config.appUrl }) }),
      }),
      defineAction({
        name: 'signup.update', description: 'Save signup form fields, copy, redirects and opt-in settings.', scope: 'account', role: 'admin', effect: 'write', resource,
        input: z.object({ newsletterId, settings: settingsSchema.describe('Fields, copy, redirect and form layout. Omitted keys keep their saved value.'), doubleOptIn: z.boolean().optional().describe('Require email confirmation before subscribing. Omit to keep the current value.') }),
        rest: { method: 'PUT', path: '/newsletters/:newsletterId/signup' }, mcp: { title: 'Save signup form settings', destructive: false },
        handler: (ctx, input) => ctx.db.tx(() => {
          const nl = getNewsletter(ctx, input.newsletterId)
          const settings = withPatch(getSettings(ctx, input.newsletterId), input.settings)
          const keys = customFields(ctx, input.newsletterId).map((f) => f.key)
          if (input.settings.fieldKeys?.some((key) => !keys.includes(key))) throw new AppError('invalid_input', 'Choose custom fields from this newsletter.', 400)
          const doubleOptIn = input.doubleOptIn ?? !!nl.double_opt_in
          ctx.db.run('INSERT INTO signup_settings (newsletter_id, settings) VALUES (?, ?) ON CONFLICT(newsletter_id) DO UPDATE SET settings = excluded.settings', input.newsletterId, JSON.stringify(settings))
          ctx.db.run('UPDATE newsletters SET double_opt_in = ?, updated_at = ? WHERE id = ?', doubleOptIn ? 1 : 0, ctx.now(), input.newsletterId)
          return { settings, doubleOptIn }
        }),
      }),
      defineAction({
        name: 'signup.saveWelcome', description: 'Save the one welcome campaign for this newsletter and turn it on or off.', scope: 'account', role: 'admin', effect: 'write', resource,
        input: z.object({ newsletterId, enabled: z.boolean().optional().describe('Send this email after a reader subscribes. Omit to keep the current value; a new welcome email starts off.'), subject: z.string().trim().min(1).max(150).optional().describe('Welcome email subject. Required when creating the welcome email (revision null); omit to keep the current subject.'), doc: nodeSchema.refine((n) => n.type === 'doc').optional().describe('Welcome email editor document. Omit to keep the current body; a new welcome email starts with an empty document.'), revision: z.number().int().positive().nullable().describe('Revision last read, or null to create the welcome campaign'), sendFormat: draftFields.sendFormat.optional().describe('How the welcome email is sent: html (themed) or plain (a plain text email that reads like a personally written one). Omit to keep the current value; a new welcome email starts as html.'),
          transactional: z.boolean().optional().describe('Treat the welcome email as a one-off transactional message instead of a newsletter issue: it shows no unsubscribe link. Plain: no closing "--" and "Unsubscribe:" lines. Html: the footer keeps its text, postal address and "View on the web" but loses the Unsubscribe and Preferences links. The List-Unsubscribe headers stay unless includeListUnsubscribeHeaders is false. Omit to keep the current value; a new welcome email starts as false.'),
          includeListUnsubscribeHeaders: z.boolean().optional().describe('Only read when transactional is true: false sends the welcome email without the List-Unsubscribe and List-Unsubscribe-Post headers. While transactional is false this is ignored and the headers are always sent. Omit to keep the current value; a new welcome email starts as true.'),
          ...senderOverrideInput.update }),
        rest: { method: 'PUT', path: '/newsletters/:newsletterId/signup/welcome' }, mcp: { title: 'Save welcome email', destructive: false },
        handler: (ctx, input, actor) => ctx.db.tx(() => {
          const options = welcomeOptions(getNewsletter(ctx, input.newsletterId).welcome)
          const existing = welcomeCampaign(ctx, input.newsletterId)
          if ((existing?.revision ?? null) !== input.revision) throw new AppError('revision_conflict', 'The welcome email changed. Reload it before saving.', 409)
          if (existing && existing.status !== 'draft') throw new AppError('not_editable', 'The welcome email must be a draft.', 409)
          const id = existing?.id ?? newId('cmp')
          // Null clears a field, omitting keeps it. Checked only when the save touches the override.
          const sender = nextSenderOverride(existing ?? {}, input)
          if (input.fromDomainId !== undefined || input.fromLocal !== undefined || input.fromName !== undefined) assertSenderOverride(ctx, input.newsletterId, sender)
          // On an existing welcome email an omitted field keeps its stored value; defaults apply only when it is created.
          const enabled = input.enabled ?? (existing ? options.enabled : false)
          if (existing) ctx.db.run('UPDATE campaigns SET subject = ?, doc = COALESCE(?, doc), format = ?, send_format = ?, from_domain_id = ?, from_local = ?, from_name = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND newsletter_id = ?', input.subject ?? existing.subject, input.doc ? JSON.stringify(input.doc) : null, 'doc', input.sendFormat ?? existing.sendFormat, sender.fromDomainId, sender.fromLocal, sender.fromName, ctx.now(), id, input.newsletterId)
          else {
            if (input.subject === undefined) throw new AppError('invalid_input', 'A subject is required to create the welcome email.', 400)
            ctx.db.run("INSERT INTO campaigns (id, newsletter_id, kind, subject, doc, format, send_format, from_domain_id, from_local, from_name, web_visible, created_by, created_at, updated_at) VALUES (?, ?, 'welcome', ?, ?, 'doc', ?, ?, ?, ?, 0, ?, ?, ?)", id, input.newsletterId, input.subject, JSON.stringify(input.doc ?? emptyDoc), input.sendFormat ?? 'html', sender.fromDomainId, sender.fromLocal, sender.fromName, actor.userId, ctx.now(), ctx.now())
          }
          ctx.db.run('UPDATE newsletters SET welcome = ?, updated_at = ? WHERE id = ?', JSON.stringify({ enabled, transactional: input.transactional ?? options.transactional, includeListUnsubscribeHeaders: input.includeListUnsubscribeHeaders ?? options.includeListUnsubscribeHeaders }), ctx.now(), input.newsletterId)
          return { welcome: welcomeEmail(ctx, input.newsletterId), enabled }
        }),
      }),
      defineAction({
        name: 'signup.sendWelcome', description: 'Send the welcome email once to one subscribed contact who never received it (for example one added earlier with sendWelcome false). It uses the same once-per-subscription key as every other welcome, so a second call sends nothing and returns alreadyQueued true. It never targets more than the given contact.', scope: 'account', role: 'admin', effect: 'write', resource,
        input: z.object({ newsletterId, contactId: z.string().min(1).describe('The one contact to send the welcome email to. Must be subscribed to this newsletter.') }),
        rest: { method: 'POST', path: '/newsletters/:newsletterId/signup/welcome/send' }, mcp: { title: 'Send the welcome email to one contact, once', destructive: false },
        handler: async (ctx, input) => {
          const nl = getNewsletter(ctx, input.newsletterId)
          const contact = ctx.db.get<{ id: string; email: string; status: string; subscribed_at: number | null }>('SELECT id, email, status, subscribed_at FROM contacts WHERE id = ? AND newsletter_id = ?', input.contactId, nl.id)
          if (!contact) throw notFound('That contact')
          if (contact.status !== 'subscribed') throw new AppError('not_subscribed', 'Only a subscribed contact can receive the welcome email.', 409)
          if (isSuppressed(ctx, contact.email, nl.id) || ctx.db.get('SELECT id FROM suppressions WHERE email = ? AND newsletter_id IS NULL', contact.email)) throw new AppError('suppressed', 'This address is suppressed.', 409)
          if (!welcomeEnabled(nl.welcome) || !welcomeCampaign(ctx, nl.id)) throw new AppError('welcome_disabled', 'Turn on and save the welcome email first.', 409)
          const mailId = `welcome:${contact.id}:${contact.subscribed_at}`
          const stateOf = () => ctx.db.get<{ state: string }>('SELECT state FROM signup_mail WHERE id = ?', mailId)?.state ?? null
          if (stateOf()) return { sent: false, alreadyQueued: true, mailId, state: stateOf() }
          ctx.db.tx(() => queueWelcome(ctx, nl.id, contact.id, contact.subscribed_at))
          try { await deliverMail(ctx, mailId) } catch { /* The durable signup.mail job retries safe failures. */ }
          return { sent: stateOf() === 'sent', alreadyQueued: false, mailId, state: stateOf() }
        },
      }),
    )
  },
}
