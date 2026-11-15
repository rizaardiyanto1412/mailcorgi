import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall } from './harness.ts'
import { finish, upload } from './imports-setup.ts'

test('100,000 rows import on Node with bounded SQL parameters', { timeout: 1_800_000 }, async () => {
  const install = await createInstall()
  try {
    install.dns.set('example.com', 'MX', ['mx.example.com'])
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Large import' })
    const id = await upload(owner, nl.id, Array.from({ length: 100_000 }, (_, i) => ({ email: `bulk${i}@example.com`, status: 'subscribed' })))
    const report = await finish(install, owner, nl.id, id)
    assert.equal(report.added, 100_000)
    assert.equal(report.processedRows, 100_000)
    assert.deepEqual(report.skipped, {})
    const ctx = install.app.account(owner.accountId!).ctx
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE newsletter_id = ?', nl.id)!.n, 100_000)
  } finally { install.close() }
})
