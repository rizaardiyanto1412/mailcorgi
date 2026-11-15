import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError } from './harness.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC'
const doc = (src: string) => ({ type: 'doc' as const, content: [{ type: 'image' as const, attrs: { src, alt: 'A dot' } }] })

test('images: list a newsletter’s uploads, delete one, and refuse while a campaign uses it unless confirmed', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'member@example.com,admin@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Pictures' })
    const other = await owner.action('newsletters.create', { name: 'Other' })
    const a = await owner.action('campaigns.uploadImage', { newsletterId: nl.id, data: PNG, width: 1, height: 1 })
    install.clock.advance(1000)
    const b = await owner.action('campaigns.uploadImage', { newsletterId: nl.id, data: PNG, width: 1, height: 1 })
    await owner.action('campaigns.uploadImage', { newsletterId: other.id, data: PNG, width: 1, height: 1 })
    await owner.action('newsletters.uploadImage', { newsletterId: nl.id, kind: 'logo', contentType: 'image/png', data: PNG })

    const first = await owner.action('campaigns.listImages', { newsletterId: nl.id, limit: 1 })
    assert.equal(first.images.length, 1)
    assert.equal(first.images[0].url, b.url, 'newest first')
    const second = await owner.action('campaigns.listImages', { newsletterId: nl.id, limit: 1, cursor: first.next! })
    assert.deepEqual(second.images.map((i) => i.url), [a.url])
    assert.equal(second.next, null, 'the logo and the other newsletter’s image are not listed')

    const draft = await owner.action('campaigns.create', { newsletterId: nl.id, subject: 'Uses the dot' })
    await owner.action('campaigns.update', { campaignId: draft.id, revision: draft.revision, doc: doc(a.url) })
    const id = second.images[0].id
    const err = await expectError(() => owner.action('campaigns.deleteImage', { newsletterId: nl.id, imageId: id }))
    assert.equal(err.status, 409)
    assert.equal(err.code, 'image_in_use')
    assert.deepEqual((err.details as { campaigns: { id: string; subject: string }[] }).campaigns.map((c) => [c.id, c.subject]), [[draft.id, 'Uses the dot']])
    const blobKey = `${owner.accountId}/${a.key}`
    assert.ok(await install.app.platform.blobs.get(blobKey), 'nothing was deleted')

    const memberClient = await install.signUp({ email: 'member@example.com' })
    install.app.control.ctx.db.run('INSERT INTO memberships (user_id, account_id, newsletter_id, role, created_at) VALUES (?, ?, ?, ?, ?)', memberClient.session.user.id, owner.accountId!, nl.id, 'member', install.clock.now())
    await memberClient.post('/api/auth/account', { accountId: owner.accountId })
    assert.equal((await memberClient.action('campaigns.listImages', { newsletterId: nl.id })).images.length, 2, 'members reuse images')
    assert.equal((await memberClient.actionRaw('campaigns.deleteImage', { newsletterId: nl.id, imageId: id, confirm: true })).status, 403, 'only admins delete')

    await owner.action('campaigns.deleteImage', { newsletterId: nl.id, imageId: id, confirm: true })
    assert.equal(await install.app.platform.blobs.get(blobKey), null)
    assert.deepEqual((await owner.action('campaigns.listImages', { newsletterId: nl.id })).images.map((i) => i.url), [b.url])
    assert.equal((await install.fetch(new URL(a.url).pathname)).status, 404)
    assert.equal((await owner.actionRaw('campaigns.deleteImage', { newsletterId: nl.id, imageId: id })).status, 404)

    const unused = (await owner.action('campaigns.listImages', { newsletterId: nl.id })).images[0]
    assert.equal((await owner.actionRaw('campaigns.deleteImage', { newsletterId: other.id, imageId: unused.id })).status, 404, 'an image is deleted only through its own newsletter')
    await owner.action('campaigns.deleteImage', { newsletterId: nl.id, imageId: unused.id })
    assert.deepEqual((await owner.action('campaigns.listImages', { newsletterId: nl.id })).images, [])
  } finally {
    install.close()
  }
})
