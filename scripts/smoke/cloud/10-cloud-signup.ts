import type { SmokeContext } from '../../smoke-context.ts'
import { Jar, call } from '../../smoke-context.ts'

/** Sign up through the emailed code; the code comes from the dev-only route that reads the test outbox. */
export async function cloudSignup(base: string, jar: Jar, email: string, name: string) {
  const expect = (ok: unknown, message: string) => { if (!ok) throw new Error(`smoke: ${message}`) }
  const pending = await call(base, jar, 'POST', '/api/auth/signup', { name, email, password: 'cloud test password' })
  expect(pending.status === 200 && (await pending.json()).pending === true, `cloud sign-up for ${email} asks for a code`)
  const code = await (await fetch(`${base}/api/dev/code?email=${encodeURIComponent(email)}`)).json()
  expect(/^\d{6}$/.test(code.code), 'the dev route hands out the emailed code')
  const verified = await call(base, jar, 'POST', '/api/auth/signup/verify', { email, code: code.code })
  expect(verified.status === 200, `the code verifies (${verified.status})`)
  const boot = await (await call(base, jar, 'GET', '/api/auth/bootstrap')).json()
  expect(boot.session?.user?.email === email && boot.session.current, `${email} has a session and an account`)
  jar.csrf = boot.session.csrf
  return boot.session as { current: string; user: { id: string; isInstallAdmin: boolean } }
}

export default async function step({ base, jar, json, action, expect, state }: SmokeContext) {
  const boot = await json('GET', '/api/auth/bootstrap')
  expect(boot.setupRequired === false && boot.session === null, 'a cloud install has open sign-up and no first-run setup')
  expect((await fetch(`${base}/api/dev/code?email=nobody@example.com`)).status === 404, 'no code before anyone signs up')
  const admin = await cloudSignup(base, jar, 'smoke@example.com', 'Cloud Admin')
  expect(admin.user.isInstallAdmin === true, 'ADMIN_EMAILS makes the first user an install admin')
  const newsletter = await action('newsletters.create', { name: 'Cloud Weekly' })
  state.set('newsletter', newsletter)
  const second = new Jar()
  const session = await cloudSignup(base, second, 'second@example.com', 'Second Owner')
  expect(session.user.isInstallAdmin === false && session.current !== admin.current, 'the second account is a separate, ordinary account')
  state.set('second', { jar: second, accountId: session.current })
  const listed = await action('admin.accounts', {})
  expect(listed.some((a: { id: string; plan: string }) => a.id === session.current && a.plan === 'free'), 'the admin console lists the second account on the free plan')
}
