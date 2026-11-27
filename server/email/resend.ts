import { z } from 'zod'
import type { StoreCtx } from '../core/store.ts'
import type { EmailProvider, Identity } from './index.ts'
import { messageHeaders, safeHeader } from './mime.ts'
import { identityError, sendError, noRedirect, isRedirect, redirectedSend, failedSend, unparsedSend, logSendFailure, parseJson } from './http.ts'
import { parseResendWebhook } from './resend-webhook.ts'

const domainSchema = z.object({ id: z.string(), name: z.string(), status: z.string(), records: z.array(z.object({ name: z.string(), type: z.string(), value: z.string(), record: z.string().optional(), priority: z.number().optional() })).default([]) })

export function resendProvider(ctx: StoreCtx, settings: Record<string, string>): EmailProvider {
  const request = (path: string, method: string, body?: unknown, idempotencyKey?: string) => ctx.platform.fetch(`https://api.resend.com/${path}`, { method, headers: { authorization: `Bearer ${settings.resend_api_key || ''}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': safeHeader(idempotencyKey) } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), ...noRedirect, signal: AbortSignal.timeout(30_000) })
  async function readDomain(response: Response): Promise<Identity> {
    if (!response.ok) return identityError()
    const data = domainSchema.parse(await response.json())
    return { domain: data.name, status: data.status === 'verified' ? 'verified' : data.status === 'failed' ? 'failed' : 'pending', raw: { id: data.id }, records: data.records.map((r) => ({ name: r.name.endsWith(data.name) ? r.name : `${r.name}.${data.name}`, type: r.type, value: r.priority !== undefined ? `${r.priority} ${r.value}` : r.value, purpose: r.record || (r.type === 'MX' ? 'MAIL FROM' : 'DKIM') })) }
  }
  async function domainId(domain: string) {
    if (settings.resend_identity_domain === domain && settings.resend_identity_id) return settings.resend_identity_id
    let after = ''
    for (let page = 0; page < 100; page++) {
      const response = await request(`domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`, 'GET')
      if (!response.ok) return identityError()
      const data = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })), has_more: z.boolean().default(false) }).parse(await response.json())
      const found = data.data.find((d) => d.name === domain)
      if (found) return found.id
      const last = data.data.at(-1)
      if (!data.has_more || !last) return identityError()
      after = last.id
    }
    return identityError()
  }
  return {
    name: 'resend', capabilities: { identities: true, events: true, idempotency: true },
    async send(msg) {
      try {
        const response = await request('emails', 'POST', { from: safeHeader(msg.from), to: [safeHeader(msg.to)], ...(msg.replyTo ? { reply_to: safeHeader(msg.replyTo) } : {}), subject: safeHeader(msg.subject), ...(msg.textOnly ? {} : { html: msg.html }), text: msg.text, headers: messageHeaders(msg), tags: [{ name: 'mc_account', value: msg.meta.accountId }, ...(msg.meta.deliveryId ? [{ name: 'mc_delivery', value: msg.meta.deliveryId }] : [])] }, msg.idempotencyKey)
        if (isRedirect(response)) return redirectedSend('resend', response.status)
        const text = await response.text()
        if (!response.ok) {
          logSendFailure('resend', 'status', { status: response.status, body: text, redact: [settings.resend_api_key], safe: msg.safeDiagnostics })
          return sendError(response.status, response.headers.get('retry-after'))
        }
        const data = z.object({ id: z.string().min(1) }).safeParse(parseJson(text))
        return data.success ? { ok: true, id: data.data.id } : unparsedSend('resend', response.status)
      } catch (error) { return failedSend('resend', error, [settings.resend_api_key], msg.safeDiagnostics) }
    },
    async createIdentity(domain) {
      try { return await readDomain(await request('domains', 'POST', { name: domain, region: settings.resend_region || 'us-east-1' })) } catch { return identityError() }
    },
    async getIdentity(domain) {
      try { return await readDomain(await request(`domains/${encodeURIComponent(await domainId(domain))}`, 'GET')) } catch { return identityError() }
    },
    async deleteIdentity(domain) {
      try {
        const response = await request(`domains/${encodeURIComponent(await domainId(domain))}`, 'DELETE')
        if (!response.ok && response.status !== 404) identityError()
      } catch { identityError() }
    },
    parseWebhook: (request, config) => parseResendWebhook(ctx, request, config),
  }
}
