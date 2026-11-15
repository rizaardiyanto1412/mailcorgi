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

test('the newsletter limit applies to active newsletters and archiving frees a slot', async () => {
  const second = await owner.action('newsletters.create', { name: 'Second' })
  assert.equal((await expectError(() => owner.action('newsletters.create', { name: 'Third' }))).code, 'limit_reached')
  const archived = await owner.action('newsletters.archive', { newsletterId: second.id })
  assert.ok(archived.archivedAt)
  assert.deepEqual((await owner.action('newsletters.list', {})).newsletters.map((n) => n.name), ['Corgi Mail'])
  assert.equal((await owner.action('newsletters.list', { includeArchived: true })).newsletters.length, 2)
  await install.runJobs()
  assert.equal(await install.app.stores.control.lookupSite({ slug: 'second' }), null)
  const third = await owner.action('newsletters.create', { name: 'Third' })
  assert.equal(third.slug, 'third')
  assert.equal((await expectError(() => owner.action('newsletters.unarchive', { newsletterId: second.id }))).code, 'limit_reached')
})
