# Release follow-ups

Fixes for the defects the security, UI and end-to-end lanes parked. Each records the contract it
touches and the choice made.

## DNS failures are "try again", never "no records"

Contract: section 3.2 says `resolveDns` returns the records. It said nothing about failures.

`resolveDnsOverHttps` now throws `DnsUnavailableError` on a network error, an HTTP error, an
unreadable body or a resolver status other than NOERROR or NXDOMAIN. `lookupDns()` turns that into
`AppError('dns_unavailable', …, 503)`. `website.checkHost` and `domains.check` answer that error and
change nothing, so a verified host or domain stays verified while the resolver is down. The daily
domain recheck tries again in an hour instead of burning its retries. The import MX check keeps its
existing behavior on a throw (the job retries with backoff, then fails the import with a report); the
fix there is that an HTTP error no longer caches "no MX" for a domain. The smoke run and the UI pass
both set `MC_TEST_DNS`, so neither reaches a real resolver.

## Sign-up must prove the address

Contract: section 4 says further self-hosted users join by invitation or when their email is in
`ALLOWED_EMAILS`. It did not say how the address is proved, and the code took it on trust.

Outside first-run setup, a self-hosted sign-up without an invite now gets the same emailed 6-digit
code as cloud mode (`pending: true`, then `/api/auth/signup/verify`). An invite link is proof on its
own, because it was emailed to that address. `ADMIN_EMAILS` grants install admin only to a user whose
`email_verified_at` is set, and sign-up no longer writes `is_install_admin` for those addresses.
First-run setup is unchanged and needs no email provider. An install with no provider can still add
people by invite only if the admin can read the test outbox, so the self-hosting guide now says to
configure a provider before letting others sign up.

## Team roles against section 6

Contract: members write and edit drafts and see stats; admins also publish, send, import, export
and change settings.

`contacts.export` and `imports.skipped` (a CSV of the skipped rows, which are contact addresses) now
need `admin`, and the dashboard shows their download links only to admins. Members still list and
open contacts and see import progress, because they pick audiences and read stats.
`website.publishPost` stays at `member` on purpose: its handler already refuses `visible: true`, or
any edit of a public post, unless the caller is an admin (`website.test.ts`, "members draft web-only
posts; admins publish and hide them"). A member can only keep a hidden draft. `campaigns.sendTest`
stays at `member`: a test goes to at most five addresses the writer types, never to the list, and it
counts against the monthly limit.

## No actor on custom website hosts

Contract: section 3.5 routes custom hosts to the account store and does not say whether an actor goes
with them.

The edge now signs an actor for website requests only on the app host and only for GET and HEAD.
Its one use is to leave the owner's own visits out of page views. Custom hosts get no actor at all,
and no website request with a state-changing method gets one, so the missing CSRF check there no
longer matters. Signup form posts on a website are anonymous anyway.

## Website 404s

Before it loads the archive, the website route now checks the path with indexed queries: a count of
public issues for paging, the author by slug, and the issue by slug (or id when it has none). A miss
answers 404 at once, and that 404 is cached for 60 seconds (`s-maxage=60`, and 60 seconds in the
in-process and Workers caches) under the same versioned key as the pages. Publishing, hiding or
renaming anything bumps the version, so a cached 404 never hides a new post. 404s count no page view.

## `TRUST_PROXY` on Node

Contract: section 3.6 lists the environment and had no proxy setting. Node trusted `x-forwarded-for`
from any private or loopback peer, which a directly published Docker port turns into every client.

Node now trusts forwarding headers only from a peer named in `TRUST_PROXY` (a comma-separated list
of addresses, or `true` for any private or loopback peer). From any other peer the edge drops
`x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host` and `x-real-ip` before a store sees them,
so they also cannot steer the app URL learned at first sign-in. Compose has no per-profile
environment, so `docker-compose.yml` gives Caddy a fixed address (`172.31.250.10`) on the app's own
network and sets `TRUST_PROXY` to that address. Without the `https` profile no container holds it;
with it, a client that reaches the published port directly still shows up as the gateway (`.1`).
The Worker is unchanged: it takes `cf-connecting-ip`.

## Maintained active-contact counter

Contract: 11.7 says plan limits are checked inside `subscribe()`, in its transaction.
`reserveContacts` did that with a full `COUNT(*)` on every call once a plan had a contact limit.

`account_meta.active_contacts` now holds the number of `subscribed` and `unconfirmed` contacts. The
contacts module's migration `2026-11-16-contacts-active-counter` seeds it and adds three triggers on
`contacts` (insert, delete, status change). SQLite runs triggers inside the statement's transaction,
so every write path keeps the counter exact, including bulk deletes and newsletter cascades, without
each caller having to remember it. `reserveContacts` reads the counter, and recounts only when the
row is missing. The hourly `usage.push` job recounts and resets it, which repairs any drift and
supplies the usage snapshot it already sent. The triggers sit in the contacts module because it owns
the table; the counter's readers are in `usage`.

## Growth by source

Cause: `stats_sources` changed only in the `stats.newsletter` rollup, which runs every five minutes
and recounts only the last three days of `events`. A running import showed whatever part of it the
last rollup had seen (the UI pass caught 490 of 2,940), and imported contacts whose signup date was
older than three days never appeared at all. `daily_stats` did not have the problem because
`setContactStatus` bumps it live.

Fix: the stats migration `2026-11-16-stats-live-sources` adds a trigger on `events` that bumps the
event's own day in `stats_sources` with exactly the rule the rollup uses, and recounts the table once.
The rollup stays as the repair for recent days. The trigger is on the shared `events` table because
every status change already writes an event there; no other module's code changes.
