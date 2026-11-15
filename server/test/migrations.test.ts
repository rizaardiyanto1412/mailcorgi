import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, type Install } from './harness.ts'

let install: Install
before(async () => {
  install = await createInstall()
})
after(() => install.close())

const tables = (db: { all<T>(sql: string): T[] }) => db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name)

test('the control store has every table from the contract', () => {
  const names = tables(install.app.control.ctx.db)
  for (const t of ['users', 'sessions', 'login_codes', 'accounts', 'memberships', 'invites', 'sites', 'global_suppressions', 'install_settings', 'billing_events', 'admin_alerts', 'usage_snapshots', 'rate_limits', 'jobs', 'jobs_dead', '_migrations', 'outbox'])
    assert.ok(names.includes(t), `missing control table ${t}`)
})

test('an account store has every table from the contract', async () => {
  const owner = await install.signUp({ email: 'owner@example.com' })
  const names = tables(install.app.account(owner.accountId!).ctx.db)
  for (const t of [
    'account_meta', 'newsletters', 'authors', 'contacts', 'contact_fields', 'tags', 'contact_tags', 'segments', 'suppressions', 'deleted_contacts', 'imports', 'import_chunks',
    'campaigns', 'campaign_sends', 'deliveries', 'provider_events', 'links', 'events', 'daily_stats', 'page_views', 'domains', 'uploads', 'api_keys', 'notifications', 'usage', 'outbox',
    'rate_limits', 'jobs', 'jobs_dead', '_migrations',
  ])
    assert.ok(names.includes(t), `missing account table ${t}`)
  const indexes = install.app.account(owner.accountId!).ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name)
  for (const i of ['contacts_status', 'deliveries_status', 'deliveries_message', 'events_newsletter', 'events_campaign', 'page_views_newsletter']) assert.ok(indexes.includes(i), `missing index ${i}`)
})

test('migrations run once and a restart applies nothing new', async () => {
  const before = install.app.control.ctx.db.all<{ id: number }>('SELECT id FROM _migrations')
  assert.equal(before.length, 1)
  install = await install.restart()
  const after = install.app.control.ctx.db.all<{ id: number }>('SELECT id FROM _migrations')
  assert.deepEqual(after, before)
})

test('bulk inserts stay under the parameter limit', async () => {
  const { insertMany } = await import('../core/db.ts')
  const db = install.app.control.ctx.db
  const rows = Array.from({ length: 250 }, (_, i) => [`k${i}`, i, 1])
  assert.equal(insertMany(db, 'rate_limits', ['key', 'window_start', 'count'], rows), 250)
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'k%'")!.n, 250)
})
