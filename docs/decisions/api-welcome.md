# Welcome email for API and MCP contacts

## The bug

`contacts.create` (REST `POST /newsletters/:newsletterId/contacts`, MCP `contacts_create`) only called
`subscribe(..., { consent: 'asserted' })`. Only the public form called `queueWelcome` and `deliverMail`, so an
API-created contact was inserted as `subscribed` and never got the welcome. The cause was a missing call, not a
wait on `confirmedAt`. CSV imports also call `subscribe()` and still send no welcome.

## When the welcome goes out

| Path | Trigger |
|---|---|
| Public form, double opt-in off | `subscribe()` returns `subscribed` on submit |
| Public form, double opt-in on | After the confirmation link is used (unchanged) |
| `contacts.create` (REST, MCP) | `subscribe()` returns `subscribed`, double opt-in on or off |
| CSV import | Never |

`contacts.create` asserts consent and inserts the contact as `subscribed` at once (`confirmedAt` stays null
unless consent is `confirmed`). Waiting for a confirmation would mean these contacts never get a welcome, which
is this bug. `doubleOptIn` only governs the public form. A pending (`unconfirmed`) contact gets nothing until it
is subscribed, whichever path does that. `transactional` and `sendFormat` change only how the email is rendered
(footer, headers, plain or html), never when it is triggered.

The call queues the welcome in the same transaction as the subscription, with the existing
`queueWelcome` key `welcome:${contactId}:${subscribedAt}` (`INSERT OR IGNORE` into `signup_mail`), then tries
`deliverMail` straight away. The durable `signup.mail` job stays the retry path. `deliverMail` still refuses a
contact who is not subscribed, is suppressed, or whose welcome was turned off.

- `outcome: 'exists'` (a repeat upsert, such as a tag or plan sync) never queues anything.
- `outcome: 'suppressed'` or `limit` never queues anything.
- An existing `unconfirmed` contact that this call moves to `subscribed` counts as newly subscribed.
- The API path does not call `publicSignup`; tag-triggered sequences still start from the tag listeners.

contacts cannot import signup (the dependency runs the other way), so `contacts.create` announces the
subscription through `onApiSubscribe` and signup registers the listener that queues and delivers the welcome.

## `sendWelcome` on `contacts.create`

Boolean, default `true`. `false` never queues a welcome from that call, for API imports and migrations.
It is not stored; it only affects this call.

## `signup.sendWelcome`

REST `POST /newsletters/:newsletterId/signup/welcome/send`, MCP `signup_sendWelcome`, admin, a write.
Input `newsletterId`, `contactId`. It targets that one contact only: there is no list, no "everyone who missed
it" and no backfill, and nothing runs at deploy or boot.

- Contact missing: `404 not_found`. Not subscribed: `409 not_subscribed`. Suppressed: `409 suppressed`.
  Welcome off or never saved: `409 welcome_disabled`. Nothing is sent in these cases.
- First call: `{ sent, alreadyQueued: false, mailId, state }` after queueing and one delivery attempt
  (`sent` is false while a retry is pending).
- A welcome for this subscription already queued or sent (same key): nothing is sent,
  `{ sent: false, alreadyQueued: true, mailId, state }`.

## Existing contacts

No migration or job touches existing contacts. Contacts that never got a welcome stay as they are until an
operator calls `signup.sendWelcome` for one of them.

## `sends.list`

`sends.list` reads `deliveries`, and the welcome went out as system mail without a delivery row. Now, when
`deliverMail` marks a welcome `sent`, it also does `INSERT OR IGNORE` of a `deliveries` row (`status 'sent'`,
`sent_at` now) for the welcome campaign and that contact, in the same transaction. `source.type` is `welcome`
and `campaignId` is the welcome campaign. This holds for the public form, `contacts.create` and
`signup.sendWelcome`.

- `UNIQUE (campaign_id, contact_id)` and the single evolving welcome campaign mean one row per contact. A later
  welcome after a resubscription is still sent (its `signup_mail` key differs); the log keeps the first row.
- Only newly sent welcomes appear. Earlier `signup_mail` rows are not backfilled.
- The welcome campaign stays a draft with `kind = 'welcome'`. Issue stats already filter `kind = 'issue'`.
  The daily `sent` rebuild and the hygiene bounce/complaint rate sample skip `kind = 'welcome'`, so the welcome
  does not move those numbers (a system mail carries no delivery id, so a bounce cannot reach the row anyway).
  Usage counting already ignored a draft campaign.
- `contacts.last_sent_at`, `sent_count`, `engaged_score` and the ignored streaks are not updated: a welcome is
  not an issue, a transactional one must not count as an ignored issue, and no contact row is rewritten by it.
