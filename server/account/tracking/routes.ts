import type { Hono } from 'hono'
import type { StoreCtx } from '../../core/store.ts'
import type { StoreEnv } from '../../core/http.ts'
import { clientIp, jsonNotFound } from '../../core/http.ts'
import { allowRate } from '../../core/ratelimit.ts'
import { safeUrl } from '../render/index.ts'
import { unsubscribe } from '../contacts/index.ts'
import { bumpStat } from '../sending/index.ts'
import { deliveryById, recordClick, recordOpen } from './events.ts'
import { themedPage } from './pages.ts'
import { verifyToken } from './tokens.ts'

const PIXEL = Uint8Array.from([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59])
/** Link scanners and security proxies that fetch every pixel and link before a person sees the email. */
const SCANNER_UA = /\b(bot|crawler|spider|scanner|preview|fetch|curl|wget|python-requests|go-http-client|java\/|okhttp|headlesschrome|phantomjs|barracuda|proofpoint|mimecast|messagelabs|symantec|trendmicro|forcepoint|urldefense|safelinks|outlook-ios|yahoo\/ymail-|office 365)\b/i
const OPEN_GRACE_MS = 2_000
const CLICK_GRACE_MS = 3_000

const isScanner = (userAgent: string) => SCANNER_UA.test(userAgent) || !userAgent
const noStore = { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' }

interface ContactPage {
  id: string
  email: string
  status: string
  newsletter_id: string
  name: string
  theme: string
}
const contactForPage = (ctx: StoreCtx, contactId: string) => ctx.db.get<ContactPage>('SELECT c.id, c.email, c.status, c.newsletter_id, n.name, n.theme FROM contacts c JOIN newsletters n ON n.id = c.newsletter_id WHERE c.id = ?', contactId)

async function pageToken(ctx: StoreCtx, token: string): Promise<{ purpose: 'u' | 'p'; contactId: string; campaignId: string | null } | null> {
  const u = await verifyToken(ctx, token, 'u')
  if (u) return { purpose: 'u', contactId: u[0], campaignId: u[1] && u[1] !== '0' ? u[1] : null }
  const p = await verifyToken(ctx, token, 'p')
  return p ? { purpose: 'p', contactId: p[0], campaignId: null } : null
}

function doUnsubscribe(ctx: StoreCtx, contact: ContactPage, campaignId: string | null) {
  ctx.db.tx(() => {
    const was = contact.status
    unsubscribe(ctx, { contactId: contact.id, reason: 'link', campaignId: campaignId ?? undefined })
    if (!campaignId || was !== 'subscribed') return
    const d = ctx.db.get<{ id: number; unsubscribed_at: number | null }>('SELECT id, unsubscribed_at FROM deliveries WHERE campaign_id = ? AND contact_id = ?', campaignId, contact.id)
    if (d && !d.unsubscribed_at) {
      ctx.db.run('UPDATE deliveries SET unsubscribed_at = ? WHERE id = ?', ctx.now(), d.id)
      bumpStat(ctx, campaignId, 'unsubscribes')
    }
  })
}

export function mountTrackingRoutes(app: Hono<StoreEnv>) {
  app.get('/t/o/:token', async (c) => {
    const ctx = c.get('ctx')
    const parts = await verifyToken(ctx, c.req.param('token'), 'o')
    const pixel = () => c.body(PIXEL, 200, { 'Content-Type': 'image/gif', ...noStore })
    if (!parts || !/^\d+$/.test(parts[0])) return pixel()
    const d = deliveryById(ctx, Number(parts[0]))
    const now = ctx.now()
    if (!d || !['sent', 'delivered', 'complained'].includes(d.status) || isScanner(c.req.header('user-agent') ?? '') || (d.sent_at !== null && now - d.sent_at < OPEN_GRACE_MS)) return pixel()
    recordOpen(ctx, d, now)
    return pixel()
  })

  app.get('/t/c/:token', async (c) => {
    const ctx = c.get('ctx')
    const parts = await verifyToken(ctx, c.req.param('token'), 'c')
    if (!parts || parts.length !== 2 || !/^\d+$/.test(parts[0])) return jsonNotFound(c)
    const d = deliveryById(ctx, Number(parts[0]))
    if (!d) return jsonNotFound(c)
    const link = ctx.db.get<{ id: string; url: string }>('SELECT id, url FROM links WHERE id = ? AND campaign_id = ?', parts[1], d.campaign_id)
    const url = link && safeUrl(link.url)
    if (!link || !url) return jsonNotFound(c)
    const now = ctx.now()
    if (['sent', 'delivered', 'complained'].includes(d.status) && !isScanner(c.req.header('user-agent') ?? '') && !(d.sent_at !== null && now - d.sent_at < CLICK_GRACE_MS)) recordClick(ctx, d, link, now)
    return c.redirect(url, 302)
  })

  app.get('/u/:token', async (c) => {
    const ctx = c.get('ctx')
    const token = await pageToken(ctx, c.req.param('token'))
    const contact = token && contactForPage(ctx, token.contactId)
    if (!token || !contact) return jsonNotFound(c)
    const action = `/u/${c.req.param('token')}`
    const subscribed = contact.status === 'subscribed' || contact.status === 'unconfirmed'
    if (token.purpose === 'u') return c.html(themedPage({ newsletter: contact, title: subscribed ? 'Unsubscribe?' : 'You are unsubscribed', lines: subscribed ? [`Stop receiving ${contact.name} at ${contact.email}.`] : [`${contact.email} no longer receives ${contact.name}.`], form: subscribed ? { action, button: 'Unsubscribe' } : undefined }), 200, noStore)
    return c.html(themedPage({ newsletter: contact, title: 'Your preferences', lines: [`Email: ${contact.email}`, subscribed ? `You are subscribed to ${contact.name}.` : `You are not subscribed to ${contact.name}.`], form: subscribed ? { action, button: 'Unsubscribe' } : undefined }), 200, noStore)
  })

  /** RFC 8058 one-click (`List-Unsubscribe=One-Click`) and the confirm page's form both land here; no session needed. */
  app.post('/u/:token', async (c) => {
    const ctx = c.get('ctx')
    if (!allowRate(ctx.db, `unsub:${clientIp(c) || 'none'}`, 60, 60_000, ctx.now())) return c.text('Too many requests.', 429)
    const token = await pageToken(ctx, c.req.param('token'))
    const contact = token && contactForPage(ctx, token.contactId)
    if (!token || !contact) return jsonNotFound(c)
    doUnsubscribe(ctx, contact, token.campaignId)
    const oneClick = (c.req.header('content-type') ?? '').includes('application/x-www-form-urlencoded') && /(^|&)List-Unsubscribe=One-Click(&|$)/.test(await c.req.text())
    if (oneClick) return c.text('Unsubscribed.', 200, noStore)
    return c.html(themedPage({ newsletter: contact, title: 'You are unsubscribed', lines: [`${contact.email} no longer receives ${contact.name}.`] }), 200, noStore)
  })

  app.get('/keep/:token', async (c) => {
    const ctx = c.get('ctx')
    const parts = await verifyToken(ctx, c.req.param('token'), 'k')
    const contact = parts && contactForPage(ctx, parts[0])
    if (!parts || !contact || ctx.now() - Number(parts[1] ?? 0) > 30 * 86_400_000) return jsonNotFound(c)
    const subscribed = contact.status === 'subscribed'
    return c.html(themedPage({ newsletter: contact, title: subscribed ? 'Still want these emails?' : 'This link has expired', lines: subscribed ? [`Confirm that ${contact.email} should keep receiving ${contact.name}.`] : [`${contact.email} is not subscribed to ${contact.name}.`], form: subscribed ? { action: `/keep/${c.req.param('token')}`, button: 'Keep me subscribed' } : undefined }), 200, noStore)
  })

  app.post('/keep/:token', async (c) => {
    const ctx = c.get('ctx')
    const parts = await verifyToken(ctx, c.req.param('token'), 'k')
    const contact = parts && contactForPage(ctx, parts[0])
    if (!parts || !contact || ctx.now() - Number(parts[1] ?? 0) > 30 * 86_400_000) return jsonNotFound(c)
    if (contact.status === 'subscribed') ctx.db.tx(() => {
      ctx.db.run('UPDATE contacts SET ignored_streak = 0, keep_asked_at = NULL, updated_at = ? WHERE id = ?', ctx.now(), contact.id)
      ctx.db.run('INSERT INTO events (type, newsletter_id, contact_id, at) VALUES (?, ?, ?, ?)', 'keep', contact.newsletter_id, contact.id, ctx.now())
    })
    return c.html(themedPage({ newsletter: contact, title: 'Thanks for staying', lines: [`${contact.email} keeps receiving ${contact.name}.`] }), 200, noStore)
  })
}
