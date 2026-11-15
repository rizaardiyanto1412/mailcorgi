import { z } from 'zod'
import type { StoreCtx } from '../../core/store.ts'
import { policyFor } from '../accounts/index.ts'
import { getSettingSync } from './index.ts'

const bucketSchema = z.object({ tokens: z.number(), at: z.number(), queue: z.array(z.object({ accountId: z.string(), at: z.number() })) })
const KEY = '_send_bucket'

export function takeSendPermits(ctx: StoreCtx, input: { accountId: string; want: number }): { granted: number; retryAt: number | null } {
  return ctx.db.tx(() => {
    const now = ctx.now()
    const want = Math.max(0, Math.min(1000, Math.floor(input.want)))
    if (!Number.isFinite(want) || !want) return { granted: 0, retryAt: null }
    const account = ctx.db.get<Parameters<typeof policyFor>[1]>('SELECT * FROM accounts WHERE id = ? AND deleted_at IS NULL', input.accountId)
    if (!account || account.status !== 'active' || getSettingSync(ctx, 'sending_enabled') === 'false') return { granted: 0, retryAt: now + 60_000 }
    const configuredRate = Number(getSettingSync(ctx, 'send_rate_per_second') || 10)
    const rate = Number.isFinite(configuredRate) && configuredRate > 0 ? configuredRate : 10
    const capacity = Math.max(1, rate)
    const raw = getSettingSync(ctx, KEY)
    const bucket = raw ? bucketSchema.parse(JSON.parse(raw)) : { tokens: capacity, at: now, queue: [] }
    bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) * rate / 1000)
    bucket.at = now
    // A waiting account keeps its turn across another account's faster polling; abandoned turns expire.
    bucket.queue = bucket.queue.filter((entry) => now - entry.at < 5000)
    if (!bucket.queue.some((entry) => entry.accountId === input.accountId)) bucket.queue.push({ accountId: input.accountId, at: now })
    // A batch is granted whole or not at all: granting the few tokens that trickled in since the last
    // call made the sender loop every few milliseconds, paying its per-batch rows for a handful of
    // emails. The caller is told when the whole batch will fit and sleeps until then.
    const target = Math.min(want, Math.max(1, Math.ceil(capacity / bucket.queue.length)))
    const myTurn = bucket.queue[0]?.accountId === input.accountId
    let granted = myTurn && Math.floor(bucket.tokens) >= target ? target : 0
    if (myTurn && !granted) {
      ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(bucket))
      return { granted: 0, retryAt: now + Math.max(1, Math.ceil((target - bucket.tokens) * 1000 / rate)) }
    }
    if (ctx.config.cloud) {
      const period = new Date(now).toISOString().slice(0, 7)
      const key = `_send_reserved:${input.accountId}:${period}`
      const reserved = Number(getSettingSync(ctx, key) || 0)
      const sent = ctx.db.get<{ emails_sent: number }>('SELECT emails_sent FROM usage_snapshots WHERE account_id = ? AND period = ?', input.accountId, period)?.emails_sent ?? 0
      const used = Math.max(reserved, sent)
      const max = policyFor(ctx, account).limits.maxEmailsPerMonth ?? Infinity
      granted = Math.max(0, Math.min(granted, max - used))
      if (granted) ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(used + granted))
      if (used >= max) {
        bucket.queue = bucket.queue.filter((entry) => entry.accountId !== input.accountId)
        ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(bucket))
        return { granted: 0, retryAt: Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1) }
      }
    }
    bucket.tokens -= granted
    if (granted) bucket.queue = bucket.queue.filter((entry) => entry.accountId !== input.accountId)
    ctx.db.run('INSERT INTO install_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(bucket))
    return { granted, retryAt: granted >= want ? null : now + Math.max(1, Math.ceil((1 - Math.min(bucket.tokens, 1)) * 1000 / rate)) }
  })
}
