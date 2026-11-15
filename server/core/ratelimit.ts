import type { Db } from './db.ts'

/** Fixed-window counters in the store's `rate_limits` table. */
export function allowRate(db: Db, key: string, max: number, windowMs: number, now: number): boolean {
  const windowStart = now - (now % windowMs)
  const row = db.get<{ window_start: number; count: number }>('SELECT window_start, count FROM rate_limits WHERE key = ?', key)
  if (!row || row.window_start !== windowStart) {
    db.run('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1', key, windowStart)
    return true
  }
  if (row.count >= max) return false
  db.run('UPDATE rate_limits SET count = count + 1 WHERE key = ?', key)
  return true
}

export const clearRate = (db: Db, key: string) => db.run('DELETE FROM rate_limits WHERE key = ?', key)

/** Drop windows older than a day. Call from an alarm. */
export const pruneRates = (db: Db, now: number) => db.run('DELETE FROM rate_limits WHERE window_start < ?', now - 86_400_000)
