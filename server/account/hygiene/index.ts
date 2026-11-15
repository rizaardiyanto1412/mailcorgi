import { z } from 'zod'
import { AppError } from '../../core/http.ts'
import { defineAction } from '../../core/actions.ts'
import type { AccountRegistrar } from '../rpc.ts'
import { getMeta, setMeta } from '../usage/index.ts'
import { migrations } from './migrations.ts'
import { DAY, readSettings, settingsShape } from './settings.ts'
import { atRiskWhere, cleanNewsletter, queueHygiene, scanNewsletter } from './lifecycle.ts'
import { protectionState, resumeProtection, rollingRates, type ProtectionEvidence } from './protection.ts'
export { queueHygiene, recordHygieneSend, hygieneEpoch, keepIssuedAt, keepDeliveryAllowed } from './lifecycle.ts'
export { assertSendingAllowed, checkProtection, globalSuppressions, protectionState, observeProtectionPolicy } from './protection.ts'
export { readSettings } from './settings.ts'

const newsletterId = z.string().min(1).describe('The newsletter id')
const resource = { type: 'newsletter', param: 'newsletterId' } as const

export const hygieneModule = {
  name: 'hygiene',
  register(reg: AccountRegistrar) {
    reg.migrations(migrations)
    reg.job<{ newsletterId: string }>('hygiene.scan', async (ctx, { newsletterId }) => scanNewsletter(ctx, newsletterId))
    reg.job<{ newsletterId: string }>('hygiene.clean', async (ctx, { newsletterId }) => cleanNewsletter(ctx, newsletterId))
    reg.job<ProtectionEvidence>('hygiene.reportProtection', async (ctx, evidence, budget) => {
      if (budget.take(1) < 1) return { again: ctx.now() + 1000 }
      if (ctx.config.cloud) await ctx.stores.control.requestBlock({ accountId: ctx.accountId!, evidence })
      else await ctx.stores.control.raiseAlert({ kind: 'account_protection', accountId: ctx.accountId, title: `Sending paused (${evidence.incidentId})`, body: JSON.stringify(evidence) })
      return 'done'
    })
    reg.maintenance((ctx) => {
      if (Number(getMeta(ctx, 'hygiene_next_sweep') ?? 0) > ctx.now()) return
      ctx.db.tx(() => {
        setMeta(ctx, 'hygiene_next_sweep', String(ctx.now() + DAY))
        for (const n of ctx.db.all<{ id: string }>('SELECT id FROM newsletters WHERE archived_at IS NULL')) {
          queueHygiene(ctx, n.id)
          ctx.jobs.enqueue('hygiene.clean', { newsletterId: n.id }, { dedupeKey: `hygiene.clean:${n.id}` })
        }
      })
    })
    return reg.actions(
      defineAction({ name: 'hygiene.settings', description: 'Read automatic list hygiene and reminder copy.', scope: 'account', role: 'admin', effect: 'read', resource,
        input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/hygiene' }, mcp: { title: 'Read list hygiene settings', destructive: false },
        handler: (ctx, input) => readSettings(ctx, input.newsletterId),
      }),
      defineAction({ name: 'hygiene.updateSettings', description: 'Save automatic list hygiene and reminder copy. Account protection always remains enabled.', scope: 'account', role: 'admin', effect: 'write', resource,
        input: z.object({ newsletterId, ...settingsShape }), rest: { method: 'PUT', path: '/newsletters/:newsletterId/hygiene' }, mcp: { title: 'Save list hygiene settings', destructive: false },
        handler: (ctx, { newsletterId, ...settings }) => ctx.db.tx(() => {
          ctx.db.run('UPDATE newsletters SET hygiene = ?, updated_at = ? WHERE id = ?', JSON.stringify(settings), ctx.now(), newsletterId)
          queueHygiene(ctx, newsletterId)
          ctx.jobs.enqueue('hygiene.clean', { newsletterId }, { dedupeKey: `hygiene.clean:${newsletterId}` })
          return settings
        }),
      }),
      defineAction({ name: 'hygiene.health', description: 'Read list status, inactivity and reputation rates across the latest 1,000 emails.', scope: 'account', role: 'member', effect: 'read', resource,
        input: z.object({ newsletterId }), rest: { method: 'GET', path: '/newsletters/:newsletterId/list-health' }, mcp: { title: 'Read list health', destructive: false },
        handler: (ctx, { newsletterId }, actor) => {
          const settings = readSettings(ctx, newsletterId)
          return {
            statuses: ctx.db.all<{ status: string; count: number }>('SELECT status, COUNT(*) count FROM contacts WHERE newsletter_id = ? GROUP BY status ORDER BY status', newsletterId),
            atRisk: ctx.db.get<{ count: number }>(`SELECT COUNT(*) count FROM contacts c WHERE c.newsletter_id = ? AND ${atRiskWhere(settings.strict)}`, newsletterId, ctx.now() - 90 * DAY, settings.afterIssues)!.count,
            awaitingReply: ctx.db.get<{ count: number }>("SELECT COUNT(*) count FROM contacts WHERE newsletter_id = ? AND status = 'subscribed' AND keep_asked_at IS NOT NULL", newsletterId)!.count,
            cleanedLast90Days: ctx.db.get<{ count: number }>("SELECT COUNT(*) count FROM events WHERE newsletter_id = ? AND type = 'cleaned' AND at >= ?", newsletterId, ctx.now() - 90 * DAY)!.count,
            rates: rollingRates(ctx, actor.owner ? undefined : newsletterId), ratesScope: actor.owner ? 'account' : 'newsletter',
            protection: actor.owner ? protectionState(ctx) : null, enabled: settings.enabled, afterIssues: settings.afterIssues, waitDays: settings.waitDays,
          }
        },
      }),
      defineAction({ name: 'hygiene.resume', description: 'Explicitly resume sending after reviewing an account protection pause.', scope: 'account', role: 'owner', effect: 'write', resource: { type: 'account', param: 'accountId' },
        input: z.object({ accountId: z.string().min(1).describe('The account id to resume'), confirmation: z.literal('RESUME').describe('Confirm the list and sender reputation have been reviewed') }),
        rest: { method: 'POST', path: '/accounts/:accountId/resume-sending' }, mcp: { title: 'Resume account sending', destructive: true }, handler: (ctx, input) => {
          if (input.accountId !== ctx.accountId) throw new AppError('not_found', 'Account not found.', 404)
          return resumeProtection(ctx)
        },
      }),
    )
  },
}
