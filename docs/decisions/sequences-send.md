# Email sequences: sending and enrollment

What the send path and the enrollment rules of email sequences (drips) decide, and why. The data
model and the draft actions came first (architecture 5.2 and 6); this unit makes a sequence run.

## Product decisions

- **Delays count from enrollment.** A step is due at `enrolled_at + delay_days × 86,400,000 ms`:
  exact elapsed time, no send window and no time zone. Nothing is due at enrollment, because the
  smallest delay is one day. The welcome email stays the day-0 email and is not part of a sequence.
- **Steps are sent in position order, so delays may not decrease.** `sequences.create`, `addStep`,
  `updateStep` and `reorderSteps` refuse an order where a step has a shorter delay than the one before
  it (`409 step_delay_order`). Equal delays are allowed (two emails on the same day). Data saved
  before the rule may break it; `sequences.activate` refuses such a sequence with the same code.
  A consequence: `reorderSteps` can only swap steps of equal delay. To move a step, change its delay.
- **No backfill.** Activating or resuming a sequence enrolls nobody. Only a contact who newly gains
  the entry tag (or signs up, or is entered by hand) while the sequence is active enters. A tag added
  while the sequence is paused or a draft does not enroll, then or later.
- **No re-enrollment.** `UNIQUE(sequence_id, contact_id)`: a contact is in a sequence at most once
  ever. After `completed` or `exited`, gaining the tag again does nothing, and `sequences.enroll`
  answers `409 already_enrolled`. A contact may be in several sequences at once.
- **Entry types.** `tag`: any write path that adds the tag (`contacts.create` for new and existing
  contacts, `contacts.update`, `contacts.bulk`, imports), through the contacts tag hook, in the
  transaction that wrote the tag. `signup`: only the public signup form, at the two places that queue
  the welcome email (single opt-in on submit, double opt-in on confirm); imports, the API and MCP never
  enter a signup sequence. `manual`: only `sequences.enroll`, which works for every entry type.
  `segment`: the schema keeps it, but `sequences.activate` refuses it with `409 not_supported_yet`.
  Segments are live filters with no change event, so entering by segment needs a periodic scan, which
  this unit does not add.
- **Unconfirmed contacts.** A contact who gains the entry tag while `unconfirmed` (double opt-in) is
  not enrolled. When they confirm (`unconfirmed → subscribed`), the status hook enrolls them into the
  active tag sequences whose tag they hold and that they were never in. Only this one transition
  enrolls: a contact who was already subscribed when the sequence was activated stays out (no
  backfill), and so does one who resubscribes after unsubscribing. One edge is accepted: an
  unconfirmed contact tagged before activation enters when they confirm after it.
- **Exits.** A new exit tag exits at once (`tag`). Any status change away from `subscribed` exits
  with the new status as the reason (`unsubscribed`, `bounced`, `complained`, `cleaned`); manual
  suppression unsubscribes the contact, so it arrives as `unsubscribed`. Deleting a contact removes
  their enrollment rows (their delivery rows stay, like every other delivery). Archiving a sequence
  exits everyone (`archived`). `sequences.exit` records `manual`, or `manual: <reason>`.
  The exit segment is read only right before a step is sent (`segment`), for the same reason a
  segment entry is not supported: there is no event to listen to. Exit tags are also checked at
  enrollment and before every send.
- **Archive, never delete.** Unchanged. `tags.delete` answers `409 tag_in_use`, listing the sequences,
  while a draft, active or paused sequence enters or exits by the tag.

## The catch-up rule

A sequence can fall behind: it was paused, one enrollment was paused, sending was switched off, the
account was blocked. When the tick looks at an enrollment whose next step is overdue:

- **Less than 24 hours late** (`GRACE_MS`): the step is sent normally, now.
- **24 hours or more late:** only the latest step that is already due is sent. Every due step before
  it gets a delivery row with status `skipped` and the error "Skipped: overdue when the sequence
  caught up.", which counts in the step's `skipped` stat and shows in its recipients list. Steps not
  yet due keep their own times.

So a contact never gets several emails at once after a pause. Delays are whole days, so with the
24-hour grace a step sent normally is never followed at once by a later-delay step. Two steps with
the same delay are deliberate and both go out. A single overdue step is itself the latest, so it is
sent, late; nothing is dropped silently.

The rule lives in one place, the tick. `sequences.resume` and `sequences.resumeEnrollment` only make
the enrollment due again (`next_run_at = enrolled_at + delay`), and the tick applies the rule.

## Sending

- **One job per newsletter.** `sequences.tick`, dedupe key `sequences.tick:<newsletterId>`, armed to
  the earliest `next_run_at`. Enrolling reads the job row and re-queues it only when the new time is
  earlier, so a large import costs one job row, not one per contact. No cron, no periodic scan.
- **One delivery row per step and contact.** `UNIQUE(campaign_id, contact_id)` on `deliveries` is the
  idempotency key. The tick inserts the row, and `sendDelivery` (extracted from `send.batch`, which
  now calls it too) claims it, renders with tracking and `List-Unsubscribe` carrying the step campaign
  id, calls the provider with `meta.kind = 'campaign'` and the key
  `<accountId>:<campaignId>:<deliveryId>`, and stores the result. A delivery that exists in any final
  state is never sent again; the enrollment just moves on. The enrollment moves by an update
  conditional on the step it waits for. Overlapping ticks, a job that runs twice and a crash between
  the send and the move therefore send a step once.
- **The step campaign stays `draft`.** It is a template. Its `stats` JSON is bumped by the same code
  as a campaign's, so `stats.report` and `stats.recipients` on the step's campaign id are the step
  report. The report's 48-hour timeline starts at the campaign's creation, which says little for a
  sequence; the counters and the recipients are the useful part.
- **Counters are written with each result**, not tallied per batch as `send.batch` does: sequence
  volume is a trickle, and a crash then cannot lose a tally (the rollup does not recount draft
  campaigns). The monthly usage recount (`countSentInPeriod`) now names `kind = 'sequence'`
  campaigns, which never leave `draft`.
- **Provider outcomes.**
  - Sent: the enrollment moves to the next step, or completes.
  - Temporary refusal: the delivery waits with the campaign backoff (about 1, then 2 minutes) and the
    enrollment waits with it. The third refusal marks the delivery `failed` and the enrollment moves
    on to the next step. One failed step does not end the sequence.
  - Throttled: no attempt is spent; the tick sleeps until the provider's retry time.
  - Permanent refusal: `failed` at once, the enrollment moves on.
  - Unknown (timeout, lost connection): with a provider that deduplicates (`capabilities.idempotency`)
    it is retried with the same key, at most `MAX_ATTEMPTS` (5) claims, then `failed`. Without, the
    delivery becomes `unknown`, is never resent, and the enrollment moves on.
  - A delivery left in `sending` for over ten minutes (`STUCK_AFTER_MS`) is reconciled the same way:
    requeued when the provider deduplicates, `unknown` otherwise.
- **When nothing may be sent.** Account blocked, account protection active, install `sending_enabled`
  off, or no verified sender: the tick returns `{ again: now + 1 hour }` (`HOLD_MS`) and the
  enrollments keep waiting. It never throws for these, so the job cannot back off into `jobs_dead`.
  An archived newsletter is checked once a day; a newsletter being deleted ends the job. After a long
  hold the catch-up rule applies. Rate permits and the cloud monthly limit come from
  `control.takeSendPermits`, as for campaigns; at the monthly limit the tick sleeps until the control
  store's retry time. A policy change that lets the account send more (plan or limits changed, or a
  blocked account active again) does not wait out that sleep: `applyPolicy` calls the
  `onPolicyChanged` listeners in its transaction, and sequences re-arms the tick of every newsletter
  with an active enrollment in an active sequence. Usage never imports sequences.
- **Rechecks before every send.** The enrollment is still active, the sequence still active, the
  contact subscribed and not suppressed (newsletter, account and global lists), no unsubscribe waits
  to be written, no exit tag, not in the exit segment.

## Editing a running sequence

- A step's subject and body can change at any time; contacts who have not received it get the new
  version. Its links are recorded again on each run so new links are tracked. The subject of a step in
  an active or paused sequence cannot be emptied.
- Changing a step's delay moves the contacts waiting for that step. Deleting a step (only possible
  before it was sent to anyone) hands the contacts waiting for it to the next step, or completes
  them. The only step of an active or paused sequence cannot be deleted (`409 last_step`).
- A step added to the end reaches contacts who have not completed the sequence. Contacts who already
  completed it are not reopened.

## Not done here

- Segment entry, and exiting by segment between sends (both need a scan).
- A dashboard UI for activation and enrollments: the actions are on REST and MCP.
- The smoke run creates, activates, enrolls through the API and exits by tag, but sends no step: a
  running server's clock cannot be moved a day. The fake-clock tests cover the sends.
