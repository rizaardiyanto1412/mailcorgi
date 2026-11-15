import type { SmokeContext } from '../smoke-context.ts'

export default async function step({ json, call, expect }: SmokeContext) {
  const list = await json('POST', '/api/actions/setup.checklist', {})
  const ids = list.items.map((item: { id: string }) => item.id).join(',')
  expect(ids === 'provider,testEmail,webhooks,sending,domain', `the setup checklist lists every item (${ids})`)
  const state = Object.fromEntries(list.items.map((item: { id: string; state: string }) => [item.id, item.state]))
  expect(list.provider === 'test' && state.provider === 'todo' && state.sending === 'done' && list.complete === false, 'a fresh install still needs a provider')
  const page = await call('GET', '/admin/setup')
  expect(page.status === 200 && (await page.text()).includes('id="root"'), 'the setup checklist page is served')
  const tls = await call('GET', '/api/public/tls-check?domain=unknown.example.com')
  expect(tls.status === 404, 'the TLS ask endpoint refuses unknown hosts')
}
