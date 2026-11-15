# Security review: feature units F to M

Branch `unit/n-security`, November 15, 2026. This pass attacked the fifteen feature units merged
after the foundation review, following section 10 of `docs/architecture.md`. Every fixed finding has
a test that failed before the fix. The regression tests are in `server/test/security-findings.test.ts`,
`server/test/security-isolation.test.ts` and `server/test/security-injection.test.ts`.

## Findings fixed

Ranked by severity.

### 1. Per-IP rate limits were bypassable on Node (high, Node installs)

- **What an attacker got:** a fresh rate-limit bucket on every request. This applied to sign-in, sign-up,
  login codes, password reset, the public subscribe form, one-click unsubscribe and website pages.
  Password spraying across many addresses went unthrottled. The 10-per-email limit still held.
- **Reproduction:** send 40 sign-in attempts, each with a different `cf-connecting-ip`, `x-forwarded-for`
  or `x-real-ip` header. None got a 429. `clientIp()` read those headers straight from the client,
  and only Cloudflare overwrites `cf-connecting-ip`.
- **Fix:** the edge now sets a trusted `x-mc-ip` header after it strips every inbound `x-mc-*` header.
  `clientIp()` reads only that header. The Worker takes `cf-connecting-ip`. Node takes the socket peer.
  When the peer is a private or loopback address (Caddy in Compose), Node takes the last
  `x-forwarded-for` hop, which is the address the proxy saw.
- **Test:** `sign-in attempts from one client stay rate-limited when it rotates forwarding headers`. It
  covers a direct client and a client behind a local proxy. A second client behind the same proxy
  keeps its own limit.

### 2. Test emails bypassed the monthly email limit (medium, cloud)

- **What an attacker got:** about 150 emails an hour per user, with any content and any recipients.
  The emails went out from the account's verified domain and were never counted. That is about ten
  times the free plan's 10,000 emails a month. The account kept sending after it reached its limit.
- **Reproduction:** on a plan with `maxEmailsPerMonth: 6`, call `campaigns.sendTest` twice with five
  addresses each. All ten emails were sent.
- **Fix:** `campaigns.sendTest` checks the month's usage before it sends and counts each sent test
  email with `countEmails`.
- **Test:** `test emails count against the monthly email limit`.

### 3. A pending custom hostname could lock out the domain owner (medium, cross-account)

- **What an attacker got:** a way to stop another account's website from ever serving on its own domain.
  The attacker typed the hostname into their own account and never verified it.
- **Reproduction:** account A sets `news.example.com` and does not verify it. Account B sets the same
  hostname and verifies the DNS records. B's directory sync failed with `host_taken` on every retry,
  so the hostname never served and the TLS check never approved it.
- **Fix:** `control.upsertSite` records a custom hostname in the directory only once it is verified.
  Pending hostnames were never routable, so nothing depended on them.
- **Test:** `an unverified custom hostname in another account cannot block the domain owner`.

### 4. Per-IP limits keyed on the full IPv6 address (medium, both platforms)

- **What an attacker got:** the same bypass as finding 1, on Cloudflare and on Node. One host usually
  controls a whole /64, which is 2^64 addresses.
- **Reproduction:** send 40 sign-in attempts from addresses inside one /64. None got a 429.
- **Fix:** `clientIp()` reduces an IPv6 address to its /64. `clientAddress()` keeps the full address,
  and Turnstile verification uses it.
- **Test:** `rotating addresses inside one IPv6 /64 shares one rate limit`.

### 5. Unauthenticated webhook posts flooded admin alerts (low)

- **What an attacker got:** one `admin_alerts` row for every junk POST to `/hooks/ses` or `/hooks/resend`.
  That buried real alerts and grew the control store without bound.
- **Reproduction:** 25 junk posts created 25 open alerts.
- **Fix:** the `raiseAlert` RPC keeps one open `webhook_verification` alert until an admin resolves it.
- **Test:** `unauthenticated webhook failures do not flood the admin alert list`.

### 6. Login CSRF through a text/plain form (low)

- **What an attacker got:** a way to sign a visitor in to the attacker's account from a cross-site form.
  The edge checks CSRF only when a session already exists, and `readJson` parsed any content type.
- **Reproduction:** POST `/api/auth/signin` with `content-type: text/plain` and a JSON body. It
  returned 200 and set the session cookie.
- **Fix:** `readJson` requires `application/json`. A cross-site form cannot send that type without a
  CORS preflight. The dashboard and the smoke client already send it.
- **Test:** `a cross-site form cannot sign a visitor in to the attacker account`.

## Suspicions not reproduced, and accepted risks

None of these were changed.

- **Uncached website requests.** A website request for an unknown path, or for a page beyond the
  last one, loads every public issue before it answers 404. Such responses are not cached. The
  per-IP limit (600 a minute) bounds the cost, and since findings 1 and 4 that limit holds.
  A distributed client could still keep an account store busy.
- **Reused CSP nonce.** Cached website pages reuse their CSP nonce for up to five minutes. That
  matters only together with an HTML injection, and none was found.
- **Owner actor on custom hosts.** On a custom host the edge signs an owner actor for any method,
  without a CSRF check. The session cookie is host-only on the app host, so browsers never send it
  there. As defense in depth, the edge could sign the actor only for GET and HEAD.
- **Signup success redirect.** The redirect accepts any absolute http(s) URL, and the request can
  override it. This is recorded in `docs/decisions/g-signup.md`. Any account can point its own form
  at any site, so the app origin can redirect anywhere after a form POST.
- **Self-hosted admin sign-up.** On self-hosted installs, an address in `ADMIN_EMAILS` can sign up
  without email verification before its real owner does. It then becomes an install admin. This
  is the same trust model as first-visitor setup. Set `APP_URL` and finish setup before you expose
  the port.
- **Direct port publishing on Node.** If the Node port is published directly and Docker shows every
  client as a private gateway address, `x-forwarded-for` would be trusted. Docker Desktop and the
  userland proxy do this. Publish the app only through Caddy, or bind it to loopback.
- **Role questions for the permission matrix owner.** Members can run `website.publishPost`, which
  publishes a public web post without an admin. Members can also export every contact through
  `contacts.export`.
- **DNS failures.** `resolveDnsOverHttps` returns no records on an HTTP error. A resolver outage
  then clears a verified custom host or fails a domain recheck. This is a correctness issue, not a
  security one.

## Areas checked and found sound

- **Tenant isolation.** A generic test walks all 117 registry actions and swaps every id-shaped
  input, including nested audience, filter and bulk ids. It makes three kinds of calls: an admin of
  one newsletter naming another newsletter's ids, the owner naming mismatched ids, and another
  account naming this account's ids. The control actions get the same walk with `accountId`,
  `inviteId`, `userId` and `sessionId`. Each of the 287 calls failed with 403 or 404, or changed
  nothing and returned none of the other tenant's data. Segment filters that name another
  newsletter's tag match nobody. Teammates cannot read or mark the owner's notifications.
- **RPC between stores.** No HTTP route dispatches RPC. Durable Object stubs check the account id,
  and API-key actors never gain install-admin rights.
- **Edge header smuggling.** The edge drops every `x-mc-*` header, including `x-mc-site`,
  `x-mc-host`, `x-mc-account`, `x-mc-actor` and the new `x-mc-ip`. Tested.
- **Public tokens.** The purpose is part of the signature, and a payload cannot contain a dot. The
  open pixel, the click redirect (recorded links of the same campaign only), unsubscribe,
  preferences, keep and confirm all reject forged and cross-purpose tokens. Confirm links are
  single use.
- **Public endpoints.** Subscribe answers the same for new, existing and suppressed addresses.
  Image uploads are checked by magic bytes and served with `nosniff`, and blob keys reject `..`.
  The TLS check approves only verified hosts. The embed script is static.
- **Webhooks.** SNS pins the certificate host to the topic region, allows no redirects and checks the
  topic ARN. Resend (Svix), Stripe and Polar check signatures with a timestamp tolerance, and
  billing events are idempotent. Billing events map to accounts through server-set metadata.
- **SSRF.** The server never fetches a URL a user supplies. It calls SNS hosts that are checked
  before use, and fixed hosts for Stripe, Polar, Resend, SES, Cloudflare, Turnstile and
  DNS over HTTPS.
- **Injection.** A generic test puts markup and `javascript:` URLs into every user-controlled field.
  It covers newsletter identity and theme, author, website settings, signup settings, custom
  fields, contact names and fields, the doc, markdown and html formats, and web-only posts. None of
  it comes back live in the sent email, the previews, the website pages, JSON-LD, RSS, the sitemap,
  the hosted form, the embed script or the unsubscribe, preferences and keep pages. Dashboard
  previews use `sandbox=""` iframes. Theme values are hex colors and enums. Merge fields do not
  expand twice.
- **Mail headers.** The MIME builder and providers reject CR and LF in headers. Display names are
  quoted. The sender name allows no line breaks.
- **CSV exports.** The contact, skipped-row and recipient exports all neutralize formula cells.
- **SQL.** The segment compiler binds every value and validates custom-field keys. Sort is an enum
  and cursors are bound to their newsletter.
- **Auth.** Invites are bound to the invited email, single use and hashed, and the role is admin or
  member only. Email change needs the password and a code sent to the new address. Account deletion
  needs the password. Read-only keys cannot write through REST, MCP or idempotency replay. MCP
  results are JSON data, and the server's instructions say so. CSRF is enforced on every session
  POST.
- **Billing and cloud.** Contact, newsletter, team and monthly email limits are enforced in
  `subscribe`, in the actions and in the control store's permit reservation. A blocked account
  cannot send campaigns, tests, hygiene emails, confirmations or welcome emails. Install-admin
  actions reject account owners and API keys.
- **Secrets.** Install and admin settings return only "is set" flags. The client bundle imports only
  pure schema and preset modules. No log line prints credentials or email bodies.

## Areas not reached

- Load and CPU-exhaustion testing of imports, stats rebuilds and website rendering on Workers.
- Line-by-line review of the Stripe and Polar API response handling beyond webhook verification.
- Browser-level checks of the dashboard, including clickjacking headers on every SPA asset. The UI
  lane owns these.

## Files changed outside tests

- `server/core/http.ts`: `CLIENT_IP_HEADER`, `clientAddress`, a `clientIp` that uses the /64, and the
  JSON content type in `readJson`.
- `server/edge/index.ts`: an optional `clientIp(request, peer)` dependency and a peer argument on
  `Edge.fetch`. The edge sets `x-mc-ip`.
- `server/platform-node.ts`: `nodeClientIp`, wired into the edge.
- `server/index.ts`: passes the socket peer to the edge.
- `worker/index.ts`: takes the client address from `cf-connecting-ip`.
- `server/account/signup/routes.ts`: Turnstile gets the full client address.
- `server/account/sending/index.ts`: test emails check and count monthly usage.
- `server/control/directory/index.ts`: only verified hostnames are recorded.
- `server/control/admin/index.ts`: one open webhook verification alert at a time.
- `server/test/signup.test.ts`: the abuse test sets clients through the socket peer, not a header.
