import { z } from 'zod'
import type { SmokeContext } from '../smoke-context.ts'
import { JOURNEY_CONTACTS } from './46-journey-import.ts'

/** Full journey, part 3: a saved segment over the custom field, counted by the same compiler sending uses. */
export default async function step({ action, expect, state }: SmokeContext) {
  const newsletterId = z.object({ id: z.string() }).parse(state.get('journey')).id
  const filter = { all: [{ field: 'custom', key: 'city', op: 'eq', value: 'Paris' }, { field: 'status', in: ['subscribed'] }] }
  const segment = await action('segments.create', { newsletterId, name: 'Paris readers', filter })
  const count = await action('segments.count', { newsletterId, filter })
  expect(count.count === JOURNEY_CONTACTS / 2, `the segment matches half the list (${count.count})`)
  const listed = await action('segments.list', { newsletterId })
  expect(listed.segments.some((s: { id: string }) => s.id === segment.id), 'the segment is listed')
  const never = await action('segments.count', { newsletterId, filter: { field: 'engagement', op: 'openedLast', issues: 1 } })
  expect(never.count === 0, 'nobody has opened an issue yet')
  state.set('segment', segment)
}
