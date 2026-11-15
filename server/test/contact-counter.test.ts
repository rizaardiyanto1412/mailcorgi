import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall } from './harness.ts'
import { setContactStatus, subscribe } from '../account/contacts/index.ts'
import { finish, upload } from './imports-setup.ts'

const fullCount = (db: { get<T>(sql: string): T | undefined }) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM contacts WHERE status IN ('subscribed', 'unconfirmed')")!.n
const counter = (db: { get<T>(sql: string): T | undefined }) => Number(db.get<{ value: string }>("SELECT value FROM account_meta WHERE key = 'active_contacts'")?.value)

test('the active contact counter equals a full count after a mixed workload, and reserving reads only the counter', async (t) => {
  const install = await createInstall({ cloud: true })
  t.after(() => install.close())
  install.dns.set('example.com', 'MX', ['mx.example.com'])
  const owner = await install.signUp({ email: 'owner@example.com' })
  await install.app.stores.account(owner.accountId!).applyPolicy({ version: 100, status: 'active', plan: 'test', limits: { maxContacts: 1000, maxEmailsPerMonth: 1000, maxNewsletters: 5, maxTeamPerNewsletter: 2 } })
  const a = await owner.action('newsletters.create', { name: 'First' })
  const b = await owner.action('newsletters.create', { name: 'Second' })
  const ctx = install.app.account(owner.accountId!).ctx
  assert.equal(counter(ctx.db), 0)

  const ids: string[] = []
  for (let i = 0; i < 12; i++) ids.push((await owner.action('contacts.create', { newsletterId: i % 2 ? a.id : b.id, email: `reader${i}@example.com` })).contact.id)
  subscribe(ctx, { newsletterId: a.id, email: 'pending@example.com', source: 'signup', consent: 'pending' })
  await owner.action('contacts.unsubscribe', { newsletterId: b.id, contactId: ids[0] })
  await owner.action('contacts.delete', { newsletterId: a.id, contactId: ids[1] })
  await owner.action('contacts.bulk', { newsletterId: a.id, contactIds: [ids[3], ids[5]], operation: 'unsubscribe', tagIds: [] })
  await owner.action('contacts.bulk', { newsletterId: a.id, contactIds: [ids[7], ids[9], ids[3]], operation: 'delete', tagIds: [] })
  ctx.db.tx(() => setContactStatus(ctx, ids[2], 'bounced'))
  // A reader who unsubscribed and opts in again takes a slot back.
  subscribe(ctx, { newsletterId: b.id, email: 'reader0@example.com', source: 'signup', consent: 'confirmed' })
  const imported = await upload(owner, a.id, [
    { email: 'new1@example.com', status: 'subscribed' },
    { email: 'new2@example.com', status: 'subscribed' },
    { email: 'gone@example.com', status: 'unsubscribed' },
    { email: 'reader11@example.com', status: 'unsubscribed' },
  ], { options: { consent: true, statuses: 'preserve' } })
  await finish(install, owner, a.id, imported)
  await owner.action('newsletters.archive', { newsletterId: b.id })
  assert.ok(fullCount(ctx.db) > 0)
  assert.equal(counter(ctx.db), fullCount(ctx.db))

  const get = ctx.db.get.bind(ctx.db)
  const counted: string[] = []
  ctx.db.get = ((sql: string, ...params: never[]) => {
    if (/COUNT\(\*\)[\s\S]*FROM contacts/i.test(sql)) counted.push(sql)
    return get(sql, ...params)
  }) as typeof ctx.db.get
  try {
    await owner.action('contacts.create', { newsletterId: a.id, email: 'one-more@example.com' })
  } finally {
    ctx.db.get = get
  }
  assert.deepEqual(counted, [])
  assert.equal(counter(ctx.db), fullCount(ctx.db))
})

test('the hourly usage job repairs a drifted counter', async (t) => {
  const install = await createInstall({ cloud: true })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'First' })
  for (let i = 0; i < 3; i++) await owner.action('contacts.create', { newsletterId: nl.id, email: `reader${i}@example.com` })
  const ctx = install.app.account(owner.accountId!).ctx
  ctx.db.run("UPDATE account_meta SET value = '999' WHERE key = 'active_contacts'")
  install.clock.advance(61 * 60_000)
  await install.runJobs()
  assert.equal(counter(ctx.db), 3)
})
