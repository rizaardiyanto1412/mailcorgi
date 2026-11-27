import type { StoreCtx } from '../core/store.ts'
import { AppError } from '../core/http.ts'
import { testProvider } from './test.ts'

export interface EmailMessage {
  from: string
  to: string
  replyTo?: string
  subject: string
  html: string
  text: string
  /**
   * A plain send: `text` is the message and `html` only a bare copy of it. Every real provider drops
   * `html` and sends a lone text/plain part; the test outbox stores both.
   */
  textOnly?: boolean
  /** Set for a send whose content is kept. A provider then logs only the provider, stage, status and an error class, never a reply or error text. */
  safeDiagnostics?: boolean
  headers: Record<string, string>
  meta: { accountId: string; deliveryId: string | null; kind: 'campaign' | 'system' }
  idempotencyKey: string
}

export type SendResult = { ok: true; id: string } | { ok: false; kind: 'permanent' | 'temporary' | 'throttled' | 'unknown'; message: string; retryAfterMs?: number }

export interface Identity {
  domain: string
  status: 'pending' | 'verified' | 'failed'
  records: { name: string; type: string; value: string; purpose: string }[]
  raw?: unknown
}

export interface ProviderEvent {
  /** The provider's event id, or a hash of (message id, type, timestamp, recipient). */
  id: string
  type: 'delivered' | 'bounce' | 'complaint' | 'deferred'
  bounce?: { permanent: boolean; nonexistent: boolean; reason: string }
  accountId: string | null
  deliveryId: string | null
  messageId: string
  recipient: string
  occurredAt: number
}

export type ProviderName = 'ses' | 'resend' | 'postshiba' | 'smtp' | 'test'

export interface EmailProvider {
  name: ProviderName
  capabilities: { identities: boolean; events: boolean; idempotency: boolean }
  send(msg: EmailMessage): Promise<SendResult>
  createIdentity?(domain: string): Promise<Identity>
  getIdentity?(domain: string): Promise<Identity>
  deleteIdentity?(domain: string): Promise<void>
  parseWebhook?(request: Request, settings: Record<string, string>): Promise<{ confirmUrl?: string; events: ProviderEvent[] }>
}

/** Install settings each provider reads. Secrets are decrypted by the install module. */
export const PROVIDER_SETTING_KEYS = [
  'email_provider',
  'sending_enabled',
  'email_from',
  'email_from_name',
  'send_rate_per_second',
  'send_rate_per_hour',
  'ses_region',
  'ses_access_key_id',
  'ses_secret_access_key',
  'ses_configuration_set',
  'ses_sns_topic_arn',
  'resend_api_key',
  'resend_webhook_secret',
  'postshiba_endpoint',
  'postshiba_user',
  'postshiba_password',
  'postshiba_webhook_secret',
  'smtp_host',
  'smtp_port',
  'smtp_security',
  'smtp_user',
  'smtp_password',
] as const

/** Pick the provider the install settings name. `test` until an admin configures a real one. */
export async function providerFromSettings(ctx: StoreCtx, settings: Record<string, string>): Promise<EmailProvider> {
  const name = (settings.email_provider || 'test') as ProviderName
  switch (name) {
    case 'test':
      return testProvider(ctx)
    case 'ses':
      return (await import('./ses.ts')).sesProvider(ctx, settings)
    case 'resend':
      return (await import('./resend.ts')).resendProvider(ctx, settings)
    case 'postshiba':
      return (await import('./postshiba.ts')).postshibaProvider(ctx, settings)
    case 'smtp':
      return (await import('./smtp.ts')).smtpProvider(ctx, settings)
    default:
      throw new AppError('bad_provider', 'Unknown email provider.', 500)
  }
}

export { parseSesWebhook } from './ses-webhook.ts'
export { parseResendWebhook } from './resend-webhook.ts'
export { parsePostshibaWebhook } from './postshiba-webhook.ts'
export { providerSettings, sendSystemEmail, simpleEmail } from './platform-email.ts'
