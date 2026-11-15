import { z } from 'zod'
import type { Platform } from '../core/platform.ts'
import { AppError } from '../core/http.ts'
import { fromBase64, sha256Hex } from '../core/crypto.ts'
import type { ProviderEvent } from './index.ts'

const envelopeSchema = z.object({ Type: z.enum(['Notification', 'SubscriptionConfirmation']), Message: z.string(), MessageId: z.string(), Timestamp: z.string().datetime(), TopicArn: z.string(), SignatureVersion: z.enum(['1', '2']), Signature: z.string(), SigningCertURL: z.string(), Subject: z.string().optional(), Token: z.string().optional(), SubscribeURL: z.string().optional() })
const sesEventSchema = z.object({ eventType: z.string().optional(), notificationType: z.string().optional(), mail: z.object({ messageId: z.string(), timestamp: z.string(), destination: z.array(z.string()).default([]), tags: z.record(z.string(), z.array(z.string())).default({}) }), delivery: z.object({ timestamp: z.string(), recipients: z.array(z.string()) }).optional(), bounce: z.object({ timestamp: z.string(), bounceType: z.string(), bounceSubType: z.string().optional(), bouncedRecipients: z.array(z.object({ emailAddress: z.string(), diagnosticCode: z.string().optional() })) }).optional(), complaint: z.object({ timestamp: z.string(), complainedRecipients: z.array(z.object({ emailAddress: z.string() })) }).optional(), deliveryDelay: z.object({ timestamp: z.string(), delayedRecipients: z.array(z.object({ emailAddress: z.string() })).optional() }).optional() })
const rejected = () => new AppError('invalid_webhook', 'Webhook verification failed.', 400)

function snsUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^sns\.[a-z]{2}(?:-[a-z]+)+-\d\.amazonaws\.com(?:\.cn)?$/.test(url.hostname)) throw rejected()
  return url
}

// SNS serves an X.509 certificate; WebCrypto imports its SubjectPublicKeyInfo, not the certificate.
export function certificateSpki(pem: string): Uint8Array<ArrayBuffer> {
  if (!/^-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/.test(pem)) throw rejected()
  const bytes = Uint8Array.from(fromBase64(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')))
  function node(at: number) {
    const tag = bytes[at]
    let length = bytes[at + 1]
    let start = at + 2
    if (length & 128) {
      const count = length & 127
      if (count === 0 || count > 4) throw rejected()
      length = 0
      for (let i = 0; i < count; i++) length = length * 256 + bytes[start++]
    }
    if (!Number.isFinite(length) || start + length > bytes.length) throw rejected()
    return { tag, start, end: start + length }
  }
  const certificate = node(0)
  if (certificate.tag !== 48 || certificate.end !== bytes.length) throw rejected()
  const tbs = node(certificate.start)
  if (tbs.tag !== 48) throw rejected()
  let at = tbs.start
  if (bytes[at] === 160) at = node(at).end
  for (let i = 0; i < 5; i++) at = node(at).end
  const spki = node(at)
  if (spki.tag !== 48 || spki.end > tbs.end) throw rejected()
  return bytes.slice(at, spki.end)
}

export async function parseSesWebhook(ctx: { platform: Pick<Platform, 'fetch'> }, request: Request, settings: Record<string, string>): Promise<{ confirmUrl?: string; events: ProviderEvent[] }> {
  try {
    const message = envelopeSchema.parse(await request.json())
    if (!settings.ses_sns_topic_arn || message.TopicArn !== settings.ses_sns_topic_arn) throw rejected()
    const certUrl = snsUrl(message.SigningCertURL)
    if (!certUrl.pathname.endsWith('.pem') || certUrl.search || certUrl.hash) throw rejected()
    const topic = /^arn:(aws|aws-cn):sns:([^:]+):\d{12}:[A-Za-z0-9_-]+$/.exec(message.TopicArn)
    if (!topic || certUrl.hostname !== `sns.${topic[2]}.amazonaws.com${topic[1] === 'aws-cn' ? '.cn' : ''}`) throw rejected()
    const fields: (keyof typeof message)[] = message.Type === 'Notification' ? ['Message', 'MessageId', ...(message.Subject === undefined ? [] : ['Subject'] as const), 'Timestamp', 'TopicArn', 'Type'] as const : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const
    let canonical = ''
    for (const key of fields) {
      const value = message[key]
      if (value === undefined) throw rejected()
      canonical += `${key}\n${value}\n`
    }
    const response = await ctx.platform.fetch(certUrl.href, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!response.ok || response.redirected || response.url && response.url !== certUrl.href) throw rejected()
    const pem = await response.text()
    if (pem.length > 32_768) throw rejected()
    const key = await crypto.subtle.importKey('spki', certificateSpki(pem), { name: 'RSASSA-PKCS1-v1_5', hash: message.SignatureVersion === '2' ? 'SHA-256' : 'SHA-1' }, false, ['verify'])
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Uint8Array.from(fromBase64(message.Signature)), new TextEncoder().encode(canonical))) throw rejected()
    if (message.Type === 'SubscriptionConfirmation') {
      const subscribe = snsUrl(message.SubscribeURL || '')
      if (subscribe.hostname !== certUrl.hostname) throw rejected()
      return { confirmUrl: subscribe.href, events: [] }
    }
    const data = sesEventSchema.parse(JSON.parse(message.Message))
    const type = data.eventType || data.notificationType
    const eventType = type === 'Delivery' ? 'delivered' : type === 'Bounce' ? 'bounce' : type === 'Complaint' ? 'complaint' : type === 'DeliveryDelay' ? 'deferred' : null
    if (!eventType) return { events: [] }
    const recipients = data.delivery?.recipients ?? data.bounce?.bouncedRecipients.map((r) => r.emailAddress) ?? data.complaint?.complainedRecipients.map((r) => r.emailAddress) ?? data.deliveryDelay?.delayedRecipients?.map((r) => r.emailAddress) ?? data.mail.destination
    const timestamp = data.delivery?.timestamp ?? data.bounce?.timestamp ?? data.complaint?.timestamp ?? data.deliveryDelay?.timestamp ?? data.mail.timestamp
    const occurredAt = Date.parse(timestamp)
    if (!Number.isFinite(occurredAt)) throw rejected()
    const events: ProviderEvent[] = []
    for (const recipient of recipients) events.push({ id: await sha256Hex(`${data.mail.messageId}\n${eventType}\n${timestamp}\n${recipient}`), type: eventType, accountId: data.mail.tags.mc_account?.[0] ?? null, deliveryId: data.mail.tags.mc_delivery?.[0] ?? null, messageId: data.mail.messageId, recipient, occurredAt, ...(data.bounce ? { bounce: { permanent: data.bounce.bounceType === 'Permanent', nonexistent: data.bounce.bounceSubType === 'NoEmail' || data.bounce.bouncedRecipients.some((r) => /5\.1\.1/.test(r.diagnosticCode || '')), reason: data.bounce.bounceType === 'Permanent' ? 'Permanent bounce' : 'Temporary bounce' } } : {}) })
    return { events }
  } catch { throw rejected() }
}
