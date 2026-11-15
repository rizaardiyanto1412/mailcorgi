# Release follow-ups, round 2

Gaps found by checking a real Cloudflare deployment and by the last review. Each records the
contract it touches and the choice made.

## Static assets: 404 for missing build files, immutable hashed files

Contract: section 3.5 sends "everything else" to the SPA assets with an `index.html` fallback, and
section 9 says `wrangler.jsonc` declares the assets directory. Neither said what a missing build file
returns.

On Cloudflare, `/assets/*` skips the Worker (`run_worker_first: ["/*", "!/assets/*"]`), so the asset
server answered a missing hashed chunk with `index.html` and `200 text/html`. An open tab from the
previous deploy then failed with a MIME error. Workers' asset server also sends hashed files with
`max-age=0, must-revalidate`.

- `wrangler.jsonc` now sets `not_found_handling: "none"`. A missing `/assets/` file is a 404 from the
  asset server. The Worker still runs first for every other path and serves the SPA shell itself
  (`withSpaFallback` in `server/edge/assets.ts`): a GET or HEAD for a path whose last segment has no
  dot gets `/` from the assets binding. A path with a file extension stays a 404.
- `web/public/_headers` (copied to `web/dist/_headers`) makes `/assets/*`
  `public, max-age=31536000, immutable`. Workers reads it; it is not served as a file. The Node
  server already sent that header, now refuses `/_headers`, and also answers 404 for any missing path
  under `/assets/`, extension or not.
- The web app reloads once when a chunk fails to load: Vite's `vite:preloadError` event and the lazy
  campaign editor both call `reloadAfterDeploy()` (`web/src/lib/reload.ts`). A second failure within a
  minute is shown as an error instead of looping.
- The smoke step `12-static-assets.ts` checks all of this against both the Node build and
  `wrangler dev`.

## HSTS

Contract: section 3.5 sets `Secure` cookies when the app URL is https. Nothing sent HSTS.

The edge now adds `Strict-Transport-Security: max-age=31536000` to every response when the app is on
https and not on a local host (`localhost`, `*.localhost`, `127.x`, `::1`). `APP_URL` decides when it
is set. Without it, the request's scheme decides: the Worker sees the real scheme, and Node trusts
`x-forwarded-proto` only from a `TRUST_PROXY` peer. Browsers ignore the header on plain http, so the
request scheme cannot pin a host by mistake. There is no `includeSubDomains` and no `preload`: the
app often runs on a subdomain whose siblings MailCorgi does not control.

## Deleting a newsletter

Contract: section 6 lists create, edit, archive, switch. Nothing deleted a newsletter.

`newsletters.delete` (owner, `effect: 'write'`, MCP destructive, REST `DELETE /newsletters/:id`)
takes `confirmName`, which must equal the newsletter name. It refuses with `campaign_active` while a
campaign is `sending` or `scheduled`. A `paused` campaign does not block it, because a paused campaign
cannot be canceled, and its queued jobs are removed with it.

- The newsletters migration `2026-11-16-newsletters-deleting` adds `newsletters.deleting_at`. The
  action sets it (and `archived_at`) and enqueues `newsletters.delete` in one transaction, then
  answers `{ deleting: true }`. A repeat call while the job runs answers the same; after it is done,
  404.
- The `newsletter` resolver treats a deleting newsletter as missing, so every newsletter-scoped
  action 404s at once. **Shared-file edit:** `resolveNewsletterId` in `server/core/actions.ts` now
  also runs the `newsletter` resolver for the other resource types (contact, campaign, segment, …),
  so a contact or campaign of a deleting newsletter 404s too. That costs one indexed lookup per
  action. `newsletters.delete` itself has no `resource` (owner-only, checked by `runAction`), so a
  repeat call still reaches its handler.
- The job (`server/account/newsletters/delete.ts`) is idempotent and resumable. Each run deletes up
  to 20 images (blob first, then the `uploads` row, so a storage failure never leaks a file), queues
  removal of a Cloudflare custom hostname, deletes queued jobs that name the newsletter or its
  campaigns and imports, then deletes rows in chunks of 500 by `rowid`, children before parents
  (`DELETE_STEPS`), up to 20,000 rows or until the budget expires. Every statement binds two
  parameters. When nothing is left it calls `control.removeNewsletterAccess` (team grants and
  invites) and `control.removeSite` (directory), then deletes the newsletter row. A test fails when a
  new table with a `newsletter_id`, `campaign_id`, `contact_id`, `import_id`, `delivery_id` or
  `tag_id` column is not in `DELETE_STEPS`.
- Account-wide suppressions stay. The newsletter's own unsubscribe rows and `deleted_contacts` go,
  because the newsletter they guarded is gone.
- The UI is on the newsletter settings page and in the archived list: a dialog where the owner types
  the name.

## Image library

Contract: section 5.2 has `uploads`; nothing listed or deleted them.

`campaigns.listImages` (member, read) lists campaign images newest first with a keyset cursor.
Logos, icons and avatars are not listed; they have their own replace flows. `campaigns.deleteImage`
(admin, write, MCP destructive) takes the file name (`imageId`). When a campaign of that newsletter
or its settings still mentions the image, it answers `409 image_in_use` with
`details: { campaigns: [{ id, subject, status, kind }], settings }` and deletes nothing, unless
`confirm: true`. The search uses `instr`, not `LIKE`, because ids contain `_`. The blob is deleted
first, then the row. A deleted image may still sit in a browser or CDN cache for a while, since
`/img/` is served as immutable.

`campaigns.imageUsage` (member, read) answers the same `{ campaigns, settings }` without deleting.
The editor has an Images button. Its dialog lists the uploads; choosing one inserts it, and admins can
delete one. The dialog asks `imageUsage` first, so its one confirmation already names the campaigns
that use the image; the 409 guard stays for API and MCP callers.

## Invites without email

Contract: section 6 (team) says invitations are emailed links. An install on the built-in `test`
provider emails nothing.

`team.invite` and `team.resend` now also return `link` and `emailed`. Only the owner can call them, and
the owner can invite anyone, so showing the link leaks nothing. The token is still stored hashed;
this response is the only place the readable link exists, and `team.list` never carries it. A failed
email no longer answers 502: the invite is kept and the response says `emailed: false`, so the owner
can share the link or resend. `team.list` returns `emailConfigured` (false while the provider is
`test`), and the team page then says invitations are not emailed and labels the button "Create
invitation". After an invite or resend, the page shows the link once with a copy button.

## Sign-up without a real email provider

Contract: section 4 says further self-hosted users join by invitation or when their email is in
`ALLOWED_EMAILS`; follow-ups round 1 made the second path send an emailed code.

On a self-hosted install whose provider is `test`, `/api/auth/bootstrap` now reports
`signupOpen: false` even with an allowlist, so the sign-up page says "Sign-up is by invitation" and
points to invitation links instead of sending a code nobody receives. The bootstrap response gains
no new field, so anonymous visitors learn nothing about the provider. The sign-up API itself is
unchanged: tests and the dev outbox still use the code path. Cloud mode is unchanged.

## Follow-ups

- Replacing a logo, icon or author avatar keeps the old file in storage. A cleanup of unreferenced
  branding uploads would need the same "still used" check as campaign images.
