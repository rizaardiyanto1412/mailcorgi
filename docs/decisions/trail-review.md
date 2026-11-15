# Trail review: durable limits, crash-safe counters, parked suppressions (fix/trail-review)

Three risks an independent reviewer flagged after the write-budget and index-audit changes, each
with a test that failed before the fix. Folded into `docs/architecture.md` 3.2 and 10.

- **Rate limits that guard authentication and email to strangers are durable again.**
  `allowRate(…, { durable: true })` checkpoints the count in `rate_limits` every fifth of the limit
  (at least every attempt) and at the limit. A restart, an eviction or key churn forgives at most one
  gap minus one; the cost is at most five rows per key and window. Load-only limits (website, API
  key, unsubscribe posts) stay in memory. Code guesses were already counted on the code row.
  `pruneRates` now runs from every alarm (it was never called). Numbers:
  `docs/security-review.md`, tests: `server/test/ratelimit-durable.test.ts`.
- **A send batch's counter write is one transaction, and every counter it carries is repairable.**
  The hourly `usage.push` recounts the month's emails from `deliveries.sent_at` over the campaigns
  that sent in the period (`usage.emails_sent` only rises, so test emails stay counted) and pushes
  the repaired number to the control store, whose permit reservation is written before the sends and
  so never undercounts. The rollup's change marker now includes the number of open delivery rows,
  so a batch that died mid-campaign triggers a daily recount. Contact counters, clicks, opens,
  signups' daily counts, growth by source and the active-contact trigger were checked and are
  either in the same transaction as the row they summarize or repaired hourly (the active-contact
  counter, tested in `contact-counter.test.ts`). Page views and repeat opens are deferred in memory
  by design and may lose up to a minute. Test: `server/test/send-crash.test.ts`.
- **An unsubscribe or a provider event that meets a refused write is parked, not lost.** Option (b)
  from the brief: a small JSON object per item under `<account>/pending/` in the blob store when it
  is separate from the store's rows (`BlobStore.separate`: R2 and the Node disk), plus the memory
  copy. The reader or provider is answered as landed; the send batch replays pending items before
  it claims anything and sends nothing while any wait; `claimDelivery` skips a contact whose
  unsubscribe waits; the daily `ping` and the next deferred flush also replay. Option (a), a write
  reserve, was not chosen: the meter is per object instance and the quota is per Cloudflare
  account across every store, so no store can know how close the account is. Without a separate
  blob store (a Worker without `IMAGES`) the page still says "try again later" and the memory copy
  lands if the instance survives. `ingestProviderEvents` is now async and takes `{ park }`.
  Test: `server/test/pending-suppression.test.ts`.

Interface additions: `BlobStore.separate?: boolean` (3.2), `RateOptions` on `allowRate`.
