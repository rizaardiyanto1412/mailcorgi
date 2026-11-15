import type { Db } from './db.ts'

/**
 * Fixed-window counters. They live in memory, so an ordinary request writes nothing; a key that
 * reaches its limit is written to `rate_limits` once, so a block survives a restart. A restart
 * forgets counts below the limit, which only lets a client a little over it.
 */
interface Window {
  start: number
  count: number
  stored: boolean
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

export function allowRate(db: Db, key: string, max: number, windowMs: number, now: number): boolean {
  const windowStart = now - (now % windowMs)
  const map = windows(db)
  let w = map.get(key)
  if (!w) {
    const row = db.get<{ window_start: number; count: number }>('SELECT window_start, count FROM rate_limits WHERE key = ?', key)
    w = row && row.window_start === windowStart ? { start: row.window_start, count: row.count, stored: true } : { start: windowStart, count: 0, stored: false }
    map.set(key, w)
  }
  if (w.start !== windowStart) {
    w.start = windowStart
    w.count = 0
    w.stored = false
  }
  if (w.count >= max) return false
  w.count++
  if (w.count >= max && !w.stored) {
    db.run('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count', key, windowStart, w.count)
    w.stored = true
  }
  return true
}

export function clearRate(db: Db, key: string) {
  const w = windows(db).get(key)
  windows(db).delete(key)
  if (!w || w.stored) db.run('DELETE FROM rate_limits WHERE key = ?', key)
}

/** Drop windows older than a day. Call from an alarm. */
export const pruneRates = (db: Db, now: number) => {
  if (db.get('SELECT 1 FROM rate_limits WHERE window_start < ? LIMIT 1', now - 86_400_000)) db.run('DELETE FROM rate_limits WHERE window_start < ?', now - 86_400_000)
}
