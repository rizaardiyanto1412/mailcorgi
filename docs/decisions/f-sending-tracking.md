# Unit F: sending and tracking

Deviations from `docs/architecture.md` and choices the contract leaves open.

## Preferences page lives under `/u/`

Section 11.3 names a `p` (preferences) token purpose, but section 3.5 forwards no `/p/*` path to the
account store. The preferences page is served at `/u/<p-token>` (the same prefix the edge already
forwards); the route picks the page by the token's purpose. `{{preferences_url}}` points there.

## Cancel for a paused send

Section 5.3 allows `draft|scheduled → canceled` only. "Cancel" on a paused send therefore marks every
queued delivery `skipped`, moves the campaign back through `sending` and finishes it as `sent` with
the skipped count in `stats`. A send in progress must be paused first. The `campaigns.cancel` action
handles both cases.

## Delivery attempts and eligibility time

A module migration adds `deliveries.attempts` (temporary refusals retry at most 3 times) and an index
on `campaign_sends(campaign_id, state, release_at)`. `deliveries.queued_at` doubles as the time a
queued row becomes eligible again after a temporary, throttled or lost attempt.

## Cached campaign stats

`campaigns.stats` holds `planned, sent, delivered, bounced, softBounces, complained, failed, skipped,
unknown, opens, clicks, unsubscribes, deferred` plus `baseAttempted, baseBounced, baseComplained`,
the counters at the last resume. Rates are judged on what happens after a resume, so a campaign the
owner resumes does not pause again on the same numbers.

## Gradual sending details

- The warm-up applies when at least 50 never-emailed contacts are in the audience; below that it would
  send single emails and the campaign goes out in one step.
- Step 1 = every previously emailed contact plus a random 2% of the new ones; step 2 = 5% more of
  the new ones 30 minutes later; step 3 = the rest 30 minutes after that.
- A step is held (and the campaign paused with `pause_reason`) when the campaign's hard bounce rate
  exceeds 2.5% or its complaint rate 0.08%, once at least 20 emails went out. The auto-pause for a
  send in progress uses the same limits from 200 emails.
- "Most engaged first" sends to contacts who opened or clicked in the last 90 days now and the rest
  24 hours later; `campaigns.sendMore` releases the next waiting step at once.

## Scanner rules

Opens are ignored from known scanner user agents and within 2 seconds of the send. Clicks are
ignored from scanner user agents and within 3 seconds of the send. When one delivery hits every link
of an issue (two or more) within 10 seconds, those clicks are undone. IP-based data-center detection
is not available on either platform, so the time rule stands in for it.

## Notifications and global suppression

The notifications module is a stub, so sending writes `notifications` rows directly
(`campaign_sent`, `campaign_paused`, `campaign_failed`, `user_id` NULL). Hard bounces to nonexistent
mailboxes reach the control store through a `suppression.report` job that calls
`control.reportSuppressions`, never a bare RPC after commit.

## Budget accounting

Each `send.batch` run takes one budget unit for the install settings read and one for
`control.takeSendPermits`, then at most `budget.left()` provider calls. With a budget of 40 a run makes
at most 38 provider calls.

## Test-only seam

`server/account/sending/provider.ts` exports `sendHooks.provider`, null in production. Tests set it to
a wrapper around the test provider to simulate permanent, temporary, throttled and lost results.

## Teams and signup integration

Send controls require newsletter admin; test sends, audience counts and progress allow members.
The permission matrix covers every sending action. Tracking has no actions. For calls that cannot
succeed on the shared draft fixture, the matrix asserts the specific domain error after authorization.

Tracking owns token signing and verification, including signup confirmation and the additional
`form` purpose for signed signup timestamps. Signup imports them through tracking's public index.
Campaign lists contain issues only; sending and scheduling reject welcome and keep campaigns.
