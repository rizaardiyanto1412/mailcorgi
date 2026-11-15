import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError } from './harness.ts'
import { DnsUnavailableError, resolveDnsOverHttps } from '../core/platform.ts'
import { finish, upload } from './imports-setup.ts'

const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/dns-json' } })) as unknown as typeof fetch

test('the DNS-over-HTTPS resolver treats HTTP errors, network errors and SERVFAIL as failures, not as no records', async () => {
  await assert.rejects(resolveDnsOverHttps(answer({ error: 'busy' }, 503), 'example.com', 'TXT'), DnsUnavailableError)
  await assert.rejects(resolveDnsOverHttps((async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch, 'example.com', 'TXT'), DnsUnavailableError)
  await assert.rejects(resolveDnsOverHttps(answer({ Status: 2 }), 'example.com', 'TXT'), DnsUnavailableError)
  await assert.rejects(resolveDnsOverHttps((async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch, 'example.com', 'TXT'), DnsUnavailableError)
  assert.deepEqual(await resolveDnsOverHttps(answer({ Status: 3 }), 'missing.example.com', 'TXT'), [])
  assert.deepEqual(await resolveDnsOverHttps(answer({ Status: 0, Answer: [{ type: 16, data: '"v=spf1 " "mx ~all"' }, { type: 5, data: 'x.example.com.' }] }), 'example.com', 'TXT'), ['v=spf1 mx ~all'])
})

test('a resolver outage during a website host check answers "try again" and keeps a verified host verified', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly', slug: 'weekly' })
  const info = await owner.action('website.setHost', { newsletterId: nl.id, hostname: 'news.example.com' })
  install.dns.set(info.cname.name, 'CNAME', [info.cname.value])
  install.dns.set(info.txt.name, 'TXT', [info.txt.value])
  const verifiedAt = (await owner.action('website.checkHost', { newsletterId: nl.id })).verifiedAt
  assert.ok(verifiedAt)
  await install.runJobs()
  install.clock.advance(61_000)
  assert.equal((await install.fetch('/api/public/tls-check?domain=news.example.com')).status, 200)

  install.dns.fail(true)
  const error = await expectError(() => owner.action('website.checkHost', { newsletterId: nl.id }))
  assert.equal(error.status, 503)
  assert.equal(error.code, 'dns_unavailable')
  assert.match(error.message, /try again/i)
  await install.runJobs()
  install.clock.advance(61_000)
  assert.equal((await owner.action('website.get', { newsletterId: nl.id })).host.verifiedAt, verifiedAt)
  assert.equal((await install.fetch('/api/public/tls-check?domain=news.example.com')).status, 200)
  assert.equal((await install.fetch('https://news.example.com/')).status, 200)
})

test('a resolver outage during a sending domain check or the daily recheck leaves a verified domain verified', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const domain = await owner.action('domains.add', { name: 'example.com' })
  install.dns.set('example.com', 'TXT', ['v=spf1 mx ~all'])
  install.dns.set('_dmarc.example.com', 'TXT', ['v=DMARC1; p=none'])
  assert.equal((await owner.action('domains.check', { domainId: domain.id })).status, 'verified')

  install.dns.fail(true)
  const error = await expectError(() => owner.action('domains.check', { domainId: domain.id }))
  assert.equal(error.status, 503)
  assert.equal(error.code, 'dns_unavailable')
  for (let day = 0; day < 3; day++) {
    install.clock.advance(86_400_000)
    await install.runJobs()
  }
  assert.equal((await owner.action('domains.list', {}))[0].status, 'verified')
  const ctx = install.app.account(owner.accountId!).ctx
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs_dead')!.n, 0)

  install.dns.fail(false)
  install.dns.set('example.com', 'TXT', [])
  install.clock.advance(86_400_000)
  await install.runJobs()
  assert.equal((await owner.action('domains.list', {}))[0].status, 'failed')
})

test('a resolver outage during an import marks nobody as missing MX and caches nothing; the import finishes once DNS is back', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Imports' })
  install.dns.set('example.com', 'MX', ['mx.example.com'])
  install.dns.set('example.net', 'MX', ['mx.example.net'])
  install.dns.fail(true)
  const id = await upload(owner, nl.id, [{ email: 'a@example.com', status: 'subscribed' }, { email: 'b@example.net', status: 'subscribed' }])
  await install.runJobs()
  const ctx = install.app.account(owner.accountId!).ctx
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM import_dns')!.n, 0)
  assert.equal((await owner.action('imports.get', { newsletterId: nl.id, importId: id })).processedRows, 0)
  install.dns.fail(false)
  const report = await finish(install, owner, nl.id, id)
  assert.equal(report.added, 2)
  assert.deepEqual(report.skipped, {})
})
