import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import { decodeJsonUrl, encodeJsonUrl } from '../../core/crypto.ts'
import { AppError } from '../../core/http.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { migrations } from './migrations.ts'

const STATUSES = ['all', 'queued', 'sending', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'unsubscribed', 'complained', 'failed', 'skipped', 'unknown'] as const
type Status = (typeof STATUSES)[number]

const input = z.object({
  newsletterId: z.string().min(1).describe('The newsletter id.'),
  email: z.string().trim().min(1).max(320).optional().describe('Only sends to this exact address, case-insensitive. Omit for the newsletter-wide log.'),
  status: z.enum(STATUSES).default('all').describe('Filter by delivery or engagement status. opened, clicked and unsubscribed match any send with that timestamp, so a clicked send also matches opened.'),
  cursor: z.string().max(2000).optional().describe('The nextCursor from the previous page.'),
  limit: z.number().int().min(1).max(200).default(50).describe('The maximum number of sends in this page.'),
})

/** Same meaning as `recipientWhere` in stats: engagement statuses test the timestamp, the rest the raw column. */
const statusWhere = (status: Status) => status === 'all' ? '1 = 1' : status === 'opened' ? 'd.opened_at IS NOT NULL' : status === 'clicked' ? 'd.clicked_at IS NOT NULL' : status === 'unsubscribed' ? 'd.unsubscribed_at IS NOT NULL' : 'd.status = ?'

const cursorSchema = z.object({ sentAt: z.number().int().nullable(), id: z.number().int(), newsletterId: z.string() })

type Row = { id: number; email: string; contact_id: string; subject: string; status: string; sent_at: number | null; delivered_at: number | null; opened_at: number | null; clicked_at: number | null; bounced_at: number | null; complained_at: number | null; unsubscribed_at: number | null; campaign_id: string; kind: string; slug: string; sequence_id: string | null; sequence_name: string | null; step_id: string | null; step_position: number | null }

/** The status a person would read: the most specific thing that happened, not the raw column. */
function displayStatus(r: Row) {
  if (r.unsubscribed_at != null) return 'unsubscribed'
  if (r.bounced_at != null || r.status === 'bounced') return 'bounced'
  if (r.complained_at != null) return 'complained'
  if (r.clicked_at != null) return 'clicked'
  if (r.opened_at != null) return 'opened'
  if (r.delivered_at != null || r.status === 'delivered') return 'delivered'
  return r.status
}

function source(r: Row) {
  if (r.kind === 'sequence') return { type: 'sequence' as const, name: r.sequence_name ?? r.subject, sequenceId: r.sequence_id, stepId: r.step_id, stepPosition: r.step_position, campaignId: r.campaign_id }
  return { type: r.kind === 'welcome' ? 'welcome' as const : 'campaign' as const, name: r.slug || r.subject, campaignId: r.campaign_id }
}

export const sendsModule = {
  name: 'sends',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    return reg.actions(
      defineAction({ name: 'sends.list', description: 'Read the send log: every email delivered from this newsletter, newest first, with engagement timestamps and whether it came from a campaign, welcome email or sequence step. Pass email for one contact.', scope: 'account', role: 'member', effect: 'read', resource: { type: 'newsletter', param: 'newsletterId' }, input, rest: { method: 'GET', path: '/newsletters/:newsletterId/sends' }, mcp: { title: 'List sent emails, newsletter-wide or for one email address', destructive: false }, handler: (ctx, i) => {
        const where = ['c.newsletter_id = ?', statusWhere(i.status)]
        const params: (string | number)[] = [i.newsletterId]
        if (i.status !== 'all' && !['opened', 'clicked', 'unsubscribed'].includes(i.status)) params.push(i.status)
        if (i.email) { where.push('d.email = ?'); params.push(i.email.toLowerCase()) }
        if (i.cursor) {
          const cursor = cursorSchema.safeParse(decodeJsonUrl(i.cursor))
          if (!cursor.success || cursor.data.newsletterId !== i.newsletterId) throw new AppError('invalid_input', 'That page cursor is invalid for this list.', 400)
          const { sentAt, id } = cursor.data
          // Newest first with unsent rows (NULL sent_at) last, so "after" the cursor means older, or unsent.
          if (sentAt === null) { where.push('d.sent_at IS NULL AND d.id < ?'); params.push(id) }
          else { where.push('(d.sent_at < ? OR d.sent_at IS NULL OR (d.sent_at = ? AND d.id < ?))'); params.push(sentAt, sentAt, id) }
        }
        const rows = ctx.db.all<Row>(`SELECT d.id, d.email, d.contact_id, c.subject, d.status, d.sent_at, d.delivered_at, d.opened_at, d.clicked_at, d.bounced_at, d.complained_at, d.unsubscribed_at, d.campaign_id, c.kind, c.slug, s.id AS sequence_id, s.name AS sequence_name, st.id AS step_id, st.position AS step_position
          FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id LEFT JOIN sequence_steps st ON st.campaign_id = c.id LEFT JOIN sequences s ON s.id = st.sequence_id
          WHERE ${where.join(' AND ')} ORDER BY d.sent_at DESC, d.id DESC LIMIT ?`, ...params, i.limit + 1)
        const page = rows.slice(0, i.limit)
        const last = page[page.length - 1]
        return {
          items: page.map((r) => ({ id: r.id, email: r.email, contactId: r.contact_id, subject: r.subject, sentAt: r.sent_at, deliveredAt: r.delivered_at, openedAt: r.opened_at, clickedAt: r.clicked_at, bouncedAt: r.bounced_at, complainedAt: r.complained_at, unsubscribedAt: r.unsubscribed_at, status: displayStatus(r), source: source(r) })),
          nextCursor: rows.length > i.limit && last ? encodeJsonUrl({ sentAt: last.sent_at, id: last.id, newsletterId: i.newsletterId }) : null,
        }
      } }),
    )
  },
}
