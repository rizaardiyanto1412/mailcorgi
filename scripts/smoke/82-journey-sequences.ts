import { z } from 'zod'
import type { SmokeContext } from '../smoke-context.ts'

/**
 * Full journey, part 7: an email sequence the way an app runs one, with an API key. Create it with a
 * tag entry, activate it, tag a new contact, watch the enrollment, and stop it with the exit tag.
 * The first step is a day away and a running server's clock cannot be moved, so no step email is
 * sent here; server/test/sequences-send.test.ts covers the sends with a fake clock.
 */
export default async function step({ base, action, expect, state }: SmokeContext) {
  const newsletter = z.object({ id: z.string() }).parse(state.get('journey'))
  const key = await action('apikeys.create', { name: 'Journey sequences', access: 'full' })
  const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const rest = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}/api/v1/newsletters/${newsletter.id}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, data: await r.json().catch(() => null) }
  }
  const entry = (await rest('POST', '/tags', { name: 'new-signup' })).data
  const exit = (await rest('POST', '/tags', { name: 'paid' })).data
  const before = (await rest('POST', '/contacts', { email: 'sequence-early@example.com', tags: [entry.id] })).data.contact
  const created = await rest('POST', '/sequences', {
    name: 'Journey onboarding', entry: { type: 'tag', tagId: entry.id }, exit: { tagIds: [exit.id] },
    steps: [1, 3].map((delayDays) => ({ delayDays, subject: `Day ${delayDays}`, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Hello on day ${delayDays}.` }] }] } })),
  })
  expect(created.status === 200 && created.data.status === 'draft' && created.data.steps.length === 2, `REST creates a draft sequence (${created.status})`)
  const sequence = `/sequences/${created.data.id}`
  const backwards = await rest('POST', `${sequence}/steps`, { delayDays: 2, subject: 'Too early' })
  expect(backwards.status === 409 && backwards.data.error.code === 'step_delay_order', `a step with a shorter delay than the one before is refused (${backwards.status})`)
  const activated = await rest('POST', `${sequence}/activate`)
  expect(activated.status === 200 && activated.data.status === 'active' && activated.data.enrollments.total === 0, `the sequence activates without enrolling contacts who already had the tag (${activated.status})`)

  const signup = await rest('POST', '/contacts', { email: 'sequence-user@example.com', name: 'Sequence User', tags: [entry.id], source: 'app' })
  expect(signup.status === 200 && signup.data.outcome === 'subscribed', 'the app creates a tagged contact')
  await rest('POST', '/contacts', { email: 'sequence-user@example.com', tags: [entry.id] })
  const listed = await rest('GET', `${sequence}/enrollments`)
  const enrollment = listed.data.enrollments[0]
  expect(listed.status === 200 && listed.data.enrollments.length === 1 && enrollment.email === 'sequence-user@example.com' && enrollment.status === 'active', `the tagged contact is enrolled once (${listed.data?.enrollments?.length})`)
  expect(enrollment.nextRunAt === enrollment.enrolledAt + 86_400_000 && enrollment.nextStep.position === 1, 'the first step is due exactly one day after enrollment')

  const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sequences_stats', arguments: { newsletterId: newsletter.id, sequenceId: created.data.id } } }) })
  const stats = (await mcp.json()).result?.structuredContent
  expect(stats?.enrollments?.active === 1 && stats.steps[0].waiting === 1 && stats.steps[0].sent === 0, 'MCP reads the sequence stats: one contact waits for step 1')
  const inUse = await rest('DELETE', `/tags/${entry.id}`)
  expect(inUse.status === 409 && inUse.data.error.code === 'tag_in_use', `the entry tag cannot be deleted while the sequence uses it (${inUse.status})`)

  const paid = await rest('PATCH', `/contacts/${signup.data.contact.id}`, { addTagIds: [exit.id] })
  expect(paid.status === 200, 'the app tags the contact as paid')
  const after = (await rest('GET', `/contacts/${signup.data.contact.id}`)).data.enrollments
  expect(after.length === 1 && after[0].status === 'exited' && after[0].exitReason === 'tag' && after[0].nextRunAt === null, 'the exit tag takes the contact out of the sequence')
  expect((await action('dev.outbox', { to: 'sequence-user@example.com' })).emails.length === 0, 'no sequence email went out before its day')

  const archived = await rest('POST', `${sequence}/archive`)
  expect(archived.status === 200 && archived.data.status === 'archived', 'the sequence is archived')
  // Leave the journey list as the later steps expect it.
  for (const id of [before.id, signup.data.contact.id]) await action('contacts.delete', { newsletterId: newsletter.id, contactId: id })
  await action('apikeys.revoke', { keyId: key.id })
}
