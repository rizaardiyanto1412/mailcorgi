import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, type Install } from './harness.ts'
import { createStore } from '../core/store.ts'
import { createDb, migrate } from '../core/db.ts'
import { buildRegistry, type Module } from '../core/actions.ts'
import { openDriver } from '../platform-node.ts'
import { accountMigrations } from '../account/schema.ts'
import { accountRegistry } from '../account/modules.ts'
import { controlRegistry } from '../control/modules.ts'
import { controlMigrations } from '../control/schema.ts'

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
  for (const i of ['contacts_status', 'contacts_created_page', 'contacts_email_status', 'deliveries_open', 'deliveries_message', 'events_newsletter', 'events_contact_page', 'events_soft_bounces', 'page_views_newsletter']) assert.ok(indexes.includes(i), `missing index ${i}`)
  // Dropped by the index audit (docs/performance.md): each cost a row per insert and served no hot query.
  for (const i of ['contacts_created', 'contacts_name_page', 'contacts_email_page', 'contacts_active', 'events_campaign', 'events_contact', 'deliveries_contact', 'deliveries_contact_campaign', 'deliveries_status', 'jobs_due']) assert.ok(!indexes.includes(i), `index ${i} should be dropped`)
  assert.ok(!install.app.control.ctx.db.get("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'jobs_due'"), 'the control store drops jobs_due too')
})

test('migrations run once and a restart applies nothing new', async () => {
  const before = install.app.control.ctx.db.all<{ id: string }>('SELECT id FROM _migrations')
  assert.equal(before.length, controlMigrations.length + controlRegistry.migrations.length)
  install = await install.restart()
  const after = install.app.control.ctx.db.all<{ id: string }>('SELECT id FROM _migrations')
  assert.deepEqual(after, before)
})

test('bulk inserts stay under the parameter limit', async () => {
  const { insertMany } = await import('../core/db.ts')
  const db = install.app.control.ctx.db
  const rows = Array.from({ length: 250 }, (_, i) => [`k${i}`, i, 1])
  assert.equal(insertMany(db, 'rate_limits', ['key', 'window_start', 'count'], rows), 250)
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'k%'")!.n, 250)
})

for (const [store, base, registry] of [
  ['control', controlMigrations, controlRegistry],
  ['account', accountMigrations, accountRegistry],
] as const) {
  test(`${store}: fresh schema includes every registered migration`, () => {
    const connection = openDriver(':memory:')
    try {
      const db = createDb(connection.driver)
      const migrations = [...base, ...registry.migrations]
      assert.equal(migrate(db, migrations), migrations.length)
      assert.deepEqual(db.all<{ id: string }>('SELECT id FROM _migrations ORDER BY id').map((r) => r.id), migrations.map((m) => m.id).sort())
      assert.equal(migrate(db, migrations), 0)
    } finally { connection.close() }
  })

  for (const count of [1, base.length]) {
    test(`${store}: upgrades ${count} positional migrations without replay or data loss`, () => {
      const connection = openDriver(':memory:')
      try {
        const db = createDb(connection.driver)
        db.exec('CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
        for (let i = 0; i < count; i++) {
          db.exec(base[i].sql)
          db.run('INSERT INTO _migrations VALUES (?, ?)', i + 1, 123)
        }
        const table = store === 'control' ? 'install_settings' : 'account_meta'
        db.run(`INSERT INTO ${table} (key, value) VALUES (?, ?)`, 'upgrade-test', 'preserved')
        assert.equal(migrate(db, base), base.length - count)
        assert.equal(db.get<{ value: string }>(`SELECT value FROM ${table} WHERE key = ?`, 'upgrade-test')?.value, 'preserved')
        assert.equal(db.get<{ applied_at: number }>('SELECT applied_at FROM _migrations WHERE id = ?', base[0].id)?.applied_at, 123)
        assert.equal(migrate(db, base), 0)
      } finally { connection.close() }
    })
  }

  test(`${store}: module order is stable and a later earlier-sorting id applies once`, () => {
    const connection = openDriver(':memory:')
    try {
      const db = createDb(connection.driver)
      const modules = [
        { id: '2026-11-16-imports-second', sql: "INSERT INTO imports_probe VALUES ('second')" },
        { id: '2026-11-16-imports-first', sql: 'CREATE TABLE imports_probe (value TEXT)' },
        { id: '2026-11-16-stats-first', sql: 'CREATE TABLE stats_probe (value TEXT)' },
      ]
      assert.equal(migrate(db, [...modules, ...base]), base.length + 3)
      const later = { id: '2026-11-15-imports-later', sql: "INSERT INTO imports_probe VALUES ('later')" }
      assert.equal(migrate(db, [...base, later, ...modules.reverse()]), 1)
      assert.equal(migrate(db, [...base, ...modules, later]), 0)
      assert.deepEqual(db.all<{ value: string }>('SELECT value FROM imports_probe ORDER BY rowid').map((r) => r.value), ['second', 'later'])
    } finally { connection.close() }
  })

  test(`${store}: duplicate and malformed module ids are rejected at registration`, () => {
    const module = (id: string): Module<typeof store, Record<string, (args: unknown) => Promise<unknown>>> => ({
      name: 'imports',
      register(reg) { reg.migrations([{ id, sql: 'SELECT 1' }]) },
    })
    const id = '2026-11-16-imports-add-foo'
    assert.throws(() => buildRegistry(store, [module(id), module(id)]), /Duplicate migration id/)
    for (const bad of ['0001-base', 'imports-add-foo', '2026-11-16-stats-add-foo', '2026-02-30-imports-add-foo', '2026-13-01-imports-add-foo', '2026-11-16-imports-']) {
      assert.throws(() => buildRegistry(store, [module(bad)]))
    }
  })

  test(`${store}: failed migration rolls back its SQL and remains pending`, () => {
    const connection = openDriver(':memory:')
    try {
      const db = createDb(connection.driver)
      migrate(db, base)
      const id = '2026-11-16-imports-rollback'
      assert.throws(() => migrate(db, [...base, { id, sql: 'CREATE TABLE imports_probe (value TEXT); INSERT INTO missing_table VALUES (1)' }]))
      assert.equal(db.get('SELECT id FROM _migrations WHERE id = ?', id), undefined)
      assert.equal(db.get("SELECT name FROM sqlite_master WHERE name = 'imports_probe'"), undefined)
      assert.equal(migrate(db, [...base, { id, sql: 'CREATE TABLE imports_probe (value TEXT)' }]), 1)
    } finally { connection.close() }
  })
}

for (const scope of ['control', 'account'] as const) {
  test(`${scope}: module registration migrates before HTTP routes run`, async () => {
    const connection = openDriver(':memory:')
    try {
      const registry = buildRegistry(scope, [{
        name: 'probe',
        register(reg) {
          reg.migrations([{ id: '2026-11-16-probe-create', sql: "CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES ('ready')" }])
          reg.routes((app) => app.get('/probe', (c) => c.json(c.get('ctx').db.get('SELECT value FROM probe'))))
        },
      }])
      const ctx = install.app.control.ctx
      const store = createStore(registry, scope === 'control' ? controlMigrations : accountMigrations, {
        ref: scope === 'control' ? { kind: 'control' } : { kind: 'account', accountId: 'migration-probe' },
        db: createDb(connection.driver), platform: ctx.platform, stores: ctx.stores, config: ctx.config, keys: ctx.keys, now: ctx.now,
      })
      const response = await store.fetch(new Request('http://example.com/probe'))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { value: 'ready' })
    } finally { connection.close() }
  })
}
