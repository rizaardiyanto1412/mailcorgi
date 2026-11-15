# Performance

Numbers from the load pass in `server/test/load.slow.ts` (`npm run test:slow`), on the Node build
with the `test` email provider, one process, SQLite in WAL mode. Machine: an Apple Silicon Mac mini,
Node 24. Re-run the test after a change that touches sending, contacts or stats and update this file.

## 100,000 contacts, one issue

| Step | Wall time | Notes |
|---|---|---|
| Create 100,000 contacts (`subscribe`, confirmed) | 5.3 s | 0.05 ms per contact, linear; 82 s before the fix below |
| Plan the send (audience → 100,000 delivery rows) | 0.8 s | one transaction, chunked inserts |
| Send 100,000 emails through the test provider | 56 s | 1,784 emails a second, 1,000 per alarm run |
| Stats rollup, full rebuild (`rebuild`) | 0.6 s | 100,000 deliveries, 200,000 events |
| Stats rollup, second full rebuild | 0.6 s | |
| Recurring `stats.rollup` job | 0.6 s | bounded to the last 3 days and recent campaigns |
| Campaign report (`stats.report`) | 2 ms | cached counters |
| Overview (`stats.overview`, 30 days) | 8 ms | |
| Hygiene scan over the whole list | 140 ms | picks 25 inactive readers per run |
| List health (`hygiene.health`) | 47 ms | |
| Segment count, custom field | 14 ms | |
| Segment count, "ignored the last issue" | 188 ms | correlated subquery over deliveries |
| Contacts page (50, keyset) | 1 ms | first and later pages alike |

| Resource | Value |
|---|---|
| Peak RSS of the test process | 556 MB (includes 100,000 outbox emails held by the test provider) |
| Account database after the run | 550 MB (100,000 contacts, 100,050 deliveries, 200,007 events, 100,000 outbox rows) |

The outbox rows are the test provider's copy of every email (about 350 MB of the file); a real
provider writes none.

## Row writes per operation

`npm run budget` (`scripts/write-budget.ts`) drives `wrangler dev` through a fixed scenario and
reads the dev-only write meter (`GET /api/dev/writes`), which sums `rowsWritten` and `rowsRead` of
every statement plus one write per `setAlarm`, the way Cloudflare bills a Durable Object. Index
entries are included. Measured on 2026-11-16, before and after the write-budget work:

| Operation | Rows written, before | Rows written, after | Rows read, after |
|---|---|---|---|
| SPA index (`GET /`), `/healthz` | 0 | 0 | 0 |
| `GET /api/auth/bootstrap` | 2 | 0 | 13 |
| `contacts.list` | 3 | 0 | 13 |
| `stats.overview` | 3 | 0 | 23 |
| Website page view (`GET /n/<slug>/`) | 9 | 0 | 11 |
| Website page view, second visitor | 6 | 0 | 8 |
| Public subscribe (`POST /api/public/subscribe/…`) | 31 | 30 | 19 |
| Import one contact (upload, start, process) | 91 | 66 | 175 |
| Send one issue to two readers (plan, send, finish) | 133 | 114 | 214 |
| First open (`GET /t/o/`) | 14 | 11 | 15 |
| Repeat open of the same delivery | 6 | 0 | 8 |
| First click (`GET /t/c/`) | 14 | 14 | 34 |
| Idle minute, nothing queued | 0 | 0 | 0 |
| Idle minute with a campaign scheduled for tomorrow | 0 | 0 | 0 |

The "before" column was measured on commit `b548698` with only the meter added. Every read used to
cost two or three rows because each store invocation re-armed its alarm (one row) and the
account-exists and session lookups at the edge re-armed the control store too. Now a store calls
`setAlarm` only when the next wake time differs from the one it holds in memory.

Deferred bookkeeping (page views, repeat opens, rate-limit counters) waits in memory and lands in
one batch with the next alarm, within five minutes of one that is queued anyway. A flushed page
view costs about 2 rows (the row and its index entry) plus one `daily_stats` upsert per newsletter
and day per batch. The idle rows above are measured over one minute; over a day an idle account
store now writes about 5 rows every 30 minutes for its stats check (about 250 a day), where it used
to rebuild its daily stats every 5 minutes (about 25 rows each, 7,000 a day) whether anything had
changed or not.

Per email the marginal cost is about 20 rows (the delivery row and its indexes at planning, two
status updates, the contact, the hygiene epoch, the `send` event with its four indexes); the daily,
campaign and usage counters are now written once per batch instead of once per email. A first open
is 11 rows, a click 14, a signup 30 (the contact has nine indexes, the event four, plus the
confirmation mail and its job). `docs/self-hosting.md` turns these into a list size for Workers
Free.

Where the remaining rows go, and what would cut them further (not done here):

- `contacts` carries nine indexes, so every new contact writes ten rows; `events` carries four.
  Dropping the paging indexes that the contacts page does not use would save three per signup and
  per imported row.
- A send event per email (five rows with indexes) exists for the contact timeline; a per-campaign
  summary would do for the report.

## What the load pass changed

- `subscribe()` counted every active contact on each call to record a monthly peak nobody read.
  Successive 10,000-contact batches took 1.0 s, 2.5 s, 4.3 s … 15.1 s. The count now runs once an
  hour in `usage.push`, which already counts contacts for the control store.
- The recurring `stats.rollup` recounted all history every 5 minutes (1 s per 100,000 deliveries).
  It now repairs the last 3 days of `daily_stats` and rebuilds only campaigns that are in flight,
  sent within 3 days, or never cached. Live counters keep today correct; `rebuild(ctx, newsletterId)`
  still recounts everything when a module needs it.

## Still linear in list size, by design

- The audience query for a send reads every matching contact once (`ORDER BY random()`), 0.9 s
  at 100,000.
- `reserveContacts` counts active contacts when a plan limit exists (cloud only): about 1.4 ms at
  100,000 contacts, once per imported row. A 150,000-contact import on the largest plan spends
  roughly two extra minutes there. A maintained counter would remove it; not done in this unit.
- The "ignored the last N issues" segment condition runs a correlated subquery per contact.
