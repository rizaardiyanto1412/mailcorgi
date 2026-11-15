# Building a module

Every feature lives in one folder on the server and one on the web, plus one test file. You never
edit a shared file: the kernel wires your folder in through `register(reg)` and the feature list.

```
server/account/<module>/index.ts     actions, jobs, routes, RPC, resolvers   (or server/control/<module>/)
web/src/features/<module>/index.tsx  pages, sidebar and settings entries
server/test/<module>.test.ts         behavior tests through runAction and HTTP
```

Commands: `npm run dev` (API + Vite), `npm test`, `npm run typecheck`, `npm run lint`, `npm run ci` (all of it, plus build and smoke).

## Browser pass and screenshots

`npm run ui:pass` loads the whole app in headless Chromium. It is not part of `npm run ci`, because the
browser download is large. Run it after UI work, and before a release to refresh the screenshots.

```sh
npx playwright install chromium   # once per machine
npm run build
npm run ui:pass
```

The script (`scripts/ui-pass.ts`) starts the Node build on a random port with a temporary data directory
and the `test` email provider. It seeds a demo install through the HTTP API: an owner, two newsletters,
3,000 imported contacts with tags and custom fields, segments, an import with skipped rows, campaigns
in every status, a sent campaign with opens, clicks and unsubscribes, an admin and a member of the
first newsletter, API keys and published website posts. Two things cannot happen offline, so the
script writes them straight into the account database: the sending domain is marked verified, and a
few deliveries are marked bounced. Every server it starts gets canned DNS (`MC_TEST_DNS`), so the
run never reaches a real resolver.

Before seeding, it visits `/setup` on the fresh install. After the main run it starts a second, short
`CLOUD=true` server (test billing provider), signs up through the emailed code, and visits
`/settings/billing` and the sign-up code step (`cloud-settings-billing`, `cloud-signup-code`).

It then visits every route at 1440×900 and 390×844, in light and dark, and signs in as the member and
the admin to check the role-limited pages. Last, it clicks through the main jobs: add a contact,
build a segment, import a CSV, write a campaign with every block, review and send it, open the report,
invite a teammate, create an API key, change the theme, edit the signup form, add a website host and
create a newsletter. It fails on any console error, uncaught exception, failed request, 4xx or 5xx
response from the app, horizontal scroll, or a page left loading.

Screenshots land in `docs/screenshots/<theme>/<viewport>/<page>.png`; role pages are prefixed
`as-member-` and `as-admin-`, flows `flow-`. The README links a few of them. `UI_PASS_ONLY=<regex>` limits the
run to matching page names, `UI_PASS_KEEP=1` keeps the data directory and `UI_PASS_VERBOSE=1` prints the
server log. All seeded data uses `example.com` addresses.

## The module file

```ts
import { z } from 'zod'
import { defineAction } from '../../core/actions.ts'
import type { AccountRegistrar } from '../rpc.ts'

export const contactsModule = {
  name: 'contacts',
  register(reg: AccountRegistrar) {
    reg.resolver('contact', (ctx, id) => ctx.db.get<{ newsletter_id: string }>('SELECT newsletter_id FROM contacts WHERE id = ?', id)?.newsletter_id ?? null)
    reg.job<{ importId: string }>('imports.process', async (ctx, { importId }, budget) => { /* … */ return 'done' })
    reg.routes((app) => { app.get('/f/:key', (c) => c.html('…')) })
    reg.rpc('ingestProviderEvents', (ctx, { events }) => ({ applied: 0 }))
    return reg.actions(
      defineAction({ name: 'contacts.create', /* … */ }),
    )
  },
}
```

The module object is already imported in `server/account/modules.ts` as a stub. Keep the export name.
`register` must `return reg.actions(...)` so the web client gets your action types.

### Actions

`defineAction` needs `name`, `description`, `scope`, `role`, `effect`, `input` (a `z.object`), and
`handler(ctx, input, actor)`. Add `resource: { type, param }` for anything that belongs to a
newsletter; `runAction` resolves the owning newsletter through your resolver, checks the actor's
grant and rejects a `newsletterId` that does not match. Every input field needs `.describe('…')`:
`parity.test.ts` fails otherwise. Add `rest` and `mcp` to expose the action; REST paths must not
collide. Throw `AppError(code, message, status)` from `server/core/http.ts` for user-facing errors.
Account-level resources (`domain`, `apiKey`, `account`) need the owner. Put `newsletter_id = ?` in
every query on a newsletter-scoped table even though `runAction` checked already.

### Jobs

`ctx.jobs.enqueue(kind, payload, { runAt?, dedupeKey? })` is synchronous and returns `{ id, created }`.
Call it inside the same transaction as the rows it refers to. Handlers are async, get a shared
`Budget` (`budget.take(n)` for outbound requests, `budget.expired()` to yield) and return `'done'` or
`{ again: runAt }`. A throw retries with backoff; after 8 attempts the job moves to `jobs_dead` and
an admin alert is raised. Handlers must be idempotent. Never make an RPC after a commit to tell
another store something: enqueue a job that makes the call.

### Routes

`reg.routes((app) => …)` mounts Hono routes on the store's own app. The edge has already decided
this store answers (section 3.5 of the architecture); read `c.get('ctx')` and `c.get('actor')`
(null for public routes). Public routes rate-limit with `allowRate` from `server/core/ratelimit.ts`.

### RPC

Declare the method on the store's interface from your own folder, then register it:

```ts
declare module '../rpc.ts' {
  interface AccountRpc {
    ingestProviderEvents(args: { events: ProviderEvent[] }): Promise<{ applied: number }>
  }
}
reg.rpc('ingestProviderEvents', (ctx, args) => …)
```

Call it as `await ctx.stores.account(id).ingestProviderEvents({ events })` or `ctx.stores.control.x()`.
Arguments and results are JSON. An `AppError` thrown inside arrives intact on the caller's side.

### Migrations

The fixed base migrations in each store's `schema.ts` create the existing tables. Do not edit or
append to those arrays. A feature unit follows this pattern:

1. Create `server/<store>/<module>/migrations.ts`, exporting `migrations: readonly Migration[]` (`Migration` comes from `../../core/db.ts`).
2. Give each `{ id, sql }` a unique id such as `2026-11-16-imports-add-foo`; import the list in the module's `index.ts` and call `reg.migrations(migrations)` inside `register(reg)`.
3. Add a behavior test; never change a shipped id or SQL. Base migrations run first, then pending module ids in lexical order, each transactionally and once.

The id starts with a real `YYYY-MM-DD` date, the registering module's name, and a lowercase
hyphen-separated description. Duplicate ids within a store and malformed ids fail registration.
A migration may touch only its module's tables or add columns/indexes it owns. It must be safe after
any other module's migrations: do not depend on their order or on their new schema. Earlier-sorting
ids added later still run. Keep statements under 100 bound parameters (`insertMany` chunks for you).
Legacy integer history is converted to base ids on first startup, preserving timestamps and data.

### Smoke steps

1. Add a uniquely named file `scripts/smoke/<number>-<unit>.ts`; the runner discovers `.ts` files in filename order.
2. Export one default async function receiving `SmokeContext` from `../smoke-context.ts`; use `base`, `json`, `call`, `jar`, `expect`, and `state`.
3. Check your feature over HTTP and run `npm run smoke`; add your own file, never edit another step or the runner.

`json(method, path, body?, status = 200)` checks the response status and returns JSON. `call` uses
the shared cookie jar and CSRF token. `state` is a `Map<string, unknown>` for earlier results; validate
values before using them. `20-newsletter.ts` stores the created newsletter under `newsletter`.
Setup runs at `10`, newsletter creation at `20`, API checks at `30`, and session teardown at `90`;
place authenticated feature checks between `30` and `90`. Each target gets a fresh context.

Record deviations from the architecture contract in `docs/decisions/<unit>.md`; feature units do not
edit `docs/architecture.md` directly.

## The web file

```tsx
export const contactsFeature: Feature = {
  name: 'contacts',
  nav: [{ to: '/contacts', label: 'Contacts', icon: Users }],
  routes: [{ path: 'contacts', element: <ContactsPage /> }],
  settings: [{ to: '/settings/forms', label: 'Signup forms' }],
  settingsRoutes: [{ path: 'forms', element: <FormsPage /> }],
}
```

`web/src/app/routes.tsx` already lists your feature. Data goes through `useActionQuery(name, input)`
and `useAction(name, { invalidate: ['contacts.list'] })` from `web/src/lib/api.ts`; both are typed from
the server registry, so a renamed field fails `npm run typecheck`. `useSession()` gives the current
newsletter (`current`), the account and the user. UI pieces are in `web/src/ui/index.tsx`. Every list
needs an empty state that says how to add the first item. Copy is short and sentence case.

## Tests

```ts
const install = await createInstall({ env: { ALLOWED_EMAILS: 'b@example.com' } })   // or { cloud: true }
const owner = await install.signUp({ email: 'a@example.com' })
const nl = await owner.action('newsletters.create', { name: 'Weekly' })
await install.runJobs()                     // run every due alarm
install.clock.advance(60_000)               // the fake clock drives run_at, sessions and codes
install.outbox('control')                   // or install.outbox(accountId): what the test provider sent
install.dns.set('example.com', 'MX', ['mx.example.com'])
await expectError(() => owner.action('contacts.get', { contactId: 'x' }))   // → status, code
```

Assert what a user sees: action output, HTTP status, rows in `outbox`. Reach no network: the
harness's `fetch` throws. Use `example.com` addresses only.

Add `server/test/permissions/<module>.ts` exporting `entries` with `satisfies PermissionEntries` from `../permission-types.ts`.
Map every action name to `{ role, input? }`; `input` overrides the shared valid fixture when needed, and roles must be reviewed independently of action metadata.
The matrix test discovers these files automatically and rejects missing, stale or duplicate actions; adding a module needs no shared table edit.

## Rules that bite

No Node APIs outside `server/platform-node.ts`, `server/email/smtp.ts` and `scripts/`: `npm run build` includes
`wrangler deploy --dry-run`. Both modes (self-hosted, `CLOUD=true`) must work. Status changes go through the one
transition function per entity (section 5.3). Secrets and email bodies never reach logs or action output.
