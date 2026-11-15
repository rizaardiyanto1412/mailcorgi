# MailCorgi architecture

MailCorgi is a newsletter app: write an issue, send it to a list, publish it on the web. It runs on
Cloudflare Workers (one click) or on any Node.js 22+ server (Docker). License: AGPL-3.0-only.

This file is the contract for everyone who builds MailCorgi. Read it before you write code. If the code
and this file disagree, fix one of them in the same change.

MailCheap (github.com/marclou/mailcheap) is only a feature reference. Never copy its code, text or
assets. Ansa (`~/Code/ansa`) is the owner's own MIT app: copy from it freely.

## 1. Runtime shape

SQLite everywhere. The same server code runs on two platforms.

```
            ┌──────────── Edge (stateless) ────────────┐
request ──► │ resolve who and which account, then route │
            └──────┬──────────────────────┬─────────────┘
                   ▼                      ▼
        Control store (exactly one)   Account store (one per account)
        users, sessions, accounts,    newsletters, contacts, campaigns,
        directory, billing, install   deliveries, domains, jobs, stats
        settings, global suppression
```

- **Store** = one SQLite database + one alarm + a table of RPC methods + an HTTP app.
- **Cloudflare**: `ControlStore` and `AccountStore` are SQLite-backed Durable Object classes. The Worker
  is the edge. The account store's object name is the account id. Images live in R2 (`IMAGES` binding).
- **Node**: one process. `DATA_DIR/control.db`, `DATA_DIR/accounts/<accountId>.db`, images in
  `DATA_DIR/images`. A 1-second scheduler loop fires store alarms.
- A store never reads another store's database. Stores talk through `ctx.stores` (async RPC).
- Inside a store SQL is synchronous. All network I/O is async and goes through `ctx.platform`.

### Why per-account stores

A Durable Object is single-threaded and capped at 10 GB. One store for a whole cloud install would be a
bottleneck. One store per account scales out, and deleting an account deletes its store.

## 2. Repository layout

```
server/
  core/            platform-neutral kernel (no feature logic)
    db.ts          Db handle: all/get/run/exec/tx, migrations runner
    store.ts       StoreCtx, defineStore, RPC dispatch, alarm → jobs
    jobs.ts        durable job queue per store
    actions.ts     defineAction registry, runAction, role checks
    http.ts        shared Hono helpers, errors, security headers
    crypto.ts      WebCrypto only: hash, hmac, encrypt, tokens, password hashing
    platform.ts    Platform interface (blobs, clock, fetch, setAlarm, dns)
    config.ts      env parsing (CLOUD, APP_URL, …) with no side effects
    ids.ts         id generators and token formats
    ratelimit.ts   fixed-window counters in a store table
  edge/            routing: sessions, account resolution, public tokens, webhooks, assets
  control/         control store: schema.ts, rpc.ts, routes.ts, modules below
    auth/ accounts/ directory/ install/ billing/ admin/ suppression/
  account/         account store: schema.ts, rpc.ts, routes.ts, modules below
    newsletters/ contacts/ segments/ imports/ campaigns/ render/ sending/
    tracking/ signup/ website/ domains/ stats/ hygiene/ team/ notifications/
    apikeys/ usage/
  email/           EmailProvider interface + ses.ts resend.ts smtp.ts test.ts, platform-email.ts
  api/             REST v1 router, OpenAPI, MCP server (all generated from the action registry)
  platform-node.ts Node platform + entry (index.ts)
  test/            node --test suites and the test harness (harness.ts)
worker/index.ts    Cloudflare entry: Worker edge + ControlStore + AccountStore classes
web/               Vite + React 19 + Tailwind 4 SPA (dashboard, auth, admin)
  src/app/ ui/ lib/ features/<module>/
scripts/           ci.sh, smoke.ts (drives a running instance end to end)
docs/              this file, self-hosting.md, api.md
```

Code style follows Ansa: TypeScript strict, ES modules, 2 spaces, single quotes, no semicolons, imports
with `.ts` extensions, small files, comments only for a non-obvious why. No ORMs. No Node-only APIs
outside `platform-node.ts`, `server/email/smtp.ts` and `scripts/` (the Worker bundle must build with
`nodejs_compat` but may not depend on `fs`, `net` or `child_process`).

Dependencies stay few: `hono`, `zod`, `aws4fetch`, `marked`, `sanitize-html`, `papaparse` (web),
`nodemailer` (Node only, dynamically imported), TipTap, React, TanStack Query, react-router, lucide-react.
No Stripe or Polar SDK: call their HTTP APIs with `fetch` and verify webhooks with WebCrypto.

## 3. Kernel contracts

### 3.1 Db

```ts
interface Db {
  all<T>(sql: string, ...params: Param[]): T[]
  get<T>(sql: string, ...params: Param[]): T | undefined
  run(sql: string, ...params: Param[]): { id: number; changes: number }
  exec(sql: string): void
  tx<T>(fn: () => T): T            // synchronous, re-entrant
}
```

No global database. Every function that touches data takes a `StoreCtx` (or a `Db`). Migrations are
ordered string arrays per store (`server/control/schema.ts`, `server/account/schema.ts`), tracked in a
`_migrations` table, append-only once merged to `main`. At most 100 bound parameters per statement and
100 columns per table (Durable Object limits): batch inserts in chunks.

### 3.2 StoreCtx and Platform

```ts
interface StoreCtx {
  kind: 'control' | 'account'
  accountId: string | null         // set for account stores
  db: Db
  platform: Platform
  stores: Stores                    // RPC to other stores
  config: Config
  now(): number                     // ms, test-controllable
  jobs: Jobs                        // enqueue / cancel on this store
}
interface Stores {
  control: ControlRpc               // typed async methods
  account(id: string): AccountRpc
}
interface Platform {
  blobs: BlobStore                  // put/get/delete/list by key, async, bytes + contentType
  fetch: typeof fetch
  setAlarm(store: StoreRef, at: number): Promise<void>   // earliest wins
  resolveDns(name: string, type: 'TXT'|'CNAME'|'MX'|'A'): Promise<string[]>  // DNS over HTTPS
  waitUntil(p: Promise<unknown>): void
  limits: { subrequestsPerRun: number }   // 40 on Workers Free, 900 otherwise, 900 on Node
}
```

RPC methods are plain functions `(ctx, args) => result` registered in `server/control/rpc.ts` and
`server/account/rpc.ts`. Arguments and results are JSON only. On Cloudflare a store class exposes one
`rpc(name, args)` method; on Node it is a direct call. Keep RPC surface small and named by intent
(`control.resolveSession`, `account.applyPlan`).

### 3.3 Jobs

Each store has a `jobs` table: `id, kind, payload JSON, run_at, attempts, locked_until, last_error,
dedupe_key UNIQUE NULL`. `ctx.jobs.enqueue(kind, payload, { runAt, dedupeKey })` inserts and calls
`platform.setAlarm`. The alarm handler claims due jobs, runs registered handlers
(`defineJob(kind, handler)`), and re-arms the alarm for the next `run_at`. A handler gets a budget
(`{ deadline, subrequestsLeft }`) and returns `'done'` or `{ again: runAt }`. Failures retry with
backoff up to 8 attempts, then land in `jobs_dead` and raise an admin alert. Every handler must be
idempotent: a job can run twice.

### 3.4 Actions

Every customer-facing operation is one action. The dashboard, REST API and MCP all call the same one.

```ts
defineAction({
  name: 'contacts.create',                 // unique, dot-separated
  scope: 'account',                        // 'account' | 'control'
  role: 'member',                          // minimum: 'member' | 'admin' | 'owner' ; control: 'user' | 'installAdmin'
  input: z.object({...}),                  // zod; newsletter-scoped actions include newsletterId
  rest: { method: 'POST', path: '/newsletters/:newsletterId/contacts' },  // omit to hide from REST
  mcp: { title: 'Add a contact', destructive: false },                    // omit to hide from MCP
  handler: async (ctx, input, actor) => output,
})
```

- `runAction(ctx, name, rawInput, actor)` validates input, checks role and plan limits, runs the
  handler, and maps `AppError(code, message, status)` to responses. It is the only entry point.
- `actor = { userId, role, newsletterIds: 'all' | string[], via: 'web' | 'api' | 'mcp', keyId? }`.
  A team member's actor is limited to the newsletters they were invited to; `runAction` rejects a
  `newsletterId` outside that list before the handler runs.
- Dashboard: `POST /api/actions/<name>` with a JSON body. REST: `/api/v1/...` from `rest`. MCP: tool
  name = action name with dots replaced by underscores. OpenAPI and docs are generated from the registry.
- A test (`server/test/parity.test.ts`) fails when an action lacks a description for its inputs or when
  REST paths collide.

### 3.5 Edge routing

The edge strips every inbound `x-mc-*` header, then routes:

| Path | Goes to | How the account is found |
|---|---|---|
| `/api/auth/*`, `/api/control/*`, `/api/billing/*`, `/admin` APIs | control store | — |
| `/api/actions/*` (scope account) | account store | session → `control.resolveSession` → current account |
| `/api/v1/*`, `/mcp` | account store | API key `mc_<accountId>_<secret>` |
| `/t/o/:token`, `/t/c/:token`, `/u/:token`, `/confirm/:token`, `/keep/:token` | account store | token prefix `<accountId>.` |
| `/api/public/subscribe/:newsletterKey`, `/embed.js`, `/f/:newsletterKey` | account store | key `nl_<accountId>_<rand>` |
| `/n/:slug/*` and any request on a custom website host | account store | `control.lookupSite(slug or host)`, cached 60 s |
| `/hooks/ses`, `/hooks/resend` | account store(s) | signature checked at the edge, account from message tags |
| `/hooks/stripe`, `/hooks/polar` | control store | — |
| `/img/:accountId/:key` | blobs directly | path |
| `/healthz` | edge | — |
| everything else | SPA assets (`index.html` fallback) | — |

The edge forwards the original request to the store's HTTP app and adds trusted headers
(`x-mc-actor` = signed JSON actor, `x-mc-account`). Session cookie: `mc_session`, HttpOnly, SameSite=Lax,
Secure when the app URL is https. State-changing dashboard requests need the `x-mc-csrf` header that
matches the session's CSRF token.

Custom website hosts are known to the control directory. A request whose host is neither the app host
nor a known website host gets a 404.

### 3.6 Secrets and config

No secret is required to deploy. On first boot the control store generates a master key and stores it
(Node: `DATA_DIR/secret.key`). `APP_SECRET` overrides it. Derived keys (HKDF): session signing, token
signing per account, credential encryption, suppression hashing.

Environment: `APP_URL` (optional; learned from the first sign-in when unset), `CLOUD=true`,
`BILLING_PROVIDER=stripe|polar`, `ADMIN_EMAILS` (comma list, install admins), `DATA_DIR`, `PORT`,
`IMAGES_PUBLIC_URL` (optional CDN origin for images), `SEND_BATCH_SIZE`, `TURNSTILE_SITE_KEY` /
`TURNSTILE_SECRET_KEY` (optional). Provider credentials (SES, Resend, SMTP, Stripe, Polar) are entered in
the install settings page and stored encrypted in the control store; matching env vars
(`SES_ACCESS_KEY_ID`, `STRIPE_SECRET_KEY`, …) take precedence when set. Never log a secret or an email
body.

## 4. Modes

- **Self-hosted** (default): the first visitor creates the install admin (email + password, no email
  needed). Further users join by invitation or when their email is in `ALLOWED_EMAILS`. Each user owns
  one account. No billing, no limits.
- **Cloud** (`CLOUD=true`): open sign-up with an emailed 6-digit code, plans with limits, billing
  through Stripe or Polar, admin console with blocking. Both modes run from the same files, so every
  change has to work in both.

## 5. Data

Times are integer milliseconds (UTC). Ids are text: `prefix_` + 16 base32 chars (`ids.ts`), except
high-volume rows (`deliveries`, `events`, `page_views`) which use INTEGER rowids. Emails are stored
trimmed and lowercased. JSON columns are TEXT. Money never appears in account stores.

### 5.1 Control store

```
users(id, email UNIQUE, name, password_hash, email_verified_at, is_install_admin, disabled, created_at)
sessions(id, user_id, csrf, created_at, expires_at, ip, user_agent)
login_codes(email, code_hash, purpose 'signup'|'signin'|'reset', expires_at, attempts)
accounts(id, owner_user_id, name, status 'active'|'blocked'|'deleting', block_reason, plan, plan_period_end,
         billing_provider, billing_customer_id, billing_subscription_id, billing_status, billing_paused,
         created_at, deleted_at)
memberships(user_id, account_id, newsletter_id NULL, role 'owner'|'admin'|'member', created_at)
            -- owner rows have newsletter_id NULL; team rows name one newsletter
invites(id, account_id, newsletter_id, email, role, token_hash, invited_by, expires_at, accepted_at)
sites(newsletter_id PRIMARY KEY, account_id, slug UNIQUE, custom_host UNIQUE NULL, host_verified_at)
global_suppressions(email_hash PRIMARY KEY, reason 'hard_bounce'|'spam_trap', until NULL, created_at)
install_settings(key PRIMARY KEY, value)          -- provider creds (encrypted), email_from, sending_enabled, …
billing_events(id PRIMARY KEY, provider, type, received_at, processed_at)   -- webhook idempotency
admin_alerts(id, kind, account_id NULL, title, body, created_at, resolved_at)
usage_snapshots(account_id, period, contacts, emails_sent, updated_at)      -- pushed by account stores
rate_limits(key, window_start, count)
jobs, jobs_dead, _migrations
```

### 5.2 Account store

```
account_meta(key PRIMARY KEY, value)      -- plan + limits copy, status, owner email, token key, sender defaults
newsletters(id, key UNIQUE 'nl_<accountId>_<rand>', name, slug, description, language, timezone,
            from_name, from_local, domain_id NULL, reply_to, postal_address, logo_key, icon_key,
            theme JSON, website JSON (enabled, analytics ids, custom code, social links, seo),
            double_opt_in INTEGER DEFAULT 1, welcome JSON (enabled, subject, doc),
            hygiene JSON (enabled, after_issues), tracking JSON (opens, clicks),
            archived_at, created_at, updated_at)
authors(id, newsletter_id, name, slug, bio, avatar_key, links JSON, user_id NULL, created_at)
contacts(id, newsletter_id, email, name, status, source, fields JSON,
         subscribed_at, confirmed_at, unsubscribed_at, unsubscribe_reason, bounced_at, complained_at,
         last_sent_at, last_opened_at, last_clicked_at, sent_count, open_count, click_count,
         ignored_streak, keep_asked_at, engaged_score, provider TEXT, created_at, updated_at,
         UNIQUE(newsletter_id, email))
         -- status: 'unconfirmed'|'subscribed'|'unsubscribed'|'bounced'|'complained'|'cleaned'
         -- provider: inbox provider bucket from MX/domain ('gmail','outlook','yahoo','icloud','other')
contact_fields(id, newsletter_id, key, label, type 'text'|'number'|'date'|'boolean', UNIQUE(newsletter_id,key))
tags(id, newsletter_id, name, UNIQUE(newsletter_id,name))
contact_tags(contact_id, tag_id, PRIMARY KEY(contact_id, tag_id))
segments(id, newsletter_id, name, filter JSON, created_at, updated_at)
suppressions(email PRIMARY KEY, reason 'unsubscribed'|'hard_bounce'|'complaint'|'manual'|'cleaned', newsletter_id NULL, created_at)
deleted_contacts(email_hash, newsletter_id, deleted_at)      -- keeps a re-import from resubscribing them
imports(id, newsletter_id, status, source_preset, mapping JSON, options JSON, total_rows, processed_rows,
        added, updated, skipped JSON (by reason), created_by, created_at, finished_at, error)
import_chunks(import_id, seq, rows JSON, done INTEGER, PRIMARY KEY(import_id, seq))
campaigns(id, newsletter_id, author_id NULL, kind 'issue'|'welcome'|'keep', format 'doc'|'markdown'|'html',
          subject, preview_text, doc JSON, source TEXT, html TEXT, text TEXT, slug,
          status 'draft'|'scheduled'|'sending'|'paused'|'sent'|'canceled', pause_reason,
          audience JSON (segment id / tag ids / 'engaged' / all, exclusions),
          scheduled_at, send_started_at, sent_at, published_at, web_visible INTEGER,
          stats JSON (cached counters), revision INTEGER, created_by, created_at, updated_at)
campaign_sends(id, campaign_id, step INTEGER, kind 'warmup'|'main'|'more', planned INTEGER, release_at, state,
               created_at)                                  -- gradual sending steps
deliveries(id INTEGER PRIMARY KEY, campaign_id, send_id, contact_id, email, status, provider_message_id,
           error, queued_at, sent_at, delivered_at, opened_at, clicked_at, bounced_at, complained_at,
           unsubscribed_at, open_count, click_count, UNIQUE(campaign_id, contact_id))
           -- status: 'queued'|'sending'|'sent'|'delivered'|'bounced'|'complained'|'failed'|'skipped'
links(id, campaign_id, url, position, clicks, unique_clicks, UNIQUE(campaign_id, url))
events(id INTEGER PRIMARY KEY, type, newsletter_id, contact_id NULL, campaign_id NULL, delivery_id NULL,
       data JSON, at)       -- signup, confirm, unsubscribe, open, click, bounce, complaint, cleaned, import, send
daily_stats(newsletter_id, day, subscribed, unsubscribed, sent, delivered, opens, clicks, bounces, complaints,
            page_views, PRIMARY KEY(newsletter_id, day))
page_views(id INTEGER PRIMARY KEY, newsletter_id, campaign_id NULL, path, referrer_host, country, at)
domains(id, name UNIQUE, status 'pending'|'verified'|'failed'|'suspended', provider_identity JSON,
        records JSON (name,type,value,purpose,found), last_checked_at, verified_at, created_at)
uploads(key PRIMARY KEY, newsletter_id NULL, content_type, bytes, width, height, created_by, created_at)
api_keys(id, name, hash UNIQUE, last4, access 'full'|'read', created_by, last_used_at, created_at, revoked_at)
notifications(id, user_id NULL, kind, tone, title, body, href, created_at, read_at)
usage(period PRIMARY KEY, emails_sent, contacts_peak)
outbox(id, to_email, subject, html, text, headers JSON, kind, created_at)    -- only the `test` provider writes here
rate_limits, jobs, jobs_dead, _migrations
```

Indexes that matter: `contacts(newsletter_id, status)`, `deliveries(campaign_id, status)`,
`deliveries(provider_message_id)`, `events(newsletter_id, at)`, `events(campaign_id, type)`,
`page_views(newsletter_id, at)`.

### 5.3 State machines

- **Contact**: `unconfirmed → subscribed` (confirm link, or an import/API call that asserts consent);
  `subscribed → unsubscribed | bounced | complained | cleaned`. Only the contact's own action
  (confirm link, signup with opt-in) brings a suppressed address back. Imports and API calls never do.
- **Campaign**: `draft → scheduled → sending → sent`; `sending ⇄ paused`; `draft|scheduled → canceled`.
  Only `draft` is editable. Sending is exactly-once per `(campaign_id, contact_id)`.
- **Delivery**: `queued → sending → sent → delivered`; `sent → bounced | complained`; `queued → skipped`;
  `sending → failed` (permanent provider refusal) or back to `queued` (temporary).
- **Domain**: `pending → verified`; `verified → failed` when a daily recheck finds records gone;
  `failed → verified` on recovery.

All status changes go through one function per entity (`setContactStatus`, `transitionCampaign`, …) that
checks the transition, writes the `events` row and bumps `daily_stats`. Nothing else writes `status`.

## 6. Features by module

Each module owns its folder under `server/account/<module>/` (or `server/control/<module>/`), its
actions, its jobs, its tests in `server/test/<module>.test.ts`, and its pages in
`web/src/features/<module>/`. A module calls another module only through that module's exported
functions in its `index.ts`.

**newsletters** — create, edit, archive, switch. Settings: identity, sender, reply-to, postal address,
logo, theme (colors, fonts, button style, header/footer), authors, website options. Up to 3 newsletters
per account on self-hosted by default (`MAX_NEWSLETTERS`), per plan in cloud. Slug changes update the
control directory.

**contacts** — list with search, status filter, tag filter, sort, paging (keyset). Create, edit,
delete (writes `deleted_contacts`), bulk tag, bulk delete, bulk unsubscribe. Custom fields. Contact
page with timeline from `events`. CSV export (formula-safe cells). `subscribe()`, `unsubscribe()`,
`suppress()` and `isSuppressed()` live here and are the only write paths for subscription state.

**segments** — saved filters over contacts: status, tags (any/all/none), fields (eq, contains, gt, lt,
set), signup date, source, engagement (opened/clicked in last N issues or days, never opened), inbox
provider. One compiler turns a filter into a SQL `WHERE` with bound params; the same compiler serves
the contacts list, audience counts and sends.

**imports** — the browser parses the CSV (papaparse), shows a preview, maps columns, then uploads rows
in chunks of 500. Presets detect and map exports from beehiiv, Substack, Mailchimp, Kit, MailerLite,
Buttondown, Ghost, EmailOctopus and listmonk, including their status and signup date columns. A job
processes chunks. Cleaning leaves out: invalid syntax, misspelled domains (gmial.com → reported with the
fix suggested), role addresses, disposable domains, duplicates, suppressed and previously deleted
contacts, and domains without MX (checked through `platform.resolveDns`, cached per domain). The report
lists every skip reason with counts and a downloadable CSV of skipped rows.

**campaigns** — drafts, autosave with a `revision` check (a stale save gets a 409 with the newer
revision), duplicate, delete, schedule, cancel. Formats: `doc` (the editor), `markdown`, `html` (API and
MCP). Review step with checks: subject present and under 150 chars, preview text, unsubscribe link in
html format, size under Gmail's 102 KB clip, postal address, verified sender domain, images have alt
text, links resolve to http(s). Test email to up to 5 addresses.

**render** — pure functions, no DOM. `renderEmail(campaign, newsletter, recipient) → { html, text,
headers }` and `renderWeb(campaign, newsletter) → html`. The doc format is TipTap JSON with these nodes:
paragraph, heading (1–3), bulletList, orderedList, listItem, blockquote, codeBlock, horizontalRule,
image (src, alt, width, href, caption), button (label, href, align), callout (tone, emoji), divider,
spacer, embed link card (url, title, description, image), and marks bold, italic, underline, strike,
code, link, highlight. Email HTML is table-based with inline styles and a dark-mode-safe palette.
Merge fields: `{{first_name}}`, `{{name}}`, `{{email}}`, `{{field.<key>}}`, with `|fallback`. System
links: `{{unsubscribe_url}}`, `{{web_url}}`, `{{preferences_url}}`. Every user-controlled string is
escaped. HTML-format campaigns are sanitized (`sanitize-html`) for the web archive.

**sending** — audience → `deliveries` rows (chunked inserts) → `send.batch` jobs. Each run claims up to
`min(SEND_BATCH_SIZE, platform.limits.subrequestsPerRun)` queued rows, renders, calls the provider once
per recipient, records the provider message id. Pace is capped by the provider's send rate
(`install_settings.send_rate_per_second`, default 10). Features: schedule, pause, resume, cancel;
gradual sending for contacts the account never emailed (a random 2% first, then 5% more, then the rest,
30 minutes apart, each step released only while that campaign's hard bounces stay under 2.5% and
complaints under 0.08%); "send to most engaged first, the rest later"; auto-pause past those
thresholds; provider throttling or Gmail deferrals back off with jitter and resume. Headers on every
email: `List-Unsubscribe` (https + mailto), `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
`Feedback-ID`, `X-MC-Account`, `X-MC-Delivery`. Suppressed and non-subscribed contacts are filtered at
audience time and again right before each send.

**tracking** — open pixel `/t/o/<token>`, click redirect `/t/c/<token>` (only to URLs recorded in
`links`: never an open redirect), unsubscribe `/u/<token>` (GET shows a confirm page, POST one-click per
RFC 8058), preferences page, `/keep/<token>`. Tokens are HMAC-signed with the account's token key.
Opens and clicks from link scanners are left out: known scanner user agents, data-center opens within
2 seconds of delivery, and clicks on every link within a few seconds. Provider webhooks (SES via SNS,
Resend via Svix) become one event shape (`delivered`, `bounce` hard/soft, `complaint`, `deferred`) and
update deliveries, contacts, suppressions and, for hard bounces to nonexistent mailboxes, the global
suppression list in the control store.

**signup** — hosted form page `/f/<newsletterKey>`, embeddable script `/embed.js` (renders an iframe or
inline form), and `POST /api/public/subscribe/<newsletterKey>` (JSON or form-encoded, CORS open). Double
opt-in on by default: a confirm email, then `subscribed` on click. Welcome email after confirmation.
Abuse limits: per IP and per target email (`ratelimit.ts`), honeypot field, minimum fill time, optional
Turnstile, and no more than 3 confirm emails per address per day.

**website** — server-rendered public site per newsletter at `/n/<slug>` and on a custom host: home
(description, signup form, featured and latest issues), issue pages, author pages, paging, RSS
(`/feed.xml`), `sitemap.xml`, `robots.txt`, Open Graph and Twitter meta, JSON-LD, canonical URLs.
Owner options: analytics ids (Plausible, GA4, Fathom, Umami by id only), custom head/body code (custom
hosts only), social links, hide an issue from the web. Page views are counted without cookies (bots
left out). Custom host flow: owner enters a hostname, MailCorgi shows a CNAME target and a TXT
verification record, checks them, then registers the host in the control directory. On Cloudflare the
operator also adds the hostname to the Worker (Custom Domain or Cloudflare for SaaS; when
`CF_API_TOKEN` and `CF_ZONE_ID` are set MailCorgi creates the custom hostname itself). On Node the
bundled Caddy config uses on-demand TLS with `/api/public/tls-check` as its `ask` endpoint.

**domains** — sending domains. Adding one creates the provider identity (SES `CreateEmailIdentity` with
Easy DKIM and a custom MAIL FROM; Resend domains API), stores the DNS records to add (DKIM CNAMEs or
TXT, return-path MX + SPF TXT, DMARC TXT suggestion when the root has none), and checks them on demand
and daily. A newsletter can only send from a verified domain. SMTP installs skip provider identities
and only check SPF/DMARC presence.

**stats** — overview (subscribers over time, growth, last campaigns), campaign report (sent, delivered,
unique opens, unique clicks, bounces, complaints, unsubscribes, link table, by inbox provider,
timeline), contacts growth by source, website views. Counters come from `daily_stats` and cached
`campaigns.stats`, never from scanning `events` on page load.

**hygiene** — on by default per newsletter. A contact who ignored N consecutive issues (default 8, and
at least 90 days subscribed) gets one "do you still want this?" email (`kind 'keep'`). No click within
14 days → `cleaned`. Account protection: past 5% hard bounces or 0.3% complaints over the trailing
1,000+ emails the account store asks the control store to block the account (cloud) or pauses all sends
and alerts the admin (self-hosted).

**team** — the owner invites up to 5 people per newsletter as `admin` or `member`. Members write and
edit drafts and see stats. Admins also send, import, and change newsletter settings. Only the owner
manages billing, domains, API keys, team and account deletion. Invitations are emailed links; the
invitee signs up or signs in, then sees the shared newsletter in their switcher.

**notifications** — bell in the sidebar with unread count. Created by: import finished, campaign sent,
campaign paused, domain verified or failed, account blocked, invite accepted, plan limit near. Important
ones are also emailed to the owner. Install admins get `admin_alerts` (dead jobs, provider refusing
sends, webhook failures, auto-blocks) on `/admin` and by email to `ADMIN_EMAILS`.

**apikeys + api** — keys `mc_<accountId>_<secret>` with `full` or `read` access, shown once. REST v1 and
the OpenAPI document at `/api/v1/openapi.json` come from the registry. MCP (`/mcp`, stateless streamable
HTTP, JSON-RPC over POST) exposes the same actions as tools; destructive and sending tools say so in
their descriptions and annotations. `llms.txt` and `/docs/api` render from the registry.

**control/auth** — sign-up, sign-in (password, or emailed code in cloud mode), sign-out, password reset,
email change with confirmation, sessions list and revoke. Passwords: PBKDF2-SHA256 via WebCrypto.
Attempts are rate-limited per IP and per email.

**control/billing + plans** (cloud only) — plans in `server/control/billing/plans.ts`: `free`, `starter`,
`growth`, `pro`, `scale`, each with `maxContacts`, `maxEmailsPerMonth`, `maxNewsletters`,
`maxTeamPerNewsletter`, monthly and yearly prices. One `BillingProvider` interface with `stripe.ts` and
`polar.ts`: `createCheckout`, `createPortal`, `changePlan`, `cancel`, `pause`, `resume`,
`verifyAndParseWebhook → BillingEvent[]`. Webhooks are idempotent through `billing_events`. Plan changes
are pushed to the account store with `account.applyPlan`. Limits are enforced in `runAction` (contacts,
newsletters, team) and at send time (monthly emails). A blocked account's billing is paused; unblocking
resumes it; an account blocked for 30 days is canceled.

**control/admin** — install settings (email provider and credentials, sender for system emails, sending
on/off, billing provider keys, sign-up rules), accounts list with usage, block and unblock with a
reason, impersonation-free read-only account summary, alerts, dead jobs with retry. Account deletion:
the owner requests it, the control store marks `deleting`, the account store cancels sends and wipes
itself and its images, then the control rows go.

**email** — `EmailProvider`: `send(message) → { id }`, `createIdentity(domain)`, `getIdentity(domain)`,
`deleteIdentity(domain)`, `parseWebhook(request) → ProviderEvent[]`, `capabilities`. Providers: `ses`
(SES v2 over `aws4fetch`), `resend`, `smtp` (Node only), `test` (writes to `outbox`; the default until
an admin configures a real one, and the provider every test uses). `platform-email.ts` sends system
emails (codes, invites, alerts) through the same provider.

## 7. Web app

SPA at the app host. Routes: `/signin`, `/signup`, `/setup` (first run), `/welcome` (create first
newsletter), `/` overview, `/campaigns`, `/campaigns/:id` (Write · Review · Send), `/campaigns/:id/report`,
`/contacts`, `/contacts/:id`, `/segments`, `/imports`, `/website`, `/settings/*` (newsletter, design,
authors, signup forms, domains, team, API & MCP, account, billing), `/admin/*`, `/docs/api`.

One data layer: `web/src/lib/api.ts` exposes `callAction(name, input)` and TanStack Query hooks. Types
for action inputs and outputs are imported from the server registry (type-only imports), so the client
never restates a shape. UI kit in `web/src/ui/` (copied from Ansa's `ui.tsx` and adapted): Button, Input,
Select, Dialog, Menu, Tabs, Table, Toast, Empty, Badge, Skeleton. Light and dark themes. Every list has
an empty state that says how to add the first item. Copy is plain, short, sentence case.

## 8. Testing and local CI

- `npm test` — `node --test` through `tsx`, against the Node platform with temp directories, the `test`
  email provider, a fake clock and a fake DNS resolver from `server/test/harness.ts`. Tests call
  `runAction` and HTTP routes (`app.request`) and assert behavior: status changes, emails in `outbox`,
  rows a user can see. No test reaches the network.
- `npm run typecheck`, `npm run lint` (eslint), `npm run build` (web + node bundle + `wrangler deploy
  --dry-run`).
- `npm run smoke` — starts the Node build and a `wrangler dev` Worker in turn and runs
  `scripts/smoke.ts` against each: first-run setup, create newsletter, import contacts, write and send a
  campaign through the test provider, open tracking, unsubscribe, archive page, API key call, MCP call.
- `npm run ci` runs all of the above. There is no GitHub Actions workflow: CI is local by decision.

## 9. Deploy

- **Cloudflare**: `wrangler.jsonc` declares the assets directory, both Durable Object classes
  (`new_sqlite_classes`), the `IMAGES` R2 bucket, `version_metadata`, and `nodejs_compat`. The README's
  Deploy to Cloudflare button needs no secrets. When the `IMAGES` binding is absent, images fall back to
  chunked blobs in the account store. Workers Free works for small lists (50 outbound requests per
  run and 100,000 row writes per day); the self-hosting guide says when to move to Workers Paid.
- **Docker**: multi-stage `Dockerfile`, `docker-compose.yml` with an optional Caddy profile for HTTPS and
  on-demand TLS for custom website hosts, one `/data` volume, a `/healthz` healthcheck.

## 10. Security rules

- Every account query is scoped by the store itself (one database per account), and every
  newsletter-scoped action checks the actor's newsletter list in `runAction`.
- Input never becomes SQL, a field path, unescaped HTML, CSS, a template, a redirect target or a CSV
  formula. Redirects are same-origin or to a recorded link.
- Public endpoints have limits per visitor and per target. Nothing a script can trigger emails a
  stranger more than a few times a day.
- Webhooks verify signatures (SNS certificate from an amazonaws.com URL only, Svix, Stripe, Polar/Standard
  Webhooks) before any state change.
- MCP and API output that carries people's content is data, never instructions.
- No secrets, personal data or real addresses in code, tests, fixtures or commits. Tests use
  `example.com`.
