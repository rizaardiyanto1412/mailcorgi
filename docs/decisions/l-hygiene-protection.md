# Unit L: list hygiene and account protection

This file records additions to the architecture contract and the shared changes needed by hygiene.
`docs/architecture.md` remains unchanged, as required by the feature-unit instructions.

## Reminder lifecycle

Hygiene defaults to enabled, eight ignored issues, a 90-day minimum subscription age, and a 14-day reply window.
Settings also include strict engagement, a subject, and Markdown copy. The reply window accepts 1 through 30 days,
which fits the existing keep-token lifetime. A change to the window applies to future reminders.

A completed issue queues `hygiene.scan`. A daily maintenance pass catches eligibility changes and missed scans.
Each scan creates at most 25 recipients in a hidden `kind: 'keep'` campaign. The normal `send.batch` path sends
at most 10 keep recipients per batch, with the normal sender, theme, unsubscribe headers, permits, and suppression checks.
`{{keep_url}}` is replaced before rendering with `signToken(ctx, 'k', [contactId, issuedAt])`.
The first render persists `issuedAt`, so provider retries use the same link and message.

`hygiene_requests` retains request history after a keep confirmation clears `contacts.keep_asked_at`.
The 180-day cooldown uses the send time, or the first attempt time if the provider result is uncertain or failed.
An unresolved pending request prevents another reminder. Definite skips before an attempt can qualify again.
Cleaning starts only after a delivery becomes sent, including an early provider event that proves handoff.
The cleaner uses `setContactStatus(..., 'cleaned')`, which adds the newsletter suppression and event.
Confirmed signup clears the pending ask and engagement streaks. Only issues increase ignored streaks.

Turning hygiene off stops new reminders, skips queued reminders, and suspends cleaning. Turning it back on
can clean a reminder whose original deadline passed while hygiene was off. Account protection always remains enabled.

## Strict engagement and proxy detection

A module migration adds `contacts.strict_ignored_streak`, initially copied from `ignored_streak`.
Human opens, accepted clicks, and keep confirmation reset both counters. Recognized privacy-proxy opens reset
only the normal counter. The existing open event carries `data.privacyProxy`.

The tracking route recognizes the available Apple Mail, mail-privacy, iCloud, and Google image-proxy user-agent markers.
Existing scanner and immediate-open exclusions still apply in both modes. Neither platform supplies a reliable
Apple MPP identity for a generic browser user agent. Such traffic cannot be distinguished from a human open
with the current request metadata. Historical opens cannot be reclassified before this migration.

## Account protection and resume

The account window contains exactly the latest 1,000 sent deliveries, ordered by send time and delivery id.
Rates above 5% hard bounces or 0.3% complaints trigger protection. Exactly those limits do not trigger it.
A global spam-trap match triggers protection before provider handoff, without waiting for 1,000 deliveries.
`checkSuppressed` now also returns `spamTraps`, a subset of the suppressed hashes. Existing callers continue
to use `suppressed`. Sending checks up to 1,000 candidate hashes per batch, with SQL batches below 100 parameters.
The additional control lookup consumes one request from the shared job budget.

Provider-event ingestion checks account protection before returning, in the same RPC run. Protection pauses
all sending and scheduled campaigns, cancels their send jobs, and writes one owner notice. The evidence and
report job commit together. Reports contain counts and an incident id, never recipient addresses or email bodies.
The control alert handler deduplicates retries by account and incident title.

Cloud reports use the new `control.requestBlock({ accountId, evidence })` RPC. The existing `blockAccount` path
pushes the blocked policy and handles billing. That RPC deduplicates each incident and raises the admin alert.
Cloud resume requires an observed blocked policy followed by a newer active policy, so an unrelated plan update
cannot bypass the administrator's unblock. Self-hosted resume requires the account owner to confirm `RESUME`.

A module migration adds `deliveries.hygiene_epoch`. Explicit resume starts a fresh measurement epoch, avoiding
an immediate pause on the same historical events. Deliveries join the current epoch when actually sent,
including deliveries queued before resume. Protection waits for 1,000 sends in the new epoch before judging rates.
A spam-trap match still pauses immediately. Campaign-level rate baselines reset for resumed sends.

Section 5.3 gains `scheduled -> paused` and `paused -> scheduled` transitions for account protection.
`hygiene_paused` preserves whether each campaign was scheduled or sending and the original scheduled-job payload.
Resume restores the previous state and scheduling options. An overdue scheduled campaign starts when resumed.
Campaigns paused for another reason remain paused.

## Shared files

- `server/account/campaigns/model.ts` allows scheduled campaigns to pause and return to their schedule.
- `server/account/contacts/state.ts` clears stale asks and streaks on subscription confirmation.
- `server/account/modules.ts` guards every send action during a local protection pause.
- `server/account/sending/index.ts` exports the existing rate-baseline reset and guards scheduled starts.
- `server/account/sending/batch.ts` queues hygiene after issues, records actual reminder handoff, checks global
  suppression, and limits keep batches. Issue sends alone increase inactivity streaks.
- `server/account/sending/message.ts` substitutes the personalized, stable keep link before rendering.
- `server/account/tracking/events.ts` checks protection after provider events and tracks strict engagement.
- `server/account/tracking/routes.ts` flags recognized proxy opens and clears both streaks on keep confirmation.
- `server/account/usage/index.ts` records the blocked policy version required before cloud resume.
- `server/control/admin/index.ts` implements the missing block-request RPC and deduplicates protection alerts.
- `server/control/suppression/index.ts` returns spam-trap hashes with suppression results.
- `vite.config.ts` proxies tracking, unsubscribe, and keep URLs to the API. Their absence blocked the dev smoke check.

No dependencies were added. Migrations live in `server/account/hygiene/migrations.ts` and the HTTP smoke step
lives in `scripts/smoke/65-hygiene.ts`.

## Follow-ups for sibling units

The notifications unit can replace the direct `notifications` insert in `hygiene/protection.ts` with its exported
`notify` function once that interface lands. The current row uses `user_id = NULL` for an owner-facing notice.
Stats can read `events.data.privacyProxy` when it needs to distinguish recognized proxy opens.
Deployment needs no new environment variables or bindings.
