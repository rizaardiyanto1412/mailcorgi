import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createInstall, expectError, type Install, type Client } from './harness.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import { transitionCampaign } from '../account/campaigns/index.ts'

async function setup(cloud = false) {
  const install = await createInstall({ cloud, env: { ALLOWED_EMAILS: 'other@example.com' } })
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly <script>bad()</script>', slug: 'weekly' })
  await owner.action('newsletters.update', { newsletterId: nl.id, description: 'Ideas & <script>alert("x")</script>' })
  await install.runJobs()
  return { install, owner, nl }
}
async function sent(install: Install, owner: Client, newsletterId: string, subject = 'Sent issue') {
  const campaign = await owner.action('campaigns.create', { newsletterId, subject, format: 'markdown', source: 'Hello **readers**.\n\n![A corgi](https://example.com/corgi.png)\n\n<script>bad()</script>' })
  const ctx = install.app.account(owner.accountId!).ctx
  transitionCampaign(ctx, campaign.id, 'scheduled', { scheduledAt: ctx.now() + 1000 })
  transitionCampaign(ctx, campaign.id, 'sending')
  transitionCampaign(ctx, campaign.id, 'sent')
  await owner.action('website.updateIssue', { campaignId: campaign.id, slug: 'sent-issue', visible: true })
  return campaign
}
function basics(html: string) {
  assert.match(html, /<html lang="en"/)
  assert.equal((html.match(/<h1\b/g) || []).length, 1)
  assert.match(html, /<meta name="description" content="[^"]*">/)
  assert.match(html, /<link rel="canonical" href="http/)
  for (const img of html.match(/<img\b[^>]*>/g) || []) {
    assert.match(img, /\balt="[^"]*"/)
    assert.match(img, /\bwidth="\d+"/)
    assert.match(img, /\bheight="\d+"/)
  }
  for (const match of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => JSON.parse(match[1]))
}
for (const cloud of [false, true]) test(`public home, issue, author, feeds and web-only publishing (${cloud ? 'cloud' : 'self-hosted'})`, async () => {
  const { install, owner, nl } = await setup(cloud)
  try {
    const author = await owner.action('authors.create', { newsletterId: nl.id, name: 'Writer <script>x()</script>', slug: 'writer', bio: 'Bio <img src=x onerror=x()> & friends' })
    const campaign = await sent(install, owner, nl.id, 'Hello <script>alert(1)</script> & friends')
    await owner.action('website.updateIssue', { campaignId: campaign.id, slug: 'sent-issue', visible: true, authorId: author.id })
    const post = await owner.action('website.publishPost', { newsletterId: nl.id, subject: 'Web-only story', slug: 'web-only', source: 'This is **web only**.', authorId: author.id })
    assert.equal(install.outbox(owner.accountId!).length, 0)
    for (const path of ['/n/weekly', '/n/weekly/sent-issue', '/n/weekly/authors/writer', '/n/weekly/web-only']) {
      const response = await install.fetch(path)
      assert.equal(response.status, 200, path)
      const html = await response.text()
      basics(html)
      assert.doesNotMatch(html, /<script>(?:alert|bad|x)\(/)
      assert.doesNotMatch(html, /<img src=x/)
      assert.match(response.headers.get('cache-control')!, /s-maxage=300.*stale-while-revalidate/)
      assert.ok(response.headers.get('etag'))
    }
    const home = await (await install.fetch('/n/weekly')).text()
    assert.match(home, /action="http:\/\/app.example.com\/api\/public\/subscribe\/nl_acc_/)
    assert.match(home, /name="formToken"/)
    assert.match(home, /name="website"/)
    assert.match(home, /Featured issue/)
    const issue = await (await install.fetch('/n/weekly/sent-issue')).text()
    assert.match(issue, /Hello &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; friends/)
    assert.match(issue, /property="og:image" content="https:\/\/example.com\/corgi.png"/)
    assert.match(issue, /\\u003cscript\\u003e/)
    assert.match(issue, /Share on LinkedIn/)
    const authorPage = await (await install.fetch('/n/weekly/authors/writer')).text()
    assert.match(authorPage, /Bio &lt;img src=x onerror=x\(\)&gt; &amp; friends/)
    const rss = await (await install.fetch('/n/weekly/feed.xml')).text()
    assert.match(rss, /<rss version="2.0"/)
    assert.match(rss, /<content:encoded>[\s\S]*&lt;strong&gt;readers&lt;\/strong&gt;/)
    assert.doesNotMatch(rss, /<script>/)
    assert.match(rss, /Hello &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; friends/)
    const sitemap = await (await install.fetch('/n/weekly/sitemap.xml')).text()
    assert.match(sitemap, /http:\/\/app.example.com\/n\/weekly\/sent-issue/)
    assert.match(sitemap, /\/authors\/writer/)
    assert.match(await (await install.fetch('/n/weekly/robots.txt')).text(), /Sitemap: http:\/\/app.example.com\/n\/weekly\/sitemap.xml/)
    await owner.action('website.publishPost', { newsletterId: nl.id, postId: post.id, subject: 'Hidden web post', slug: 'web-only', source: 'Hidden', visible: false })
    assert.equal((await install.fetch('/n/weekly/web-only')).status, 404)
  } finally { install.close() }
})
test('feeds and sitemap are well-formed XML, including adversarial titles and body text', async (t) => {
  const { install, owner, nl } = await setup()
  try {
    await owner.action('website.publishPost', { newsletterId: nl.id, subject: 'A & B <script>"x"</script> ]]> \u0001', slug: 'xml', source: 'A & B < C\n\n```\n</script> & ]]>\n```' })
    for (const path of ['feed.xml', 'sitemap.xml']) {
      const body = await (await install.fetch(`/n/weekly/${path}`)).text()
      const validation = spawnSync('xmllint', ['--noout', '-'], { input: body, encoding: 'utf8' })
      if (validation.error && 'code' in validation.error && validation.error.code === 'ENOENT') { t.skip('xmllint is unavailable on this machine'); return }
      assert.equal(validation.status, 0, validation.stderr)
    }
  } finally { install.close() }
})
test('drafts, hidden campaigns, non-issue campaigns and other accounts never become public', async () => {
  const { install, owner, nl } = await setup()
  try {
    const draft = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Secret draft' })
    assert.equal((await install.fetch(`/n/weekly/${draft.id}`)).status, 404)
    assert.equal((await expectError(() => owner.action('website.updateIssue', { campaignId: draft.id, slug: 'draft', visible: true }))).code, 'not_sent')
    const campaign = await sent(install, owner, nl.id)
    await owner.action('website.updateIssue', { campaignId: campaign.id, slug: 'sent-issue', visible: false })
    for (const path of ['sent-issue', campaign.id, 'missing', 'authors/missing']) {
      const response = await install.fetch(`/n/weekly/${path}`)
      assert.equal(response.status, 404)
      basics(await response.text())
    }
    const other = await install.signUp({ email: 'other@example.com' })
    const theirs = await other.action('newsletters.create', { name: 'Other', slug: 'other' })
    const post = await other.action('website.publishPost', { newsletterId: theirs.id, subject: 'Other issue', slug: 'theirs', source: 'Other' })
    await install.runJobs()
    assert.equal((await install.fetch('/n/weekly/theirs')).status, 404)
    assert.equal((await other.actionRaw('website.get', { newsletterId: nl.id })).status, 404)
    assert.equal((await owner.actionRaw('website.publishPost', { newsletterId: nl.id, postId: post.id, subject: 'Stolen', slug: 'stolen', source: '' })).status, 404)
    const ctx = install.app.account(owner.accountId!).ctx
    const actor: Actor = { userId: 'member', email: 'member@example.com', owner: false, grants: { [nl.id]: 'member' }, access: 'full', via: 'web', installAdmin: false }
    for (const name of ['website.get', 'website.update', 'website.publishPost', 'website.setHost', 'website.checkHost', 'website.stats']) {
      await assert.rejects(() => runAction(ctx, name, { newsletterId: nl.id, settings: {}, subject: 'X', slug: 'x', source: '', hostname: 'news.example.com' }, actor), (e: unknown) => e instanceof AppError && e.status === 403)
    }
  } finally { install.close() }
})
test('cache versions change on campaigns, theme, authors, website settings and hiding posts', async () => {
  const { install, owner, nl } = await setup()
  try {
    const post = await owner.action('website.publishPost', { newsletterId: nl.id, subject: 'First', slug: 'first', source: 'First body' })
    const first = await install.fetch('/n/weekly/first')
    const etag = first.headers.get('etag')!
    const tag = first.headers.get('cache-tag')
    assert.equal((await install.fetch('/n/weekly/first', { headers: { 'if-none-match': etag } })).status, 304)
    assert.equal((await install.fetch('/n/weekly/first', { method: 'HEAD' })).body, null)
    await owner.action('campaigns.updateTheme', { newsletterId: nl.id, theme: { accent: '#075985' } })
    const changed = await install.fetch('/n/weekly/first', { headers: { 'if-none-match': etag } })
    assert.equal(changed.status, 200)
    assert.notEqual(changed.headers.get('etag'), etag)
    assert.notEqual(changed.headers.get('cache-tag'), tag)
    assert.match(await changed.text(), /--accent:#075985/)
    await owner.action('website.publishPost', { newsletterId: nl.id, postId: post.id, subject: 'First', slug: 'first', source: 'Secret', visible: false })
    assert.equal((await install.fetch('/n/weekly/first', { headers: { 'if-none-match': etag } })).status, 404)
    const campaign = await sent(install, owner, nl.id)
    const before = (await install.fetch('/n/weekly')).headers.get('cache-tag')
    await owner.action('website.updateIssue', { campaignId: campaign.id, slug: 'renamed', visible: true })
    assert.notEqual((await install.fetch('/n/weekly')).headers.get('cache-tag'), before)
    assert.equal((await install.fetch('/n/weekly/sent-issue')).status, 404)
    assert.equal((await install.fetch('/n/weekly/renamed')).status, 200)
  } finally { install.close() }
})
test('custom hostname requires both DNS records; custom code runs only on the verified host', async () => {
  const { install, owner, nl } = await setup()
  try {
    const options = await owner.action('website.get', { newsletterId: nl.id })
    await owner.action('website.update', { newsletterId: nl.id, settings: { ...options.settings, headCode: '<meta name="custom-marker" content="yes">', bodyCode: '<script>window.customHostOnly=true</script>', plausible: 'news.example.com', ga4: 'G-123ABC', fathom: 'ABCDEFGH', umami: 'abcdef12-1234-1234-1234-abcdef123456' } })
    const info = await owner.action('website.setHost', { newsletterId: nl.id, hostname: 'news.example.com' })
    assert.match(info.txt.value, new RegExp(`^${owner.accountId}\\.w\\.`))
    await install.runJobs()
    assert.equal((await install.fetch('https://news.example.com/')).status, 404)
    assert.equal((await install.fetch('/api/public/tls-check?domain=news.example.com')).status, 404)
    install.dns.set(info.cname.name, 'CNAME', [info.cname.value + '.'])
    assert.equal((await owner.action('website.checkHost', { newsletterId: nl.id })).verifiedAt, null)
    install.dns.set(info.txt.name, 'TXT', ['"' + info.txt.value + '"'])
    assert.ok((await owner.action('website.checkHost', { newsletterId: nl.id })).verifiedAt)
    await install.runJobs()
    install.clock.advance(61000)
    assert.equal((await install.fetch('/api/public/tls-check?domain=news.example.com')).status, 200)
    const response = await install.fetch('https://news.example.com/')
    assert.equal(response.status, 200)
    const custom = await response.text()
    assert.match(custom, /name="custom-marker"/)
    assert.match(custom, /window.customHostOnly=true/)
    assert.match(custom, /rel="canonical" href="https:\/\/news.example.com"/)
    assert.match(custom, /action="http:\/\/app.example.com\/api\/public\/subscribe\//)
    const app = await (await install.fetch('/n/weekly')).text()
    assert.doesNotMatch(app, /custom-marker|window.customHostOnly/)
    for (const domain of ['plausible.io', 'googletagmanager.com', 'usefathom.com', 'cloud.umami.is']) assert.ok(app.includes(domain))
    assert.equal((await owner.actionRaw('website.update', { newsletterId: nl.id, settings: { ga4: 'G-123" onload="alert(1)' } })).status, 400)
    await owner.action('newsletters.setSlug', { newsletterId: nl.id, slug: 'weekly-new' })
    await install.runJobs()
    assert.equal((await install.fetch('https://news.example.com/')).status, 200)
    await owner.action('newsletters.archive', { newsletterId: nl.id })
    await install.runJobs()
    assert.equal((await install.fetch('https://news.example.com/')).status, 404)
    await owner.action('newsletters.unarchive', { newsletterId: nl.id })
    await install.runJobs()
    install.clock.advance(61000)
    assert.equal((await install.fetch('https://news.example.com/')).status, 200)
    install.dns.set(info.txt.name, 'TXT', [])
    assert.equal((await owner.action('website.checkHost', { newsletterId: nl.id })).verifiedAt, null)
    await install.runJobs()
    assert.equal((await install.fetch('/api/public/tls-check?domain=news.example.com')).status, 404)
    assert.equal((await install.fetch('https://news.example.com/')).status, 404)
    assert.equal((await install.fetch('https://unknown.example.com/')).status, 404)
  } finally { install.close() }
})
test('human page loads count once per request, including cache hits; bots, prefetch and owner visits do not', async () => {
  const { install, owner, nl } = await setup()
  try {
    const headers = { 'user-agent': 'Mozilla/5.0 Reader', referer: 'https://search.example.com/find?private=secret', 'cf-ipcountry': 'ID' }
    for (let i = 0; i < 2; i++) assert.equal((await install.fetch('/n/weekly', { headers })).status, 200)
    await owner.fetch('/n/weekly', { headers })
    await install.fetch('/n/weekly', { headers: { ...headers, 'user-agent': 'Googlebot' } })
    await install.fetch('/n/weekly', { headers: { ...headers, 'sec-purpose': 'prefetch;prerender' } })
    await install.fetch('/n/weekly', { method: 'HEAD', headers })
    await install.fetch('/n/weekly/feed.xml', { headers })
    const stats = await owner.action('website.stats', { newsletterId: nl.id })
    assert.equal(stats.days[0].page_views, 2)
    assert.deepEqual(stats.referrers, [{ host: 'search.example.com', views: 2 }])
    const rows = install.app.account(owner.accountId!).ctx.db.all<{ country: string; referrer_host: string }>('SELECT country, referrer_host FROM page_views')
    assert.deepEqual(rows.map((row) => ({ ...row })), Array(2).fill({ country: 'ID', referrer_host: 'search.example.com' }))
  } finally { install.close() }
})
test('paging, disabled archive noindex, slug collisions and foreign author validation', async () => {
  const { install, owner, nl } = await setup()
  try {
    for (let i = 0; i < 12; i++) await owner.action('website.publishPost', { newsletterId: nl.id, subject: `Story ${i}`, slug: `story-${i}`, source: 'Read me' })
    const home = await (await install.fetch('/n/weekly')).text()
    assert.match(home, /rel="next" href="http:\/\/app.example.com\/n\/weekly\?page=2"/)
    const second = await (await install.fetch('/n/weekly?page=2')).text()
    assert.equal((second.match(/<article class="card/g) || []).length, 2)
    for (const query of ['page=0', 'page=-1', 'page=no', 'page=999']) assert.equal((await install.fetch(`/n/weekly?${query}`)).status, 404)
    assert.equal((await owner.actionRaw('website.publishPost', { newsletterId: nl.id, subject: 'Collision', slug: 'story-0', source: '' })).status, 409)
    assert.equal((await owner.actionRaw('website.publishPost', { newsletterId: nl.id, subject: 'Reserved', slug: 'authors', source: '' })).status, 400)
    assert.equal((await owner.actionRaw('website.publishPost', { newsletterId: nl.id, subject: 'Foreign author', slug: 'foreign', source: '', authorId: 'missing' })).status, 404)
    const options = await owner.action('website.get', { newsletterId: nl.id })
    await owner.action('website.update', { newsletterId: nl.id, settings: { ...options.settings, enabled: false } })
    const response = await install.fetch('/n/weekly')
    assert.equal(response.status, 404)
    assert.match(await response.text(), /name="robots" content="noindex, nofollow"/)
    assert.doesNotMatch(await (await install.fetch('/n/weekly/feed.xml')).text(), /<item>/)
    assert.doesNotMatch(await (await install.fetch('/n/weekly/sitemap.xml')).text(), /<url>/)
    assert.match(await (await install.fetch('/n/weekly/robots.txt')).text(), /Disallow:/)
  } finally { install.close() }
})
test('website settings and CNAME target work when APP_URL was learned during setup', async () => {
  const install = await createInstall({ env: { APP_URL: '' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Learned URL' })
    await install.runJobs()
    const settings = await owner.action('website.get', { newsletterId: nl.id })
    assert.equal(settings.host.url, 'http://app.example.com/n/learned-url')
    assert.equal(settings.host.cname.value, 'app.example.com')
    const host = await owner.action('website.setHost', { newsletterId: nl.id, hostname: 'learned.example.com' })
    assert.equal(host.cname.value, 'app.example.com')
    assert.equal((await install.fetch('/n/learned-url')).status, 200)
  } finally { install.close() }
})
test('Cloudflare for SaaS provisioning is idempotent across retries after a successful remote creation', async () => {
  const install = await createInstall({ env: { CF_API_TOKEN: 'test-only-token', CF_ZONE_ID: 'a'.repeat(32), WEBSITE_CNAME_TARGET: 'target.example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Cloudflare hostname' })
    const host = await owner.action('website.setHost', { newsletterId: nl.id, hostname: 'news.example.com' })
    assert.equal(host.cname.value, 'target.example.com')
    install.dns.set(host.cname.name, 'CNAME', [host.cname.value])
    install.dns.set(host.txt.name, 'TXT', [host.txt.value])
    const ctx = install.app.account(owner.accountId!).ctx
    let created = 0
    const remote = new Map<string, string>()
    ctx.platform.fetch = async (input, init) => {
      const url = new URL(String(input))
      assert.equal(url.hostname, 'api.cloudflare.com')
      if (init?.method === 'DELETE') { remote.delete('news.example.com'); return new Response(null, { status: 204 }) }
      if (init?.method === 'POST') {
        created++
        remote.set('news.example.com', 'cf_hostname')
        return Response.json({ success: true, result: { id: 'cf_hostname' } })
      }
      return Response.json({ success: true, result: [...remote].map(([hostname, id]) => ({ hostname, id })) })
    }
    await owner.action('website.checkHost', { newsletterId: nl.id })
    await install.runJobs()
    assert.equal((await owner.action('website.get', { newsletterId: nl.id })).host.cloudflareId, 'cf_hostname')
    assert.equal(created, 1)
    ctx.db.run('UPDATE website_hosts SET cf_id = NULL WHERE newsletter_id = ?', nl.id)
    await owner.action('website.checkHost', { newsletterId: nl.id })
    await install.runJobs()
    assert.equal((await owner.action('website.get', { newsletterId: nl.id })).host.cloudflareId, 'cf_hostname')
    assert.equal(created, 1, 'retry discovers the already-created remote hostname')
    await owner.action('website.setHost', { newsletterId: nl.id, hostname: '' })
    await install.runJobs()
    assert.equal(remote.size, 0, 'removing a hostname cleans up Cloudflare through a durable job')
  } finally { install.close() }
})
test('a verified hostname cannot be claimed by another account', async () => {
  const { install, owner, nl } = await setup()
  try {
    const host = await owner.action('website.setHost', { newsletterId: nl.id, hostname: 'news.example.com' })
    install.dns.set(host.cname.name, 'CNAME', [host.cname.value])
    install.dns.set(host.txt.name, 'TXT', [host.txt.value])
    await owner.action('website.checkHost', { newsletterId: nl.id })
    await install.runJobs()
    const other = await install.signUp({ email: 'other@example.com' })
    const theirs = await other.action('newsletters.create', { name: 'Other' })
    assert.equal((await expectError(() => other.action('website.setHost', { newsletterId: theirs.id, hostname: 'news.example.com' }))).code, 'host_taken')
    assert.equal((await other.action('website.get', { newsletterId: theirs.id })).host.hostname, '')
  } finally { install.close() }
})
test('raw HTML campaigns cannot inject scripts, event handlers, unsafe URLs or extra main headings', async () => {
  const { install, owner, nl } = await setup()
  try {
    const draft = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'HTML <script>bad()</script>', format: 'html', html: '<h1>Body heading</h1><p>Full <strong>content</strong></p><script>alert(1)</script><img src="https://example.com/photo.png" onerror="alert(1)"><a href="javascript:alert(1)">Unsafe link</a>' })
    const ctx = install.app.account(owner.accountId!).ctx
    transitionCampaign(ctx, draft.id, 'scheduled', { scheduledAt: ctx.now() + 1000 })
    transitionCampaign(ctx, draft.id, 'sending')
    transitionCampaign(ctx, draft.id, 'sent')
    await owner.action('website.updateIssue', { campaignId: draft.id, slug: 'html', visible: true })
    const response = await install.fetch('/n/weekly/html')
    assert.equal(response.status, 200)
    const body = await response.text()
    basics(body)
    assert.match(body, /Full <strong>content<\/strong>/)
    assert.match(body, /property="og:image" content="https:\/\/example.com\/photo.png"/)
    assert.doesNotMatch(body, /onerror=|javascript:|<script>alert/)
    assert.match(body, /<h2>Body heading<\/h2>/)
  } finally { install.close() }
})
test('configured signup challenges load asynchronously under the website CSP', async () => {
  const install = await createInstall({ env: { TURNSTILE_SITE_KEY: 'test-site-key', TURNSTILE_SECRET_KEY: 'test-secret-key' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Challenge form' })
    await install.runJobs()
    const response = await install.fetch(`/n/${nl.slug}`)
    const body = await response.text()
    assert.match(body, /<script async defer nonce="([^"]+)" src="https:\/\/challenges.cloudflare.com\/turnstile\/v0\/api.js"/)
    assert.match(body, /class="cf-turnstile" data-sitekey="test-site-key"/)
    const nonce = /<script async defer nonce="([^"]+)"/.exec(body)?.[1]
    assert.ok(response.headers.get('content-security-policy')?.includes(`'nonce-${nonce}'`))
    assert.doesNotMatch(body, /test-secret-key/)
  } finally { install.close() }
})

for (const cloud of [false, true]) test(`website form submits to signup and sends confirmation (${cloud ? 'cloud' : 'self-hosted'})`, async () => {
  const { install, owner } = await setup(cloud)
  try {
    const home = await (await install.fetch('/n/weekly')).text()
    const form = /<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/.exec(home)
    assert.ok(form)
    const fields = new URLSearchParams()
    for (const input of form[2].matchAll(/<input\b[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(input[0])?.[1]
      if (name) fields.set(name, /value="([^"]*)"/.exec(input[0])?.[1] ?? '')
    }
    fields.set('email', 'reader@example.com')
    install.clock.advance(2001)
    const response = await install.fetch(form[1], { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fields })
    assert.equal(response.status, 200, await response.text())
    const mail = install.outbox(owner.accountId!).find((m) => m.to_email === 'reader@example.com')
    assert.ok(mail)
    assert.match(mail.subject, /^Confirm/)
    assert.match(mail.text, /http:\/\/app.example.com\/confirm\//)
  } finally { install.close() }
})

test('welcome and keep campaigns stay out of every public archive surface even when sent and visible', async () => {
  const { install, owner, nl } = await setup()
  try {
    await sent(install, owner, nl.id)
    const ctx = install.app.account(owner.accountId!).ctx
    for (const kind of ['welcome', 'keep']) {
      const campaign = await owner.action('campaigns.create', { newsletterId: nl.id, subject: `Private ${kind} campaign` })
      transitionCampaign(ctx, campaign.id, 'scheduled', { scheduledAt: ctx.now() + 1000 })
      transitionCampaign(ctx, campaign.id, 'sending')
      transitionCampaign(ctx, campaign.id, 'sent')
      ctx.db.run('UPDATE campaigns SET kind = ?, slug = ?, web_visible = 1 WHERE id = ? AND newsletter_id = ?', kind, `private-${kind}`, campaign.id, nl.id)
      for (const slug of [`private-${kind}`, campaign.id]) assert.equal((await install.fetch(`/n/weekly/${slug}`)).status, 404)
      assert.equal((await expectError(() => owner.action('website.updateIssue', { campaignId: campaign.id, slug: `private-${kind}`, visible: true }))).code, 'not_sent')
    }
    for (const path of ['', '/feed.xml', '/sitemap.xml']) {
      const response = await install.fetch(`/n/weekly${path}`)
      assert.equal(response.status, 200)
      const body = await response.text()
      assert.match(body, /sent-issue/)
      assert.doesNotMatch(body, /Private (welcome|keep) campaign|private-(welcome|keep)/)
    }
  } finally { install.close() }
})

test('members draft web-only posts; admins publish and hide them', async () => {
  const { install, owner, nl } = await setup()
  try {
    const ctx = install.app.account(owner.accountId!).ctx
    const member: Actor = { userId: owner.session.user.id, email: owner.email, owner: false, grants: { [nl.id]: 'member' }, access: 'full', via: 'web', installAdmin: false }
    const input = { newsletterId: nl.id, subject: 'Member draft', slug: 'member-draft', source: 'Original', visible: false }
    await runAction(ctx, 'website.publishPost', input, member)
    assert.equal((await install.fetch('/n/weekly/member-draft')).status, 404)
    const draft = ctx.db.get<{ id: string }>('SELECT id FROM website_posts WHERE newsletter_id = ? AND slug = ?', nl.id, input.slug)!
    await runAction(ctx, 'website.publishPost', { ...input, postId: draft.id, source: 'Revised' }, member)
    const denied = (error: unknown) => error instanceof AppError && error.status === 403
    await assert.rejects(() => runAction(ctx, 'website.publishPost', { ...input, postId: draft.id, visible: true }, member), denied)
    const admin: Actor = { ...member, grants: { [nl.id]: 'admin' } }
    await runAction(ctx, 'website.publishPost', { ...input, postId: draft.id, visible: true }, admin)
    assert.equal((await install.fetch('/n/weekly/member-draft')).status, 200)
    for (const visible of [true, false]) await assert.rejects(() => runAction(ctx, 'website.publishPost', { ...input, postId: draft.id, visible }, member), denied)
    await runAction(ctx, 'website.publishPost', { ...input, postId: draft.id, visible: false }, admin)
    assert.equal((await install.fetch('/n/weekly/member-draft')).status, 404)
  } finally { install.close() }
})
