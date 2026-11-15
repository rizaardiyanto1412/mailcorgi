# Index audit and rows per operation (perf/index-audit)

Goal: make the app useful on Workers Free, where every index entry is a row written and the account
gets 100,000 a day. Numbers and the per-table breakdown are in `docs/performance.md`.

Deviations from the contract, each folded into `docs/architecture.md` in the same branch:

- **Base indexes dropped through a new base migration.** The dropped indexes were created by
  `0001-base` and `0003-base`, which no module owns, so `0004-base` (account) and `0003-base`
  (control, `jobs_due`) were appended to the base lists. Shipped ids and SQL are untouched; 3.1 now
  says an index change to a base table is appended as the next base id.
- **Sends and first opens write no `events` row** (5.2, 3.2). The delivery row carries `sent_at`
  and `opened_at`; `contacts.get` returns a `deliveries` list and the web timeline merges it with
  the events. Clicks stay as events: per-link uniqueness and the scanner-burst check read them.
  `rebuildDaily` already counted sends and opens from deliveries, so the reports are unchanged. The
  rollup's change marker now also sums the campaigns' open and click counters, since opens no longer
  add an event id.
- **`import_seen` is no longer written** (5.2 module list). The addresses an import has already met
  are rebuilt from the stored chunks (which were kept anyway) and cached in memory for the run.
  The table stays so newsletter deletion keeps working on old rows.
- **Imports commit 50 rows per transaction** with one checkpoint (counters and chunk position) and
  one `daily_stats` write per newsletter, day and column. A crash replays at most 50 rows and the
  replay is exact because the checkpoint commits with the rows.
- **Send permits are granted whole or not at all.** `control.takeSendPermits` grants `min(want,
  share)` tokens when the bucket holds them and otherwise returns `retryAt` for when it will. The
  sender used to spin every alarm run for the few tokens that had trickled in, paying its per-batch
  rows for 7 emails at a time (11.5 says the pace is install-wide; the average rate is unchanged).
- **Queries on queued and sending deliveries repeat the partial index's WHERE term**
  (`OPEN_ROWS` in `server/account/sending/batch.ts`), because SQLite uses a partial index only when
  the query implies its predicate term for term.
- `hygiene.recordHygieneSend` no longer updates the delivery; the sender writes `hygiene_epoch` in
  the same statement that marks the row sent (`hygieneEpoch(ctx)` is exported for it).
