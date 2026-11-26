import { z } from 'zod'
import type { AccountRegistrar } from '../rpc.ts'
import { AppError, clientAddress, clientIp, errorResponse, validate } from '../../core/http.ts'
import { allowRate } from '../../core/ratelimit.ts'
import { sha256Hex } from '../../core/crypto.ts'
import { newId } from '../../core/ids.ts'
import { subscribe } from '../contacts/index.ts'
import { notifySignupsRefused } from '../notifications/index.ts'
import { parseTheme, escapeHtml, safeUrl } from '../render/index.ts'
import { customFields, getSettings, publicNewsletter, getNewsletter, redirectSchema } from './settings.ts'
import { confirmationSchema, formTokenSchema, formToken } from './tokens.ts'
import { signToken, verifyToken } from '../tracking/index.ts'
import { deliverMail, queueMail, queueWelcome } from './mail.ts'
import { hostedForm, page } from './pages.ts'
import { embedScript } from './embed.ts'

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320), name: z.string().trim().max(200).optional(),
  fields: z.record(z.string(), z.union([z.string().max(10000), z.number().finite(), z.boolean()])).default({}),
  website: z.string().max(1000).default(''), formToken: z.string().max(2000),
  redirectUrl: redirectSchema.optional(), 'cf-turnstile-response': z.string().max(2048).optional(),
})
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' }
export function registerRoutes(reg: AccountRegistrar) {
  reg.routes((app) => {
    app.use('/api/public/subscribe/*', async (c, next) => {
      for (const [k, v] of Object.entries(cors)) c.header(k, v)
      try { await next() } catch (err) {
        const response = errorResponse(err)
        for (const [k, v] of Object.entries(cors)) response.headers.set(k, v)
        return response
      }
      for (const [k, v] of Object.entries(cors)) c.header(k, v)
    })
    app.options('/api/public/subscribe/:newsletterKey', (c) => c.body(null, 204))
    app.get('/api/public/subscribe/:newsletterKey', async (c) => {
      const ctx = c.get('ctx')
      const nl = publicNewsletter(ctx, c.req.param('newsletterKey'))
      return c.json({ name: nl.name, description: nl.description, theme: parseTheme(nl.theme), settings: getSettings(ctx, nl.id), fields: customFields(ctx, nl.id).filter((f) => getSettings(ctx, nl.id).fieldKeys.includes(f.key)),
        formToken: await formToken(ctx, nl.id), siteKey: ctx.config.turnstile?.siteKey ?? '' })
    })
    app.get('/f/:newsletterKey', async (c) => {
      const ctx = c.get('ctx')
      const nl = publicNewsletter(ctx, c.req.param('newsletterKey'))
      c.header('Cache-Control', 'no-store')
      if (ctx.config.turnstile) c.header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
      return c.html(hostedForm({ nl, settings: getSettings(ctx, nl.id), fields: customFields(ctx, nl.id), formToken: await formToken(ctx, nl.id), siteKey: ctx.config.turnstile?.siteKey, base: ctx.config.appUrl }))
    })
    app.get('/embed.js', (c) => {
      publicNewsletter(c.get('ctx'), c.req.query('key') ?? '')
      c.header('Content-Type', 'application/javascript; charset=utf-8')
      c.header('Access-Control-Allow-Origin', '*')
      c.header('Cache-Control', 'public, max-age=300')
      return c.body(embedScript)
    })
    app.post('/api/public/subscribe/:newsletterKey', async (c) => {
      const ctx = c.get('ctx')
      const nl = publicNewsletter(ctx, c.req.param('newsletterKey'))
      const settings = getSettings(ctx, nl.id)
      if (!allowRate(ctx.db, `signup:ip:${await sha256Hex(clientIp(c))}`, 20, 3_600_000, ctx.now(), { durable: true })) throw new AppError('rate_limited', 'Too many signup attempts. Please try again later.', 429)
      if (Number(c.req.header('content-length') ?? 0) > 32_768) throw new AppError('too_large', 'The form is too large.', 413)
      const body = await c.req.text()
      if (body.length > 32_768) throw new AppError('too_large', 'The form is too large.', 413)
      const isJson = (c.req.header('content-type') ?? '').includes('application/json')
      let raw: unknown
      try {
        if (isJson) raw = JSON.parse(body)
        else {
          const params = new URLSearchParams(body)
          const fields: Record<string, string | number | boolean> = {}
          for (const f of customFields(ctx, nl.id)) {
            const value = params.get(`field.${f.key}`)
            if (value !== null && value !== '') fields[f.key] = f.type === 'boolean' ? value === 'true' : f.type === 'number' ? Number(value) : value
          }
          raw = { ...Object.fromEntries(params), fields }
        }
      } catch { throw new AppError('invalid_input', 'Send a valid signup form.', 400) }
      const input = validate(signupSchema, raw)
      const ok = () => {
        if (!isJson) {
          const redirect = input.redirectUrl || settings.redirectUrl
          if (redirect) return c.redirect(safeUrl(redirect), 303)
          return c.html(page(nl, `<p role="status">${escapeHtml(settings.successMessage)}</p>`))
        }
        return c.json({ ok: true, message: settings.successMessage, redirectUrl: input.redirectUrl || settings.redirectUrl || null })
      }
      if (input.website) return ok()
      const started = formTokenSchema.safeParse(await verifyToken(ctx, input.formToken, 'form'))
      if (!started.success || started.data.newsletterId !== nl.id || ctx.now() - started.data.issuedAt < 2000 || ctx.now() - started.data.issuedAt > 3_600_000) throw new AppError('form_expired', 'Please reopen the form and take a moment before submitting.', 400)
      if (!allowRate(ctx.db, `signup:target:${await sha256Hex(input.email)}`, 10, 3_600_000, ctx.now(), { durable: true })) return ok()
      if (ctx.config.turnstile) {
        let verified = false
        try {
          const response = await ctx.platform.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: ctx.config.turnstile.secretKey, response: input['cf-turnstile-response'] ?? '', remoteip: clientAddress(c) }) })
          verified = response.ok && z.object({ success: z.literal(true) }).safeParse(await response.json()).success
        } catch { /* A verification outage must not admit unchecked requests. */ }
        if (!verified) throw new AppError('challenge_failed', 'Please complete the verification and try again.', 400)
      }
      const fields = Object.fromEntries(Object.entries(input.fields).filter(([key]) => settings.fieldKeys.includes(key)))
      const targetHash = await sha256Hex(input.email)
      let mailId = ''
      const result = ctx.db.tx(() => {
        const result = subscribe(ctx, { newsletterId: nl.id, email: input.email, name: settings.showName ? input.name : undefined, fields, source: 'signup', tagSource: 'signup', consent: nl.double_opt_in ? 'pending' : 'confirmed' })
        if (!nl.double_opt_in && result.outcome === 'subscribed') mailId = queueWelcome(ctx, nl.id, result.contact.id, result.contact.subscribedAt)
        if (result.outcome === 'limit') notifySignupsRefused(ctx)
        return result
      })
      if (result.outcome === 'limit') throw new AppError('not_accepting', 'This newsletter is not taking new subscribers right now. Please try again later.', 503)
      if (nl.double_opt_in && !ctx.db.get('SELECT id FROM suppressions WHERE email = ? AND newsletter_id IS NULL', input.email) && ctx.db.get('SELECT id FROM contacts WHERE id = ? AND newsletter_id = ?', result.contact.id, nl.id)) {
        const confirmToken = await signToken(ctx, 'cf', [result.contact.id, ctx.now()])
        ctx.db.tx(() => {
          if (!allowRate(ctx.db, `signup:confirm:${targetHash}`, 3, 86_400_000, ctx.now(), { durable: true })) return
          mailId = newId('sgm')
          queueMail(ctx, { id: mailId, newsletterId: nl.id, contactId: result.contact.id, kind: 'confirm', token: confirmToken })
        })
      }
      if (mailId) { try { await deliverMail(ctx, mailId) } catch { /* The durable job retries safe failures. */ } }
      return ok()
    })
    app.get('/confirm/:token', async (c) => {
      const ctx = c.get('ctx')
      const value = c.req.param('token')
      const parsed = confirmationSchema.safeParse(await verifyToken(ctx, value, 'cf'))
      if (!parsed.success || parsed.data.issuedAt > ctx.now() || ctx.now() - parsed.data.issuedAt > 7 * 86_400_000) throw new AppError('invalid_token', 'That confirmation link is invalid or expired. Please sign up again.', 400)
      const contact = ctx.db.get<{ id: string; newsletter_id: string; email: string; created_at: number }>('SELECT id, newsletter_id, email, created_at FROM contacts WHERE id = ?', parsed.data.contactId)
      if (!contact || contact.created_at > parsed.data.issuedAt) throw new AppError('invalid_token', 'That confirmation link is no longer valid.', 400)
      const nl = getNewsletter(ctx, contact.newsletter_id)
      const request = ctx.db.get<{ consumed_at: number | null }>("SELECT consumed_at FROM signup_mail WHERE newsletter_id = ? AND contact_id = ? AND kind = 'confirm' AND token = ?", nl.id, contact.id, value)
      if (!request) throw new AppError('invalid_token', 'That confirmation link is no longer valid.', 400)
      let mailId = ''
      ctx.db.tx(() => {
        if (request.consumed_at !== null) return
        ctx.db.run("UPDATE signup_mail SET consumed_at = ? WHERE newsletter_id = ? AND contact_id = ? AND kind = 'confirm'", ctx.now(), nl.id, contact.id)
        const result = subscribe(ctx, { newsletterId: nl.id, email: contact.email, source: 'signup', tagSource: 'signup', consent: 'confirmed' })
        if (result.outcome === 'subscribed') mailId = queueWelcome(ctx, nl.id, contact.id, result.contact.subscribedAt)
      })
      if (mailId) { try { await deliverMail(ctx, mailId) } catch { /* The durable job retries safe failures. */ } }
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      return c.html(page(nl, '<p role="status">Thanks for confirming your subscription.</p>'))
    })
  })
}
