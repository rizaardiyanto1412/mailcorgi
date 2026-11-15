import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError } from './harness.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'

test('newsletter settings, images and author CRUD are scoped and validated', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const a = await owner.action('newsletters.create', { name: 'Settings test' })
    const b = await owner.action('newsletters.create', { name: 'Other newsletter' })
    const updated = await owner.action('newsletters.update', { newsletterId: a.id, fromName: 'The editor', fromLocal: 'hello', replyTo: 'reply@example.com', postalAddress: '123 Example Street', language: 'id', timezone: 'Asia/Jakarta', doubleOptIn: false, tracking: { opens: false, clicks: true } })
    assert.equal(updated.fromLocal, 'hello')
    assert.equal(updated.timezone, 'Asia/Jakarta')
    assert.equal(updated.language, 'id')
    assert.equal(updated.doubleOptIn, false)
    assert.deepEqual(updated.tracking, { opens: false, clicks: true })
    for (const input of [{ timezone: 'bad' }, { fromLocal: 'evil\r\nBcc: x' }, { replyTo: 'bad' }, { language: 'not_valid' }]) assert.equal((await owner.actionRaw('newsletters.update', { newsletterId: a.id, ...input })).status, 400)
    const image = await owner.action('newsletters.uploadImage', { newsletterId: a.id, kind: 'logo', contentType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=' })
    const response = await install.fetch(`/img/${owner.accountId}/${image.logoKey}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal((await expectError(() => owner.action('newsletters.uploadImage', { newsletterId: a.id, kind: 'icon', contentType: 'image/png', data: btoa('<svg></svg>') }))).status, 400)
    const author = await owner.action('authors.create', { newsletterId: a.id, name: 'A writer', slug: 'writer', bio: 'Words.', links: { website: 'https://example.com' } })
    assert.equal((await owner.action('authors.list', { newsletterId: a.id })).authors[0].name, 'A writer')
    await owner.action('authors.update', { newsletterId: a.id, authorId: author.id, name: 'Editor', slug: 'writer', bio: 'More words.' })
    assert.equal((await owner.action('authors.list', { newsletterId: a.id })).authors[0].bio, 'More words.')
    const ctx = install.app.account(owner.accountId!).ctx
    const actor: Actor = { userId: 'member', email: 'member@example.com', owner: false, grants: { [b.id]: 'admin' }, access: 'full', via: 'web', installAdmin: false }
    await assert.rejects(runAction(ctx, 'authors.delete', { newsletterId: b.id, authorId: author.id }, actor), (e: unknown) => e instanceof AppError && e.status === 404)
    await assert.rejects(runAction(ctx, 'newsletters.update', { newsletterId: a.id, name: 'No' }, actor), (e: unknown) => e instanceof AppError && e.status === 403)
    await owner.action('authors.delete', { newsletterId: a.id, authorId: author.id })
    assert.equal((await owner.action('authors.list', { newsletterId: a.id })).authors.length, 0)
    await owner.action('newsletters.archive', { newsletterId: a.id })
    await install.runJobs()
    assert.equal(await install.app.stores.control.lookupSite({ slug: a.slug }), null)
    await owner.action('newsletters.unarchive', { newsletterId: a.id })
    await install.runJobs()
    assert.equal((await install.app.stores.control.lookupSite({ slug: a.slug }))?.newsletter_id, a.id)
  } finally { install.close() }
})
