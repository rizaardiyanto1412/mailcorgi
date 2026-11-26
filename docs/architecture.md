# MailCorgi architecture

MailCorgi is a newsletter app: write an issue, send it to a list, publish it on the web. It runs on
Cloudflare Workers (one click) or on any Node.js 22+ server (Docker). License: AGPL-3.0-only.

This file is the contract for everyone who builds MailCorgi. Read it before you write code. If the code
and this file disagree, fix one of them in the same change. `docs/decisions/` keeps the history of
each build unit's choices; their accepted deviations are folded in here.

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
    auth/ accounts/ directory/ install/ billing/ admin/ suppression/ setup/ dev/
  account/         account store: schema.ts, rpc.ts, routes.ts, modules below
    newsletters/ contacts/ segments/ imports/ campaigns/ render/ sending/
    tracking/ signup/ website/ domains/ stats/ hygiene/ team/ notifications/
    apikeys/ usage/ setup/ dev/
  email/           EmailProvider interface + ses.ts resend.ts postshiba.ts smtp.ts test.ts, platform-email.ts
  api/             REST v1 router, OpenAPI, MCP server (all generated from the action registry)
  platform-node.ts Node platform + entry (index.ts)
  test/            node --test suites and the test harness (harness.ts)
worker/index.ts    Cloudflare entry: Worker edge + ControlStore + AccountStore classes
web/               Vite + React 19 + Tailwind 4 SPA (dashboard, auth, admin)
  src/app/ ui/ lib/ features/<module>/
scripts/           ci.sh, smoke.ts + smoke/ (end to end), ui-pass.ts (browser pass), live-check.ts
                   (checks a real deployment), docs-api.ts, env-reference.ts, backup.mjs, install.sh
docs/              this file, self-hosting.md, cloud-mode.md, api.md (generated), decisions/
```

Code style follows Ansa: TypeScript strict, ES modules, 2 spaces, single quotes, no semicolons, imports
with `.ts` extensions, small files, comments only for a non-obvious why. No ORMs. No Node-only APIs
outside `platform-node.ts`, `server/email/smtp.ts` and `scripts/` (the Worker bundle must build with
`nodejs_compat` but may not depend on `fs`, `net` or `child_process`).

Dependencies stay few: `hono`, `@hono/node-server` (the Node HTTP adapter), `zod`, `aws4fetch`, `marked`,
`sanitize-html`, `papaparse` (web), `nodemailer` (Node only, dynamically imported), TipTap, React, TanStack
Query, react-router, lucide-react. Dev only: TypeScript, tsx, esbuild, Vite, Tailwind, wrangler, ESLint with
`typescript-eslint` and `eslint-plugin-react-hooks`. No Stripe or Polar SDK: call their HTTP APIs with `fetch`
and verify webhooks with WebCrypto.

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
`{ id: string, sql: string }` records tracked by id in `_migrations`. Each store's `schema.ts` retains
the fixed base ids (`0001-base`, `0002-base`, …) in their original order; a change to a base table's
indexes is appended as the next base id, never edited in. Legacy integer history is
converted transactionally to those ids on first startup, without replaying applied SQL.
Modules export lists from `server/<store>/<module>/migrations.ts` and contribute them through
`reg.migrations(list)` in `register(reg)`. Base migrations run first; pending module migrations run
in lexical id order, each SQL change and history entry in one transaction. Module ids use a real
date, module name and description (`2026-11-16-imports-add-foo`). Duplicate ids within a store,
malformed ids and wrong module names are rejected. Shipped ids and SQL are immutable.
A migration may touch only its module's tables or add columns/indexes it owns, and must be safe
after any other module's migrations. Feature units add their own migration and smoke step files;
see `docs/development.md`. At most 100 bound parameters per statement and
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
  keys: Keys                        // derived keys (3.6): session signing, credentials, tokenKey(accountId)
  now(): number                     // ms, test-controllable
  jobs: Jobs                        // enqueue / cancel on this store
  registry: Registry                // this store's actions, jobs, rpc, routes, resolvers
  meter: Meter                      // rows written and read since this instance opened (alarms count as writes)
  later: Later                      // later.add(key, flush): a write that may wait for the next alarm
  memory: Map<string, unknown>      // per-instance scratch; lost on restart, so only for what may be lost
}
interface Stores {
  control: ControlRpc               // typed async methods
  account(id: string): AccountRpc
}
interface Platform {
  blobs: BlobStore                  // put/get/delete/list by key, async, bytes + contentType; `separate` when stored outside the store's rows (R2, a disk)
  fetch: typeof fetch
  setAlarm(store: StoreRef, at: number | null): Promise<void>   // the store re-arms to its next wake time; null clears
  getAlarm(store: StoreRef): Promise<number | null>             // what is armed; asked once after a restart
  resolveDns(name: string, type: 'TXT'|'CNAME'|'MX'|'A'): Promise<string[]>  // DNS over HTTPS
  waitUntil(p: Promise<unknown>): void
  destroyStore(store: StoreRef): Promise<void>   // deletes an account store's data for good
  limits: { subrequestsPerRun: number }   // 40 on Workers Free, 900 otherwise, 900 on Node
}
```

**Row writes are the scarce resource.** Workers Free allows 100,000 Durable Object rows written a
day for the whole Cloudflare account, and a `setAlarm` costs one. So: a read-only request writes
nothing; a store calls `setAlarm` only when its next wake time differs from what it holds in memory
(one `getAlarm` read after a restart); an idle store writes nothing. Bookkeeping that may lag or be
lost (page views, repeat opens, load-only rate-limit counters, the stats rollup's change marker) lives in
`ctx.memory` and is written in one batch through `ctx.later` when the next alarm fires, within five
minutes of an alarm that is queued anyway, else on an alarm armed for that purpose. Counters a send
batch bumps (daily, campaign, usage) are written once per batch, and the control store grants send
permits for a whole batch or tells the sender when the batch will fit, so a send never spins for a
few tokens at a time. That batch write is one transaction. If the batch dies before it, nothing is
lost for good: the contact counters (`sent_count`, `last_sent_at`, the streaks) ride in the
delivery's own transaction, the rollup recounts the day and the campaign from the delivery rows,
and the hourly usage job recounts the month's emails from `deliveries.sent_at` (`usage.emails_sent`
only rises, so test emails, which have no delivery row, stay counted). The control store's permit
reservation is written before the sends, so it is never below what went out. An import commits 50
rows per transaction with one checkpoint and one daily counter write per newsletter and day.
A rate limit that guards authentication or email to strangers is durable
(`allowRate(…, { durable: true })`): its count is checkpointed in `rate_limits` every fifth of the
limit, so a restart, an eviction or key churn forgives at most that many attempts minus one, at a
cost of at most five rows per key and window. Limits that only protect against load (website
pages, API keys, unsubscribe posts) stay in memory. `docs/security-review.md` lists both with their
numbers. Code guesses are counted on the code row itself. Sends and first opens write no `events` row: the delivery row
is their record and the timeline reads it. The store's `Meter` counts rows as
Cloudflare bills them (`rowsWritten`, index entries included, plus one per alarm; `changes` on Node)
and `GET /api/dev/writes?accounts=…` reads it when `MC_TEST_DNS` is on. `npm run budget` prints
rows per operation on `wrangler dev` (`docs/performance.md`).

When the platform refuses a write (Cloudflare's quota message, a full disk), every entry point
answers `503 storage_write_limit` with a message a person can act on; reads keep working, a click
still redirects, a pixel still answers. An unsubscribe or a provider event (complaint, bounce) that
cannot be written is parked (`server/account/tracking/pending.ts`): in memory, and when
`platform.blobs.separate` is true (R2, a disk) as one small object under `<account>/pending/`, so an
eviction does not lose it; the reader or the mail provider is then answered as if it landed. Parked
items are applied by the next flush, by the daily ping and before every send batch, which sends
nothing while any wait or while the blob store cannot be listed, and a claimed delivery to a contact
whose unsubscribe waits is skipped. Without a separate blob store (a Worker with no `IMAGES`
bucket) the unsubscribe page still says it could not be recorded, and the memory copy is applied if
the instance survives. A job that
meets a refused write spends no attempt: the alarm throws so the platform retries it, and the Worker's
daily cron (`5 0 * * *`, after the quota resets) pings every account store so queued work resumes
without a visitor. The web app shows one banner while it sees that code.

`resolveDns` throws `DnsUnavailableError` on a network or HTTP error, an unreadable answer or a
resolver status other than NOERROR or NXDOMAIN; callers answer `503 dns_unavailable` and change
nothing, so a resolver outage never unverifies a domain or host. `MC_TEST_DNS` (JSON keyed
`TYPE:name`) replaces every lookup with canned answers for tests, smoke and the UI pass (see 3.6).
The Worker reads its plan from `WORKERS_PLAN`; `wrangler.jsonc` ships `"free"` (with `keep_vars`),
and a Workers Paid install deletes that line.

RPC methods are plain functions `(ctx, args) => result`. `server/control/rpc.ts` and `server/account/rpc.ts`
hold the typed interfaces (`ControlRpc`, `AccountRpc`); a module adds its methods by declaration merging
from its own folder and registers them with `reg.rpc(name, fn)`. Arguments and results are JSON only. On
Cloudflare a store class exposes one `rpc(name, args)` method whose result is `{ ok, result } | { ok: false,
code, message, status }` so an `AppError` crosses intact; on Node it is a direct call. Keep RPC surface
small and named by intent (`control.resolveSession`, `account.applyPolicy`).

### 3.3 Jobs

Each store has a `jobs` table: `id, kind, payload JSON, run_at, attempts, locked_until, claim_token,
last_error, dedupe_key UNIQUE NULL, created_at`. `ctx.jobs.enqueue(kind, payload, { runAt, dedupeKey })` is
synchronous, returns `{ id, created }` (`created: false` when the dedupe key already queued one) and arms
the alarm. The alarm handler claims due jobs, runs registered handlers (`reg.job(kind, handler)`), and
re-arms the alarm for the next wake time. A handler is async, gets a `Budget` (`take(n)`, `expired()`) and
returns `'done'` or `{ again: runAt }`. Failures retry with backoff up to 8 attempts, then land in
`jobs_dead` and raise an admin alert (`admin_alerts` in the control store; an account store gets there
through its own `alerts.raise` job). Every handler must be idempotent: a job can run twice.

### 3.4 Actions

Every customer-facing operation is one action. The dashboard, REST API and MCP all call the same one.

```ts
defineAction({
  name: 'contacts.create',                 // unique, dot-separated
  scope: 'account',                        // 'account' | 'control'
  role: 'member',                          // minimum: 'member' | 'admin' | 'owner' ; control: 'user' | 'installAdmin'
  effect: 'write',                         // 'read' | 'write' | 'send'
  resource: { type: 'newsletter', param: 'newsletterId' },  // which input names the resource; see 11.2
  input: z.object({...}),                  // zod; newsletter-scoped actions include newsletterId
  rest: { method: 'POST', path: '/newsletters/:newsletterId/contacts' },  // omit to hide from REST
  mcp: { title: 'Add a contact', destructive: false },                    // omit to hide from MCP
  handler: async (ctx, input, actor) => output,
})
```

- `runAction(ctx, name, rawInput, actor)` validates input, checks role and plan limits, runs the
  handler, and maps `AppError(code, message, status)` to responses. It is the only entry point.
- `actor = { userId, email, owner: boolean, grants: Record<newsletterId, 'admin' | 'member'>, access: 'full' | 'read',
  via: 'web' | 'api' | 'mcp', keyId?, installAdmin: boolean }`. Roles are per newsletter. `runAction` resolves
  the newsletter that the named resource really belongs to (11.2), then checks the actor's role for that
  newsletter, and rejects a non-`read` action for a `read` key. An action without a `resource` passes for
  the owner, and for anyone with at least one grant that meets its `role`; the handler filters by grants.
  A `send` action is refused while the account policy is not `active`. Details in section 11.
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
| `/api/v1/*`, `/mcp` | account store | API key `mc_<accountId>_<secret>`; `/mcp` also takes an OAuth access token `mca_<accountId>_<secret>` |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | edge | metadata built from the request's public origin (docs/oauth.md) |
| `/oauth/register` | control store | — |
| `/oauth/token`, `/oauth/revoke` | account store | code `mcc_`, refresh token `mcr_` or access token `mca_`, each `<prefix>_<accountId>_<secret>` |
| `/oauth/authorize` | web app | consent page; approval calls `oauth.decide` on the control store, which asks the account store for a code |
| `/t/o/:token`, `/t/c/:token`, `/u/:token`, `/confirm/:token`, `/keep/:token` | account store | token prefix `<accountId>.` (`/u/` also serves the preferences page for a `p` token) |
| `/api/public/subscribe/:newsletterKey`, `/embed.js?key=`, `/f/:newsletterKey` | account store | key `nl_<accountId>_<rand>` |
| `/api/public/tls-check?domain=` | edge | Caddy's on-demand TLS `ask`: 200 for the app host and verified custom hosts |
| `/n/:slug/*` and any request on a custom website host | account store | `control.lookupSite(slug or host)`, cached 60 s |
| `/hooks/ses`, `/hooks/resend`, `/hooks/postshiba` | account store(s) | signature checked at the edge, account from message tags |
| `/hooks/stripe`, `/hooks/polar` | control store | — |
| `/img/:accountId/:key` | blobs directly | path |
| `/healthz` | edge | — |
| `/api/dev/writes` | edge | only when `MC_TEST_DNS` is active: the write meters of the control store and the named account stores |
| `/api/dev/*`, `/hooks/test` | control store | only when `MC_TEST_DNS` is active (3.6) |
| everything else | SPA assets (`index.html` fallback for paths without a file extension) | — |

The edge forwards the original request to the store's HTTP app and adds trusted headers
(`x-mc-actor` = signed JSON actor, `x-mc-account`). Session cookie: `mc_session`, HttpOnly, SameSite=Lax,
Secure when the app URL is https. State-changing dashboard requests need the `x-mc-csrf` header that
matches the session's CSRF token.

Custom website hosts are known to the control directory. A request whose host is neither the app host
nor a known website host gets a 404. Website requests carry a signed actor only on the app host and
only for GET and HEAD (to leave the owner's visits out of page views); custom hosts never get one.

Static assets: on Cloudflare `/assets/*` skips the Worker and `not_found_handling` is `none`, so a
missing hashed file is a 404, never `index.html`; the Worker serves the SPA shell for other paths.
`web/public/_headers` makes `/assets/*` immutable for a year, and Node sends the same header. The web
app reloads once when a chunk from an older deploy fails to load.

Every response carries `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`) when the
app is on https and not on a local host. On Node the edge trusts `x-forwarded-for`, `-proto`, `-host`
and `x-real-ip` only from a peer named in `TRUST_PROXY` (addresses, or `true` for any private or
loopback peer) and strips them otherwise. The Worker uses `cf-connecting-ip`.

### 3.6 Secrets and config

No secret is required to deploy. On first boot the control store generates a master key and stores it
(Node: `DATA_DIR/secret.key`). `APP_SECRET` overrides it. Derived keys (HKDF): session signing, token
signing per account, credential encryption, suppression hashing.

Environment: `APP_URL` (optional; learned from the first sign-in when unset), `CLOUD=true`,
`BILLING_PROVIDER=stripe|polar`, `ADMIN_EMAILS` (comma list, install admins), `ALLOWED_EMAILS`,
`SIGNUP_MODE`, `DATA_DIR`, `PORT`, `HOST`, `TRUST_PROXY`, `IMAGES_PUBLIC_URL` (optional CDN origin for
images), `SEND_BATCH_SIZE`, `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` (optional), `WORKERS_PLAN`,
`WEBSITE_CNAME_TARGET`, `CF_API_TOKEN` / `CF_ZONE_ID`. The full list is generated into
`docs/self-hosting.md` from `scripts/env-reference.ts`, and a test fails when code and list differ.
Provider credentials (SES, Resend, PostShiba, SMTP, Stripe, Polar, Cloudflare) are entered in the install settings
page and stored encrypted in the control store; matching env vars (`SES_ACCESS_KEY_ID`,
`STRIPE_SECRET_KEY`, …) take precedence when set. Saving a provider choice that lacks its credentials
(after merging saved values and env) is refused with `400 missing_credentials`. Never log a secret or
an email body.

`MC_TEST_DNS` turns on canned DNS, the install-admin actions `dev.outbox`, `dev.ingest` and
`dev.controlOutbox`, `GET /api/dev/code`, and the `test` billing provider with `POST /hooks/test`. It
is inert when `NODE_ENV=production` (the Docker image sets it) and on a Worker whose app URL is not a
loopback address.

## 4. Modes

- **Self-hosted** (default): the first visitor creates the install admin (email + password, no email
  needed). Further users join by invitation link (proof on its own), or, when their email is in
  `ALLOWED_EMAILS`, with an emailed 6-digit code. While the email provider is `test`, sign-up is by
  invitation only. `ADMIN_EMAILS` grants install admin only to a verified address. Each user owns one
  account. No billing, no limits (newsletters and team size included).
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
sessions(id, user_id, csrf, created_at, expires_at, ip, user_agent)   -- id = sha256 of the cookie token
login_codes(email, code_hash, purpose 'signup'|'signin'|'reset', expires_at, attempts, PRIMARY KEY(email, purpose))
accounts(id, owner_user_id, name, status 'active'|'blocked'|'deleting', block_reason, policy_version, plan, plan_period_end,
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
outbox(id, to_email, subject, html, text, headers JSON, kind, created_at)    -- system emails from the `test` provider
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
suppressions(id, email, newsletter_id NULL, reason, created_at)
         -- account-wide rows (newsletter_id NULL): 'hard_bounce'|'complaint'|'manual'
         -- newsletter rows: 'unsubscribed'|'cleaned'
         -- UNIQUE(email) WHERE newsletter_id IS NULL; UNIQUE(newsletter_id, email) WHERE newsletter_id IS NOT NULL
         -- a contact's own opt-in removes only that newsletter's row; account-wide rows stay
deleted_contacts(email_hash, newsletter_id, deleted_at)      -- keeps a re-import from resubscribing them
imports(id, newsletter_id, status, source_preset, mapping JSON, options JSON, total_rows, processed_rows,
        added, updated, skipped JSON (by reason), created_by, created_at, finished_at, error)
import_chunks(import_id, seq, rows JSON, done INTEGER, PRIMARY KEY(import_id, seq))
campaigns(id, newsletter_id, author_id NULL, kind 'issue'|'welcome'|'keep'|'sequence', format 'doc'|'markdown'|'html',
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
           -- status: 'queued'|'sending'|'sent'|'delivered'|'bounced'|'complained'|'failed'|'skipped'|'unknown'
           -- also: attempt_token, attempt_at
provider_events(id PRIMARY KEY, delivery_id, type, occurred_at, received_at)   -- dedupe of webhook events
links(id, campaign_id, url, position, clicks, unique_clicks, UNIQUE(campaign_id, url))
events(id INTEGER PRIMARY KEY, type, newsletter_id, contact_id NULL, campaign_id NULL, delivery_id NULL,
       data JSON, at)       -- signup, confirm, unsubscribe, click, soft_bounce, bounce, complaint, cleaned, keep, campaign.*
                            -- sends and opens are not events: the delivery row (sent_at, opened_at) is their record
daily_stats(newsletter_id, day, subscribed, unsubscribed, sent, delivered, opens, clicks, bounces, complaints,
            page_views, PRIMARY KEY(newsletter_id, day))
page_views(id INTEGER PRIMARY KEY, newsletter_id, campaign_id NULL, path, referrer_host, country, at)
domains(id, name UNIQUE, status 'pending'|'verified'|'failed'|'suspended', provider_identity JSON,
        records JSON (name,type,value,purpose,found), last_checked_at, verified_at, created_at)
uploads(key PRIMARY KEY, newsletter_id NULL, content_type, bytes, width, height, created_by, created_at)
api_keys(id, name, hash UNIQUE, last4, access 'full'|'read', created_by, last_used_at, created_at, revoked_at)
api_idempotency(key PRIMARY KEY, fingerprint, response NULL, status NULL, expires_at)
notifications(id, user_id NULL, kind, tone, title, body, href, created_at, read_at)
usage(period PRIMARY KEY, emails_sent, contacts_peak)
outbox(id, to_email, subject, html, text, headers JSON, kind, created_at)    -- only the `test` provider writes here
_blobs(key, seq, content_type, data BLOB)   -- images when no R2 bucket is bound (Cloudflare only)
rate_limits, jobs, jobs_dead, _migrations
```

Every index entry is a row written (3.2), so the account store keeps only the indexes a hot query
needs; `server/test/index-audit.test.ts` pins the query plans. Besides the UNIQUE constraints above:
`contacts(newsletter_id, status)` (counts, audiences), `contacts(newsletter_id, created_at, id)` (the
default contact page; sorting by name or email scans or uses the unique email index),
`contacts(email, status)` (cross-newsletter bounces, the warm-up "fresh" check);
`deliveries(campaign_id, status) WHERE status IN ('queued', 'sending')` (the send loop; a sent row
leaves it; queries repeat that term so SQLite can use it), `deliveries(provider_message_id) WHERE
provider_message_id IS NOT NULL` (webhooks), the hygiene module's rolling-window index on sent rows;
`events(newsletter_id, at)` (daily rebuilds), `events(newsletter_id, contact_id, id)` (the timeline
and click bookkeeping), `events(campaign_id) WHERE type = 'soft_bounce'`; `page_views(newsletter_id,
at)`. Deliveries have no index on `contact_id`: per-contact lookups go through the UNIQUE
`(campaign_id, contact_id)` key with the newsletter's campaign ids. The `jobs` table has no index.
The base migration `0004-base` dropped the rest; a later audit appends another base migration rather
than editing a shipped one.

Module migrations add to the base tables above (each module owns its own):

- **newsletters**: `newsletters.deleting_at`.
- **contacts**: triggers that keep `account_meta.active_contacts` (subscribed + unconfirmed) exact.
- **imports**: `imports.uploaded_at`, `headers`, `added_detail`; `import_chunks.position`;
  `import_seen` (no longer written: the addresses already met are rebuilt from the stored chunks and
  kept in memory for the run), `import_skips`, `import_dns` (24-hour MX cache). Rows are committed
  50 at a time with one checkpoint per batch.
- **sequences**: `sequences(id, newsletter_id, name, status 'draft'|'active'|'paused'|'archived',
  entry JSON {type 'signup'|'tag'|'segment'|'manual', tagId?, segmentId?}, exit JSON {tagIds?,
  segmentId?}, delay_anchor 'enrolled_at', created_by, created_at, updated_at, archived_at)` with
  index `(newsletter_id, status)` (the list, and the tag hook's lookup of active sequences);
  `sequence_steps(id, sequence_id, position, delay_days, campaign_id UNIQUE, created_at, updated_at,
  UNIQUE(sequence_id, position))`; `sequence_enrollments(id, sequence_id, contact_id, status
  'active'|'paused'|'completed'|'exited', source, enrolled_at, last_step_id, next_step_id,
  next_run_at, exit_reason, paused_at, finished_at, UNIQUE(sequence_id, contact_id))` with the
  partial index `(next_run_at) WHERE status = 'active' AND next_run_at IS NOT NULL` for the
  scheduler. `paused` and `paused_at` are reserved for per-enrollment pause and resume, which no
  code writes yet.
- **sending**: `deliveries.attempts` (a temporary refusal retries at most 3 times).
- **signup**: `signup_settings`, `signup_mail` (confirmation and welcome attempts).
- **website**: `website_posts` (web-only Markdown posts), `website_hosts`, `website_cache_versions`
  plus triggers on `campaigns`, `newsletters` and `authors` that bump the cache version.
- **stats**: `stats_reports`, `stats_sources` (with a live trigger on `events`), `stats_website`.
- **hygiene**: `contacts.strict_ignored_streak`, `deliveries.hygiene_epoch`, `hygiene_requests`,
  `hygiene_paused`.
- **notifications**: `notifications.email_attempted_at`, `notification_receipts`,
  `notification_emails`, `notification_events`.
- **control/admin**: `admin_alert_emails`, `admin_alert_email_attempts` (email cooldowns).

### 5.3 State machines

- **Contact**: `unconfirmed → subscribed` (confirm link, or an import/API call that asserts consent,
  including a re-import of an existing unconfirmed contact);
  `subscribed → unsubscribed | bounced | complained | cleaned`. Only the contact's own action
  (confirm link, signup with opt-in) brings a suppressed address back. Imports and API calls never do.
  A signup with double opt-in may create an unconfirmed row for a deleted or newsletter-suppressed
  address; the tombstone and suppression stay until the reader confirms.
- **Campaign**: `draft → scheduled → sending → sent`; `sending ⇄ paused`; `scheduled ⇄ paused`
  (account protection only); `draft|scheduled → canceled`. A paused send cannot be canceled: stopping
  it marks the queued deliveries `skipped` and finishes the campaign as `sent`; a running send must be
  paused first. Sending now accepts a scheduled time up to 5 seconds in the past (clock drift).
  Only `draft` is editable. One delivery row per `(campaign_id, contact_id)`; a send is attempted at
  most once automatically (11.5).
- **Delivery**: `queued → sending → sent → delivered`; `sending|sent|delivered → bounced`;
  `sent|delivered → complained`; `queued → skipped`; `sending → failed` (definite refusal), back to
  `queued` (definite temporary refusal), or `unknown` (the outcome was never learned). Provider events can
  arrive early, late, twice and out of order (11.6).
- **Domain**: `pending → verified`; `verified → failed` when a daily recheck finds records gone;
  `failed → verified` on recovery.

All status changes go through one function per entity (`setContactStatus`, `transitionCampaign`, …) that
checks the transition, writes the `events` row and bumps `daily_stats`. Nothing else writes `status`.

## 6. Features by module

Each module owns its folder under `server/account/<module>/` (or `server/control/<module>/`), its
actions, its jobs, its tests in `server/test/<module>.test.ts`, and its pages in
`web/src/features/<module>/`. A module calls another module only through that module's exported
functions in its `index.ts`.

**newsletters** — create, edit, archive, switch, delete. Settings: identity, sender, reply-to, postal
address, logo, icon, theme (colors, fonts, button style, header/footer), authors, website options.
Unlimited newsletters on self-hosted; per-plan limits in cloud. Slug changes update the control
directory. Replacing a logo, icon or author avatar, or deleting an author, queues removal of the old
file after the new state commits (`newsletters.deleteImage`, skipped while anything still names it).
`newsletters.delete` (owner) needs `confirmName` equal to the name and is refused while a campaign is
sending or scheduled. It sets `deleting_at`, after which every action on the newsletter or its rows
404s, and a resumable `newsletters.delete` job removes images (blob first, then the row), queued jobs
and rows in chunks, then team grants, invites and the directory entry. Account-wide suppressions stay.

**contacts** — list with search, status filter, tag filter, sort, paging (keyset). Create, edit,
delete (writes `deleted_contacts`), bulk tag, bulk delete, bulk unsubscribe. Custom fields. Contact
page with timeline from `events`. CSV export (formula-safe cells). `subscribe()`, `unsubscribe()`,
`suppress()` and `isSuppressed()` live here and are the only write paths for subscription state.
`contacts/tags.ts` is the only writer of `contact_tags`: `addContactTags()` and `removeContactTags()`
serve `subscribe()` (new and existing contacts, so imports and `contacts.create` too), `contacts.update`
(`addTagIds`, `removeTagIds`), `contacts.bulk`, `tags.delete` and contact deletion. Other modules
register with `onContactTagsAdded(listener)`; a listener is called synchronously, inside the writing
transaction, once per contact with only the tags that contact newly gained and the write path
(`manual`, `api`, `mcp`, `bulk`, `import`, `signup`). Removals and tags already present emit nothing.

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
lists every skip reason with counts and a downloadable CSV of skipped rows (admins only). Imports use
`asserted` or `pending` consent, never `confirmed`. Opt-outs in the file become suppressed contacts and
count as `imported_<status>` skips. A row for an existing contact is a duplicate, except that a
consented subscribed row turns an existing `unconfirmed` contact `subscribed` and counts as
`updated`. The report splits added contacts into subscribed and unconfirmed, with the reason. Import
states: `uploading`, `queued`, `processing`, `completed`, `canceled`, `stalled` (no chunk for an hour),
`failed` (eight processing failures). Each row commits its contact change and checkpoint together.

**campaigns** — drafts, autosave with a `revision` check (a stale save gets a 409 with the newer
revision), duplicate, delete, schedule, cancel. Formats: `doc` (the editor), `markdown`, `html` (API and
MCP). Review step with checks: subject present and under 150 chars, preview text, unsubscribe link in
html format, size under Gmail's 102 KB clip, postal address, verified sender domain, images have alt
text, links resolve to http(s). Test email to up to 5 addresses. Image library: `campaigns.listImages`
lists campaign uploads (not logos, icons or avatars); `campaigns.deleteImage` refuses with
`409 image_in_use` while a campaign or the settings mention the image, unless `confirm: true`. A
deleted image can linger in caches because `/img/` is served immutable.

**sequences** — email sequences (drips): ordered steps a contact receives a set number of whole days
after entering, counted from enrollment (`delay_anchor = 'enrolled_at'`), not from the previous step.
Entry is one of `signup` (the public form only; imports and API-created contacts do not enter), `tag`
(a contact newly gains the tag, by any write path), `segment` or `manual`; exit rules name tags or a
segment. A contact enters a sequence at most once, and may be in several sequences. Each step owns a
hidden `campaigns` row (`kind = 'sequence'`, `web_visible = 0`, always `draft`) so rendering,
deliveries, tracking and stats are the campaign ones; that row is left out of `campaigns.list`, the
website and issue-based engagement, cannot be sent, scheduled, canceled, duplicated or deleted as a
campaign (`409 not_issue` / `sequence_step`), and can be saved through `campaigns.update` by admins
only. Sequences are archived, never deleted. This unit ships the tables and the draft-mode actions
(`sequences.list|get|create|update|archive|addStep|updateStep|deleteStep|reorderSteps`); a sequence is
`draft` or `archived` and nothing is enrolled or sent yet. The module listens to the contacts tag hook
with `syncContactTags`, which resolves the active tag-entry sequences a new tag starts with one
indexed read; the enrollment unit extends it to create enrollments.

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
(`install_settings.send_rate_per_second`, default 10). Features: schedule, pause, resume, stop (a paused
send only; see 5.3); gradual sending when the audience has at least 50 contacts the account never
emailed (step 1: everyone emailed before plus a random 2% of the new ones; step 2: 5% more 30 minutes
later; step 3: the rest 30 minutes after that); "most engaged first" (opened or clicked in the last 90
days now, the rest 24 hours later); `campaigns.sendMore` releases the next step at once. One gate,
`stepGate`, holds every step release (timed, `sendMore`, and a resume into a due step) while the whole
campaign's hard bounces exceed 2.5% or complaints 0.08%, once 20 emails went out; `sendMore` and
`resume` then refuse with `409 step_held`, and `campaigns.progress` reports `nextStepHeld { reason,
message }` so the dashboard disables the button and says why. A running send auto-pauses past the same
limits measured from the last resume (from 200 emails). Provider throttling or Gmail deferrals back off
with jitter and resume. Headers on every
email: `List-Unsubscribe` (https + mailto), `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
`Feedback-ID`, `X-MC-Account`, `X-MC-Delivery`. Suppressed and non-subscribed contacts are filtered at
audience time and again right before each send.

**tracking** — open pixel `/t/o/<token>`, click redirect `/t/c/<token>` (only to URLs recorded in
`links`: never an open redirect), unsubscribe `/u/<token>` (GET shows a confirm page, POST one-click per
RFC 8058), preferences page (also under `/u/`, picked by token purpose), `/keep/<token>`. Tokens are
HMAC-signed with the account's token key. Opens and clicks from link scanners are left out: known
scanner user agents, opens within 2 seconds and clicks within 3 seconds of the send (neither platform
can detect data-center IPs), and every link of an issue clicked within 10 seconds (undone). Opens
through recognized privacy proxies (Apple Mail, Google image proxy) are flagged. Provider webhooks (SES via SNS,
Resend via Svix, PostShiba via an HMAC-signed batch) become one event shape (`delivered`, `bounce` hard/soft, `complaint`, `deferred`) and
update deliveries, contacts, suppressions and, for hard bounces to nonexistent mailboxes, the global
suppression list in the control store.

**signup** — hosted form page `/f/<newsletterKey>`, embeddable script `/embed.js` (renders an iframe or
inline form), and `POST /api/public/subscribe/<newsletterKey>` (JSON or form-encoded, CORS open). Double
opt-in on by default: a confirm email, then `subscribed` on click. Welcome email after confirmation
(its content is a `kind: 'welcome'` draft campaign; confirm and welcome emails go out as system emails
with durable attempt records). Abuse limits: 20 submissions per IP per hour, 10 per target per hour,
honeypot field, a signed `formToken` from `GET /api/public/subscribe/<key>` that must be 2 seconds to
1 hour old, optional Turnstile, and no more than 3 confirm emails per address per day. Past the plan
contact limit the endpoint answers `503 not_accepting` and the owner is told once a month. A success
redirect may be any absolute http(s) URL (an exception to the same-origin rule in section 10).

**website** — server-rendered public site per newsletter at `/n/<slug>` and on a custom host: home
(description, signup form, featured and latest issues), issue pages, author pages, paging, RSS
(`/feed.xml`), `sitemap.xml`, `robots.txt`, Open Graph and Twitter meta, JSON-LD, canonical URLs.
Owner options: analytics ids (Plausible, GA4, Fathom, Umami by id only), custom head/body code (only on
a verified custom host), social links, hide an issue from the web, and web-only Markdown posts
(`website_posts`) that never send email. Pages are cached per newsletter cache version (Cache API on
Cloudflare, a 256-entry LRU on Node, `s-maxage=300`); unknown paths answer a 404 cached for 60
seconds. Page views are counted without cookies (bots, prefetches, feeds and 404s left out). Custom
host flow: owner enters a hostname, MailCorgi shows a CNAME target (`WEBSITE_CNAME_TARGET` or the app
host) and a TXT record at `_mailcorgi.<host>`, checks both, then registers the host in the control
directory through a job. On Cloudflare the
operator also adds the hostname to the Worker (Custom Domain or Cloudflare for SaaS; when
`CF_API_TOKEN` and `CF_ZONE_ID` are set MailCorgi creates the custom hostname itself). On Node the
bundled Caddy config uses on-demand TLS with `/api/public/tls-check` as its `ask` endpoint.

**domains** — sending domains. Adding one creates the provider identity (SES `CreateEmailIdentity` with
Easy DKIM and a custom MAIL FROM; Resend domains API), stores the DNS records to add (DKIM CNAMEs or
TXT, return-path MX + SPF TXT, DMARC TXT suggestion when the root has none), and checks them on demand
and daily. A newsletter can only send from a verified domain. SMTP and PostShiba installs skip provider identities
and only check SPF/DMARC presence.

**stats** — overview (subscribers over time, growth, last campaigns), campaign report (sent, delivered,
unique opens, unique clicks, bounces, complaints, unsubscribes, link table, by inbox provider,
timeline), contacts growth by source, website views. Counters come from `daily_stats`, cached
`campaigns.stats` and the `stats_*` tables, never from scanning `events` on page load; the one
exception is the current subscriber count, an indexed count on `contacts`. Rollup jobs rebuild them.

**hygiene** — on by default per newsletter. A contact who ignored N consecutive issues (default 8, and
at least 90 days subscribed) gets one "do you still want this?" email (`kind 'keep'`). No click within
14 days → `cleaned`. A scan queues at most 25 reminders per run; a strict-engagement option ignores
privacy-proxy opens. Account protection (always on): past 5% hard bounces or 0.3% complaints over the
latest 1,000 sent emails, or on any global spam-trap match, the account store pauses all sending and
scheduled campaigns and asks the control store to block the account (cloud,
`control.requestBlock`) or alerts the admin (self-hosted). Resume needs a newer active policy after
the block (cloud) or the owner typing `RESUME` (self-hosted), and starts a fresh 1,000-email window.

**team** — the owner invites people to each newsletter as `admin` or `member`. Self-hosted installs have
no team limit; in cloud mode the plan's `maxTeamPerNewsletter` limits members plus pending invitations
(5 when a plan sets none). Members write and edit drafts, list contacts and see stats. Admins also
send, import, export contacts and change newsletter settings. Only the owner manages billing, domains,
API keys, team and account deletion. Invitations are emailed links valid for 7 days; `team.invite`
also returns the link once, so an install without a real email provider can share it. The invitee
signs up or signs in, then sees the shared newsletter in their switcher. Team actions run in the
control store.

**notifications** — bell in the sidebar with unread count. Created by: import finished, campaign sent,
campaign paused, domain verified or failed, account blocked, invite accepted, plan limit near. Important
ones (paused or failed campaigns, failed domains, blocks, limits, failed imports, account protection)
are also emailed to the owner, at most once per kind in six hours. Install admins get `admin_alerts`
(dead jobs, provider refusing sends, webhook failures, auto-blocks) on `/admin` and by email to
`ADMIN_EMAILS`, with the same cooldown.

**apikeys + api** — keys `mc_<accountId>_<secret>` with `full` or `read` access, shown once. REST v1 and
the OpenAPI document at `/api/v1/openapi.json` come from the registry. MCP (`/mcp`, stateless streamable
HTTP, JSON-RPC over POST) exposes the same actions as tools; destructive and sending tools say so in
their descriptions and annotations. `llms.txt` and `/docs/api` render from the registry.

**control/auth** — sign-up (emailed 6-digit code in both modes, except first-run setup and invite
links), sign-in (password, or emailed code in cloud mode), sign-out, password reset, email change with
confirmation, sessions list and revoke. Passwords: PBKDF2-SHA256 via WebCrypto. Attempts are
rate-limited per IP and per email.

**control/billing + plans** (cloud only) — plans in `server/control/billing/plans.ts`: `free`, `starter`,
`growth`, `pro`, `scale`, each with `maxContacts`, `maxEmailsPerMonth`, `maxNewsletters`,
`maxTeamPerNewsletter`, monthly and yearly prices. One `BillingProvider` interface with `stripe.ts` and
`polar.ts`: `createCheckout`, `createPortal`, `changePlan`, `cancel`, `pause`, `resume`,
`verifyAndParseWebhook → BillingEvent[]`. Webhooks are idempotent through `billing_events`. Plan changes
are pushed to the account store with `account.applyPolicy`. Limits are enforced in `runAction` (contacts,
newsletters, team) and at send time (monthly emails). A blocked account's billing is paused; unblocking
resumes it; an account blocked for 30 days is canceled.

Billing details:
- Stripe uses API version `2026-09-30.endive`, checked against the published Stripe OpenAPI schema.
  Price lookup keys are `mailcorgi_<plan>_<monthly|yearly>`; Stripe prices must carry those keys.
- Polar products are configured by `polar_products` (or `POLAR_PRODUCTS`), a JSON object mapping
  `<plan>_<monthly|yearly>` to product UUIDs. Both providers use `fetch` and WebCrypto only.
- Polar's current API supports **pause at period end**, rather than immediate collection suspension.
  Blocking stops sending immediately after the policy push; Polar collection pauses at period end.
  Unblocking cancels a scheduled pause, or resumes an already paused subscription (which starts a
  new charged period). Stripe pauses collection immediately with `pause_collection.behavior=void`.
- Both webhook schemes enforce a 5-minute timestamp tolerance. Polar verification accepts Standard
  Webhooks keys and legacy Polar UTF-8 keys, as documented for secrets created before September 8,
  2026. Replay ids are namespaced by provider in `billing_events`; webhook application and policy
  enqueue commit together. Older event timestamps cannot overwrite newer subscription state.
- Payment failure keeps the current limits for 7 days; cancellation keeps them through the paid
  period plus a 7-day grace period. Payment recovery clears expiry. A 30-day block returns to free
  and cancels billing. Policy pushes requeue if the version changed while RPC was in flight.
- Account stores push usage immediately after bootstrap and hourly afterward through `usage.push`.
  Monthly limits at send time still use the reserved permits contract in 11.5. `billing.get` reads live
  counts through `account.liveUsage`, falling back to the snapshot; the admin list shows snapshots.
  Limit errors carry `details { resource, used, limit }`.
- Cloud plan-limit errors include `details.billingUrl = '/settings/billing'`; the shared web shell
  displays a link to plans and usage. Billing settings navigation is absent in self-hosted mode.

Provider documentation checked while implementing (November 15, 2026):
[Stripe checkout](https://docs.stripe.com/api/checkout/sessions/create),
[Stripe signatures](https://docs.stripe.com/webhooks/signature),
[Stripe OpenAPI](https://github.com/stripe/openapi/blob/master/openapi/spec3.json),
[Polar checkout](https://polar.sh/docs/api-reference/checkouts/create-session),
[Polar webhook delivery](https://polar.sh/docs/integrate/webhooks/delivery), and
[Polar live OpenAPI](https://api.polar.sh/openapi.json).


**control/admin** — install settings (email provider and credentials, sender for system emails, sending
on/off, billing provider keys, sign-up rules), accounts list with usage, block and unblock with a
reason, impersonation-free read-only account summary, alerts, dead jobs with retry, and a setup
checklist (`setup.checklist`, which asks account stores through `account.setupStatus`). Account deletion:
the owner requests it, the control store marks `deleting`, the account store cancels sends and wipes
itself and its images, then the control rows go.
The control store first cancels the subscription, then calls `account.selfWipe({})` until it returns
`{ done: true }`. The account store marks a deleting policy, cancels queued jobs, removes at most 20
blobs per call, and clears feature tables. Then `platform.destroyStore` deletes the store (Node removes
the database files; the Worker calls `deleteAll()` on the object); a 404 from a store that is already
gone counts as done. Control users, sessions, memberships, invites, sites, usage and addressed test
emails are removed only after that succeeds. Every step may retry.

Profile operations live in `control/accounts` and `web/src/features/account` (the existing `accounts`
feature entry re-exports it). Email changes use the `account_email_changes` confirmation table, expire
after 15 minutes and allow 5 wrong guesses; password and confirmed email changes revoke all sessions.
The edge resolves sessions afresh to make revocation effective on the next request. Account and billing
settings and install administration remain reachable before the first newsletter exists.

Admin sign-up rules use `signup_mode` (`closed`, `allowlist`, or cloud `open`) and comma-separated
`allowed_emails`. Environment values override stored settings. Billing secrets are encrypted and are
returned to the console only as configured flags. The admin console includes email provider settings
at `/admin/email`, alongside accounts, alerts, dead jobs, install settings and suppressions.

Global suppression RPCs: `control.reportSuppression({ emailHash, reason, nonexistent? })` and
`control.checkSuppressed({ emailHashes }) → { suppressed: string[] }` (up to 1000 hashes, SQL batches
of 90). Hashes are HMAC-SHA256 of trimmed, lowercase email with `keys.suppression`.
`reportSuppressions({ accountId, events })` also accepts verified provider bounce events for existing
callers and only adds permanent nonexistent-mailbox reports. Those expire in 180 days; spam traps and
other explicit permanent reports have no expiry.


**email** — `EmailProvider`: `send(message) → { id }`, `createIdentity(domain)`, `getIdentity(domain)`,
`deleteIdentity(domain)`, `parseWebhook(request) → ProviderEvent[]`, `capabilities`. Providers: `ses`
(SES v2 over `aws4fetch`), `resend`, `postshiba` (HTTP inject with the SMTP credential), `smtp` (Node only), `test` (writes to `outbox`; the default until
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
- `npm run smoke` — starts the Node build and a `wrangler dev` Worker, each in self-hosted and cloud
  mode, with `MC_TEST_DNS`, and runs the steps in `scripts/smoke/` (and `scripts/smoke/cloud/`)
  against each: first-run setup, create newsletter, import contacts, write and send a campaign through
  the test provider, open tracking, unsubscribe, archive page, API key call, MCP call, and each unit's
  own step. `--selfhosted`, `--cloud` and `--only node|wrangler` narrow a run.
- Generated docs are tested: `docs/api.md` must equal `npm run docs:api` output, and the environment
  reference in `docs/self-hosting.md` must match the code.
- `npm run ci` runs all of the above. There is no GitHub Actions workflow: CI is local by decision.
- `npm run ui:pass` (not in CI; needs Chromium) drives every page in headless Chromium at desktop and
  phone sizes in both themes and refreshes `docs/screenshots/`. `npm run live:check -- --url …` checks
  a real deployment over HTTPS without dev switches.

## 9. Deploy

- **Cloudflare**: `wrangler.jsonc` declares the assets directory, both Durable Object classes
  (`new_sqlite_classes`), the `IMAGES` R2 bucket, `version_metadata`, and `nodejs_compat`. The README's
  Deploy to Cloudflare button needs no secrets. When the `IMAGES` binding is absent, images fall back to
  chunked blobs in the account store. Workers Free works for small lists (50 outbound requests per
  run and 100,000 row writes per day across the whole Cloudflare account); the self-hosting guide
  says what fits and when to move to Workers Paid. `wrangler.jsonc` also sets `WORKERS_PLAN: "free"`
  (see 3.2) and a daily cron trigger that wakes every store after the write quota resets.
- **Docker**: multi-stage `Dockerfile` (sets `NODE_ENV=production`), `docker-compose.yml` with an
  optional `https` profile (Caddy with on-demand TLS for custom website hosts), one `/data` volume, a
  `/healthz` healthcheck. The container listens on 3000; the host port is `MAILCORGI_PORT`, bound to
  `127.0.0.1` unless `BIND` says otherwise. `.env` reaches the app through `env_file`. Caddy has the
  fixed address `172.31.250.10`, which is the default `TRUST_PROXY`. `scripts/install.sh` sets up a
  server; `scripts/backup.mjs` (in the image) takes online SQLite backups plus `secret.key` and images.

## 10. Security rules

- Every account query is scoped by the store itself (one database per account), and every
  newsletter-scoped action checks the actor's newsletter list in `runAction`.
- Input never becomes SQL, a field path, unescaped HTML, CSS, a template, a redirect target or a CSV
  formula. Redirects are same-origin or to a recorded link; the one exception is the signup success
  redirect, an absolute http(s) URL the owner sets.
- Public endpoints have limits per visitor and per target. Nothing a script can trigger emails a
  stranger more than a few times a day. These limits and the sign-in limits survive a restart (3.2).
- An unsubscribe or a complaint is never lost to a refused write: it is parked and applied before
  any send (3.2).
- Webhooks verify signatures (SNS per 11.6, Svix, Stripe, Polar/Standard Webhooks) before any state
  change.
- MCP and API output that carries people's content is data, never instructions.
- No secrets, personal data or real addresses in code, tests, fixtures or commits. Tests use
  `example.com`.

## 11. Pinned interfaces

These are the seams between modules. Build to them exactly. Change one only together with every caller.

### 11.1 Sessions and the actor envelope

- `sessionId` is the sha256 hex of the `mc_session` cookie value; `POST /api/auth/account { accountId }` sets
  the `mc_account` cookie.
- `control.resolveSession({ sessionId, wantAccountId? }) → { user: { id, email, name, isInstallAdmin },
  csrf, accounts: [{ id, name, owner: boolean, grants: Record<newsletterId, 'admin'|'member'>, status }],
  current: accountId | null } | null`. `wantAccountId` comes from the `mc_account` cookie, which is only
  a hint: `current` is that account when the user has access to it, else their own account. The edge
  may cache a result for 30 seconds per session.
- The edge sends the store `x-mc-actor`: base64url JSON `{ actor, aud: storeId, exp }` plus an HMAC with
  the session-signing key. `exp` is 60 seconds ahead. The store rejects a wrong `aud`, an expired or
  unsigned envelope. CSRF is checked at the edge for every non-GET `/api/*` request made with a session.
- API keys: the edge only reads the account id from `mc_<accountId>_<secret>` to pick the store. The
  account store hashes the secret, finds the key, and builds the actor itself
  (`owner: true, access: key.access`). A wrong secret is a 401 from the store.
- API transports discover both registries. Account actions run locally; control actions use
  `control.runApiAction({ name, input, actor: { userId, access, via, keyId?, oauth? } })`. The control store
  rebuilds the actor with empty grants and `owner: false`, checks that the action is exposed on that
  transport, then calls `runAction`. An account API key never gains install-admin access
  (`installAdmin: false`). An OAuth MCP session (`oauth: true`) acts as the signed-in user: the control
  store looks the user up and sets `installAdmin` with `isInstallAdmin`, as it does for a web session.
- REST write/send idempotency records are scoped to the authenticated key and retained for 24 hours.
  A synchronous reservation precedes execution; overlapping requests and uncertain failures return 409
  instead of risking a duplicate send. Completed results and application errors are replayed.

### 11.2 Authorization

- `resource.type` is one of `newsletter | contact | segment | campaign | import | author | tag | domain |
  apiKey | account`. For newsletter-scoped types `runAction` calls `resolveNewsletterId(ctx, type, id)`
  (one registry, each module registers its own resolver that reads the row). A missing row is a 404. If
  the input also carries `newsletterId` and it differs from the resolved one, that is a 404 too.
- Role check: owner passes everything. Otherwise `grants[newsletterId]` must meet the action's `role`.
  Account-level types (`domain`, `apiKey`, `account`) need `owner`.
- Handlers still put `newsletter_id = ?` in every query on newsletter-scoped tables.
- `effect`: a `read` key may only run `read` actions. MCP marks `write` and `send` tools as not
  read-only, and `send` tools as destructive.

### 11.3 Public tokens

`<accountId>.<purpose>.<payload>.<sig>`, all base64url except the account id. `sig` = HMAC-SHA256 over
`purpose.payload` with the account's token key, truncated to 16 bytes. Purposes and payloads:
`o` open (delivery id), `c` click (delivery id, link id), `u` unsubscribe (contact id, campaign id or 0),
`p` preferences (contact id), `cf` confirm (contact id, issued-at; valid 7 days), `k` keep (contact id,
issued-at; valid 30 days), `w` website-host verification, `form` signed signup-form timestamp. A
token for one purpose never passes for another. Tokens die with the contact row. Tracking owns
signing and verification; signup uses its exports.

### 11.4 Jobs, precisely

- `enqueue` inserts the row and arms the alarm in the same event. On Cloudflare both commit together
  (storage writes in one event are atomic). On Node there is no alarm registry: the scheduler asks each
  open store for its next wake time every second and, at startup, opens every account database.
- Next wake time = the smallest of `run_at` over unclaimed jobs and `locked_until` over claimed ones,
  or a pending `later` flush. Every store invocation (request, RPC, alarm) ends by re-arming to that
  time, but only calls `setAlarm` when the time differs from the one it holds in memory (3.2).
- A claim sets `locked_until` and a random `claim_token`. Completing, failing or rescheduling a job is a
  conditional update on that token, so a claimant whose lease expired cannot overwrite its successor.
- One `Budget` per invocation, shared by every handler in it: `budget.take(n)` returns how many outbound
  requests the caller may make now; `budget.expired()` says when to yield. Handlers that get nothing
  return `{ again: soon }`.

### 11.5 Sending, precisely

```ts
interface EmailProvider {
  name: 'ses' | 'resend' | 'postshiba' | 'smtp' | 'test'
  capabilities: { identities: boolean; events: boolean; idempotency: boolean }
  send(msg: { from, to, replyTo?, subject, html, text, headers: Record<string,string>,
              meta: { accountId: string; deliveryId: string | null; kind: 'campaign'|'system' },
              idempotencyKey: string }): Promise<SendResult>
  createIdentity?(domain): Promise<Identity>; getIdentity?(domain): Promise<Identity>; deleteIdentity?(domain): Promise<void>
  parseWebhook?(request, settings): Promise<{ confirmUrl?: string; events: ProviderEvent[] }>
}
type SendResult =
  | { ok: true; id: string }
  | { ok: false; kind: 'permanent' | 'temporary' | 'throttled' | 'unknown'; message: string; retryAfterMs?: number }
```

- `meta` travels with the message so events can be routed back: SES `EmailTags` (`mc_account`,
  `mc_delivery`) and the install's configuration set; Resend `tags`; PostShiba `X-Capsule-Unique-Args`. Also as `X-MC-Account` and
  `X-MC-Delivery` headers.
- Per delivery: set `status='sending', attempt_token, attempt_at` and commit, call the provider, then
  record the result. `unknown` (timeout, connection lost, or a crash that leaves a row in `sending` for
  more than 10 minutes) is retried with the same `idempotencyKey` only when the provider has
  `capabilities.idempotency`; otherwise the row becomes `unknown` and is never resent automatically. A
  later provider event for that delivery still updates it.
- Pace is install-wide. Before each batch the account store calls
  `control.takeSendPermits({ accountId, want }) → { granted, retryAt }` (token bucket at
  `send_rate_per_second`, and a rolling 60-minute count against `send_rate_per_hour` when one is set;
  at the hourly cap `retryAt` is when the oldest minute leaves the window). Monthly email limits are reserved in the same call in cloud mode.
- Block and plan changes: the control store bumps `accounts.policy_version`, and in the same transaction
  enqueues a `policy.push` job that calls `account.applyPolicy({ version, status, plan, limits })`. The
  account store ignores a version it already has or passed. A limit of `null` means unlimited (JSON has
  no Infinity); `usage.limits(ctx)` turns it into `Infinity`. Every send batch re-reads the local policy,
  so a block stops sending within one batch. Account-to-control updates (slug and host directory rows,
  usage snapshots, global suppression reports) use the same pattern in the other direction:
  enqueue a job, never a bare RPC after commit.

### 11.6 Provider events

```ts
interface ProviderEvent {
  id: string                 // provider's event id, or a hash of (message id, type, timestamp, recipient)
  type: 'delivered' | 'bounce' | 'complaint' | 'deferred'
  bounce?: { permanent: boolean; nonexistent: boolean; reason: string }
  accountId: string | null; deliveryId: string | null; messageId: string; recipient: string
  occurredAt: number
}
```

- The edge verifies the webhook, groups events by `accountId`, and calls
  `account.ingestProviderEvents(events)`. Events without an account are counted and dropped.
- The account store inserts each event into `provider_events` and applies it in one transaction; a
  duplicate id is a no-op, so counters and thresholds move once. A delivery is found by `deliveryId`,
  else by `provider_message_id`. An event for a delivery still in `sending` first marks it sent.
- SNS: accept only when `SigningCertURL` is https, its host matches `sns.<region>.amazonaws.com`
  (or `.amazonaws.com.cn`), its path ends in `.pem`, the fetch follows no redirect, the signature
  verifies, and `TopicArn` equals the configured `ses_sns_topic_arn`. A `SubscriptionConfirmation` is
  confirmed only under the same checks and only when `SubscribeURL` is on the same SNS host.

### 11.7 Shared module functions

```ts
// server/account/contacts/index.ts — the only writers of subscription state
subscribe(ctx, { newsletterId, email, name?, fields?, tags?, source, consent: 'asserted' | 'confirmed' | 'pending',
                 at? }): { contact, created: boolean, outcome: 'subscribed' | 'pending' | 'suppressed' | 'limit' | 'exists' }
unsubscribe(ctx, { contactId, reason?, campaignId? }): void
suppress(ctx, { email, newsletterId: string | null, reason }): void
isSuppressed(ctx, email, newsletterId): boolean
setContactStatus(ctx, contactId, status, detail?): void
// 'pending' → unconfirmed + confirm email (signup module sends it); it may create a row for a deleted or
// newsletter-suppressed address, which stays suppressed until 'confirmed'. 'asserted' never revives a
// suppressed or deleted address. Account-wide suppressions block all three. Plan limits are checked
// inside subscribe(), in its transaction, against the maintained account_meta.active_contacts counter.

// server/account/segments/index.ts
type Filter = { all: Filter[] } | { any: Filter[] } | { not: Filter } | Condition
type Condition =
  | { field: 'status'; in: ContactStatus[] } | { field: 'tag'; id: string }
  | { field: 'custom'; key: string; op: 'eq'|'neq'|'contains'|'gt'|'lt'|'set'|'unset'; value?: string|number|boolean }
  | { field: 'subscribedAt' | 'lastOpenedAt' | 'lastClickedAt' | 'lastSentAt'; op: 'before'|'after'|'withinDays'|'never'; value?: number }
  | { field: 'source' | 'provider'; in: string[] } | { field: 'email'; op: 'contains'|'endsWith'; value: string }
  | { field: 'engagement'; op: 'openedLast'|'clickedLast'|'ignoredLast'; issues: number }
compileFilter(filter: Filter | null, newsletterId: string): { where: string; params: Param[] }   // alias `c` = contacts
audienceQuery(ctx, newsletterId, audience): { where, params }   // adds status = 'subscribed' and suppression

// server/account/render/index.ts
renderEmail(input: { campaign, newsletter, theme, recipient: { contact, links: { unsubscribe, web, preferences, openPixel?, wrap?(url): string } } }):
  { subject: string; html: string; text: string; headers: Record<string,string> }
renderWeb(input: { campaign, newsletter, theme, author? }): { html: string; excerpt: string; image?: string }
renderDocPreview(doc, theme): string

// server/account/usage/index.ts
reserveContacts(ctx, n): boolean      // inside the caller's transaction
countEmails(ctx, n): void
limits(ctx): { maxContacts, maxEmailsPerMonth, maxNewsletters, maxTeamPerNewsletter }   // Infinity when self-hosted
```
