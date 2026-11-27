import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Client } from './harness.ts'
import type { StoreCtx } from '../core/store.ts'
import { setContactStatus, subscribe, suppress } from '../account/contacts/index.ts'
import { finish, upload } from './imports-setup.ts'

const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello {{first_name|friend}}, welcome aboard.' }] }] } as const
const headers = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' })

async function setup(t: { after: (fn: () => unknown) => void }, opts: { doubleOptIn?: boolean; welcome?: boolean; transactional?: boolean; sendFormat?: 'html' | 'plain' } = {}) {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const account = owner.accountId!
  const ctx = install.app.account(account).ctx
  await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: opts.welcome ?? true, subject: 'Welcome reader', doc: JSON.parse(JSON.stringify(doc)), revision: null, transactional: opts.transactional ?? false, sendFormat: opts.sendFormat ?? 'html' })
  if (opts.doubleOptIn) await owner.action('signup.update', { newsletterId: nl.id, settings: {}, doubleOptIn: true })
  const key = await owner.action('apikeys.create', { name: 'App', access: 'full' })
  const welcomes = (to?: string) => install.outbox(account).filter((m) => m.kind === 'system' && m.subject === 'Welcome reader' && (!to || m.to_email === to))
  const mailRows = (contactId?: string) => ctx.db.all<{ id: string; state: string; contact_id: string }>("SELECT id, state, contact_id FROM signup_mail WHERE kind = 'welcome'" + (contactId ? ' AND contact_id = ?' : ''), ...(contactId ? [contactId] : [])).map((r) => ({ ...r }))
  const create = (email: string, extra: Record<string, unknown> = {}, client: Client = owner) => client.action('contacts.create', { newsletterId: nl.id, email, ...extra } as never)
  return { install, owner, nl, ctx, account, key, welcomes, mailRows, create }
}
const deliveriesOf = (ctx: StoreCtx) => ctx.db.all<{ campaign_id: string; email: string; status: string; sent_at: number | null }>('SELECT campaign_id, email, status, sent_at FROM deliveries').map((r) => ({ ...r }))

test('contacts.create sends one welcome through signup_mail, and a repeat upsert sends nothing more', async (t) => {
  const { install, nl, ctx, welcomes, mailRows, create } = await setup(t)
  const first = await create('new@example.com', { name: 'Nina' })
  assert.equal(first.outcome, 'subscribed')
  assert.equal(welcomes('new@example.com').length, 1)
  assert.match(welcomes('new@example.com')[0].text, /Hello Nina/)
  assert.deepEqual(mailRows(first.contact.id).map((r) => [r.id, r.state]), [[`welcome:${first.contact.id}:${first.contact.subscribedAt}`, 'sent']])
  // Tag and plan syncs call create again on the same email.
  assert.equal((await create('new@example.com', { name: 'Nina B', sendWelcome: true })).outcome, 'exists')
  await install.runJobs()
  assert.equal(welcomes().length, 1)
  assert.equal(mailRows().length, 1)
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM campaigns WHERE newsletter_id = ? AND kind = 'welcome'", nl.id)!.n, 1)
})

test('sendWelcome false queues nothing; the default and true both send', async (t) => {
  const { welcomes, mailRows, create } = await setup(t)
  assert.equal((await create('quiet@example.com', { sendWelcome: false })).outcome, 'subscribed')
  assert.equal(mailRows().length, 0)
  assert.equal(welcomes().length, 0)
  await create('default@example.com')
  await create('explicit@example.com', { sendWelcome: true })
  assert.deepEqual(welcomes().map((m) => m.to_email).sort(), ['default@example.com', 'explicit@example.com'])
})

test('REST and MCP contacts_create both send the welcome, and a repeat does not', async (t) => {
  const { install, nl, key, welcomes } = await setup(t)
  const rest = await install.fetch(`/api/v1/newsletters/${nl.id}/contacts`, { method: 'POST', headers: headers(key.secret), body: JSON.stringify({ email: 'rest@example.com' }) })
  assert.equal(rest.status, 200)
  const call = (args: object) => install.fetch('/mcp', { method: 'POST', headers: headers(key.secret), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'contacts_create', arguments: { newsletterId: nl.id, ...args } } }) }).then((r) => r.json())
  const mcp = await call({ email: 'mcp@example.com' })
  assert.notEqual(mcp.result.isError, true)
  assert.equal(mcp.result.structuredContent.outcome, 'subscribed')
  await call({ email: 'mcp@example.com' })
  assert.deepEqual(welcomes().map((m) => m.to_email).sort(), ['mcp@example.com', 'rest@example.com'])
  const silent = await call({ email: 'silent@example.com', sendWelcome: false })
  assert.notEqual(silent.result.isError, true)
  assert.equal(welcomes().length, 2)
})

test('no welcome while the welcome email is off', async (t) => {
  const { welcomes, mailRows, create } = await setup(t, { welcome: false })
  assert.equal((await create('off@example.com')).outcome, 'subscribed')
  assert.equal(welcomes().length, 0)
  assert.equal(mailRows().length, 0)
})

test('unsubscribed, bounced, cleaned and suppressed contacts get nothing, and neither do pending ones', async (t) => {
  const { owner, nl, ctx, welcomes, mailRows, create } = await setup(t)
  const unsub = (await create('unsub@example.com', { sendWelcome: false })).contact
  const bounced = (await create('bounced@example.com', { sendWelcome: false })).contact
  const cleaned = (await create('cleaned@example.com', { sendWelcome: false })).contact
  await owner.action('contacts.unsubscribe', { newsletterId: nl.id, contactId: unsub.id })
  setContactStatus(ctx, bounced.id, 'bounced', {})
  setContactStatus(ctx, cleaned.id, 'cleaned', {})
  suppress(ctx, { email: 'blocked@example.com', newsletterId: nl.id, reason: 'manual' })
  const pending = subscribe(ctx, { newsletterId: nl.id, email: 'pending@example.com', source: 'test', consent: 'pending' })
  assert.equal(pending.outcome, 'pending')
  for (const email of ['unsub@example.com', 'bounced@example.com', 'cleaned@example.com', 'blocked@example.com']) assert.equal((await create(email)).outcome, 'suppressed', email)
  assert.equal(welcomes().length, 0)
  assert.equal(mailRows().length, 0)
  for (const id of [unsub.id, bounced.id, cleaned.id, pending.contact.id]) await expectError(() => owner.action('signup.sendWelcome', { newsletterId: nl.id, contactId: id }))
  assert.equal(welcomes().length, 0)
})

test('an API call that asserts consent for a pending contact subscribes them and sends the welcome once', async (t) => {
  const { nl, ctx, welcomes, create } = await setup(t)
  const pending = subscribe(ctx, { newsletterId: nl.id, email: 'wait@example.com', source: 'test', consent: 'pending' })
  assert.equal(welcomes().length, 0)
  const result = await create('wait@example.com')
  assert.equal(result.outcome, 'subscribed')
  assert.equal(result.contact.id, pending.contact.id)
  assert.equal(welcomes().length, 1)
  await create('wait@example.com')
  assert.equal(welcomes().length, 1)
})

test('double opt-in and a transactional plain welcome do not hold back an API-created contact', async (t) => {
  const { owner, nl, ctx, welcomes, create } = await setup(t, { doubleOptIn: true, transactional: true, sendFormat: 'plain' })
  const result = await create('doi@example.com', { source: 'app' })
  assert.equal(result.outcome, 'subscribed')
  assert.equal(result.contact.confirmedAt, null)
  assert.equal(result.contact.status, 'subscribed')
  assert.equal(welcomes('doi@example.com').length, 1)
  assert.doesNotMatch(welcomes('doi@example.com')[0].text, /unsubscribe/i, 'transactional: no unsubscribe lines')
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM contacts WHERE newsletter_id = ? AND confirmed_at IS NULL', nl.id)!.n, 1)
  assert.equal((await owner.action('signup.get', { newsletterId: nl.id })).doubleOptIn, true)
})

test('the public form with double opt-in still waits for the confirmation click', async (t) => {
  const { install, nl, account, welcomes } = await setup(t, { doubleOptIn: true })
  const config: { formToken: string } = await (await install.fetch(`/api/public/subscribe/${nl.key}`)).json()
  install.clock.advance(2001)
  const response = await install.fetch(`/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'form@example.com', formToken: config.formToken }) })
  assert.equal(response.status, 200)
  assert.equal(welcomes().length, 0)
  const confirm = install.outbox(account).find((m) => m.to_email === 'form@example.com' && m.subject.startsWith('Confirm'))!
  const link = /http:\/\/app\.example\.com\/confirm\/[^\s<>"\]]+/.exec(confirm.text)![0]
  assert.equal((await install.fetch(link)).status, 200)
  assert.equal(welcomes('form@example.com').length, 1)
})

test('a CSV import of subscribed contacts sends no welcome', async (t) => {
  const { install, owner, nl, welcomes, mailRows } = await setup(t)
  install.dns.set('example.com', 'MX', ['10 mx.example.com'])
  const id = await upload(owner, nl.id, [{ email: 'csv-one@example.com', status: 'subscribed' }, { email: 'csv-two@example.com', status: 'subscribed' }], { options: { consent: true, defaultStatus: 'subscribed' } })
  await finish(install, owner, nl.id, id)
  assert.equal((await owner.action('contacts.list', { newsletterId: nl.id })).contacts.filter((c) => c.status === 'subscribed' && c.email.startsWith('csv-')).length, 2)
  await install.runJobs()
  assert.equal(welcomes().length, 0)
  assert.equal(mailRows().length, 0)
})

test('signup.sendWelcome sends once to a subscribed contact who missed it, then is a no-op', async (t) => {
  const { install, owner, nl, welcomes, mailRows, create } = await setup(t)
  const contact = (await create('missed@example.com', { sendWelcome: false })).contact
  const other = (await create('other@example.com', { sendWelcome: false })).contact
  const first = await owner.action('signup.sendWelcome', { newsletterId: nl.id, contactId: contact.id })
  assert.deepEqual(first, { sent: true, alreadyQueued: false, mailId: `welcome:${contact.id}:${contact.subscribedAt}`, state: 'sent' })
  const second = await owner.action('signup.sendWelcome', { newsletterId: nl.id, contactId: contact.id })
  assert.deepEqual([second.sent, second.alreadyQueued, second.mailId], [false, true, first.mailId])
  await install.runJobs()
  assert.deepEqual(welcomes().map((m) => m.to_email), ['missed@example.com'])
  assert.deepEqual(mailRows(other.id), [], 'only the named contact is touched')
  // A later contacts.create on the same contact is an exists and does not repeat it.
  await create('missed@example.com')
  assert.equal(welcomes().length, 1)
})

test('signup.sendWelcome refuses missing contacts, a disabled welcome and other newsletters', async (t) => {
  const { install, owner, nl, welcomes, create } = await setup(t)
  const contact = (await create('x@example.com', { sendWelcome: false })).contact
  assert.equal((await expectError(() => owner.action('signup.sendWelcome', { newsletterId: nl.id, contactId: 'ct_missing' }))).status, 404)
  const elsewhere = await owner.action('newsletters.create', { name: 'Elsewhere' }).catch(() => null)
  if (elsewhere) assert.equal((await expectError(() => owner.action('signup.sendWelcome', { newsletterId: elsewhere.id, contactId: contact.id }))).status, 404)
  await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: false, revision: (await owner.action('signup.get', { newsletterId: nl.id })).welcome!.revision })
  const off = await expectError(() => owner.action('signup.sendWelcome', { newsletterId: nl.id, contactId: contact.id }))
  assert.deepEqual([off.status, off.code], [409, 'welcome_disabled'])
  await install.runJobs()
  assert.equal(welcomes().length, 0)
})

test('a sent welcome shows in sends.list as a welcome row for that address, over REST and MCP, without becoming an issue or touching counters', async (t) => {
  const { install, owner, nl, ctx, key, create } = await setup(t)
  const welcomeId = (await owner.action('signup.get', { newsletterId: nl.id })).welcome!.id
  const contact = (await create('seen@example.com')).contact
  const list = await owner.action('sends.list', { newsletterId: nl.id, email: 'seen@example.com' })
  assert.equal(list.items.length, 1)
  assert.deepEqual([list.items[0].source.type, list.items[0].source.campaignId, list.items[0].status, list.items[0].contactId, list.items[0].subject], ['welcome', welcomeId, 'sent', contact.id, 'Welcome reader'])
  assert.equal(list.items[0].sentAt, install.clock.now())
  const rest = await (await install.fetch(`/api/v1/newsletters/${nl.id}/sends?email=seen@example.com`, { headers: headers(key.secret) })).json()
  assert.equal(rest.items[0].source.type, 'welcome')
  const mcp = await (await install.fetch('/mcp', { method: 'POST', headers: headers(key.secret), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sends_list', arguments: { newsletterId: nl.id, email: 'seen@example.com' } } }) })).json()
  assert.equal(mcp.result.structuredContent.items[0].source.campaignId, welcomeId)
  // Not an issue, not a usage send, no counters or streaks, no hygiene sample.
  const row = ctx.db.get<{ sent_count: number; ignored_streak: number; last_sent_at: number | null }>('SELECT sent_count, ignored_streak, last_sent_at FROM contacts WHERE id = ?', contact.id)!
  assert.deepEqual({ ...row }, { sent_count: 0, ignored_streak: 0, last_sent_at: null })
  assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM campaigns WHERE id = ?', welcomeId)!.status, 'draft')
  const day = ctx.db.get<{ n: number | null }>('SELECT SUM(sent) n FROM daily_stats WHERE newsletter_id = ?', nl.id)!.n
  assert.ok(!day)
  // A repeat call and a manual send for the same contact keep exactly one delivery row.
  await create('seen@example.com')
  await owner.action('signup.sendWelcome', { newsletterId: nl.id, contactId: contact.id })
  assert.equal(deliveriesOf(ctx).length, 1)
})

test('the public form welcome also appears in sends.list, and a resubscription welcome does not break on the unique row', async (t) => {
  const { install, owner, nl, ctx, welcomes } = await setup(t)
  await owner.action('signup.update', { newsletterId: nl.id, settings: {}, doubleOptIn: false })
  const config: { formToken: string } = await (await install.fetch(`/api/public/subscribe/${nl.key}`)).json()
  install.clock.advance(2001)
  await install.fetch(`/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'form@example.com', formToken: config.formToken }) })
  assert.equal(welcomes().length, 1)
  assert.equal((await owner.action('sends.list', { newsletterId: nl.id, email: 'form@example.com' })).items[0].source.type, 'welcome')
  // A second subscription of the same contact has a new key and sends again; the log keeps its one row.
  const contactId = ctx.db.get<{ id: string }>("SELECT id FROM contacts WHERE email = 'form@example.com'")!.id
  install.clock.advance(1000)
  ctx.db.run("UPDATE contacts SET subscribed_at = ? WHERE id = ?", install.clock.now(), contactId)
  assert.equal((await owner.action('signup.sendWelcome', { newsletterId: nl.id, contactId })).sent, true)
  assert.equal(welcomes().length, 2)
  assert.equal(deliveriesOf(ctx).length, 1)
})
