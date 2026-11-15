/** Row-write budget: reads write nothing, and a refused write (Cloudflare's daily quota) degrades, never breaks reads. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addContacts, createIssue, drive, issueDoc, LINK_A, sendableInstall, tokensIn } from './sending-setup.ts'
import { expectError } from './harness.ts'
import { STORAGE_WRITE_LIMIT_MESSAGE } from '../core/http.ts'

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'

async function sentIssue() {
  const setup = await sendableInstall()
  const { install, owner, nl, ctx, accountId } = setup
  addContacts(ctx, nl.id, 2)
  const website = await owner.action('website.get', { newsletterId: nl.id })
  await owner.action('website.update', { newsletterId: nl.id, settings: { ...website.settings, enabled: true } })
  const issue = await createIssue(owner, nl.id, { doc: issueDoc([LINK_A]) })
  await owner.action('campaigns.send', { campaignId: issue.id })
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  await install.runJobs()
  const html = install.outbox(accountId).find((r) => r.kind === 'campaign' && r.to_email === 'reader0@example.com')!.html
  install.clock.advance(5000)
  return { ...setup, issue, open: tokensIn(html, '/t/o/')[0], click: tokensIn(html, '/t/c/')[0] }
}

/** Rows written by `fn`, alarms included, across every store. */
async function writesOf(install: Awaited<ReturnType<typeof sendableInstall>>['install'], fn: () => Promise<unknown>) {
  const before = install.writes()
  await fn()
  return install.writes() - before
}

test('read-only requests write no row: SPA shell, bootstrap, contacts, overview, a website page and a repeat open', async (t) => {
  const { install, owner, nl, open } = await sentIssue()
  t.after(() => install.close())
  const reader = { headers: { 'user-agent': UA } }
  assert.equal((await install.fetch(`/t/o/${open}`, reader)).status, 200, 'first open')
  install.clock.advance(301_000)
  await install.runJobs()
  const cases: [string, () => Promise<unknown>][] = [
    ['SPA shell', () => install.fetch('/')],
    ['healthz', () => install.fetch('/healthz')],
    ['bootstrap, signed out', () => install.fetch('/api/auth/bootstrap')],
    ['bootstrap, signed in', () => owner.get('/api/auth/bootstrap')],
    ['contacts.list', () => owner.action('contacts.list', { newsletterId: nl.id, limit: 50 })],
    ['stats.overview', () => owner.action('stats.overview', { newsletterId: nl.id, range: '30' })],
    ['website page', async () => assert.equal((await install.fetch(`/n/${nl.slug}/`, reader)).status, 200)],
    ['repeat open', async () => assert.equal((await install.fetch(`/t/o/${open}`, reader)).status, 200)],
    ['a second website page view', async () => assert.equal((await install.fetch(`/n/${nl.slug}/`, { headers: { 'user-agent': UA, referer: 'https://example.org/' } })).status, 200)],
  ]
  for (const [label, fn] of cases) assert.equal(await writesOf(install, fn), 0, `${label} wrote rows`)
  // The deferred views and the repeat open land in one batch when the next alarm fires.
  const store = install.app.account(owner.accountId!)
  assert.equal(store.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM page_views WHERE newsletter_id = ?', nl.id)!.n, 0, 'views wait in memory')
  install.clock.advance(301_000)
  await install.runJobs()
  assert.equal(store.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM page_views WHERE newsletter_id = ?', nl.id)!.n, 2)
  assert.equal(await writesOf(install, () => install.runJobs()), 0, 'an idle store writes nothing')
  assert.equal(await writesOf(install, () => install.tick()), 0, 'a scheduler tick with nothing due writes nothing')
})

test('a scheduled campaign keeps the store idle until its time', async (t) => {
  const { install, owner, nl } = await sendableInstall()
  t.after(() => install.close())
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.schedule', { campaignId: issue.id, scheduledAt: install.clock.now() + 86_400_000 })
  await install.runJobs()
  const idle = await writesOf(install, async () => {
    for (let i = 0; i < 60; i++) {
      install.clock.advance(1000)
      await install.tick()
    }
  })
  assert.equal(idle, 0)
})

test('opening a store again needs no write, and a refused write leaves every read working', async (t) => {
  const first = await sentIssue()
  const { owner, nl, open, click, accountId } = first
  const install = await first.install.restart()
  t.after(() => install.close())
  install.refuseWrites(true)
  assert.equal(await writesOf(install, () => install.fetch('/api/auth/bootstrap')), 0)
  const session = await install.clientFromCookie(owner.cookie)
  assert.equal(session.accountId, accountId)
  assert.equal((await session.action('contacts.list', { newsletterId: nl.id, limit: 10 })).contacts.length, 2)
  assert.ok((await session.action('stats.overview', { newsletterId: nl.id, range: '30' })).growth.length > 0)
  const reader = { headers: { 'user-agent': UA }, redirect: 'manual' as const }
  assert.equal((await install.fetch(`/n/${nl.slug}/`, reader)).status, 200, 'the public website still answers')
  assert.equal((await install.fetch(`/n/${nl.slug}/feed.xml`, reader)).status, 200, 'the feed still answers')
  const redirect = await install.fetch(`/t/c/${click}`, reader)
  assert.equal(redirect.status, 302, 'a click still redirects')
  assert.equal(redirect.headers.get('location'), LINK_A)
  assert.equal((await install.fetch(`/t/o/${open}`, reader)).status, 200, 'the pixel still answers')
  assert.equal((await install.fetch('/')).status, 404, 'the shell path never reaches a store')

  const err = await expectError(() => session.action('contacts.create', { newsletterId: nl.id, email: 'new@example.com', consent: true } as never))
  assert.equal(err.status, 503)
  assert.equal(err.code, 'storage_write_limit')
  assert.equal(err.message, STORAGE_WRITE_LIMIT_MESSAGE)
  const signIn = await install.fetch('/api/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' }) })
  assert.equal(signIn.status, 503)
  assert.equal((await signIn.json()).code, 'storage_write_limit')

  install.refuseWrites(false)
  const created = await session.action('contacts.create', { newsletterId: nl.id, email: 'new@example.com', consent: true } as never)
  assert.ok(created)
})

test('an unsubscribe that cannot be stored is parked in the blob store and answered as landed', async (t) => {
  const { install, nl, accountId, issue, click } = await sentIssue()
  t.after(() => install.close())
  const ctx = install.app.account(accountId).ctx
  const contactId = ctx.db.get<{ contact_id: string }>('SELECT contact_id FROM deliveries WHERE campaign_id = ? ORDER BY id', issue.id)!.contact_id
  const { signToken } = await import('../account/tracking/index.ts')
  const token = await signToken(ctx, 'u', [contactId, issue.id])
  install.refuseWrites(true)
  const page = await install.fetch(`/u/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
  assert.equal(page.status, 200, 'the disk blob store takes the parked unsubscribe')
  assert.equal(await page.text(), 'Unsubscribed.')
  assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM contacts WHERE id = ?', contactId)!.status, 'subscribed', 'no row could be written yet')
  void click
  void nl
  install.refuseWrites(false)
  const ok = await install.fetch(`/u/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
  assert.equal(ok.status, 200)
  assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM contacts WHERE id = ?', contactId)!.status, 'unsubscribed')
})

test('a send that meets a refused write spends no attempt and resumes once writes are allowed', async (t) => {
  const { install, owner, nl, ctx } = await sendableInstall()
  t.after(() => install.close())
  addContacts(ctx, nl.id, 3)
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: issue.id })
  install.refuseWrites(true)
  for (let i = 0; i < 5; i++) {
    install.clock.advance(1000)
    await install.runJobs()
  }
  const job = ctx.db.get<{ attempts: number; last_error: string | null }>("SELECT attempts, last_error FROM jobs WHERE kind = 'send.batch'")
  assert.ok(job, 'the send job is still queued')
  assert.equal(job.attempts, 0)
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent'")!.n, 0)
  assert.ok(install.app.account(owner.accountId!).writesRefusedAt(), 'the store remembers the refusal')
  install.refuseWrites(false)
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent'")!.n, 3)
})
