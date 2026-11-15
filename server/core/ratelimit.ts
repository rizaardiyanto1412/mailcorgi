import type { Db } from './db.ts'

/**
 * Fixed-window counters. They live in memory, so an ordinary request writes nothing. A key that
 * reaches its limit is written to `rate_limits` once, so a block survives a restart.
 *
 * A limit that guards authentication or emails to strangers is `durable`: its count is also
 * written at every checkpoint (every fifth of the limit, at least every attempt), so a restart,
 * an eviction or key churn forgives at most one checkpoint's worth of attempts (`max / 5`,
 * rounded up, minus one) and costs at most five row writes per key and window. A limit that only
 * protects against load keeps its count in memory and starts over after a restart.
 */
interface Window {
  start: number
  count: number
  /** The count the `rate_limits` row holds for this window, 0 when it holds none. */
  stored: number
}
const counters = new WeakMap<Db, Map<string, Window>>()

function windows(db: Db): Map<string, Window> {
  let map = counters.get(db)
  if (!map) {
    map = new Map()
    counters.set(db, map)
  }
  if (map.size > 20_000) for (const key of [...map.keys()].slice(0, 5_000)) map.delete(key)
  return map
}

export interface RateOptions {
  /** Checkpoint the count in the database so it survives a restart. */
  durable?: boolean
}

/** How many attempts a durable limit may forgive after a restart: the gap between checkpoints, minus one. */
export const durableSlack = (max: number) => Math.max(1, Math.ceil(max / 5)) - 1

export function allowRate(db: Db, key: string, max: number, windowMs: number, now: number, opts: RateOptions = {}): boolean {
  const windowStart = now - (now % windowMs)
  const map = windows(db)
  let w = map.get(key)
  if (!w) {
    const row = db.get<{ window_start: number; count: number }>('SELECT window_start, count FROM rate_limits WHERE key = ?', key)
    w = row && row.window_start === windowStart ? { start: row.window_start, count: row.count, stored: row.count } : { start: windowStart, count: 0, stored: 0 }
    map.set(key, w)
  }
  if (w.start !== windowStart) {
    w.start = windowStart
    w.count = 0
    w.stored = 0
  }
  if (w.count >= max) return false
  w.count++
  const step = opts.durable ? Math.max(1, Math.ceil(max / 5)) : max
  if (w.count > w.stored && (w.count >= max || w.count % step === 0)) {
    db.run('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count', key, windowStart, w.count)
    w.stored = w.count
  }
  return true
}

export function clearRate(db: Db, key: string) {
  const w = windows(db).get(key)
  windows(db).delete(key)
  if (!w || w.stored) db.run('DELETE FROM rate_limits WHERE key = ?', key)
}

/** Drop windows older than a day. Called from every alarm; it writes only when there is something to drop. */
export const pruneRates = (db: Db, now: number) => {
  if (db.get('SELECT 1 FROM rate_limits WHERE window_start < ? LIMIT 1', now - 86_400_000)) db.run('DELETE FROM rate_limits WHERE window_start < ?', now - 86_400_000)
}
