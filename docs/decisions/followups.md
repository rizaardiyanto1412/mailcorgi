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
