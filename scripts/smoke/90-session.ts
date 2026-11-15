import type { SmokeContext } from '../smoke-context.ts'

export default async function step({ json, call, expect }: SmokeContext) {
  const deepLink = await call('GET', '/campaigns')
  expect(deepLink.status === 200, 'client-side routes fall back to the SPA')
  await json('POST', '/api/auth/signout', {})
  expect((await json('GET', '/api/auth/bootstrap')).session === null, 'signed out')
  await json('POST', '/api/auth/signin', { email: 'smoke@example.com', password: 'smoke test password' })
  const again = (await json('GET', '/api/auth/bootstrap')).session
  expect(again?.user?.email === 'smoke@example.com', 'signed in again')
  const forged = await call('POST', '/api/actions/newsletters.list', {})
  expect(forged.status === 403, 'a request without the CSRF header is refused')
}
