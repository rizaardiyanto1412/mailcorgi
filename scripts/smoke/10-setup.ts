import type { SmokeContext } from '../smoke-context.ts'

export default async function step({ jar, json, call, expect }: SmokeContext) {
  const health = await json('GET', '/healthz')
  expect(health.ok === true, '/healthz ok')
  const index = await call('GET', '/')
  expect(index.status === 200 && (await index.text()).includes('id="root"'), 'the SPA index is served')
  const boot = await json('GET', '/api/auth/bootstrap')
  expect(boot.setupRequired === true, 'a fresh install needs setup')
  await json('POST', '/api/auth/setup', { name: 'Smoke Tester', email: 'smoke@example.com', password: 'smoke test password' })
  const session = (await json('GET', '/api/auth/bootstrap')).session
  expect(session?.user?.email === 'smoke@example.com' && session.current, 'setup created a session and an account')
  jar.csrf = session.csrf
  expect((await json('POST', '/api/actions/newsletters.list', {})).newsletters.length === 0, 'no newsletters yet, so the app lands on /welcome')
}
