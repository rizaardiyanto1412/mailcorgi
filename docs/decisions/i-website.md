# Public website implementation decisions

The website module serves newsletter homes, sent issues, author pages, web-only posts, RSS, sitemaps, and robots files. The settings page appears at `/website` and `/settings/website`.

## Web-only posts keep email campaigns separate

`website_posts` stores Markdown posts. Publishing a post never changes a campaign's sending status, queues a delivery, or sends email. This adds a module-owned table to the data model in architecture section 5.2. Sent campaigns remain in `campaigns`; `website.updateIssue` changes only their website slug, visibility, and author.

A disabled website serves a branded 404 with `noindex, nofollow`. Its feed and sitemap contain no issues. Archived newsletters remain unavailable through the directory and the account route.

## Cache invalidation follows database changes

`website_cache_versions` stores a counter for each newsletter. Module-owned triggers increment the counter when public campaign fields, newsletter settings, authors, posts, or host settings change. The migration adds triggers on `campaigns`, `newsletters`, and `authors` without changing their schemas or writers. This extends section 3.1's module ownership rule to observe another module's writes. The triggers keep invalidation correct when sending or theme actions change rows.

Cache keys contain the account, newsletter, version, origin, path, page, and five-minute time bucket. Cloudflare uses the Cache API. Node uses an LRU capped at 256 entries and about 16 MB of UTF-16 body strings. Successful responses include ETags, `s-maxage=300`, `stale-while-revalidate=60`, and a versioned `Cache-Tag`. Failed or hidden pages bypass the cache. Page-view counting runs after cache lookup, including on conditional requests.

The edge retains its 60-second positive directory cache. Unknown sites are not cached, so a just-created newsletter can appear when its directory job completes. The TLS check reads the directory directly, so removing verification does not leave a cached TLS approval. As section 3.5 specifies, the TLS check also accepts the app host.

## Host verification and provisioning use durable jobs

`website_hosts` stores the hostname, a signed purpose-`w` token, verification time, and optional Cloudflare hostname id. A hostname needs both the exact TXT value at `_mailcorgi.<hostname>` and a CNAME to `WEBSITE_CNAME_TARGET`, or the app hostname by default. A failed DNS check clears verification.

Host updates enqueue directory jobs in the same transaction. Cloudflare for SaaS provisioning first searches for the hostname, so a retry can recover after remote creation succeeded. Removing or replacing a provisioned hostname queues a deletion job. Cloudflare calls use `CF_API_TOKEN` and `CF_ZONE_ID` through `platform.fetch`.

The newsletter directory job reads the website module's exported `websiteHost` helper. This small shared edit preserves host state across slug changes, archive, and restore. `upsertSite` also preserves omitted host fields and rejects host collisions.

## Public content stays escaped

Page metadata, titles, descriptions, author biographies, labels, RSS fields, and sitemap fields are escaped. JSON-LD escapes characters that can close a script element. Issue bodies pass through `renderWeb`, then a website sanitizer that removes the document wrapper, lowers body headings, and adds image dimensions. XML output removes characters forbidden by XML 1.0. The XML test uses `xmllint` when installed and reports a skip otherwise.

Custom head and body HTML appears only when the current request uses the locally verified custom hostname. App-host pages never include that code. Analytics accepts provider ids only. Public pages use a CSP nonce for generated scripts, and Turnstile loads asynchronously when configured.

The edge forwards a signed actor for an owner's public request so the website can exclude that session from counts. Counts also exclude bots, prefetches, feeds, HEAD requests, and 404 pages. Referrers retain only the hostname. Browsers do not send the app session cookie to a different custom domain, so identifying an owner there requires a session cookie on that domain.

## Integration points for sibling units

- Signup forms post form-encoded data to the app origin at `POST /api/public/subscribe/:newsletterKey`. Fields are `email`, honeypot `website`, and millisecond `startedAt`. Turnstile adds its standard `cf-turnstile-response` field. The signup unit owns validation, confirmation, and the response page.
- Sending can import `websiteUrl(ctx, newsletterId)` from `server/account/website/index.ts` for canonical web links. It returns the verified custom origin, otherwise the app origin followed by `/n/<slug>`. Append the campaign slug, or its id when the slug is empty. Callers need the app URL available in their context; website routes and settings load the learned origin through the control RPC when needed.
- Web-only posts use ids prefixed with `post_`; page views for them have no `campaign_id`. Website totals still include those views in `daily_stats`.

## Other shared edits

`vite.config.ts` proxies only `/n` and its child paths to the API during development. The prior configuration returned the dashboard HTML for public pages. `server/test/edge.test.ts` now asserts that a known newsletter website returns its actual page rather than the previous stub's 404. No dependencies were added, and `docs/architecture.md` is unchanged as the unit instructions require.
