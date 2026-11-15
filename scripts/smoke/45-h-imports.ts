import type { SmokeContext } from '../smoke-context.ts'
import { z } from 'zod'

export default async function importsSmoke({ json, call, state, expect }: SmokeContext) {
  const newsletterId = z.object({ id: z.string() }).parse(state.get('newsletter')).id
  const action = (name: string, input: unknown, status = 200) => json('POST', '/api/actions/' + name, input, status)
  const created = await action('imports.create', { newsletterId, mapping: { email: 'Email', name: 'Name', status: 'Status' }, options: { consent: true } })
  const importId = z.object({ id: z.string() }).parse(created).id
  const identity = { newsletterId, importId }
  const chunk = { ...identity, seq: 0, rows: [{ Email: 'optout@example.com', Name: 'Reader', Status: 'unsubscribed' }, { Email: '=FORMULA()', Name: 'Reader', Status: 'subscribed' }] }
  expect((await action('imports.addChunk', chunk)).accepted, 'import chunk accepted')
  expect(!(await action('imports.addChunk', chunk)).accepted, 'duplicate chunk is a no-op')
  await action('imports.start', { ...identity, totalRows: 2 })
  let done = false
  for (let i = 0; i < 40; i++) {
    const report = await action('imports.get', identity)
    if (report.status === 'completed') {
      expect(report.processedRows === 2 && report.skipped.imported_unsubscribed === 1 && report.skipped.invalid_syntax === 1, 'import report counts')
      done = true; break
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  expect(done, 'import finishes through the alarm scheduler')
  const attempted = await action('contacts.create', { newsletterId, email: 'optout@example.com' })
  expect(attempted.outcome === 'suppressed', 'imported opt-out never subscribes')
  const download = await call('GET', `/api/actions/imports.skipped?newsletterId=${newsletterId}&importId=${importId}`)
  expect(download.status === 200 && (await download.text()).includes("\"'=FORMULA()\""), 'skipped CSV is downloadable and formula-safe')
  const page = await call('GET', '/imports')
  expect(page.status === 200 && (await page.text()).includes('id="root"'), 'imports SPA route loads')
  const canceled = z.object({ id: z.string() }).parse(await action('imports.create', { newsletterId, mapping: { email: 'email' } }))
  expect((await action('imports.cancel', { newsletterId, importId: canceled.id })).status === 'canceled', 'cancel upload')
}
