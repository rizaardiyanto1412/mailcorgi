# Unit K: stats and notifications

This record describes the choices and contract deviations in unit K. The unit brief and
`docs/development.md` require this file instead of an edit to `docs/architecture.md`.

## Campaign counters and rebuilds

`campaigns.stats.sent` counts deliveries with `sent_at`, including those later delivered, bounced,
or complained. The previous sending recount used only the current `sent` status, while tracking
incremented a lifetime counter. The sending recount, threshold denominator, and completion message
now use the lifetime count consistently. Delivered, bounced, and complained remain current outcome
counts. Report rates use successful sends as their denominator. Click-to-open uses unique opens.
All rates return zero for an empty denominator and stay between zero and 100 percent.

`rebuildCampaign(ctx, campaignId)` rebuilds counters from deliveries and the recorded provider and
soft-bounce events. It preserves sending's resume baselines. The timeline counts first timestamps
in the first 48 hours after `send_started_at`. Historical delivery notifications stay in the
timeline even when a recipient later bounces or complains. Unique engagement uses delivery
timestamps after tracking's scanner rollback.

`rebuild(ctx, newsletterId)` rebuilds `daily_stats`, growth sources, website breakdowns, and campaign
caches. Subscription totals exclude pending signups. Confirmation after a pending signup counts
once. Unsubscribes, cleaning, hard bounces, and complaints reduce subscriber growth. Source history
uses the event's source, then the current contact's source, then `unknown` if neither survives.

The recurring `stats.rollup` job queues one daily rebuild per active newsletter every five minutes.
Each newsletter job queues separate campaign jobs so an alarm can yield between campaigns. A report
with an absent or old breakdown queues a campaign rebuild. Until that job runs, the report shows
cached totals and says that its breakdown is being prepared. Raw events, deliveries, and page views
are read by jobs and rebuilds, not by dashboard requests. Recipient pages and CSV exports read
indexed delivery rows in pages of at most 500.

The additional module tables are `stats_reports`, `stats_sources`, and `stats_website`. They keep
report timelines, provider results, source growth, and traffic dimensions out of page-load recounts.
The current subscriber count is one indexed `contacts(newsletter_id, status)` count. This is a
contract exception to the requirement that every displayed number come from `daily_stats` or
`campaigns.stats`. It keeps the current count correct after contact deletion and reactivation.
The overview test includes 50,000 contacts and 200 campaigns and caps page-load reads at ten.

Hourly and daily jobs recount the retained history. A large account with years of tracking data may
need an incremental rollup checkpoint later. There is no event-retention job in this unit.

## Notification visibility and delivery

`notify(ctx, { kind, tone?, title, body?, href?, userId? })` is the public account-module function.
`notificationKinds` and `notificationTones` define all supported kinds and their default tones.
A notification without `userId` targets the account owner. Existing rows with a null user also
remain visible only to the owner. Explicit user notifications are visible only to that user.
Read receipts belong to the viewing user. The bell marks the visible page read when opened.
Timestamp-and-id cursors preserve notifications created in the same millisecond.

Paused or failed campaigns, failed domains, account blocks, and near-limit warnings email the
owner. Successful imports, completed campaigns, verified domains, and accepted invites stay in the
bell. Cooldowns persist in SQLite and allow at most one owner email per kind in six hours. Near-limit
notifications fire once per resource per UTC month at 90 percent. Email usage checks run both when
sending increments usage and when usage snapshots run.

The email jobs record an attempt before calling `platform-email`. This favors at-most-once alerts
after a crash or an uncertain provider result. An email attempt that fails is not automatically
resent. The in-app notification remains available. Exactly-once email delivery would require a
stable idempotency key through `platform-email` and a provider that honors it.

`control.raiseAlert` now delegates to exported `raiseAdminAlert`. Alert rows remain available to the
existing admin page. Emails to distinct `ADMIN_EMAILS` use the same persistent six-hour cooldown per
kind. Dead jobs already reach `raiseAlert`. Provider refusals and failed webhook verification now
reach it too, and account blocking raises an admin alert. Cooldowns reduce email volume while
preserving every alert row.

The control store forwards invite acceptance through a durable job. The account RPC remembers the
forwarded event id, so retrying that job cannot duplicate the notification.

Imports and list hygiene arrived from `main` with their own notification writes. Both now call
`notify`. That adds two kinds: `import_failed` (warn, emailed) and `account_protection` (danger,
emailed). Imports pass the importer's `userId`, so a teammate's import stays in that teammate's
bell and only emails the owner when the owner ran it.

## Shared-file edits

- `server/account/sending/stats.ts` replaces the local notification insert with the notifications
  export and fixes the recount and threshold denominator described above.
- `server/account/sending/index.ts` exports `EMPTY_STATS` for report defaults.
- `server/account/sending/batch.ts` fixes the completion count and queues provider-refusal alerts.
- `server/account/domains/index.ts` calls `notify` when verification changes.
- `server/account/usage/index.ts` calls notification helpers for policy blocks and plan limits and
  seeds the stats rollup job at bootstrap.
- `server/account/hygiene/protection.ts` calls `notify` instead of inserting a `notifications` row.
- `server/account/notifications/index.ts` replaces the minimal `notify` that `main` added for imports.
  The imports call sites keep their arguments; they type-check against the full signature.
- `server/control/accounts/team.ts` queues a notification when an invite is accepted.
- `server/control/admin/index.ts`, `alerts.ts`, and `migrations.ts` add the exported alert function,
  cooldowns, email jobs, and the durable notification-forwarding job. The existing actions remain.
- `server/edge/email-hooks.ts` reports failed webhook verification through control RPC.
- `web/src/features/stats/index.tsx` keeps the existing feature registration and imports the new
  overview and report pages from the directories assigned to this unit.
- Existing migration, sending and hygiene tests now include module migrations and distinguish the
  send job and campaign emails from background jobs and system emails. The hygiene spam-trap test
  now counts only campaign emails, because the owner gets an `account_protection` alert email.

All schema changes are module migrations. No dependency was added. The smoke step is
`scripts/smoke/65-k-stats-notifications.ts`. Permission entries are in separate stats and notification
files. The Node, Worker, and Vite smoke runners load every page built here and call its actions.
