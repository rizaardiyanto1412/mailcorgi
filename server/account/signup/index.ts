import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { AppError } from '../../core/http.ts'
import { newId } from '../../core/ids.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { nodeSchema, emptyDoc } from '../render/index.ts'
import { hostedForm } from './pages.ts'
import { migrations } from './migrations.ts'
import { getNewsletter, getSettings, settingsSchema, customFields, welcomeCampaign, welcomeEnabled } from './settings.ts'
import { deliverMail } from './mail.ts'
import { registerRoutes } from './routes.ts'
export { formToken } from './tokens.ts'

const newsletterId = z.string().min(1).describe('The newsletter id')
const resource = { type: 'newsletter', param: 'newsletterId' } as const
export const signupModule = {
  name: 'signup',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    registerRoutes(reg)
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
          return { settings: getSettings(ctx, nl.id), doubleOptIn: !!nl.double_opt_in, welcomeEnabled: welcomeEnabled(nl.welcome), welcome: welcomeCampaign(ctx, nl.id), fields: customFields(ctx, nl.id),
            hostedUrl: `${ctx.config.appUrl}/f/${nl.key}`, apiUrl: `${ctx.config.appUrl}/api/public/subscribe/${nl.key}`,
            inlineSnippet: `<script src="${src}" async></script>`, popupSnippet: `<script src="${src}" data-mode="popup" data-label="Subscribe" async></script>` }
        },
      }),
      defineAction({
        name: 'signup.preview', description: 'Preview unsaved form settings with the newsletter theme.', scope: 'account', role: 'admin', effect: 'read', resource,
        input: z.object({ newsletterId, settings: settingsSchema.describe('Form settings to preview') }),
        handler: (ctx, input) => ({ html: hostedForm({ nl: getNewsletter(ctx, input.newsletterId), settings: input.settings, fields: customFields(ctx, input.newsletterId), formToken: '', base: ctx.config.appUrl }) }),
      }),
      defineAction({
        name: 'signup.update', description: 'Save signup form fields, copy, redirects and opt-in settings.', scope: 'account', role: 'admin', effect: 'write', resource,
        input: z.object({ newsletterId, settings: settingsSchema.describe('Fields, copy, redirect and form layout'), doubleOptIn: z.boolean().describe('Require email confirmation before subscribing') }),
        rest: { method: 'PUT', path: '/newsletters/:newsletterId/signup' }, mcp: { title: 'Save signup form settings', destructive: false },
        handler: (ctx, input) => ctx.db.tx(() => {
          getNewsletter(ctx, input.newsletterId)
          const keys = customFields(ctx, input.newsletterId).map((f) => f.key)
          if (input.settings.fieldKeys.some((key) => !keys.includes(key))) throw new AppError('invalid_input', 'Choose custom fields from this newsletter.', 400)
          ctx.db.run('INSERT INTO signup_settings (newsletter_id, settings) VALUES (?, ?) ON CONFLICT(newsletter_id) DO UPDATE SET settings = excluded.settings', input.newsletterId, JSON.stringify(input.settings))
          ctx.db.run('UPDATE newsletters SET double_opt_in = ?, updated_at = ? WHERE id = ?', input.doubleOptIn ? 1 : 0, ctx.now(), input.newsletterId)
          return { settings: input.settings, doubleOptIn: input.doubleOptIn }
        }),
      }),
      defineAction({
        name: 'signup.saveWelcome', description: 'Save the one welcome campaign for this newsletter and turn it on or off.', scope: 'account', role: 'admin', effect: 'write', resource,
        input: z.object({ newsletterId, enabled: z.boolean().describe('Send this email after a reader subscribes'), subject: z.string().trim().min(1).max(150).describe('Welcome email subject'), doc: nodeSchema.refine((n) => n.type === 'doc').default(emptyDoc).describe('Welcome email editor document'), revision: z.number().int().positive().nullable().describe('Revision last read, or null to create the welcome campaign') }),
        rest: { method: 'PUT', path: '/newsletters/:newsletterId/signup/welcome' }, mcp: { title: 'Save welcome email', destructive: false },
        handler: (ctx, input, actor) => ctx.db.tx(() => {
          getNewsletter(ctx, input.newsletterId)
          const existing = welcomeCampaign(ctx, input.newsletterId)
          if ((existing?.revision ?? null) !== input.revision) throw new AppError('revision_conflict', 'The welcome email changed. Reload it before saving.', 409)
          if (existing && existing.status !== 'draft') throw new AppError('not_editable', 'The welcome email must be a draft.', 409)
          const id = existing?.id ?? newId('cmp')
          if (existing) ctx.db.run('UPDATE campaigns SET subject = ?, doc = ?, format = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND newsletter_id = ?', input.subject, JSON.stringify(input.doc), 'doc', ctx.now(), id, input.newsletterId)
          else ctx.db.run("INSERT INTO campaigns (id, newsletter_id, kind, subject, doc, format, web_visible, created_by, created_at, updated_at) VALUES (?, ?, 'welcome', ?, ?, 'doc', 0, ?, ?, ?)", id, input.newsletterId, input.subject, JSON.stringify(input.doc), actor.userId, ctx.now(), ctx.now())
          ctx.db.run('UPDATE newsletters SET welcome = ?, updated_at = ? WHERE id = ?', JSON.stringify({ enabled: input.enabled }), ctx.now(), input.newsletterId)
          return { welcome: welcomeCampaign(ctx, input.newsletterId), enabled: input.enabled }
        }),
      }),
    )
  },
}
