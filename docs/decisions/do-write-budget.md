# Durable Object write budget

A Workers Free deployment went down after a few test runs: the account hit 100,000 Durable Object rows
written in a day, and every request failed with `500 internal`, because each store invocation ended
with `setAlarm` (one row write) whether or not anything changed.

Decisions, folded into `docs/architecture.md` 3.2, 3.5, 9 and 11.4:

- `Platform.getAlarm` was added. A store keeps the armed time in memory and calls `setAlarm` only when
  the next wake time differs; after a restart it asks the platform once.
- `StoreCtx` gained `meter`, `later` and `memory`. Page views, repeat opens and rate-limit counters are
  kept in memory and written in one batch by the next alarm (within five minutes of an alarm that is
  queued anyway). Losing a minute of them on an eviction is accepted.
- Rate limits are counted in memory; a key that reaches its limit is written once so a block survives a
  restart. Counts below the limit are forgotten on restart.
- The stats rollup skips its rebuild when nothing changed (marker in memory) and waits 30 minutes
  between idle checks instead of 5.
- A send batch writes the daily, campaign and usage counters once per batch, not once per email. A crash
  loses at most the last batch's tally, which the rollup repairs.
- A refused write is `503 storage_write_limit` everywhere. Reads keep working. A job that meets one
  spends no attempt; the alarm throws so the platform retries, and a daily cron trigger (`5 0 * * *`)
  pings every account store after the quota resets.
- The setup checklist does not show today's write use: the meter is per object instance and resets on
  eviction, and a durable daily counter would itself cost writes. `npm run budget` measures instead.
