# Performance

Numbers from the load pass in `server/test/load.slow.ts` (`npm run test:slow`), on the Node build
with the `test` email provider, one process, SQLite in WAL mode. Machine: an Apple Silicon Mac mini,
Node 24, measured on 2026-11-16 on an idle machine (the earlier numbers were taken while CI ran
alongside). Re-run the test after a change that touches sending, contacts or stats and update this file.

## 100,000 contacts, one issue

| Step | Wall time | Notes |
|---|---|---|
| Create 100,000 contacts (`subscribe`, confirmed) | 8.1 s | 0.08 ms per contact, linear; 82 s before the fix below |
| Plan the send (audience → 100,000 delivery rows) | 0.4 s | one transaction, chunked inserts |
| Send 100,000 emails through the test provider | 35 s | 2,850 emails a second, 1,000 per alarm run; 56 s before the index audit |
| Stats rollup, full rebuild (`rebuild`) | 1.3 s | 100,000 deliveries, 100,000 events |
| Stats rollup, second full rebuild | 1.3 s | |
| Recurring `stats.rollup` job | 1.3 s | bounded to the last 3 days and recent campaigns |
| Campaign report (`stats.report`) | 1 ms | cached counters |
| Overview (`stats.overview`, 30 days) | 3 ms | |
| Hygiene scan over the whole list | 123 ms | picks 25 inactive readers per run |
| List health (`hygiene.health`) | 40 ms | |
| Segment count, custom field | 79 ms | |
| Segment count, "ignored the last issue" | 128 ms | correlated subquery over deliveries |
| Contacts page (50, keyset) | 1 ms | first and later pages alike |

| Resource | Value |
|---|---|
| Peak RSS of the test process | 558 MB (includes 100,000 outbox emails held by the test provider) |
| Account database after the run | 486 MB (100,000 contacts, 100,050 deliveries, 100,007 events, 100,000 outbox rows) |

The outbox rows are the test provider's copy of every email (about 350 MB of the file); a real
provider writes none.

## Row writes per operation

`npm run budget` (`scripts/write-budget.ts`) drives `wrangler dev` through a fixed scenario and
reads the dev-only write meter (`GET /api/dev/writes`), which sums `rowsWritten` and `rowsRead` of
every statement plus one write per `setAlarm`, the way Cloudflare bills a Durable Object. Index
entries are included. The meter also counts per statement, and the script prints, under every
operation, the statements that wrote rows grouped by table: that breakdown is the map for any
further cut. The at-volume rows import 1,000 contacts and send one issue to 1,002 readers, and the
"per item" column divides by that count so the fixed cost of a job or a campaign does not hide in it.
Measured on 2026-11-16, before and after the index audit (and unchanged after the trail review:
durable rate limits write only at their checkpoints, none of which a single signup or send reaches) (`WORKERS_PLAN=free`, a send rate of 100
a second, the `test` email provider):

| Operation | Rows written, before | Rows written, after | Rows read, after |
|---|---|---|---|
| SPA index (`GET /`), `/healthz` | 0 | 0 | 0 |
| `GET /api/auth/bootstrap`, `contacts.list`, `stats.overview` | 0 | 0 | 13 to 23 |
| Website page view (`GET /n/<slug>/`), either visitor | 0 | 0 | 8 to 11 |
| Public subscribe (`POST /api/public/subscribe/…`) | 30 | 13 | 16 |
| Import one contact (upload, start, process, including the job and the notification) | 66 | 49 | 187 |
| **Import 1,000 contacts, per contact** | **28.0** | **11.1** | 7.4 |
| Send one issue to two readers (plan, send, finish) | 128 | 94 | 293 |
| **Send one issue to 1,002 readers, per email** | **24.2** (22.2 without the test outbox) | **11.4** (**9.4** without the test outbox) | 167 |
| First open (`GET /t/o/`) | 11 | 4 | 13 |
| First click (`GET /t/c/`) | 14 | 8 | 22 |
| Repeat open of the same delivery | 0 | 0 | 8 |
| Idle minute, nothing queued | 0 | 0 | 0 |
| Idle minute with a campaign scheduled for tomorrow | 0 | 0 | 0 |

The "before" column is commit `5914ed0` with only the per-statement meter added. The `test` provider
writes every email to `outbox` (two rows: the row and its key); a real provider writes none, so the
number without the outbox is the one that counts on Cloudflare.

Where the rows went before, and where they go now, per item at volume:

| Table | Imported contact, before | after | Sent email, before | after | Why |
|---|---|---|---|---|---|
| `contacts` | 16 | 7 | 2 | 1 | The insert wrote 1 row + 2 unique keys + 7 indexes + the counter trigger, then a status update rewrote 3 index entries and a second update reset the streaks. Four indexes are gone, a new subscriber is inserted already subscribed, and the streak reset rides in the same statement. Per send, the engagement score is now computed in the counter update instead of a second pass over every recipient when the campaign finishes. |
| `events` | 6 | 4 | 5 | 0 | The row had four indexes; two remain (newsletter + time, and the contact timeline), plus the growth-by-source trigger. The `send` event is gone: the delivery row is the record and the timeline reads it. |
| `deliveries` | | | 14 | 8 | Insert 3 (row, unique key, the partial open-rows index), claim 2, sent 3 (the row, leaving the partial index, the message-id and hygiene partial entries). The contact indexes, the full status index and the full message-id index are gone, and the hygiene epoch is written in the same statement as `sent`. |
| `import_seen` | 3 | 0 | | | Was a row and its key per contact plus a delete at the end. Addresses already met are rebuilt from the chunks stored anyway and kept in memory for the run. |
| `imports`, `import_chunks` | 2 | 0.1 | | | One checkpoint per 50 rows instead of per row, committed with the rows it covers. |
| `daily_stats` | 1 | 0.02 | | | Once per newsletter, day and column per batch of 50. |
| per batch (`jobs`, alarm, `daily_stats`, `campaigns`, `usage`, control bucket) | | | 1.0 | 0.2 | The sender asked for permits every alarm run and got the handful of tokens that had trickled in, so a "batch" was 7 emails. The control store now grants a whole batch or says when it will fit, so a batch on Workers Free is 36 emails. The `jobs.run_at` index is gone too (the queue is a handful of rows and the alarm query never used it). |
| `outbox` (test provider only) | | | 2 | 2 | |

Signup went from 30 to 13 (contact 7, event 3 plus its trigger 2, daily counter 1), a first open from 11 to 4 (the delivery, the contact with its score in one statement,
the campaign counter, the daily counter; no event row), a first click from 14 to 8 (the click
event with two indexes stays: per-link uniqueness and the scanner-burst check need it).

Where the remaining rows go, and what each one buys:

- A sent email: 3 for the delivery row at planning, 2 to claim it (architecture 11.5 commits
  `sending` before the provider call), 3 to record the result (the row, the partial open-rows index
  it leaves, the message-id entry for webhooks and the hygiene window entry), 1 for the contact's
  counters, 0.2 for the batch's counters and job. Dropping the hygiene window index would save one
  more but would make the rolling bounce check scan the campaign's deliveries on every batch.
- An imported contact: 7 for the contact (row, two unique keys, three indexes, the active-contact
  trigger) and 4 for the signup event (row, two indexes, the growth-by-source trigger).
  `rebuildDaily` and the growth-by-source report count signups from these events, so they stay.
- Repeat opens, page views and rate limits are still batched in memory and land with the next
  write or alarm (the previous unit's work).

Deferred bookkeeping (page views, repeat opens, rate-limit counters) waits in memory and lands in
one batch with the next alarm, within five minutes of one that is queued anyway. A flushed page
view costs about 2 rows (the row and its index entry) plus one `daily_stats` upsert per newsletter
and day per batch. Over a day an idle account store writes about 5 rows every 30 minutes for its
stats check (about 250 a day). `docs/self-hosting.md` turns these numbers into a list size for
Workers Free.

Indexes dropped (base migration `0004-base`; `server/test/index-audit.test.ts` pins the plan of
every hot query against 50,000 contacts and 100,000 deliveries):

| Index | Why it was safe to drop |
|---|---|
| `contacts(newsletter_id, created_at)` | Covered by `contacts(newsletter_id, created_at, id)`, the paging index. |
| `contacts(newsletter_id, name, id)` | Only the contact list sorted by name used it; a 50,000-row sort takes well under a second and is a rare admin action. |
| `contacts(newsletter_id, email, id)` | The UNIQUE `(newsletter_id, email)` key already orders by email, and SQLite drops the trailing `id` sort term for a unique index (no temp B-tree). |
| `contacts(status)` | Only the hourly active-contact recount used it; `(newsletter_id, status)` serves that count as a covering scan. |
| `events(campaign_id, type)` | Only the soft-bounce count per campaign used it; replaced by a partial index that holds soft bounces only (near zero rows written). |
| `events(contact_id, at)` | Every query by contact now carries `newsletter_id` and uses the timeline index `(newsletter_id, contact_id, id)`. |
| `deliveries(contact_id)`, `deliveries(contact_id, campaign_id)` | The engagement segment filters and the timeline look up `(campaign_id IN (…), contact_id)` through the UNIQUE key; the unsubscribe page and hygiene use the key directly. |
| `deliveries(campaign_id, status)` | Replaced by the same index restricted to `queued` and `sending` rows: a sent row leaves it instead of staying for ever. |
| `deliveries(provider_message_id)` | Replaced by the same index restricted to rows that have a message id, so planning a delivery writes no NULL entry. |
| `jobs(run_at)` (both stores) | The next-wake query is `MIN(COALESCE(locked_until, run_at))`, which cannot use it; claiming scans a queue of a few rows. |

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
