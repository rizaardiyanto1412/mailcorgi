import { z } from 'zod'
import type { SmokeContext } from '../smoke-context.ts'
import { sleep } from '../smoke-context.ts'

/** Full journey, part 5: double opt-in through the public form, confirmation, and a deleted reader who comes back. */
export default async function step({ base, action, expect, state }: SmokeContext) {
  const newsletter = z.object({ id: z.string(), key: z.string() }).parse(state.get('journey'))
  const email = 'optin@example.com'
  const subscribe = async () => {
    const config = await (await fetch(`${base}/api/public/subscribe/${newsletter.key}`)).json()
    await sleep(2100)
    const response = await fetch(`${base}/api/public/subscribe/${newsletter.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Opt In', formToken: config.formToken }) })
    expect(response.status === 200, `public signup answers ${response.status}`)
    const mail = (await action('dev.outbox', { to: email })).emails.at(-1)
    const link = mail && /https?:\/\/[^\s<>"\]]+\/confirm\/[^\s<>"\]]+/.exec(mail.text)?.[0]
    expect(link, 'the reader got a confirmation email')
    expect((await fetch(link!)).status === 200, 'the confirmation link works')
    const contact = (await action('contacts.list', { newsletterId: newsletter.id, search: email })).contacts[0]
    expect(contact?.status === 'subscribed' && contact.source === 'signup', 'the reader is subscribed after confirming')
    return contact
  }
  const first = await subscribe()
  expect((await fetch(`${base}/api/public/subscribe/${newsletter.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, formToken: 'bad' }) })).status === 400, 'a forged form token is refused')
  await action('contacts.delete', { newsletterId: newsletter.id, contactId: first.id })
  expect((await action('contacts.create', { newsletterId: newsletter.id, email })).outcome === 'suppressed', 'an owner cannot re-add a deleted reader')
  const second = await subscribe()
  expect(second.id !== first.id, 'the returning reader is a new contact row')
}
