import { z } from 'zod'
import type { SmokeContext } from '../smoke-context.ts'
import { waitUntil } from '../smoke-context.ts'

export const JOURNEY_CONTACTS = 2000
export const journeyEmail = (i: number) => `journey${i}@example.com`
export const journeyCity = (i: number) => (i % 2 === 0 ? 'Paris' : 'Berlin')

/** Full journey, part 2: 2,000 contacts arrive through the chunked CSV import with a custom field and a tag. */
export default async function step({ action, expect, state }: SmokeContext) {
  const newsletter = z.object({ id: z.string() }).parse(state.get('journey'))
  const newsletterId = newsletter.id
  const field = await action('contactFields.create', { newsletterId, key: 'city', label: 'City', type: 'text' })
  const tag = await action('tags.create', { newsletterId, name: 'imported' })
  const created = await action('imports.create', { newsletterId, mapping: { email: 'Email', name: 'Name', status: 'Status', fields: { city: 'City' } }, options: { consent: true, tagIds: [tag.id] } })
  const importId = created.id as string
  for (let seq = 0; seq * 500 < JOURNEY_CONTACTS; seq++) {
    const rows = Array.from({ length: 500 }, (_, n) => {
      const i = seq * 500 + n
      return { Email: journeyEmail(i), Name: `Reader ${i}`, Status: 'subscribed', City: journeyCity(i) }
    })
    const chunk = await action('imports.addChunk', { newsletterId, importId, seq, rows })
    expect(chunk.accepted === true, `chunk ${seq} accepted`)
  }
  await action('imports.start', { newsletterId, importId, totalRows: JOURNEY_CONTACTS })
  const report = await waitUntil('import of 2,000 contacts', 120_000, async () => {
    const r = await action('imports.get', { newsletterId, importId })
    if (r.status === 'failed' || r.status === 'canceled' || r.status === 'stalled') throw new Error(`smoke: import ended as ${r.status}: ${r.error}`)
    return r.status === 'completed' ? r : null
  }, 500)
  expect(report.added === JOURNEY_CONTACTS && report.processedRows === JOURNEY_CONTACTS, `every row was added (${report.added} added, skipped ${JSON.stringify(report.skipped)})`)
  const total = await action('segments.count', { newsletterId, filter: null })
  expect(total.count === JOURNEY_CONTACTS, `the newsletter has ${JOURNEY_CONTACTS} contacts (${total.count})`)
  const tagged = await action('segments.count', { newsletterId, filter: { field: 'tag', id: tag.id } })
  expect(tagged.count === JOURNEY_CONTACTS, 'every imported contact carries the import tag')
  const page = await action('contacts.list', { newsletterId, search: journeyEmail(7), limit: 5 })
  expect(page.contacts[0]?.fields?.city === 'Berlin' && page.contacts[0]?.status === 'subscribed', 'custom fields came through the mapping')
  const notifications = await action('notifications.list')
  expect(notifications.items.some((n: { kind: string }) => n.kind === 'import_finished'), 'the bell shows the finished import')
  state.set('field', field)
  state.set('tag', tag)
}
