# Audit gaps

Fixes for the five gaps in the feature-completeness audit of 16 November 2026, and one doc error it
found. Each section names the contract it touches and the choice made.

## Every step release passes the same rate gate

Contract: section 6 **sending** says each gradual step is "released only while that campaign's hard
bounces stay under 2.5% and complaints under 0.08%".

Only the timed release checked that. `campaigns.sendMore` released the next step with no check, and
`campaigns.resume` reset the rate baseline, so the next timed release measured from zero and passed.

Now one gate, `stepGate`, reads the whole campaign's counters (at least 20 sent), never the counters
since the last resume. It guards three paths:

- the timed release in the send loop (it pauses the campaign, as before);
- `campaigns.sendMore`, which refuses with `409 step_held`, a message that names the rate, the number
  sent and the limit, and `details { reason, rate, limit, sent }`;
- `campaigns.resume`, which refuses the same way when a step is already due. A resume before the
  next step is due goes ahead, and the timed release holds that step when its time comes.

The auto-pause for a running step still measures from the last resume, as section 6 intends. The
engaged-first second step goes through the same gate. Scheduled sends were checked: `send.start` only
releases the first step, so they had no hole. Account protection's resume uses the timed release, so
the gate covers it too. An owner whose warm-up bounced can stop the send; nothing lets the next slice
out while the campaign's rates are over the limit.

## Email provider settings are checked as a whole

Contract: section 3.6 says provider credentials are entered in the install settings and env vars
take precedence.

`install.settings.set` now merges the update with saved values, lets env overrides win, and refuses
`400 missing_credentials` with `details { provider, missing }` when the chosen provider lacks what it
needs: SES region, access key ID and secret; Resend API key; SMTP host, plus the password when a user
is set. Clearing a needed credential is refused the same way. `install.settings.get` returns
`missing` for the saved provider, and **Admin → Email** marks those inputs. The setup checklist uses
the same list (`PROVIDER_CREDENTIALS` in `control/install`).

## Import results say who ended up unconfirmed

Contract: section 5.3 says an import makes a contact subscribed only when it asserts consent. The
default stays: a row without a subscribed status and confirmed consent is added as `unconfirmed`.

New column `imports.added_detail` (migration `2026-11-16-imports-added-detail`) counts added contacts
as `subscribed`, `no_status_column`, `pending_in_file` or `no_consent`. `imports.get` and
`imports.list` return `addedBreakdown { subscribed, unconfirmed, unconfirmedReasons, note }`
(`null` for imports that ran before the column existed). The report and the "Import finished"
notification split "added and subscribed" from "added but unconfirmed" and say why. The mapping step
shows, before upload, what status rows will get and that unconfirmed contacts receive nothing. The
`consent` and `defaultStatus` field descriptions, which feed REST, OpenAPI and MCP, say the same.

## `contacts.create` fails at the contact limit

Contract: section 11.7 keeps `subscribe()` returning `outcome: 'limit'` for internal callers.

`contacts.create` now throws `403 limit_reached` instead of returning a contact that was never
inserted; in cloud mode `runAction` adds `details.billingUrl`. Other callers:

- Imports already skip the row as `contact_limit`.
- The public signup endpoint used to answer "Thanks" and add nobody. It now answers
  `503 not_accepting` ("This newsletter is not taking new subscribers right now"), which the hosted
  form and `embed.js` show, and the owner gets one notification a month that signups are being
  turned away.
- The confirm link only promotes an existing unconfirmed contact, which already holds a plan slot.

`runAction` now keeps an error's own `details` and adds `billingUrl` to them, rather than replacing
them.

## Billing usage and limit errors are live

Contract: section 6 **control/billing** says usage snapshots are pushed hourly and are for display.

`billing.get` now asks the account store for live counts through a new RPC,
`account.liveUsage({}) → { contacts, emailsSent }`, which reads the maintained `active_contacts`
counter and this month's `usage` row. It returns `usage { contacts, emailsSent, live, updatedAt }`
and falls back to the snapshot, marked `live: false` with its time, when the store cannot answer.
Contacts here count subscribed and unconfirmed, the same number the limit uses.

Limit errors now carry the live count in the message and `details { resource, used, limit }`:
contacts, newsletters, team seats and test emails. `admin.accounts` stays on snapshots and returns
`usage_updated_at`; the admin list shows "Snapshot from 12 min ago" or "No usage reported yet".

## Team size is a plan limit in cloud mode only

Contract: section 6 **team** says "the owner invites up to 5 people per newsletter". That is wrong in
both modes. Self-hosted installs have no team limit. In cloud mode each plan sets
`maxTeamPerNewsletter` (2 on free, 5 on starter, up to 50 on scale), counted as members plus pending
invitations; 5 is only the fallback for a cloud plan with no value. The README, the self-hosting guide
and the cloud-mode guide now say so. Section 6 should read: "The owner invites people to each
newsletter as `admin` or `member`; in cloud mode the plan limits how many (members plus pending
invitations)."
