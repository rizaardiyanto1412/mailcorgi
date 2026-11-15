/**
 * Checks a real deployment over HTTPS without dev-only switches: no canned DNS, no dev outbox.
 * It creates its own newsletter, contacts, campaign draft, web post and API keys, and cleans up.
 *
 *   npm run live:check -- --url https://news.example.com --email admin@example.com --password '...'
 *
 * On a fresh install it runs first-run setup with those credentials (add --name to set the name).
 * Exit code 1 when any check fails.
 */
import { createSmokeContext, waitUntil, type SmokeContext } from './smoke-context.ts'
import { everyNodeDoc } from './smoke/70-journey-send.ts'

const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined)
const base = (arg('url') ?? '').replace(/\/+$/, '')
const email = arg('email') ?? process.env.MC_LIVE_EMAIL ?? ''
const password = arg('password') ?? process.env.MC_LIVE_PASSWORD ?? ''
const adminName = arg('name') ?? 'Live Check'
const CONTACTS = 1000
const CHUNK = 500
const SLOW_MS = 5000

if (!/^https?:\/\//.test(base) || !email || !password) {
  console.error('usage: npm run live:check -- --url <https://your.install> --email <admin email> --password <password> [--name <admin name>]')
  process.exit(2)
}

type RequestRecord = { step: string; method: string; path: string; status: number; ms: number; note?: string }
const requests: RequestRecord[] = []
let currentStep = 'start'

/** Every request the checks make goes through here, so slow answers, 5xx and limit errors are caught wherever they happen. */
const realFetch = globalThis.fetch
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const method = init?.method ?? 'GET'
  const started = performance.now()
  const response = await realFetch(input, init)
  const record: RequestRecord = { step: currentStep, method, path: url.pathname + (url.search.length > 60 ? url.search.slice(0, 60) + '…' : url.search), status: response.status, ms: Math.round(performance.now() - started) }
  if (response.status >= 500) {
    const body = await response.clone().text().catch(() => '')
    record.note = body.slice(0, 400)
  }
  requests.push(record)
  return response
}

const run = Math.random().toString(36).slice(2, 8)
const contactEmail = (i: number) => `live-${run}-${i}@example.com`
const ctx: SmokeContext = createSmokeContext(base)
const { action, json, call, expect, state, jar } = ctx

type StepResult = { name: string; ok: boolean; ms: number; error?: string; notes: string[] }
const results: StepResult[] = []
let notes: string[] = []
const note = (line: string) => notes.push(line)

async function step(name: string, needs: string[], fn: () => Promise<void>) {
  currentStep = name
  notes = []
  const started = performance.now()
  const missing = needs.filter((key) => !state.has(key))
  if (missing.length) {
    results.push({ name, ok: false, ms: 0, error: `skipped: an earlier step did not produce ${missing.join(', ')}`, notes })
    return
  }
  try {
    await fn()
    results.push({ name, ok: true, ms: Math.round(performance.now() - started), notes })
  } catch (err) {
    results.push({ name, ok: false, ms: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err), notes })
  }
}

const newsletter = () => state.get('newsletter') as { id: string; slug: string; key: string }
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

/** A 1×1 PNG with a random tail after IEND, so the bytes are unique to this run and still sniff as PNG. */
function uniquePng() {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
  const tail = new TextEncoder().encode(`mailcorgi-live-check-${run}-${Date.now()}`)
  const bytes = new Uint8Array(png.length + tail.length)
  bytes.set(png)
  bytes.set(tail, png.length)
  return bytes
}

/** Delete every contact of a newsletter, archive it and wait until its public site is gone. Returns the number deleted. */
async function emptyAndArchive(newsletterId: string, slug: string) {
  let deleted = 0
  for (let i = 0; i < 50; i++) {
    const page = await action('contacts.list', { newsletterId, limit: 100 })
    if (!page.contacts.length) break
    await action('contacts.bulk', { newsletterId, contactIds: page.contacts.map((c: { id: string }) => c.id), operation: 'delete' })
    deleted += page.contacts.length
  }
  const left = await action('segments.count', { newsletterId, filter: null })
  expect(left.count === 0, `every contact of ${slug} was deleted (${left.count} left)`)
  await action('newsletters.archive', { newsletterId })
  await waitUntil(`the archived website /n/${slug} to go away`, 20_000, async () => (await call('GET', `/n/${slug}`)).status === 404, 500)
  return deleted
}

const SECURITY_HEADERS = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy']

await step('1. Health, SPA, hashed asset, security headers', [], async () => {
  const health = await call('GET', '/healthz')
  expect(health.status === 200 && (await health.json()).ok === true, `/healthz answered ${health.status}`)
  const index = await call('GET', '/')
  const html = await index.text()
  expect(index.status === 200 && html.includes('id="root"'), `the SPA index is served (${index.status})`)
  for (const header of SECURITY_HEADERS) expect(index.headers.get(header), `the SPA index sends ${header}`)
  for (const header of SECURITY_HEADERS) expect(health.headers.get(header), `/healthz sends ${header}`)
  const deep = await call('GET', '/campaigns')
  expect(deep.status === 200 && (await deep.text()).includes('id="root"'), 'a client-side route falls back to the SPA')
  const asset = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
  expect(asset, 'the SPA index links a hashed /assets/*.js file')
  const served = await call('GET', asset!)
  const body = await served.text()
  expect(served.status === 200 && /javascript/.test(served.headers.get('content-type') ?? '') && body.length > 1000, `${asset} is served as JavaScript (${served.status} ${served.headers.get('content-type')})`)
  // The Worker adds a CSP to everything it answers; its absence shows the assets layer served the file directly.
  note(`${asset}: ${body.length} bytes, cache-control "${served.headers.get('cache-control')}", ${served.headers.get('content-security-policy') ? 'answered by the Worker' : 'served by the assets layer without the Worker'}`)
  const missing = await call('GET', '/assets/does-not-exist-' + run + '.js')
  note(`a missing hashed asset answers ${missing.status} ${missing.headers.get('content-type')}`)
  if (!index.headers.get('strict-transport-security')) note('no Strict-Transport-Security header (turn on HSTS in the Cloudflare zone if you use a custom domain)')
})

await step('2. Sign in, CSRF, sign-in timing', [], async () => {
  const boot = await json('GET', '/api/auth/bootstrap')
  if (boot.setupRequired) {
    await json('POST', '/api/auth/setup', { name: adminName, email, password })
    note('ran first-run setup')
  } else {
    await json('POST', '/api/auth/signin', { email, password })
  }
  const session = (await json('GET', '/api/auth/bootstrap')).session
  expect(session?.user?.email === email && session.csrf, 'signed in with a session and a CSRF token')
  jar.csrf = session.csrf
  const forged = await realFetch(`${base}/api/actions/newsletters.list`, { method: 'POST', headers: { cookie: jar.header(), 'content-type': 'application/json' }, body: '{}' })
  expect(forged.status === 403, `an action without the CSRF header is refused (${forged.status})`)
  // Password checks run PBKDF2 (100,000 iterations) in the ControlStore Durable Object.
  const samples: number[] = []
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    const r = await realFetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    samples.push(Math.round(performance.now() - started))
    expect(r.status === 200, `timed sign-in ${i + 1} answered ${r.status}: ${(await r.text()).slice(0, 300)}`)
  }
  note(`password sign-in wall time over 3 tries: min ${Math.min(...samples)} ms, median ${median(samples)} ms, max ${Math.max(...samples)} ms`)
  const health: number[] = []
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    await realFetch(`${base}/healthz`)
    health.push(Math.round(performance.now() - started))
  }
  note(`network round trip baseline (/healthz): median ${median(health)} ms, so sign-in costs about ${median(samples) - median(health)} ms on the platform`)
})

await step('3. Create a newsletter', [], async () => {
  const created = await action('newsletters.create', { name: `Live check ${run}` })
  expect(created.id && created.slug && created.key, 'the newsletter has an id, slug and key')
  await action('newsletters.update', { newsletterId: created.id, postalAddress: '1 Example Street, Example City' })
  state.set('newsletter', created)
  note(`newsletter ${created.id} (/n/${created.slug})`)
})

await step('4. Image upload to R2 and read back', ['newsletter'], async () => {
  const bytes = uniquePng()
  const data = btoa(String.fromCharCode(...bytes))
  const uploaded = await action('campaigns.uploadImage', { newsletterId: newsletter().id, data, width: 1, height: 1 })
  expect(uploaded.contentType === 'image/png' && uploaded.bytes === bytes.length, 'the upload reports the right type and size')
  const image = await fetch(new URL(uploaded.url, base))
  const back = new Uint8Array(await image.arrayBuffer())
  expect(image.status === 200, `the image URL answers ${image.status}`)
  expect(image.headers.get('content-type') === 'image/png', `the image comes back as image/png (${image.headers.get('content-type')})`)
  expect(back.length === bytes.length && back.every((b, i) => b === bytes[i]), `the image bytes match (${back.length} of ${bytes.length})`)
  note(`stored and read back ${back.length} bytes from ${uploaded.url.replace(base, '')}, cache-control "${image.headers.get('cache-control')}"`)
  state.set('image', { ...uploaded, url: new URL(uploaded.url, base).href })
  // Emails need absolute image URLs; a relative one means the account store does not know APP_URL.
  expect(/^https?:\/\//.test(uploaded.url), `the upload returned an absolute URL (got "${uploaded.url}")`)
})

await step(`5. Import ${CONTACTS} contacts through alarm-driven jobs`, ['newsletter'], async () => {
  const newsletterId = newsletter().id
  const tag = await action('tags.create', { newsletterId, name: `live-${run}` })
  const created = await action('imports.create', { newsletterId, mapping: { email: 'Email', name: 'Name', status: 'Status' }, options: { consent: true, tagIds: [tag.id] } })
  const importId = created.id as string
  for (let seq = 0; seq * CHUNK < CONTACTS; seq++) {
    const rows = Array.from({ length: CHUNK }, (_, n) => ({ Email: contactEmail(seq * CHUNK + n), Name: `Reader ${seq * CHUNK + n}`, Status: 'subscribed' }))
    expect((await action('imports.addChunk', { newsletterId, importId, seq, rows })).accepted === true, `chunk ${seq} accepted`)
  }
  await action('imports.start', { newsletterId, importId, totalRows: CONTACTS })
  const started = performance.now()
  let polls = 0
  const report = await waitUntil(`import of ${CONTACTS} contacts`, 300_000, async () => {
    polls++
    const r = await action('imports.get', { newsletterId, importId })
    if (['failed', 'canceled', 'stalled'].includes(r.status)) throw new Error(`the import ended as ${r.status}: ${r.error}`)
    return r.status === 'completed' ? r : null
  }, 1000)
  note(`the import finished ${Math.round(performance.now() - started)} ms after start (${polls} polls)`)
  expect(report.added === CONTACTS && report.processedRows === CONTACTS, `report counts: ${report.added} added, ${report.processedRows} processed, skipped ${JSON.stringify(report.skipped)}`)
  const total = await action('segments.count', { newsletterId, filter: null })
  expect(total.count === CONTACTS, `the newsletter has ${CONTACTS} contacts (${total.count})`)
  const tagged = await action('segments.count', { newsletterId, filter: { all: [{ field: 'tag', id: tag.id }, { field: 'status', in: ['subscribed'] }] } })
  expect(tagged.count === CONTACTS, `a segment of tagged subscribers counts ${CONTACTS} (${tagged.count})`)
  state.set('import', importId)
})

await step('6. Campaign draft, autosave, review, preview', ['newsletter'], async () => {
  const image = state.get('image') as { url: string } | undefined
  const doc = JSON.parse(JSON.stringify(everyNodeDoc).replaceAll('https://example.com/picture.png', image?.url ?? 'https://example.com/picture.png'))
  const draft = await action('campaigns.create', { newsletterId: newsletter().id, subject: `Live check issue ${run}`, doc })
  state.set('campaign', draft)
  const saved = await action('campaigns.update', { campaignId: draft.id, revision: draft.revision, previewText: 'Every block in one issue' })
  expect(saved.revision > draft.revision, 'autosave bumps the revision')
  await action('campaigns.update', { campaignId: draft.id, revision: draft.revision, previewText: 'stale' }, 409)
  const preview = await action('campaigns.preview', { campaignId: draft.id })
  const errors = preview.checks.filter((c: { level: string }) => c.level === 'error').map((c: { id: string }) => c.id)
  expect(errors.join(',') === 'sender_domain', `the only blocking review check is the missing verified domain (${errors.join(', ')})`)
  expect(preview.email.html.includes('Press me') && preview.email.html.includes('a callout') && preview.web.html.includes('Press me'), 'the email and web previews render every block')
  if (image) expect(preview.email.html.includes(image.url), 'the preview uses the uploaded image')
  note(`email preview ${preview.email.html.length} bytes; checks: ${preview.checks.map((c: { id: string; level: string }) => `${c.id}(${c.level})`).join(' ')}`)
})

await step('7. Public website, feed, sitemap, hosted form, public subscribe', ['newsletter'], async () => {
  const nl = newsletter()
  const author = await action('authors.create', { newsletterId: nl.id, name: 'Live Writer', slug: `live-writer-${run}`, bio: 'Newsletter author.' })
  state.set('author', author)
  await action('website.publishPost', { newsletterId: nl.id, subject: 'Live check post', slug: 'live-post', source: 'Hello **readers** & friends.', authorId: author.id })
  const page = `/n/${nl.slug}`
  // The public directory lives in the ControlStore; the newsletter syncs to it from its AccountStore.
  await waitUntil('the website to appear in the directory', 20_000, async () => (await call('GET', page)).status === 200, 500)
  for (const path of [page, `${page}/live-post`, `${page}/authors/live-writer-${run}`]) {
    const response = await call('GET', path)
    const html = await response.text()
    expect(response.status === 200 && html.includes('rel="canonical"'), `${path} renders (${response.status})`)
  }
  const feed = await call('GET', `${page}/feed.xml`)
  expect(feed.status === 200 && (await feed.text()).includes('Live check post'), `the RSS feed lists the post (${feed.status})`)
  const sitemap = await call('GET', `${page}/sitemap.xml`)
  expect(sitemap.status === 200 && (await sitemap.text()).includes('/live-post'), `the sitemap lists the post (${sitemap.status})`)
  const hosted = await call('GET', `/f/${nl.key}`)
  expect(hosted.status === 200 && (await hosted.text()).includes('name="formToken"'), `the hosted signup form renders (${hosted.status})`)
  const embed = await call('GET', `/embed.js?key=${nl.key}`)
  expect(embed.status === 200, `the embed script is served (${embed.status})`)
  const subscribe = async (address: string) => {
    const config = await json('GET', `/api/public/subscribe/${nl.key}`)
    await new Promise((resolve) => setTimeout(resolve, 2100))
    const r = await fetch(`${base}/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify({ email: address, formToken: config.formToken }) })
    return { status: r.status, body: await r.text(), cors: r.headers.get('access-control-allow-origin') }
  }
  const fresh = await subscribe(`live-${run}-signup@example.com`)
  const existing = await subscribe(contactEmail(1))
  expect(fresh.status === 200 && fresh.cors === '*', `a public subscribe answers 200 with CORS (${fresh.status}: ${fresh.body})`)
  expect(existing.status === fresh.status && existing.body === fresh.body, `a known address gets the same neutral answer (${existing.status}: ${existing.body})`)
  note(`public subscribe answer: ${fresh.body}`)
  const pending = await action('contacts.list', { newsletterId: nl.id, search: `live-${run}-signup@example.com` })
  note(`the new signup is ${pending.contacts[0]?.status ?? 'missing'} (double opt-in sends a confirm email through the configured provider)`)
  const signup = await action('signup.get', { newsletterId: nl.id })
  expect(signup.hostedUrl === `${base}/f/${nl.key}`, `signup settings show an absolute hosted form URL (got "${signup.hostedUrl}")`)
})

await step('8. API keys: REST, MCP, read-only refusal', ['newsletter'], async () => {
  const nl = newsletter()
  const key = await action('apikeys.create', { name: `Live check ${run}`, access: 'full' })
  state.set('fullKey', key)
  const readKey = await action('apikeys.create', { name: `Live check read ${run}`, access: 'read' })
  state.set('readKey', readKey)
  const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const seen = new Set<string>()
  let cursor: string | null = null
  let pages = 0
  do {
    const query: string = `limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const r = await fetch(`${base}/api/v1/newsletters/${nl.id}/contacts?${query}`, { headers })
    const data = await r.json()
    expect(r.status === 200, `REST page ${pages + 1} answered ${r.status}: ${JSON.stringify(data).slice(0, 300)}`)
    for (const c of data.contacts) seen.add(c.id)
    cursor = data.nextCursor
    pages++
  } while (cursor && pages < 20)
  expect(seen.size >= CONTACTS && pages >= 5, `REST paged through every contact (${seen.size} in ${pages} pages)`)
  const mcp = async (id: number, method: string, params: unknown = {}) => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    expect(r.ok, `MCP ${method} answered ${r.status}`)
    return r.json()
  }
  const init = await mcp(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'MailCorgi live check', version: '1' } })
  expect(init.result?.protocolVersion === '2025-06-18', 'MCP initializes')
  const tools = await mcp(2, 'tools/list')
  expect(tools.result?.tools?.some((t: { name: string }) => t.name === 'segments_count'), `MCP lists tools (${tools.result?.tools?.length})`)
  const count = await mcp(3, 'tools/call', { name: 'segments_count', arguments: { newsletterId: nl.id, filter: null } })
  expect(count.result?.isError === false && count.result.structuredContent.count >= CONTACTS, `MCP counts the contacts (${count.result?.structuredContent?.count})`)
  note(`MCP lists ${tools.result.tools.length} tools`)
  const refused = await fetch(`${base}/api/v1/newsletters/${nl.id}/contacts`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${readKey.secret}` }, body: JSON.stringify({ email: `live-${run}-nope@example.com` }) })
  expect(refused.status === 403, `a read-only key cannot write (${refused.status})`)
})

await step('9. Notifications show the finished import', ['import'], async () => {
  const list = await action('notifications.list')
  const item = list.items.find((n: { kind: string; href: string }) => n.kind === 'import_finished' && n.href.includes(state.get('import') as string))
  expect(item, 'the bell lists this run\'s finished import')
  note(`"${item.title}: ${item.body}"`)
})

await step('10. Clean up', [], async () => {
  const nl = state.get('newsletter') as { id: string } | undefined
  for (const keyName of ['fullKey', 'readKey']) {
    const key = state.get(keyName) as { id: string; secret: string } | undefined
    if (!key) continue
    await action('apikeys.revoke', { keyId: key.id })
    const after = await fetch(`${base}/api/v1/newsletters`, { headers: { authorization: `Bearer ${key.secret}` } })
    expect(after.status === 401, `a revoked key is refused (${after.status})`)
  }
  if (!nl) return
  const campaign = state.get('campaign') as { id: string } | undefined
  if (campaign) await action('campaigns.delete', { campaignId: campaign.id, revision: (await action('campaigns.get', { campaignId: campaign.id })).revision })
  const author = state.get('author') as { id: string } | undefined
  if (author) await action('authors.delete', { newsletterId: nl.id, authorId: author.id })
  const deleted = await emptyAndArchive(nl.id, (state.get('newsletter') as { slug: string }).slug)
  const earlier = (await action('newsletters.list')).newsletters.filter((n: { id: string; name: string }) => n.id !== nl.id && /^Live check [a-z0-9]{6}$/.test(n.name))
  for (const old of earlier) {
    await emptyAndArchive(old.id, old.slug)
    note(`also archived ${old.slug}, left by an earlier run that did not finish`)
  }
  note(`deleted ${deleted} contacts, the draft and the author; revoked both keys; archived the newsletter (there is no delete action for newsletters)`)
  if (state.has('image')) note('the uploaded test image stays in R2: there is no action to delete an upload')
})

currentStep = 'done'

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
console.log(`\nMailCorgi live check: ${base} (run ${run})\n`)
for (const r of results) {
  const stepRequests = requests.filter((q) => q.step === r.name)
  const slowest = stepRequests.reduce((max, q) => Math.max(max, q.ms), 0)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.name, 58)} ${pad(`${r.ms} ms`, 10)} ${stepRequests.length} requests, slowest ${slowest} ms`)
  for (const line of r.notes) console.log(`      - ${line}`)
  if (r.error) console.log(`      ! ${r.error}`)
}

const slow = requests.filter((q) => q.ms > SLOW_MS)
const errors = requests.filter((q) => q.status >= 500)
const limits = requests.filter((q) => q.note && /exceeded|1102|1027|subrequest|cpu|resource limit/i.test(q.note))
console.log(`\nRequests: ${requests.length}, over ${SLOW_MS} ms: ${slow.length}, 5xx: ${errors.length}, limit errors: ${limits.length}`)
for (const q of slow) console.log(`  SLOW ${q.ms} ms  ${q.method} ${q.path}  [${q.step}]`)
for (const q of errors) console.log(`  ${q.status}  ${q.method} ${q.path}  [${q.step}]\n        ${q.note?.replace(/\s+/g, ' ')}`)
const byPath = new Map<string, number[]>()
for (const q of requests) {
  const key = `${q.method} ${q.path.replace(/\?.*/, '').replace(/\/(nl|cmp|imp|ctc|key|aut)_[A-Za-z0-9]+/g, '/:id').replace(/\/[A-Z0-9]{20,}[^/]*/g, '/:id')}`
  byPath.set(key, [...(byPath.get(key) ?? []), q.ms])
}
console.log('\nSlowest endpoints (median / max over calls):')
for (const [key, values] of [...byPath].sort((a, b) => Math.max(...b[1]) - Math.max(...a[1])).slice(0, 8)) console.log(`  ${pad(key, 64)} ${median(values)} / ${Math.max(...values)} ms (${values.length}x)`)

console.log(`
Not checked on a live instance:
  - Sending a campaign: it needs a verified sending domain, which needs real DNS records. The review
    correctly blocks sending until then. Check it with your own domain from Admin → Setup.
  - Delivery, confirm and welcome emails: they need a real email provider. The built-in test
    provider stores emails and sends nothing, and the dev outbox that would show them is off in production.
  - Opens, clicks, unsubscribes and provider webhooks: they follow a real send.
  - CPU time per request: Cloudflare does not report it over HTTP. A request over the limit fails
    with error 1102, which this check flags; see Workers Logs for exact numbers.
`)

const failed = results.filter((r) => !r.ok)
if (failed.length || errors.length) {
  console.log(`live check: ${failed.length} step(s) failed, ${errors.length} server error(s)`)
  process.exitCode = 1
} else console.log('live check: all steps passed')
