import type { SmokeContext } from '../../smoke-context.ts'

export default async function step({ json, call, expect }: SmokeContext) {
  await json('POST', '/api/auth/signout', {})
  expect((await json('GET', '/api/auth/bootstrap')).session === null, 'signed out')
  expect((await call('GET', '/settings/billing')).status === 200, 'the billing page serves the SPA')
}
