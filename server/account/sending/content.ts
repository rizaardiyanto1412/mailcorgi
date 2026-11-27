import type { Budget, JobResult } from '../../core/jobs.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { EmailMessage } from '../../email/index.ts'

/** How long a copy stays readable, counted from the moment the provider accepted the email. */
export const CONTENT_TTL_MS = 30 * 86_400_000
/** Largest copy kept, in UTF-8 bytes. A Durable Object row holds at most 2 MB, and a copy this size must never fail the send. */
export const MAX_CONTENT_BYTES = 1_000_000
const PURGE_KEY = 'delivery_content.purge'
const PURGE_CHUNK = 200
const PURGE_PER_RUN = 2_000

export interface ContentSnapshot { subject: string; html: string | null; text: string }

/** The kinds that send through `sendDelivery` and keep a copy. Welcome and re-engagement emails never do. */
export const capturesKind = (ctx: StoreCtx, kind: string) => ctx.config.captureDeliveryContent && (kind === 'issue' || kind === 'sequence')

/** The exact strings handed to the provider adapter. Strings cannot change afterwards, so the copy is immutable. */
export const snapshotOf = (message: EmailMessage): ContentSnapshot => ({ subject: message.subject, html: message.textOnly ? null : message.html, text: message.text })

/**
 * True only for a delivery no earlier attempt ever touched. Any marker of a past attempt (a token, a
 * time, a counter, a provider id, an error, a delivery time) means the content or the acceptance time
 * of the accepted email may be another one, and the row gets no copy. A throttle puts `attempts` back
 * to zero, so the counter alone is not enough.
 */
export function neverAttempted(d: object): boolean {
  const row = d as Record<string, unknown>
  return row.attempts === 0 && ['attempt_token', 'attempt_at', 'provider_message_id', 'error', 'sent_at', 'delivered_at', 'opened_at', 'clicked_at', 'bounced_at', 'complained_at', 'unsubscribed_at'].every((key) => row[key] === null)
}

const bytes = (value: string | null) => (value === null ? 0 : new TextEncoder().encode(value).length)

/** Make sure one purge job runs by `at`. A job already due sooner is left alone. */
export function armPurge(ctx: StoreCtx, at: number) {
  const job = ctx.db.get<{ run_at: number }>('SELECT run_at FROM jobs WHERE dedupe_key = ?', PURGE_KEY)
  if (job && job.run_at <= at) return
  ctx.jobs.cancelByKey(PURGE_KEY)
  ctx.jobs.enqueue('delivery_content.purge', {}, { runAt: at, dedupeKey: PURGE_KEY })
}

/**
 * Keep the copy of an email the provider accepted. Runs after the accepted send is committed, in its own
 * transaction, so a failure here cannot undo the send. The row must still be the same accepted attempt
 * (same token, `sent`, same time), and its contact and newsletter must still exist. Any failure skips the
 * copy. The log line is fixed and never carries an error name or text.
 */
export function keepContent(ctx: StoreCtx, d: { id: number; contact_id: string; attempt_token: string | null }, newsletterId: string, snapshot: ContentSnapshot, at: number) {
  if (bytes(snapshot.subject) + bytes(snapshot.html) + bytes(snapshot.text) > MAX_CONTENT_BYTES) return
  try {
    ctx.db.tx(() => {
      const own = ctx.db.get("SELECT 1 FROM deliveries d JOIN contacts c ON c.id = d.contact_id AND c.newsletter_id = ? JOIN newsletters n ON n.id = c.newsletter_id WHERE d.id = ? AND d.contact_id = ? AND d.status = 'sent' AND d.attempt_token = ? AND d.sent_at = ? AND n.deleting_at IS NULL", newsletterId, d.id, d.contact_id, d.attempt_token, at)
      if (!own) return
      ctx.db.run('INSERT OR IGNORE INTO delivery_content (delivery_id, contact_id, accepted_at, expires_at, subject, html, text) VALUES (?, ?, ?, ?, ?, ?, ?)', d.id, d.contact_id, at, at + CONTENT_TTL_MS, snapshot.subject, snapshot.html, snapshot.text)
      armPurge(ctx, at + CONTENT_TTL_MS)
    })
  } catch {
    console.error('[delivery-content] copy skipped')
  }
}

/** The copy of one delivery, or null at the cutoff, whether or not the purge ran, and when the copy does not match the delivery's own acceptance time. */
export function readContent(ctx: StoreCtx, deliveryId: number, sentAt: number | null) {
  if (!ctx.config.captureDeliveryContent || sentAt === null) return null
  const row = ctx.db.get<{ subject: string; html: string | null; text: string }>('SELECT subject, html, text FROM delivery_content WHERE delivery_id = ? AND accepted_at = ? AND expires_at > ?', deliveryId, sentAt, ctx.now())
  return row ? { subject: row.subject, html: row.html, text: row.text } : null
}

/** Delete expired copies in bounded chunks, then sleep until the next expiry. Runs whether or not the feature is on. */
export function purgeExpired(ctx: StoreCtx, budget: Budget): JobResult {
  const now = ctx.now()
  let removed = 0
  while (removed < PURGE_PER_RUN && !budget.expired()) {
    const n = ctx.db.tx(() => ctx.db.run('DELETE FROM delivery_content WHERE delivery_id IN (SELECT delivery_id FROM delivery_content WHERE expires_at <= ? LIMIT ?)', now, PURGE_CHUNK).changes)
    removed += n
    if (n < PURGE_CHUNK) break
  }
  const next = nextExpiry(ctx)
  return next === null ? 'done' : { again: next }
}

export const nextExpiry = (ctx: StoreCtx) => ctx.db.get<{ at: number | null }>('SELECT MIN(expires_at) AS at FROM delivery_content')?.at ?? null
