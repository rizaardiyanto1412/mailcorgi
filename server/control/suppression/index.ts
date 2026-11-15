import { z } from 'zod'
import { hmac, toHex } from '../../core/crypto.ts'
import type { StoreCtx } from '../../core/store.ts'
import type { ControlRegistrar } from '../rpc.ts'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const report = z.object({ emailHash: hash, reason: z.enum(['hard_bounce', 'spam_trap']), nonexistent: z.boolean().optional() })
export const suppressionHash = async (ctx: StoreCtx, email: string) => toHex(await hmac(ctx.keys.suppression, email.trim().toLowerCase()))
function reportSuppression(ctx: StoreCtx, raw: z.infer<typeof report>) {
  const input = report.parse(raw)
  const until = input.reason === 'hard_bounce' && input.nonexistent ? ctx.now() + 180 * 86_400_000 : null
  ctx.db.run(`INSERT INTO global_suppressions (email_hash, reason, until, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(email_hash) DO UPDATE SET reason = CASE WHEN reason = 'spam_trap' THEN reason ELSE excluded.reason END,
    until = CASE WHEN until IS NULL OR excluded.until IS NULL THEN NULL ELSE MAX(until, excluded.until) END`, input.emailHash, input.reason, until, ctx.now())
}
declare module '../rpc.ts' {
  interface ControlRpc {
    reportSuppression(args: z.infer<typeof report>): Promise<void>
    checkSuppressed(args: { emailHashes: string[] }): Promise<{ suppressed: string[] }>
  }
}
export const suppressionModule = {
  name: 'suppression',
  register(reg: ControlRegistrar) {
    reg.rpc('reportSuppression', reportSuppression)
    reg.rpc('reportSuppressions', async (ctx, { events }) => {
      for (const e of events) if (e.type === 'bounce' && e.bounce?.permanent && e.bounce.nonexistent) reportSuppression(ctx, { emailHash: await suppressionHash(ctx, e.recipient), reason: 'hard_bounce', nonexistent: true })
    })
    reg.rpc('checkSuppressed', (ctx, raw) => {
      const { emailHashes } = z.object({ emailHashes: z.array(hash).max(1000) }).parse(raw)
      const suppressed: string[] = []
      for (let i = 0; i < emailHashes.length; i += 90) {
        const batch = emailHashes.slice(i, i + 90)
        if (batch.length) suppressed.push(...ctx.db.all<{ email_hash: string }>(`SELECT email_hash FROM global_suppressions WHERE email_hash IN (${batch.map(() => '?').join(',')}) AND (until IS NULL OR until > ?)`, ...batch, ctx.now()).map((r) => r.email_hash))
      }
      return { suppressed: [...new Set(suppressed)] }
    })
    reg.maintenance((ctx) => { ctx.db.run('DELETE FROM global_suppressions WHERE until IS NOT NULL AND until <= ?', ctx.now()) })
  },
}
