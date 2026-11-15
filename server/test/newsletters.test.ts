import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Client, type Install } from './harness.ts'

let install: Install
let owner: Client
before(async () => {
  install = await createInstall({ env: { MAX_NEWSLETTERS: '2', ALLOWED_EMAILS: 'other@example.com' } })
  owner = await install.signUp({ email: 'owner@example.com' })
})
after(() => install.close())

test('create, list and get', async () => {
  const nl = await owner.action('newsletters.create', { name: 'The Weekly Corgi' })
  assert.equal(nl.slug, 'the-weekly-corgi')
  assert.match(nl.key, new RegExp(`^nl_${owner.accountId}_[a-z2-7]{16}$`))
  assert.equal(nl.doubleOptIn, true)
  const list = await owner.action('newsletters.list', {})
  assert.deepEqual(list.newsletters.map((n) => n.id), [nl.id])
  assert.equal((await owner.action('newsletters.get', { newsletterId: nl.id })).name, 'The Weekly Corgi')
  await install.runJobs()
  assert.equal((await install.app.stores.control.lookupSite({ slug: 'the-weekly-corgi' }))?.newsletter_id, nl.id)
})

test('rename and change the slug, which updates the directory', async () => {
  const nl = (await owner.action('newsletters.list', {})).newsletters[0]
  const renamed = await owner.action('newsletters.update', { newsletterId: nl.id, name: 'Corgi Mail', description: 'Dogs.' })
  assert.equal(renamed.name, 'Corgi Mail')
  assert.equal(renamed.description, 'Dogs.')
  const moved = await owner.action('newsletters.setSlug', { newsletterId: nl.id, slug: 'corgi-mail' })
  assert.equal(moved.slug, 'corgi-mail')
  await install.runJobs()
  assert.equal(await install.app.stores.control.lookupSite({ slug: 'the-weekly-corgi' }), null)
  assert.equal((await install.app.stores.control.lookupSite({ slug: 'corgi-mail' }))?.newsletter_id, nl.id)
  assert.equal((await expectError(() => owner.action('newsletters.setSlug', { newsletterId: nl.id, slug: 'api' }))).code, 'slug_taken')
  assert.equal((await expectError(() => owner.action('newsletters.setSlug', { newsletterId: nl.id, slug: 'Bad Slug!' }))).code, 'invalid_input')
})

test('slugs are unique within the account and across accounts', async () => {
  assert.equal((await expectError(() => owner.action('newsletters.create', { name: 'Corgi Mail' }))).code, 'slug_taken')
  const other = await install.signUp({ email: 'other@example.com' })
  assert.equal((await expectError(() => other.action('newsletters.create', { name: 'x', slug: 'corgi-mail' }))).code, 'slug_taken')
})

test('cloud newsletter limits apply to active newsletters and archiving frees a slot', async (t) => {
  const cloud = await createInstall({ cloud: true })
  t.after(() => cloud.close())
  const user = await cloud.signUp({ email: 'cloud@example.com' })
  const first = await user.action('newsletters.create', { name: 'First' })
  assert.equal((await expectError(() => user.action('newsletters.create', { name: 'Second' }))).code, 'limit_reached')
  await user.action('newsletters.archive', { newsletterId: first.id })
  await user.action('newsletters.create', { name: 'Second' })
  assert.equal((await expectError(() => user.action('newsletters.unarchive', { newsletterId: first.id }))).code, 'limit_reached')
})

test('self-hosted newsletters have no plan limit', async () => {
  for (let i = 0; i < 4; i++) await owner.action('newsletters.create', { name: `Unlimited ${i}` })
  assert.equal((await owner.action('newsletters.list', {})).newsletters.length, 5)
})
