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

Measured by summing `changes` over every statement on the Node driver:

| Operation | Rows changed |
|---|---|
| Plan one delivery | 1 |
| Send one email | 10 |
| One open | 7 |
| One click | 8 |
| One signup | 6 |

Cloudflare counts index entries too, so budget about double on Workers. `docs/self-hosting.md`
turns these into a list size for Workers Free.

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
