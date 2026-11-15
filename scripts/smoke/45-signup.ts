import { z } from 'zod'
import type { SmokeContext } from '../smoke-context.ts'

export default async function step({ base, json, call, expect, state }: SmokeContext) {
  const newsletter = z.object({ id: z.string(), key: z.string() }).parse(state.get('newsletter'))
  const current = await json('POST', '/api/actions/signup.get', { newsletterId: newsletter.id })
  expect(current.doubleOptIn === true, 'signup defaults to double opt-in')
  expect(current.inlineSnippet.includes('/embed.js?key='), 'signup settings expose an embed snippet')
  const hosted = await call('GET', `/f/${newsletter.key}`)
  expect(hosted.status === 200 && (await hosted.text()).includes('name="formToken"'), 'hosted signup form has a signed timestamp')
  const embed = await call('GET', `/embed.js?key=${newsletter.key}`)
  const script = await embed.text()
  expect(embed.status === 200 && new TextEncoder().encode(script).length < 8192, 'embed script is under 8 KB')
  const preview = await json('POST', '/api/actions/signup.preview', { newsletterId: newsletter.id, settings: current.settings })
  expect(preview.html.includes('<form'), 'form preview renders')
  await json('POST', '/api/actions/signup.update', { newsletterId: newsletter.id, settings: current.settings, doubleOptIn: false })
  const config = await json('GET', `/api/public/subscribe/${newsletter.key}`)
  await new Promise((resolve) => setTimeout(resolve, 2100))
  const response = await fetch(`${base}/api/public/subscribe/${newsletter.key}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: JSON.stringify({ email: 'smoke-reader@example.com', formToken: config.formToken }) })
  expect(response.status === 200 && response.headers.get('access-control-allow-origin') === '*', 'public signup answers with CORS')
  const contacts = await json('POST', '/api/actions/contacts.list', { newsletterId: newsletter.id, search: 'smoke-reader@example.com' })
  expect(contacts.contacts[0]?.status === 'subscribed', 'public single opt-in subscribes the contact')
  const welcome = await json('POST', '/api/actions/signup.saveWelcome', { newsletterId: newsletter.id, enabled: false, subject: 'Welcome', doc: { type: 'doc', content: [{ type: 'paragraph' }] }, revision: null })
  expect(welcome.welcome.kind === 'welcome', 'signup saves a welcome campaign')
  const spa = await call('GET', '/settings/forms')
  expect(spa.status === 200 && (await spa.text()).includes('<div id="root">'), 'signup settings SPA loads')
  await json('POST', '/api/actions/signup.update', { newsletterId: newsletter.id, settings: current.settings, doubleOptIn: true })
}
