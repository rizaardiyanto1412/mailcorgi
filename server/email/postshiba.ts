import { z } from 'zod'
import type { StoreCtx } from '../core/store.ts'
import { randomToken, toBase64 } from '../core/crypto.ts'
import type { EmailProvider, SendResult } from './index.ts'
import { encoded, mailbox, messageHeaders, safeHeader, InvalidMessageError } from './mime.ts'
import { sendError, unknownSend, invalidSend } from './http.ts'
import { parsePostshibaWebhook } from './postshiba-webhook.ts'

export const POSTSHIBA_ENDPOINT = 'https://inject.postshiba.com'
const HOURLY_RETRY_MS = 10 * 60_000
const DAILY_RETRY_MS = 60 * 60_000

const resultSchema = z.object({ success_count: z.number(), fail_count: z.number().default(0), failed_recipients: z.array(z.unknown()).default([]), errors: z.array(z.unknown()).default([]) })

/** Refusals PostShiba names in its reply. The reply text itself is never passed on. */
const REFUSALS: [RegExp, string][] = [
  [/too large/i, 'The message is too large for PostShiba.'],
  [/unverified domain|domain_unverified|not aligned/i, 'The sender domain is not verified in PostShiba.'],
  [/domain_suspended|sending disabled/i, 'PostShiba has paused sending for this domain or cluster.'],
  [/kyc_required/i, 'The PostShiba account is pending approval and cannot send to this recipient yet.'],
  [/firewall/i, 'The PostShiba email firewall refused the recipient.'],
  [/malware|phishing|spamhaus/i, 'PostShiba blocked the sender or the message content.'],
]

const address = (value: string) => (/<([^<>]+)>\s*$/.exec(value)?.[1] ?? value).trim()

function refusal(status: number, text: string, retryAfter: string | null): SendResult {
  const seconds = retryAfter ? Number(retryAfter) : NaN
  const wait = (fallback: number) => (Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : fallback)
  // The cluster's caps: PostShiba drops the message, so it stays queued here until there is room.
  if (/daily send limit/i.test(text)) return { ok: false, kind: 'throttled', message: 'PostShiba daily send limit reached. The send resumes when the cluster has room.', retryAfterMs: wait(DAILY_RETRY_MS) }
  if (status === 429 || /hourly send limit/i.test(text)) return { ok: false, kind: 'throttled', message: 'PostShiba hourly send limit reached. The send resumes when the cluster has room.', retryAfterMs: wait(HOURLY_RETRY_MS) }
  if (status === 401 || status === 403) return { ok: false, kind: 'permanent', message: 'PostShiba rejected the SMTP credential. Check postshiba_user and postshiba_password.' }
  if (status === 413 || status === 552) return { ok: false, kind: 'permanent', message: REFUSALS[0][1] }
  const known = REFUSALS.find(([pattern]) => pattern.test(text))
  if (known) return { ok: false, kind: 'permanent', message: known[1] }
  if (/(^|[\s"[:])4[25]\d[\s-]/.test(text)) return { ok: false, kind: 'temporary', message: 'PostShiba asked to try again later.' }
  if (status === 200 || status >= 550 && status <= 559) return { ok: false, kind: 'permanent', message: 'PostShiba rejected the recipient.' }
  return sendError(status, retryAfter)
}

/** PostShiba over HTTP inject: the SMTP credential as HTTP Basic, so it runs on Workers and on Node. */
export function postshibaProvider(ctx: StoreCtx, settings: Record<string, string>): EmailProvider {
  return {
    name: 'postshiba', capabilities: { identities: false, events: true, idempotency: false },
    async send(msg) {
      let endpoint: URL
      try {
        endpoint = new URL(`${(settings.postshiba_endpoint || POSTSHIBA_ENDPOINT).replace(/\/+$/, '')}/api/inject/v1`)
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Invalid endpoint.')
      } catch { return { ok: false, kind: 'permanent', message: 'The PostShiba endpoint must be an https URL.' } }
      try {
        const from = address(safeHeader(msg.from))
        const to = address(safeHeader(msg.to))
        const messageId = `<${randomToken(18)}@${from.split('@')[1] || 'localhost'}>`
        const headers = {
          From: mailbox(msg.from), To: mailbox(msg.to), ...(msg.replyTo ? { 'Reply-To': mailbox(msg.replyTo) } : {}), Subject: encoded(msg.subject),
          ...messageHeaders(msg), 'Message-ID': messageId,
          'X-Capsule-Unique-Args': safeHeader(JSON.stringify({ mc_account: msg.meta.accountId, ...(msg.meta.deliveryId ? { mc_delivery: msg.meta.deliveryId } : {}) })),
        }
        const response = await ctx.platform.fetch(endpoint.href, {
          method: 'POST',
          headers: { authorization: `Basic ${toBase64(new TextEncoder().encode(`${settings.postshiba_user || ''}:${settings.postshiba_password || ''}`))}`, 'content-type': 'application/json' },
          body: JSON.stringify({ envelope_sender: from, content: { text_body: msg.text, html_body: msg.html, headers }, recipients: [{ email: to }] }),
          redirect: 'error', signal: AbortSignal.timeout(30_000),
        })
        const text = await response.text()
        if (!response.ok) return refusal(response.status, text.slice(0, 4000), response.headers.get('retry-after'))
        let json: unknown
        try { json = JSON.parse(text) } catch { return unknownSend() }
        const result = resultSchema.safeParse(json)
        if (!result.success) return unknownSend()
        if (result.data.success_count >= 1 && result.data.fail_count === 0) return { ok: true, id: messageId }
        return refusal(200, JSON.stringify([result.data.errors, result.data.failed_recipients]).slice(0, 4000), null)
      } catch (error) { return error instanceof InvalidMessageError ? invalidSend() : unknownSend() }
    },
    parseWebhook: (request, config) => parsePostshibaWebhook(ctx, request, config),
  }
}
