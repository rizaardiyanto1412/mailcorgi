import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError } from './harness.ts'
import { runAction, type Actor } from '../core/actions.ts'

const ordinaryUser: Actor = { userId: 'usr_reader', email: 'reader@example.com', owner: true, grants: {}, access: 'full', via: 'web', installAdmin: false }

test('install email settings encrypt credentials, redact all output and respect environment overrides', async (t) => {
  const install = await createInstall({ env: { SES_SECRET_ACCESS_KEY: 'environment-test-secret' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const values = { ses_access_key_id: 'test-access-credential', ses_secret_access_key: 'stored-test-secret', smtp_user: 'test-smtp-credential', smtp_password: 'test-smtp-password', resend_api_key: 'test-resend-key', resend_webhook_secret: 'test-webhook-secret' }
  assert.deepEqual(await owner.action('install.settings.set', { values }), { ok: true })
  const output = await owner.action('install.settings.get', {})
  assert.equal(output.secretsSet.ses_access_key_id, true)
  assert.equal(output.secretsSet.smtp_user, true)
  assert.equal(output.fromEnv.ses_secret_access_key, true)
  for (const [key, value] of Object.entries(values)) {
    assert.equal(output.values[key], undefined)
    assert.ok(!JSON.stringify(output).includes(value))
    const row = install.app.control.ctx.db.get<{ value: string }>('SELECT value FROM install_settings WHERE key = ?', key)
    assert.match(row!.value, /^v1:/)
    assert.ok(!row!.value.includes(value))
  }
  assert.ok(!JSON.stringify(output).includes('environment-test-secret'))
  assert.equal(output.webhookUrls.ses, 'http://app.example.com/hooks/ses')
  assert.equal((await install.app.stores.control.getInstallSettings({ keys: ['ses_secret_access_key'] })).ses_secret_access_key, 'environment-test-secret')
  await assert.rejects(runAction(install.app.control.ctx, 'install.settings.get', {}, ordinaryUser), { status: 403 })
  await assert.rejects(runAction(install.app.control.ctx, 'install.settings.set', { values: { email_provider: 'test' } }, ordinaryUser), { status: 403 })
  await assert.rejects(runAction(install.app.control.ctx, 'install.email.test', { to: 'reader@example.com' }, ordinaryUser), { status: 403 })
})

test('settings validate the complete update before saving and test email uses the system sender', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  assert.equal((await expectError(() => owner.action('install.settings.set', { values: { email_from_name: 'Should not save', email_from: 'invalid' } }))).status, 400)
  assert.equal((await owner.action('install.settings.get', {})).values.email_from_name, '')
  for (const values of [{ send_rate_per_second: 'NaN' }, { smtp_port: '99999' }, { email_provider: 'unknown' }, { email_from_name: 'Sender\r\nBcc: reader@example.com' }]) assert.equal((await expectError(() => owner.action('install.settings.set', { values }))).status, 400)
  await owner.action('install.settings.set', { values: { email_from: 'system@example.com', email_from_name: 'Example sender' } })
  assert.deepEqual(await owner.action('install.email.test', { to: 'reader@example.com' }), { ok: true })
  assert.equal(install.outbox().at(-1)?.to_email, 'reader@example.com')
  assert.equal(install.outbox().at(-1)?.subject, 'MailCorgi test email')
})

test('send permits enforce a persistent global bucket and give a waiting account its turn', async (t) => {
  let install = await createInstall({ env: { ALLOWED_EMAILS: 'second@example.com' } })
  t.after(() => install.close())
  const first = await install.signUp({ email: 'first@example.com' })
  const second = await install.signUp({ email: 'second@example.com' })
  await first.action('install.settings.set', { values: { send_rate_per_second: '1' } })
  const permits = (accountId: string, want = 10) => install.app.stores.control.takeSendPermits({ accountId, want })
  assert.equal((await permits(first.accountId!)).granted, 1)
  assert.equal((await permits(second.accountId!)).granted, 0)
  install.clock.advance(1000)
  // The first caller cannot take the token reserved by the second caller's waiting turn.
  assert.equal((await permits(first.accountId!)).granted, 0)
  assert.equal((await permits(second.accountId!)).granted, 1)
  install = await install.restart()
  assert.equal((await permits(first.accountId!)).granted, 0)
  install.clock.advance(1000)
  assert.equal((await permits(first.accountId!)).granted, 1)
  const signedIn = await install.signIn('first@example.com', 'correct horse battery')
  await signedIn.action('install.settings.set', { values: { sending_enabled: 'false' } })
  install.clock.advance(1000)
  assert.equal((await permits(first.accountId!)).granted, 0)
  assert.equal((await permits('acc_missing')).granted, 0)
})

test('cloud permits reserve monthly allowance atomically and refuse blocked accounts', async (t) => {
  const install = await createInstall({ cloud: true, env: { ADMIN_EMAILS: 'owner@example.com' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  await owner.action('install.settings.set', { values: { send_rate_per_second: '10000' } })
  const ctx = install.app.control.ctx
  const period = new Date(install.clock.now()).toISOString().slice(0, 7)
  ctx.db.run('INSERT INTO usage_snapshots (account_id, period, contacts, emails_sent, updated_at) VALUES (?, ?, 0, ?, ?)', owner.accountId, period, 9998, install.clock.now())
  const result = await install.app.stores.control.takeSendPermits({ accountId: owner.accountId!, want: 10 })
  assert.equal(result.granted, 2)
  assert.equal((await install.app.stores.control.takeSendPermits({ accountId: owner.accountId!, want: 10 })).granted, 0)
  ctx.db.run("UPDATE accounts SET status = 'blocked' WHERE id = ?", owner.accountId)
  install.clock.advance(31 * 86_400_000)
  assert.equal((await install.app.stores.control.takeSendPermits({ accountId: owner.accountId!, want: 10 })).granted, 0)
})
