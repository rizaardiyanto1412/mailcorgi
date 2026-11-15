import type { SmokeContext } from '../smoke-context.ts'

export default async function step({ json, expect, state }: SmokeContext) {
  const created = await json('POST', '/api/actions/newsletters.create', { name: 'Smoke Weekly' })
  expect(created.slug === 'smoke-weekly', 'the newsletter got its slug')
  const read = await json('POST', '/api/actions/newsletters.get', { newsletterId: created.id })
  expect(read.name === 'Smoke Weekly', 'the newsletter reads back')
  const list = await json('POST', '/api/actions/newsletters.list', {})
  expect(list.newsletters.length === 1, 'the list has one newsletter')

  state.set('newsletter', created)
}
