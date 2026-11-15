import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createInstall, expectError } from './harness.ts'
import { suppressionHash } from '../control/suppression/index.ts'
import { getPolicy } from '../account/usage/index.ts'

const password = 'correct horse battery'
test('admin permissions, account search, usage, alerts, settings and dead job recovery', async (t) => {
  const install = await createInstall({ cloud: true, env: { ADMIN_EMAILS: 'admin@example.com' } })
  t.after(() => install.close())
  const admin = await install.signUp({ email: 'admin@example.com' })
  const member = await install.signUp({ email: 'member@example.com' })
  const accountId = member.accountId!
  for (const [name, input] of [
    ['admin.accounts', {}], ['admin.alerts', {}], ['admin.deadJobs', {}], ['admin.settings', {}], ['admin.suppressions', {}], ['admin.setSetting', { key: 'signup_mode', value: 'closed' }], ['admin.deleteAccount', { accountId, confirmation: 'DELETE' }],
  ] as const) assert.equal((await member.actionRaw(name, input)).status, 403)
  await install.app.stores.control.pushUsage({ accountId, period: '2026-01', contacts: 23, emailsSent: 42 })
  await install.app.stores.control.pushUsage({ accountId, period: '2026-01', contacts: 22, emailsSent: 40 })
  const rows = await admin.action('admin.accounts', { search: 'member@example.com' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.contacts, 22)
  assert.equal(rows[0]?.emails_sent, 42)
  await install.app.stores.control.raiseAlert({ kind: 'test', accountId, title: 'Needs attention' })
  const alerts = await admin.action('admin.alerts', {})
  assert.equal(alerts[0]?.title, 'Needs attention')
  await admin.action('admin.resolveAlert', { alertId: alerts[0]!.id })
  assert.equal((await admin.action('admin.alerts', {})).length, 0)
  assert.equal((await admin.action('admin.alerts', { resolved: true })).length, 1)
  await admin.action('admin.setSetting', { key: 'stripe_secret_key', value: 'test-only-encrypted-key' })
  const settings = await admin.action('admin.settings', {})
  assert.equal(settings.secretsSet.stripe_secret_key, true)
  assert.ok(!JSON.stringify(settings).includes('test-only-encrypted-key'))
  const stored = install.app.control.ctx.db.get<{ value: string }>('SELECT value FROM install_settings WHERE key = ?', 'stripe_secret_key')?.value
  assert.ok(stored?.startsWith('v1:'))
  await admin.action('admin.setSetting', { key: 'signup_mode', value: 'closed' })
  assert.equal((await install.fetch('/api/auth/bootstrap').then((r) => r.json())).signupOpen, false)
  assert.equal((await install.fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'closed@example.com', name: 'Closed', password }) })).status, 403)
  const invalid = await admin.actionRaw('admin.setSetting', { key: 'polar_products', value: '{broken' })
  assert.equal(invalid.status, 400)
  for (const id of [null, accountId]) {
    const db = id ? install.app.account(id).ctx.db : install.app.control.ctx.db
    db.run('INSERT INTO jobs_dead (id, kind, payload, attempts, last_error, created_at, died_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'job_test', 'policy.push', '{}', 8, 'Synthetic failure', install.clock.now(), install.clock.now())
    assert.equal((await admin.action('admin.deadJobs', { accountId: id })).length, 1)
    await admin.action('admin.deadJobs', { accountId: id, operation: 'retry', jobId: 'job_test' })
    assert.equal((await admin.action('admin.deadJobs', { accountId: id })).length, 0)
    assert.equal(db.get<{ attempts: number }>('SELECT attempts FROM jobs WHERE id = ?', 'job_test')?.attempts, 0)
    db.run('DELETE FROM jobs WHERE id = ?', 'job_test')
    db.run('INSERT INTO jobs_dead (id, kind, payload, attempts, last_error, created_at, died_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'job_discard', 'test', '{}', 8, 'Synthetic failure', install.clock.now(), install.clock.now())
    await admin.action('admin.deadJobs', { accountId: id, operation: 'discard', jobId: 'job_discard' })
    assert.equal((await admin.action('admin.deadJobs', { accountId: id })).length, 0)
  }
})

test('global suppression hashes, batch lookup and 180-day expiry', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const admin = await install.signUp({ email: 'admin@example.com' })
  const hashes = await Promise.all(Array.from({ length: 110 }, (_, n) => suppressionHash(install.app.control.ctx, `mailbox${n}@example.com`)))
  for (const emailHash of hashes) await install.app.stores.control.reportSuppression({ emailHash, reason: 'hard_bounce', nonexistent: true })
  const permanent = await suppressionHash(install.app.control.ctx, 'trap@example.com')
  await install.app.stores.control.reportSuppression({ emailHash: permanent, reason: 'spam_trap' })
  assert.equal((await install.app.stores.control.checkSuppressed({ emailHashes: hashes })).suppressed.length, 110)
  const lookup = await admin.action('admin.suppressions', { email: 'mailbox0@example.com' })
  assert.equal(lookup[0]?.email_hash, hashes[0])
  assert.equal(lookup[0]?.until, install.clock.now() + 180 * 86_400_000)
  install.clock.advance(180 * 86_400_000)
  assert.equal((await install.app.stores.control.checkSuppressed({ emailHashes: [...hashes, permanent] })).suppressed.length, 1)
})

test('profile, password and session revocation take effect on the next request', async (t) => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'other@example.com' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const other = await install.signUp({ email: 'other@example.com' })
  const second = await install.signIn(owner.email, password)
  await owner.action('account.updateProfile', { name: 'Updated name' })
  assert.equal((await second.action('account.profile', {})).name, 'Updated name')
  const secondSession = (await second.action('account.sessions', {}))[0]!
  assert.ok(secondSession)
  await other.action('account.revokeSession', { sessionId: secondSession.id })
  assert.equal((await owner.action('account.sessions', {})).length, 2)
  await owner.action('account.revokeSession', { sessionId: secondSession.id })
  assert.equal((await install.app.stores.control.resolveSession({ sessionId: secondSession.id })), null)
  const active = await install.signIn(owner.email, password)
  assert.equal((await expectError(() => active.action('account.changePassword', { currentPassword: 'wrong password', newPassword: 'replacement password' }))).code, 'bad_password')
  await active.action('account.changePassword', { currentPassword: password, newPassword: 'replacement password' })
  assert.equal((await active.actionRaw('account.profile', {})).status, 401)
  assert.equal((await owner.actionRaw('account.profile', {})).status, 401)
  const fresh = await install.signIn(owner.email, 'replacement password')
  assert.equal((await fresh.action('account.profile', {})).name, 'Updated name')
})

test('email change requires confirmation, limits guesses and revokes sessions', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  await owner.action('account.requestEmailChange', { currentPassword: password, email: 'new@example.com' })
  assert.equal((await owner.action('account.profile', {})).email, 'owner@example.com')
  assert.equal((await expectError(() => owner.action('account.confirmEmailChange', { code: 'invalid' }))).code, 'invalid_input')
  const code = install.lastCode('new@example.com')
  await owner.action('account.confirmEmailChange', { code })
  assert.equal((await owner.actionRaw('account.profile', {})).status, 401)
  const fresh = await install.signIn('new@example.com', password)
  assert.equal((await fresh.action('account.profile', {})).email, 'new@example.com')
  await install.runJobs()
  assert.equal(install.app.account(fresh.accountId!).ctx.db.get<{ value: string }>("SELECT value FROM account_meta WHERE key = 'owner_email'")?.value, 'new@example.com')
  assert.equal((await expectError(() => fresh.action('account.confirmEmailChange', { code }))).code, 'bad_code')
  await fresh.action('account.requestEmailChange', { currentPassword: password, email: 'later@example.com' })
  const correct = install.lastCode('later@example.com')
  const wrong = correct === '000000' ? '999999' : '000000'
  for (let n = 0; n < 5; n++) assert.equal((await expectError(() => fresh.action('account.confirmEmailChange', { code: wrong }))).code, 'bad_code')
  assert.equal((await expectError(() => fresh.action('account.confirmEmailChange', { code: correct }))).code, 'bad_code')
})

test('deletion retries a failed image wipe, preserves another account and cannot bootstrap again', async (t) => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'other@example.com' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const other = await install.signUp({ email: 'other@example.com' })
  const accountId = owner.accountId!
  const nl = await owner.action('newsletters.create', { name: 'Delete me' })
  const store = install.app.account(accountId)
  for (let n = 0; n < 23; n++) await store.ctx.platform.blobs.put(`${accountId}/image${n}.png`, new Uint8Array([1, 2]), 'image/png')
  await store.ctx.platform.blobs.put(`${other.accountId}/keep.png`, new Uint8Array([3]), 'image/png')
  assert.equal((await expectError(() => other.action('account.delete', { accountId, confirmation: 'DELETE', currentPassword: password }))).status, 404)
  const removeBlob = store.ctx.platform.blobs.delete
  store.ctx.platform.blobs.delete = async () => { throw new Error('Synthetic storage outage') }
  await owner.action('account.delete', { accountId, confirmation: 'DELETE', currentPassword: password })
  await install.runJobs()
  assert.equal(getPolicy(store.ctx).status, 'deleting')
  assert.ok(install.app.control.ctx.db.get('SELECT id FROM accounts WHERE id = ?', accountId), 'control data stays until the wipe succeeds')
  assert.equal((await owner.actionRaw('newsletters.get', { newsletterId: nl.id })).status, 410)
  store.ctx.platform.blobs.delete = removeBlob
  install.clock.advance(60_000)
  await install.runJobs()
  assert.ok(install.app.control.ctx.db.get('SELECT id FROM accounts WHERE id = ?', accountId), 'deletion yields between blob batches')
  assert.equal((await store.ctx.platform.blobs.list(`${accountId}/`)).length, 3)
  install.clock.advance(1000)
  await install.runJobs()
  assert.equal(install.app.control.ctx.db.get('SELECT id FROM accounts WHERE id = ?', accountId), undefined)
  assert.deepEqual(await store.ctx.platform.blobs.list(`${accountId}/`), [])
  assert.equal((await store.ctx.platform.blobs.list(`${other.accountId}/`)).length, 1)
  assert.equal((await owner.actionRaw('account.profile', {})).status, 401)
  assert.equal((await other.action('account.profile', {})).email, 'other@example.com')
  assert.equal(install.app.accountIds().includes(accountId), false)
  await assert.rejects(async () => install.app.stores.account(accountId).selfWipe({}), /not provisioned/i)
  await install.tick()
  assert.equal(fs.existsSync(path.join(install.dataDir, 'accounts', `${accountId}.db`)), false, 'the destroyed store leaves no database behind')
})

test('a newer policy committed during a push is delivered on the next job run', async (t) => {
  const { pushPolicy } = await import('../control/accounts/index.ts')
  const { accountRegistry } = await import('../account/modules.ts')
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const accountId = owner.accountId!
  const apply = accountRegistry.rpc.get('applyPolicy')!
  let changed = false
  accountRegistry.rpc.set('applyPolicy', (ctx, policy) => {
    if (!changed) {
      changed = true
      pushPolicy(install.app.control.ctx, accountId, { status: 'blocked', block_reason: 'Committed during a push' })
    }
    return apply(ctx, policy)
  })
  t.after(() => { accountRegistry.rpc.set('applyPolicy', apply) })
  pushPolicy(install.app.control.ctx, accountId, { plan: 'starter' })
  await install.runJobs()
  assert.equal(getPolicy(install.app.account(accountId).ctx).status, 'blocked')
  assert.equal(getPolicy(install.app.account(accountId).ctx).version, 3)
})
