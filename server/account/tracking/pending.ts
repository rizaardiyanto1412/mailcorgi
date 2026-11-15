import type { StoreCtx } from '../../core/store.ts'
import { isWriteRefused } from '../../core/db.ts'
import { randomToken } from '../../core/crypto.ts'
import type { ProviderEvent } from '../../email/index.ts'
import { unsubscribe } from '../contacts/index.ts'
import { bumpStat } from '../sending/index.ts'
import { ingestProviderEvents } from './events.ts'

/**
 * Suppressions the store could not write because the platform refused the row (the daily quota).
 * They wait in memory and, when the blob store is separate from the store's rows (R2, a disk),
 * as one small object each, so an eviction does not lose them. They are applied by the next flush,
 * by the daily ping and, above all, before any send batch: no email goes to a reader whose
 * unsubscribe is waiting.
 */
export type Pending =
  | { id: string; kind: 'unsubscribe'; contactId: string; campaignId: string | null }
  | { id: string; kind: 'events'; events: ProviderEvent[] }

type PendingInput = Pending extends infer P ? (P extends Pending ? Omit<P, 'id'> : never) : never

const LIST = 'tracking.pending'
const CHECKED = 'tracking.pendingChecked'
const REPLAY_LIMIT = 200
const keyOf = (ctx: StoreCtx, id: string) => `${ctx.accountId}/pending/${id}.json`

function list(ctx: StoreCtx): Pending[] {
  let items = ctx.memory.get(LIST) as Pending[] | undefined
  if (!items) {
    items = []
    ctx.memory.set(LIST, items)
  }
  return items
}

/** The unsubscribe link and the one-click POST: the contact, and the credit on the issue it came from. */
export function recordUnsubscribe(ctx: StoreCtx, contactId: string, campaignId: string | null) {
  ctx.db.tx(() => {
    const was = ctx.db.get<{ status: string }>('SELECT status FROM contacts WHERE id = ?', contactId)?.status
    if (!was) return
    unsubscribe(ctx, { contactId, reason: 'link', campaignId: campaignId ?? undefined })
    if (!campaignId || was !== 'subscribed') return
    const d = ctx.db.get<{ id: number; unsubscribed_at: number | null }>('SELECT id, unsubscribed_at FROM deliveries WHERE campaign_id = ? AND contact_id = ?', campaignId, contactId)
    if (d && !d.unsubscribed_at) {
      ctx.db.run('UPDATE deliveries SET unsubscribed_at = ? WHERE id = ?', ctx.now(), d.id)
      bumpStat(ctx, campaignId, 'unsubscribes')
    }
  })
}

/** Park an item the store could not write. Returns whether it would survive an eviction. */
export async function park(ctx: StoreCtx, item: PendingInput): Promise<boolean> {
  const full = { id: `${ctx.now()}-${randomToken(6)}`, ...item } as Pending
  list(ctx).push(full)
  ctx.later.add(LIST, applyPending)
  if (!ctx.platform.blobs.separate) return false
  try {
    await ctx.platform.blobs.put(keyOf(ctx, full.id), new TextEncoder().encode(JSON.stringify(full)), 'application/json')
    return true
  } catch {
    return false
  }
}

/** Whether an unsubscribe for this contact waits to be written. */
export const unsubscribePending = (ctx: StoreCtx, contactId: string) => list(ctx).some((item) => item.kind === 'unsubscribe' && item.contactId === contactId)

async function applyOne(ctx: StoreCtx, item: Pending) {
  if (item.kind === 'unsubscribe') recordUnsubscribe(ctx, item.contactId, item.campaignId)
  else await ingestProviderEvents(ctx, item.events, { park: false })
}

/** Apply what waits in memory, oldest first. Returns how many items still wait (writes were refused again). */
export async function applyPending(ctx: StoreCtx): Promise<number> {
  const items = list(ctx)
  while (items.length) {
    const item = items[0]
    try {
      await applyOne(ctx, item)
    } catch (err) {
      if (isWriteRefused(err)) {
        ctx.later.add(LIST, applyPending)
        return items.length
      }
      // A contact that no longer exists, or a malformed item: nothing left to record.
      console.error('[pending]', item.kind, err)
    }
    items.shift()
    if (ctx.platform.blobs.separate) ctx.platform.waitUntil(ctx.platform.blobs.delete(keyOf(ctx, item.id)).catch(() => {}))
  }
  return 0
}

/**
 * Apply what waits, after loading what an earlier instance parked in the blob store (once per
 * instance). Throws when the blob store cannot be listed: the caller must not send until it can.
 */
export async function replayPending(ctx: StoreCtx): Promise<number> {
  if (ctx.platform.blobs.separate && !ctx.memory.get(CHECKED)) {
    const items = list(ctx)
    const known = new Set(items.map((item) => item.id))
    const keys = (await ctx.platform.blobs.list(`${ctx.accountId}/pending/`)).sort()
    for (const key of keys.slice(0, REPLAY_LIMIT)) {
      const blob = await ctx.platform.blobs.get(key)
      if (!blob) continue
      try {
        const item = JSON.parse(new TextDecoder().decode(blob.bytes)) as Pending
        if (item && typeof item.id === 'string' && !known.has(item.id)) items.push(item)
      } catch {
        await ctx.platform.blobs.delete(key).catch(() => {})
      }
    }
    if (keys.length <= REPLAY_LIMIT) ctx.memory.set(CHECKED, true)
  }
  return applyPending(ctx)
}
