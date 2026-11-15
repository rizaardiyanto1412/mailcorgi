import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import type { Budget } from '../../core/jobs.ts'
import { hmac, toHex } from '../../core/crypto.ts'
import { newId } from '../../core/ids.ts'
import { AppError } from '../../core/http.ts'
import { getMeta, setMeta, getPolicy } from '../usage/index.ts'
import { resetRateBaseline } from '../sending/index.ts'
import { transitionCampaign, type CampaignRow } from '../campaigns/index.ts'

export const protectionSchema = z.object({
  incidentId: z.string(), reason: z.enum(['bounce_rate', 'complaint_rate', 'spam_trap']),
  policyVersion: z.number(), at: z.number(), total: z.number(), bounces: z.number(), complaints: z.number(),
})
export type ProtectionEvidence = z.infer<typeof protectionSchema>
export const protectionState = (ctx: StoreCtx) => {
  const raw = getMeta(ctx, 'hygiene_protection')
  return raw ? protectionSchema.parse(JSON.parse(raw)) : null
}
export function assertSendingAllowed(ctx: StoreCtx) {
  if (protectionState(ctx)) throw new AppError('sending_paused', 'Sending is paused to protect your reputation. Review list health before resuming.', 403)
}
export function rollingRates(ctx: StoreCtx, newsletterId?: string) {
  const epoch = Number(getMeta(ctx, 'hygiene_epoch') ?? 0)
  const row = ctx.db.get<{ total: number; bounces: number; complaints: number }>(`
    SELECT COUNT(*) total, COALESCE(SUM(bounced_at IS NOT NULL), 0) bounces,
      COALESCE(SUM(complained_at IS NOT NULL), 0) complaints FROM (
      SELECT d.bounced_at, d.complained_at FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id
      WHERE d.sent_at IS NOT NULL AND d.hygiene_epoch = ? ${newsletterId ? 'AND c.newsletter_id = ?' : ''}
      ORDER BY d.sent_at DESC, d.id DESC LIMIT 1000
    )`, epoch, ...(newsletterId ? [newsletterId] : []))!
  return { ...row, bounceRate: row.total ? row.bounces / row.total : 0, complaintRate: row.total ? row.complaints / row.total : 0, bounceLimit: 0.05, complaintLimit: 0.003, minimum: 1000 }
}
export function checkProtection(ctx: StoreCtx, spamTrap = false): boolean {
  if (protectionState(ctx)) return true
  const rates = rollingRates(ctx)
  const reason = spamTrap ? 'spam_trap' : rates.total < 1000 ? null : rates.bounceRate > rates.bounceLimit ? 'bounce_rate' : rates.complaintRate > rates.complaintLimit ? 'complaint_rate' : null
  if (!reason) return false
  ctx.db.tx(() => {
    const evidence: ProtectionEvidence = { incidentId: newId('hyg'), reason, policyVersion: getPolicy(ctx).version, at: ctx.now(), total: rates.total, bounces: rates.bounces, complaints: rates.complaints }
    setMeta(ctx, 'hygiene_protection', JSON.stringify(evidence))
    ctx.db.run("DELETE FROM account_meta WHERE key = 'hygiene_block_version'")
    for (const row of ctx.db.all<CampaignRow>("SELECT * FROM campaigns WHERE status IN ('sending', 'scheduled')")) {
      const start = ctx.db.get<{ payload: string }>('SELECT payload FROM jobs WHERE dedupe_key = ?', `send.start:${row.id}`)
      ctx.db.run('INSERT OR IGNORE INTO hygiene_paused (campaign_id, previous_status, start_payload) VALUES (?, ?, ?)', row.id, row.status, start?.payload ?? null)
      transitionCampaign(ctx, row.id, 'paused', { reason: 'account_protection' })
      ctx.jobs.cancelByKey(`send.start:${row.id}`)
      ctx.jobs.cancelByKey(`send.batch:${row.id}`)
    }
    ctx.db.run('INSERT INTO notifications (id, user_id, kind, tone, title, body, href, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)', newId('ntf'), 'account_protection', 'danger', 'Sending is paused', 'Bounce or complaint rates crossed the account safety limit, or a spam trap was detected. Review list health before resuming.', '/list-health', ctx.now())
    ctx.jobs.enqueue('hygiene.reportProtection', evidence, { dedupeKey: `hygiene.report:${evidence.incidentId}` })
  })
  return true
}
export function resumeProtection(ctx: StoreCtx) {
  const incident = protectionState(ctx)
  const blockedVersion = getMeta(ctx, 'hygiene_block_version')
  if (ctx.config.cloud && incident && (blockedVersion === null || getPolicy(ctx).status !== 'active' || getPolicy(ctx).version <= Number(blockedVersion))) throw new AppError('admin_required', 'Ask the install administrator to review and unblock this account.', 403)
  if (getPolicy(ctx).status !== 'active') throw new AppError('account_blocked', 'This account is blocked. Ask the install administrator to review it.', 403)
  return ctx.db.tx(() => {
    if (!protectionState(ctx)) return { resumed: false }
    setMeta(ctx, 'hygiene_epoch', String(Number(getMeta(ctx, 'hygiene_epoch') ?? 0) + 1))
    ctx.db.run("DELETE FROM account_meta WHERE key = 'hygiene_protection'")
    for (const hold of ctx.db.all<{ campaign_id: string; previous_status: string; start_payload: string | null }>('SELECT * FROM hygiene_paused')) {
      const row = ctx.db.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', hold.campaign_id)
      if (!row || row.status !== 'paused' || row.pause_reason !== 'account_protection') continue
      if (hold.previous_status === 'scheduled') {
        const at = Math.max(ctx.now() + 1000, row.scheduled_at ?? ctx.now())
        transitionCampaign(ctx, row.id, 'scheduled', { scheduledAt: at })
        ctx.jobs.enqueue('send.start', hold.start_payload ? JSON.parse(hold.start_payload) : { campaignId: row.id, options: { gradual: false, engagedFirst: false } }, { runAt: at, dedupeKey: `send.start:${row.id}` })
      } else {
        resetRateBaseline(ctx, row.id)
        transitionCampaign(ctx, row.id, 'sending')
        ctx.jobs.enqueue('send.batch', { campaignId: row.id }, { dedupeKey: `send.batch:${row.id}` })
      }
    }
    ctx.db.run('DELETE FROM hygiene_paused')
    return { resumed: true }
  })
}

export async function globalSuppressions(ctx: StoreCtx, emails: string[], budget: Budget): Promise<Set<string> | null> {
  if (budget.take(1) < 1) return null
  const pairs = await Promise.all([...new Set(emails)].map(async (email) => ({ email, hash: toHex(await hmac(ctx.keys.suppression, email.trim().toLowerCase())) })))
  const result = await ctx.stores.control.checkSuppressed({ emailHashes: pairs.map((p) => p.hash) })
  const traps = new Set(result.spamTraps)
  if (pairs.some((p) => traps.has(p.hash))) checkProtection(ctx, true)
  const suppressed = new Set(result.suppressed)
  return new Set(pairs.filter((p) => suppressed.has(p.hash)).map((p) => p.email))
}

export function observeProtectionPolicy(ctx: StoreCtx, policy: { version: number; status: string }) {
  if (policy.status === 'blocked' && protectionState(ctx)) setMeta(ctx, 'hygiene_block_version', String(policy.version))
}
