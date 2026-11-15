# Signup implementation decisions

The signup unit owns `signup_settings` and `signup_mail`, contributed through its module migration.
No base migrations change. Vite adds proxies for `/f/`, `/embed.js`, and `/confirm/` so
public signup routes work on the development origin rather than returning the SPA fallback. The shared edge test changes its hosted-form
expectation from the old stub 404 to a rendered form; invalid newsletter keys still return 404.

- Form options live in `signup_settings`, rather than adding an unspecified JSON column to newsletters.
  The existing `newsletters.double_opt_in` and `newsletters.welcome` columns retain their purposes;
  welcome JSON stores the enabled flag, and the editable content is one `kind: 'welcome'` campaign.
  Signup creates and edits that draft with revision checks through its own newsletter-admin action.
- Confirmation and welcome emails use the email provider directly with `meta.kind: 'system'` and
  no campaign delivery, as instructed by the coordinator. They use the newsletter theme and install
  system sender address. Signup owns durable attempt records and retry jobs. Definite temporary
  failures retry with the same idempotency key and snapshotted message, even after settings or
  campaign edits. Uncertain sends retry only for idempotent providers;
  non-idempotent providers stop at unknown. Pending attempts also stop at unknown if the provider
  changes, since idempotency keys do not cross providers. Replayed confirmation links do not send another welcome
  or undo a later unsubscribe.
- The theme JSON endpoint is GET `/api/public/subscribe/:newsletterKey`, keeping it within the edge's
  existing public-key routing. It returns form settings, selected field definitions, public Turnstile
  key, theme and a signed form timestamp; it contains no reader or provider credentials.
- The public API requires a formToken from that GET, at least two seconds old and at most one hour
  old. Hosted and embedded forms handle it automatically. This makes the minimum fill time enforceable
  without a browser-only timestamp that callers could forge. Direct API clients follow GET, wait,
  POST. The IP limit is 20 submissions per UTC hour per account; the target limit is 10 per hour and
  3 confirmation emails per UTC day per account, across its newsletters. Counters store hashes.
- Signup success redirects accept an absolute http(s) URL, including an optional per-request override,
  as required by the brief. This deliberately narrows the general architecture's same-origin redirect
  rule for the public signup flow. Backslashes, whitespace, credentials and relative URLs are rejected.
- The embed uses DOM construction and textContent, no eval, inline scripts or innerHTML. It assigns
  individual style properties from the validated theme JSON; host CSP needs the install origin in
  script-src and connect-src. Optional Turnstile also needs challenges.cloudflare.com in script-src,
  connect-src and frame-src. Popup mode uses a native dialog with an explicit open button.

Integration follow-ups:

- Signup uses tracking's shared `signToken`/`verifyToken` through its public index for
  confirmation (`cf`), unsubscribe (`u`), preferences (`p`) and signed form timestamps
  (`form`). Preferences resolve under `/u/:token`. Signup owns payload schemas and
  confirmation expiry; it has no separate signing implementation.
- The contacts pending-consent API refuses to recreate a deleted contact. Signup respects that result
  and does not send a dead confirmation token. Explicitly rejoining a previously deleted address with
  double opt-in needs a contacts-owned way to create a pending row while preserving the tombstone
  until confirmation. Existing newsletter-suppressed contact rows can rejoin normally; account and
  global suppression continue to prevent email.
- Welcome content remains a draft campaign. Campaign lists include issues only, and sending
  rejects `kind: 'welcome'` and `keep` for both immediate sends and scheduling. Signup never
  schedules welcome campaigns or creates campaign deliveries.

Verification is recorded in the unit report. The embed behavior test executes the shipped script
against a fake DOM and the actual HTTP API, including popup open/close and error recovery.
