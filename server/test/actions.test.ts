import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Client, type Install } from './harness.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'

let install: Install
let owner: Client
let newsletterId: string
before(async () => {
  install = await createInstall({ env: { ALLOWED_EMAILS: 'member@example.com,plain@example.com' } })
  owner = await install.signUp({ email: 'owner@example.com' })
  newsletterId = (await owner.action('newsletters.create', { name: 'Weekly' })).id
})
after(() => install.close())

test('invalid input is a 400 with the issues', async () => {
  const err = await expectError(() => owner.action('newsletters.create', { name: '' } as any))
  assert.equal(err.status, 400)
  assert.equal(err.code, 'invalid_input')
  assert.deepEqual((err.details as { issues: { path: string }[] }).issues.map((i) => i.path), ['name'])
})

test('an unknown action is a 404', async () => {
  const response = await owner.actionRaw('nothing.here', {})
  assert.equal(response.status, 404)
})

test('a member may read but not do owner things, and only in granted newsletters', async () => {
  const other = (await owner.action('newsletters.create', { name: 'Other' })).id
  const member = await install.signUp({ email: 'member@example.com' })
  install.app.control.ctx.db.run('INSERT INTO memberships (user_id, account_id, newsletter_id, role, created_at) VALUES (?, ?, ?, ?, ?)', member.session.user.id, owner.accountId, newsletterId, 'member', 1)
  await member.post('/api/auth/account', { accountId: owner.accountId })
  await member.refresh()
  assert.equal(member.accountId, owner.accountId)

  const list = await member.action('newsletters.list', {})
  assert.deepEqual(list.newsletters.map((n) => n.id), [newsletterId])
  assert.equal((await member.action('newsletters.get', { newsletterId })).id, newsletterId)
  assert.equal((await expectError(() => member.action('newsletters.get', { newsletterId: other }))).status, 403)
  assert.equal((await expectError(() => member.action('newsletters.update', { newsletterId, name: 'x' }))).status, 403)
  assert.equal((await expectError(() => member.action('newsletters.create', { name: 'Mine' }))).status, 403)
  assert.equal((await expectError(() => member.action('newsletters.archive', { newsletterId }))).status, 403)
})

test('a missing resource is a 404 even for the owner, and a mismatched newsletterId too', async () => {
  assert.equal((await expectError(() => owner.action('newsletters.get', { newsletterId: 'nl_aaaaaaaaaaaaaaaa' }))).status, 404)
  const ctx = install.app.account(owner.accountId!).ctx
  const actor: Actor = { userId: 'u', email: 'owner@example.com', owner: true, grants: {}, access: 'full', via: 'web', installAdmin: false }
  await assert.rejects(runAction(ctx, 'newsletters.get', { newsletterId: 'nl_aaaaaaaaaaaaaaaa' }, actor), (err: AppError) => err.status === 404)
})

test('a read-only key may not run write actions', async () => {
  const ctx = install.app.account(owner.accountId!).ctx
  const actor: Actor = { userId: 'u', email: 'owner@example.com', owner: true, grants: {}, access: 'read', via: 'api', installAdmin: false }
  await assert.rejects(runAction(ctx, 'newsletters.update', { newsletterId, name: 'x' }, actor), (err: AppError) => err.status === 403)
  const got = (await runAction(ctx, 'newsletters.get', { newsletterId }, actor)) as { id: string }
  assert.equal(got.id, newsletterId)
})

test('a control action needs an install admin when it says so', async () => {
  const user = await install.signUp({ email: 'plain@example.com' })
  assert.equal((await expectError(() => user.action('install.settings.get', {}))).status, 403)
  const settings = await owner.action('install.settings.get', {})
  assert.equal(settings.values.email_provider, '')
})
