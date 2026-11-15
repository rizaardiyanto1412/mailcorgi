import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError } from './harness.ts'

type Checklist = { provider: string; complete: boolean; items: { id: string; state: string; detail: string }[] }
const states = (list: Checklist) => Object.fromEntries(list.items.map((item) => [item.id, item.state]))

for (const cloud of [false, true]) test(`setup checklist follows real install state (${cloud ? 'cloud' : 'self-hosted'})`, async (t) => {
  const install = await createInstall({ cloud, env: { ADMIN_EMAILS: 'owner@example.com' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const checklist = async () => (await owner.action('setup.checklist', {})) as Checklist

  const fresh = await checklist()
  assert.equal(fresh.provider, 'test')
  assert.deepEqual(states(fresh), { provider: 'todo', testEmail: 'todo', webhooks: 'todo', sending: 'done', domain: 'todo' })
  assert.equal(fresh.complete, false)

  // A test email through the local outbox does not count once a real provider is chosen.
  await owner.action('install.email.test', { to: 'reader@example.com' })
  await owner.action('install.settings.set', { values: { email_provider: 'resend', email_from: 'system@example.com' } })
  let list = await checklist()
  assert.equal(states(list).provider, 'todo')
  assert.match(list.items[0].detail, /resend_api_key/)
  assert.equal(states(list).testEmail, 'todo')

  await owner.action('install.settings.set', { values: { resend_api_key: 're_test_key' } })
  assert.equal(states(await checklist()).provider, 'done')

  // A refused send records nothing.
  const control = install.app.control.ctx
  control.platform.fetch = async () => Response.json({ message: 'Invalid API key' }, { status: 401 })
  await expectError(() => owner.action('install.email.test', { to: 'reader@example.com' }))
  assert.equal(states(await checklist()).testEmail, 'todo')

  control.platform.fetch = async () => Response.json({ id: 'msg-example' })
  await owner.action('install.email.test', { to: 'reader@example.com' })
  list = await checklist()
  assert.equal(states(list).testEmail, 'done')
  assert.match(list.items.find((item) => item.id === 'webhooks')!.detail, /resend_webhook_secret/)

  await install.app.stores.account(owner.accountId!).ingestProviderEvents({ events: [{ id: 'evt-example', type: 'delivered', accountId: owner.accountId!, deliveryId: null, messageId: 'msg-example', recipient: 'reader@example.com', occurredAt: install.clock.now() }] })
  assert.equal(states(await checklist()).webhooks, 'done')

  await owner.action('install.settings.set', { values: { sending_enabled: 'false' } })
  assert.equal(states(await checklist()).sending, 'todo')
  await owner.action('install.settings.set', { values: { sending_enabled: 'true' } })

  await owner.action('install.settings.set', { values: { email_provider: 'smtp', smtp_host: 'smtp.example.com' } })
  list = await checklist()
  assert.equal(states(list).webhooks, 'skipped')
  assert.equal(states(list).testEmail, 'todo')

  await owner.action('domains.add', { name: 'example.com' })
  install.dns.set('example.com', 'TXT', ['v=spf1 include:example.com ~all'])
  install.dns.set('_dmarc.example.com', 'TXT', ['v=DMARC1; p=none'])
  const [domain] = await owner.action('domains.list', {})
  assert.equal((await owner.action('domains.check', { domainId: domain.id })).status, 'verified')
  assert.equal(states(await checklist()).domain, 'done')
})

test('only install admins can read the setup checklist', async (t) => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'friend@example.com' } })
  t.after(() => install.close())
  const admin = await install.signUp({ email: 'admin@example.com' })
  const friend = await install.signUp({ email: 'friend@example.com' })
  assert.equal(((await admin.action('setup.checklist', {})) as Checklist).items.length, 5)
  assert.equal((await expectError(() => friend.action('setup.checklist', {}))).status, 403)
  const response = await friend.fetch('/api/actions/setup.checklist', { method: 'POST', body: '{}' })
  assert.equal(response.status, 403)
})
