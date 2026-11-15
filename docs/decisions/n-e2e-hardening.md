# Unit N: end-to-end verification and hardening

Deviations from `docs/architecture.md`, and the dev-only switches the full journey needs.

## `MC_TEST_DNS`: canned DNS answers and the dev endpoints

Contract: section 3.2 says `resolveDns` is DNS over HTTPS, and section 6 lists no dev endpoints.

Deviation: `MC_TEST_DNS` (a JSON object keyed `TYPE:name`) replaces every DNS lookup with canned
answers, and turns on four dev-only surfaces: the account actions `dev.outbox` and `dev.ingest`,
the control action `dev.controlOutbox` (all install-admin only), and the public control route
`GET /api/dev/code?email=` that returns the newest sign-in code emailed to an address. The same flag
enables the `test` billing provider (`BILLING_PROVIDER=test`) and its webhook `POST /hooks/test`,
which applies a plain JSON subscription event with no signature.

Why: the smoke journey has to verify a sending domain, read confirmation and invitation emails,
sign up in cloud mode, feed bounce and complaint events, and upgrade a plan, over plain HTTP against
both platforms. None of that is reachable without DNS or a real provider.

Guard: the flag is inert when `NODE_ENV=production` (Docker sets it) and, on the Worker, whenever
the app URL is not a loopback address (`wrangler dev` sets `APP_URL=http://127.0.0.1:<port>`). A
deployed Worker always has a public `APP_URL`, so `config.testDns` is null there whatever variables
say. `server/test/e2e-hardening.test.ts` checks that every surface answers 404 without the flag.

## `Platform.destroyStore`

Contract: section 6 (control/admin) says deleted accounts keep an empty database and a policy
tombstone because the platform has no destroy method.

Deviation: `Platform.destroyStore(ref)` exists. Node closes the handle and deletes the `.db`,
`-wal` and `-shm` files; the Worker's control object calls `destroy(accountId)` on the account
object, which runs `deleteAlarm()` and `deleteAll()`. The `account.delete` job calls it after
`selfWipe` reports done and before the control rows go. A retry after the store is gone treats a
404 from the account store as a finished wipe. The old "an old RPC cannot bootstrap deleted data"
guarantee is replaced by "there is no data left": bootstrap is only ever called with a fresh id.

## Send now tolerates clock drift

Contract: section 5.3 has `draft → scheduled → sending`. `campaigns.send` schedules for `ctx.now()`
and the transition then re-reads the clock, so on a real clock the check `scheduledAt < now` failed
whenever a millisecond passed in between (the fake test clock never moves). The transition now
accepts a time up to 5 seconds in the past (`SCHEDULE_DRIFT_MS`); `campaigns.schedule` still
demands at least a minute ahead.

## A deleted contact can rejoin through double opt-in

Contract: 11.7 says `'asserted'` never revives a suppressed or deleted address. It said nothing
about `'pending'`, and the code treated it like `'asserted'`, so a reader the owner had deleted
could never sign up again. Now `'pending'` with no existing row creates an unconfirmed contact even
with a tombstone or a newsletter-level suppression; the tombstone and suppression stay until the
reader confirms (`'confirmed'` clears them). Account-wide suppressions (hard bounce, complaint)
still block.

## Saved Cloudflare settings

`cf_api_token` and `cf_zone_id` saved in the admin console are now read through
`control.getInstallSettings`, so the environment wins when set and the saved values apply
otherwise. Each hostname job takes one more budget unit for that RPC.

## `MAX_NEWSLETTERS` is gone; `NODE_ENV` has a job

`MAX_NEWSLETTERS` was parsed and never read; it is removed from the config and the environment
reference. `NODE_ENV=production` now turns off the dev switches above.

## Smoke runner

`npm run smoke` runs the self-hosted steps (`scripts/smoke/*.ts`) and the cloud steps
(`scripts/smoke/cloud/*.ts`) against the Node build and `wrangler dev`, four server starts in all.
`--selfhosted`, `--cloud` and `--only node|wrangler` narrow a local run. The cloud servers get
`CLOUD=true`, `ADMIN_EMAILS=smoke@example.com` and `BILLING_PROVIDER=test`.
