import { AwsClient } from 'aws4fetch'
import { z } from 'zod'
import type { StoreCtx } from '../core/store.ts'
import { toBase64 } from '../core/crypto.ts'
import type { EmailProvider, Identity } from './index.ts'
import { buildMime, InvalidMessageError } from './mime.ts'
import { identityError, sendError, unknownSend, invalidSend } from './http.ts'
import { parseSesWebhook } from './ses-webhook.ts'

const identitySchema = z.object({ VerifiedForSendingStatus: z.boolean().optional(), DkimAttributes: z.object({ Status: z.string().optional(), Tokens: z.array(z.string()).optional() }).optional() })

export function sesProvider(ctx: StoreCtx, settings: Record<string, string>): EmailProvider {
  const region = settings.ses_region || 'us-east-1'
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new Error('Invalid SES region.')
  const host = `email.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`
  const client = new AwsClient({ accessKeyId: settings.ses_access_key_id || '', secretAccessKey: settings.ses_secret_access_key || '', region, service: 'ses' })
  async function request(path: string, method: string, body?: unknown) {
    const signed = await client.sign(`https://${host}/v2/email/${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return ctx.platform.fetch(signed, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  }
  function identity(domain: string, data: z.infer<typeof identitySchema>): Identity {
    const records: Identity['records'] = (data.DkimAttributes?.Tokens ?? []).map((token) => ({ name: `${token}._domainkey.${domain}`, type: 'CNAME', value: `${token}.dkim.amazonses.com`, purpose: 'DKIM' }))
    records.push({ name: `mail.${domain}`, type: 'MX', value: `10 feedback-smtp.${region}.amazonses.com`, purpose: 'MAIL FROM' }, { name: `mail.${domain}`, type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', purpose: 'SPF' })
    return { domain, status: data.VerifiedForSendingStatus ? 'verified' : 'pending', records }
  }
  async function getIdentity(domain: string) {
    try {
      const response = await request(`identities/${encodeURIComponent(domain)}`, 'GET')
      if (!response.ok) return identityError()
      return identity(domain, identitySchema.parse(await response.json()))
    } catch { return identityError() }
  }
  return {
    name: 'ses', capabilities: { identities: true, events: true, idempotency: false },
    async send(msg) {
      try {
        const response = await request('outbound-emails', 'POST', {
          FromEmailAddress: msg.from, Destination: { ToAddresses: [msg.to] },
          Content: { Raw: { Data: toBase64(new TextEncoder().encode(buildMime(msg))) } },
          EmailTags: [{ Name: 'mc_account', Value: msg.meta.accountId }, ...(msg.meta.deliveryId ? [{ Name: 'mc_delivery', Value: msg.meta.deliveryId }] : [])],
          ...(settings.ses_configuration_set ? { ConfigurationSetName: settings.ses_configuration_set } : {}),
        })
        if (!response.ok) return sendError(response.status, response.headers.get('retry-after'), response.headers.get('x-amzn-errortype') || '')
        const parsed = z.object({ MessageId: z.string().min(1) }).safeParse(await response.json())
        return parsed.success ? { ok: true, id: parsed.data.MessageId } : unknownSend()
      } catch (error) { return error instanceof InvalidMessageError ? invalidSend() : unknownSend() }
    },
    async createIdentity(domain) {
      try {
        const response = await request('identities', 'POST', { EmailIdentity: domain, DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' } })
        if (!response.ok && response.status !== 409) return identityError()
        const mailFrom = await request(`identities/${encodeURIComponent(domain)}/mail-from`, 'PUT', { MailFromDomain: `mail.${domain}`, BehaviorOnMxFailure: 'REJECT_MESSAGE' })
        if (!mailFrom.ok) return identityError()
        return getIdentity(domain)
      } catch { return identityError() }
    },
    getIdentity,
    async deleteIdentity(domain) {
      try {
        const response = await request(`identities/${encodeURIComponent(domain)}`, 'DELETE')
        if (!response.ok && response.status !== 404) identityError()
      } catch { identityError() }
    },
    parseWebhook: (request, config) => parseSesWebhook(ctx, request, config),
  }
}
