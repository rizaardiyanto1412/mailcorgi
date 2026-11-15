/** Unit N: fixes found by the end-to-end pass. Each test failed before its fix. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseConfig } from '../core/config.ts'
import { dnsResolver } from '../core/platform.ts'
import { createInstall, expectError, type Install } from './harness.ts'
import { getPolicy } from '../account/usage/index.ts'
import { sendableInstall, addContacts, issueDoc } from './sending-setup.ts'

const DNS = JSON.stringify({ 'TXT:example.com': ['v=spf1 mx ~all'], 'MX:example.com': ['mx.example.com'] })

test('MC_TEST_DNS is inert without the flag and in production, and answers only when set', async () => {
  assert.equal(parseConfig({}).testDns, null)
  assert.equal(parseConfig({ MC_TEST_DNS: DNS, NODE_ENV: 'production' }).testDns, null)
  assert.deepEqual(parseConfig({ MC_TEST_DNS: DNS }).testDns, { 'TXT:example.com': ['v=spf1 mx ~all'], 'MX:example.com': ['mx.example.com'] })
  assert.throws(() => parseConfig({ MC_TEST_DNS: '{"TXT:x":"nope"}' }), /MC_TEST_DNS/)
  let real = 0
  const resolver = async () => { real++; return ['real'] }
  assert.deepEqual(await dnsResolver(null, resolver)('example.com', 'TXT'), ['real'])
  const canned = dnsResolver(parseConfig({ MC_TEST_DNS: DNS }).testDns, resolver)
  assert.deepEqual(await canned('Example.com.', 'TXT'), ['v=spf1 mx ~all'])
  assert.deepEqual(await canned('other.example.com', 'TXT'), [])
  assert.equal(real, 1, 'the canned resolver never falls through to the network')
})

test('dev outbox endpoints answer 404 without the flag, and only for an install admin with it', async () => {
  const plain = await createInstall({ env: { ALLOWED_EMAILS: 'other@example.com' } })
  try {
    const admin = await plain.signUp({ email: 'admin@example.com' })
    assert.equal((await expectError(() => admin.action('dev.outbox', {}))).status, 404)
    assert.equal((await expectError(() => admin.action('dev.controlOutbox', {}))).status, 404)
  } finally { plain.close() }
  const install = await createInstall({ env: { MC_TEST_DNS: DNS, ALLOWED_EMAILS: 'other@example.com' } })
  try {
    const admin = await install.signUp({ email: 'admin@example.com' })
    const other = await install.signUp({ email: 'other@example.com' })
    await admin.action('install.email.test', { to: 'admin@example.com' })
    const control = await admin.action('dev.controlOutbox', { to: 'admin@example.com' })
    assert.equal(control.emails.at(-1)?.subject, 'MailCorgi test email')
    assert.deepEqual(await admin.action('dev.outbox', {}), { emails: [] })
    assert.equal((await expectError(() => other.action('dev.outbox', {}))).status, 404)
    assert.equal((await expectError(() => other.action('dev.controlOutbox', {}))).status, 403)
  } finally { install.close() }
})

test('saved Cloudflare settings provision a custom hostname; environment values win', async () => {
  const install = await createInstall({ env: { WEBSITE_CNAME_TARGET: 'target.example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    await owner.action('install.settings.set', { values: { cf_api_token: 'saved-token', cf_zone_id: 'b'.repeat(32) } })
    const nl = await owner.action('newsletters.create', { name: 'Hosted' })
    const host = await owner.action('website.setHost', { newsletterId: nl.id, hostname: 'news.example.com' })
    install.dns.set(host.cname.name, 'CNAME', [host.cname.value])
    install.dns.set(host.txt.name, 'TXT', [host.txt.value])
    const ctx = install.app.account(owner.accountId!).ctx
    const calls: { url: string; auth: string | undefined; method: string }[] = []
    ctx.platform.fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(input), auth: headers.get('authorization') ?? undefined, method: init?.method ?? 'GET' })
      if (init?.method === 'POST') return Response.json({ success: true, result: { id: 'cf_saved' } })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({ success: true, result: [] })
    }
    await owner.action('website.checkHost', { newsletterId: nl.id })
    await install.runJobs()
    assert.equal((await owner.action('website.get', { newsletterId: nl.id })).host.cloudflareId, 'cf_saved')
    assert.ok(calls.length >= 2)
    assert.ok(calls.every((c) => c.auth === 'Bearer saved-token' && c.url.includes(`/zones/${'b'.repeat(32)}/`)), JSON.stringify(calls))
    await owner.action('website.setHost', { newsletterId: nl.id, hostname: '' })
    await install.runJobs()
    assert.equal(calls.at(-1)?.method, 'DELETE')
  } finally { install.close() }
  const env = await createInstall({ env: { CF_API_TOKEN: 'env-token', CF_ZONE_ID: 'c'.repeat(32), WEBSITE_CNAME_TARGET: 'target.example.com' } })
  try {
    const owner = await env.signUp({ email: 'owner@example.com' })
    await owner.action('install.settings.set', { values: { cf_api_token: 'saved-token', cf_zone_id: 'b'.repeat(32) } })
    const nl = await owner.action('newsletters.create', { name: 'Hosted' })
    const host = await owner.action('website.setHost', { newsletterId: nl.id, hostname: 'news.example.com' })
    env.dns.set(host.cname.name, 'CNAME', [host.cname.value])
    env.dns.set(host.txt.name, 'TXT', [host.txt.value])
    const ctx = env.app.account(owner.accountId!).ctx
    const auths: (string | null)[] = []
    ctx.platform.fetch = async (input, init) => {
      auths.push(new Headers(init?.headers).get('authorization'))
      assert.ok(String(input).includes(`/zones/${'c'.repeat(32)}/`))
      return init?.method === 'POST' ? Response.json({ success: true, result: { id: 'cf_env' } }) : Response.json({ success: true, result: [] })
    }
    await owner.action('website.checkHost', { newsletterId: nl.id })
    await env.runJobs()
    assert.equal((await owner.action('website.get', { newsletterId: nl.id })).host.cloudflareId, 'cf_env')
    assert.ok(auths.length && auths.every((a) => a === 'Bearer env-token'))
  } finally { env.close() }
})

async function publicSignup(install: Install, key: string, email: string) {
  const config: { formToken: string } = await (await install.fetch(`/api/public/subscribe/${key}`)).json()
  install.clock.advance(2001)
  return install.fetch(`/api/public/subscribe/${key}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '192.0.2.9' }, body: JSON.stringify({ email, formToken: config.formToken }) })
}
const confirmLink = (install: Install, account: string, email: string) => {
  const mail = install.outbox(account).filter((m) => m.to_email === email && m.subject.startsWith('Confirm')).at(-1)
  const match = mail && /http:\/\/app\.example\.com\/confirm\/[^\s<>"\]]+/.exec(mail.text)
  return match ? match[0] : null
}

test('a deleted contact who signs up again with double opt-in and confirms is subscribed again', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const account = owner.accountId!
    const first = await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com' })
    await owner.action('contacts.delete', { newsletterId: nl.id, contactId: first.contact.id })
    assert.equal((await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com' })).outcome, 'suppressed', 'an import or API call never revives a deleted address')
    assert.equal((await publicSignup(install, nl.key, 'reader@example.com')).status, 200)
    const pending = (await owner.action('contacts.list', { newsletterId: nl.id })).contacts
    assert.equal(pending.length, 1)
    assert.equal(pending[0].status, 'unconfirmed')
    const link = confirmLink(install, account, 'reader@example.com')
    assert.ok(link, 'the rejoining reader gets a confirmation email')
    assert.equal((await install.fetch(link)).status, 200)
    const contacts = (await owner.action('contacts.list', { newsletterId: nl.id })).contacts
    assert.equal(contacts.length, 1)
    assert.equal(contacts[0].status, 'subscribed')
    assert.equal(contacts[0].confirmedAt !== null, true)
    assert.equal(install.app.account(account).ctx.db.get('SELECT 1 FROM deleted_contacts WHERE newsletter_id = ?', nl.id), undefined, 'confirming clears the tombstone')
    const again = await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com' })
    assert.equal(again.outcome, 'exists')
  } finally { install.close() }
})

test('account deletion destroys the account store file and survives a retry', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'other@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const other = await install.signUp({ email: 'other@example.com' })
    const accountId = owner.accountId!
    await owner.action('newsletters.create', { name: 'Delete me' })
    const file = path.join(install.dataDir, 'accounts', `${accountId}.db`)
    assert.ok(fs.existsSync(file))
    await owner.action('account.delete', { accountId, confirmation: 'DELETE', currentPassword: 'correct horse battery' })
    await install.runJobs()
    assert.equal(install.app.control.ctx.db.get('SELECT id FROM accounts WHERE id = ?', accountId), undefined)
    assert.equal(fs.existsSync(file), false, 'the database file is deleted')
    assert.equal(fs.existsSync(file + '-wal'), false)
    assert.equal(install.app.accountIds().includes(accountId), false)
    await assert.rejects(async () => install.app.stores.account(accountId).selfWipe({}), /not provisioned/i)
    assert.ok(fs.existsSync(path.join(install.dataDir, 'accounts', `${other.accountId}.db`)))
    assert.equal((await other.action('account.profile', {})).email, 'other@example.com')
    // A second deletion job for the same account (a replayed retry) must not die or touch the other store.
    const control = install.app.control
    control.ctx.db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', 'usr_gone', 'ghost@example.com', 'Ghost', 'x', install.clock.now())
    control.ctx.db.run('INSERT INTO accounts (id, owner_user_id, name, status, policy_version, plan, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)', accountId, 'usr_gone', 'Ghost', 'deleting', 'free', install.clock.now())
    control.ctx.jobs.enqueue('account.delete', { accountId }, { dedupeKey: `account.delete:${accountId}:retry` })
    await install.runJobs()
    assert.equal(control.ctx.db.get('SELECT id FROM accounts WHERE id = ?', accountId), undefined)
    assert.equal(control.ctx.db.get('SELECT id FROM jobs_dead'), undefined)
    const again = await install.restart()
    try {
      assert.equal(again.app.accountIds().includes(accountId), false)
      assert.equal(getPolicy(again.app.account(other.accountId!).ctx).status, 'active')
    } finally { again.close() }
  } finally { install.close() }
})

test('send now works on a clock that moves between reading the time and writing the transition', async () => {
  let at = Date.UTC(2026, 0, 15, 12, 0, 0)
  // Every read of the clock is a millisecond later, as a real clock behaves under load.
  const clock = { now: () => ++at, advance: (ms: number) => void (at += ms), set: (ms: number) => void (at = ms) }
  const { install, owner, nl, ctx } = await sendableInstall({ clock })
  try {
    addContacts(ctx, nl.id, 3)
    const draft = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Now', doc: issueDoc() as never })
    await owner.action('campaigns.update', { campaignId: draft.id, revision: draft.revision, previewText: 'A preview' })
    const sent = await owner.action('campaigns.send', { campaignId: draft.id })
    assert.equal(sent.planned, 3)
    assert.equal(sent.campaign.status, 'sending')
  } finally { install.close() }
})

test('the test billing provider and its webhook exist only in dev mode', async () => {
  const plain = await createInstall({ cloud: true, env: { BILLING_PROVIDER: 'test' } })
  try {
    const owner = await plain.signUp({ email: 'owner@example.com' })
    assert.equal((await expectError(() => owner.action('billing.checkout', { accountId: owner.accountId!, plan: 'starter', interval: 'monthly' }))).code, 'billing_unconfigured')
    assert.equal((await plain.fetch('/hooks/test', { method: 'POST', body: '{}' })).status, 404)
  } finally { plain.close() }
  const install = await createInstall({ cloud: true, env: { BILLING_PROVIDER: 'test', MC_TEST_DNS: DNS } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const checkout = await owner.action('billing.checkout', { accountId: owner.accountId!, plan: 'starter', interval: 'monthly' })
    assert.match(checkout.url, /\/settings\/billing\?test_checkout=starter_monthly$/)
    const hook = await install.fetch('/hooks/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'evt_1', accountId: owner.accountId, status: 'active', plan: 'growth' }) })
    assert.deepEqual(await hook.json(), { received: true, applied: 1 })
    await install.runJobs()
    assert.equal((await owner.action('billing.get', { accountId: owner.accountId! })).plan, 'growth')
    assert.equal(getPolicy(install.app.account(owner.accountId!).ctx).limits.maxNewsletters, 5)
  } finally { install.close() }
})
