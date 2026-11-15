import type { SmokeContext } from '../smoke-context.ts'
import { waitUntil } from '../smoke-context.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC'

/** Image library and newsletter deletion, on its own newsletter so later steps are unaffected. */
export default async function step({ base, action, call, expect }: SmokeContext) {
  const nl = await action('newsletters.create', { name: 'Smoke doomed', slug: `smoke-doomed-${Date.now().toString(36)}` })
  const image = await action('campaigns.uploadImage', { newsletterId: nl.id, data: PNG, width: 1, height: 1 })
  const list = await action('campaigns.listImages', { newsletterId: nl.id })
  expect(list.images.length === 1 && list.images[0].url === image.url, 'the image library lists the upload')
  const draft = await action('campaigns.create', { newsletterId: nl.id, subject: 'Uses the image' })
  await action('campaigns.update', { campaignId: draft.id, revision: draft.revision, doc: { type: 'doc', content: [{ type: 'image', attrs: { src: image.url, alt: 'Dot' } }] } })
  const inUse = await action('campaigns.deleteImage', { newsletterId: nl.id, imageId: list.images[0].id }, 409)
  expect(inUse.code === 'image_in_use' && inUse.details.campaigns[0].id === draft.id, 'deleting a used image names the campaign')
  await action('campaigns.deleteImage', { newsletterId: nl.id, imageId: list.images[0].id, confirm: true })
  const gone = await fetch(new URL(new URL(image.url).pathname, base))
  await gone.arrayBuffer()
  expect(gone.status === 404, `a deleted image is gone from storage (${gone.status})`)

  await action('campaigns.uploadImage', { newsletterId: nl.id, data: PNG, width: 1, height: 1 })
  await action('newsletters.delete', { newsletterId: nl.id, confirmName: 'Smoke' }, 400)
  const started = await action('newsletters.delete', { newsletterId: nl.id, confirmName: 'Smoke doomed' })
  expect(started.deleting === true, 'deleting a newsletter starts')
  await waitUntil('the newsletter deletion', 30_000, async () => {
    const all = await action('newsletters.list', { includeArchived: true })
    return !all.newsletters.some((n: { id: string }) => n.id === nl.id)
  })
  // The newsletter row goes last, once its rows, images and team access are gone.
  await waitUntil('the deletion job to finish', 30_000, async () => {
    const r = await call('POST', '/api/actions/newsletters.delete', { newsletterId: nl.id, confirmName: 'Smoke doomed' })
    await r.arrayBuffer()
    return r.status === 404
  })
}
