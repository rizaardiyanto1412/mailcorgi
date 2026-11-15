import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Install } from './harness.ts'

const post = (install: Install, path: string, body: unknown) => install.fetch(`/api/auth/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const cookieOf = (response: Response) => response.headers.getSetCookie().map((s) => s.split(';')[0]).join('; ')

test('first-run setup still works with no email provider and makes the install admin', async (t) => {
  const install = await createInstall({ env: { ADMIN_EMAILS: 'boss@example.com' } })
  t.after(() => install.close())
  const response = await post(install, 'setup', { name: 'First', email: 'first@example.com', password: 'first password' })
  assert.equal(response.status, 200)
  const first = await install.clientFromCookie(cookieOf(response))
  assert.equal(first.session.user.isInstallAdmin, true)
  assert.equal(install.outbox().length, 0)
})

test('self-hosted: an ADMIN_EMAILS address must prove it owns the address before it gets a session or admin rights', async (t) => {
  const install = await createInstall({ env: { ADMIN_EMAILS: 'boss@example.com' } })
  t.after(() => install.close())
  await install.signUp({ email: 'first@example.com' })

  const squatter = await post(install, 'signup', { name: 'Squatter', email: 'boss@example.com', password: 'squatter password' })
  assert.equal(squatter.status, 200)
  assert.equal((await squatter.json()).pending, true)
  assert.equal(squatter.headers.getSetCookie().some((c) => c.startsWith('mc_session=')), false)
  assert.equal((await expectError(() => install.signIn('boss@example.com', 'squatter password'))).code, 'unverified')

  // The real owner reads the code from their inbox; the squatter's pending password dies with it.
  const owner = await post(install, 'signup', { name: 'Boss', email: 'boss@example.com', password: 'boss password' })
  assert.equal((await owner.json()).pending, true)
  const verified = await post(install, 'signup/verify', { email: 'boss@example.com', code: install.lastCode('boss@example.com') })
  assert.equal(verified.status, 200)
  const boss = await install.clientFromCookie(cookieOf(verified))
  assert.equal(boss.session.user.isInstallAdmin, true)
  assert.equal((await expectError(() => install.signIn('boss@example.com', 'squatter password'))).status, 401)
})

test('self-hosted: an allowlisted address signs up with an emailed code; an invite link is proof enough', async (t) => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'friend@example.com' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const pending = await post(install, 'signup', { name: 'Friend', email: 'friend@example.com', password: 'friend password' })
  assert.equal((await pending.json()).pending, true)
  assert.equal(pending.headers.getSetCookie().some((c) => c.startsWith('mc_session=')), false)
  assert.equal((await post(install, 'signup/verify', { email: 'friend@example.com', code: install.lastCode('friend@example.com') })).status, 200)

  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  await owner.action('team.invite', { accountId: owner.accountId!, newsletterId: nl.id, email: 'guest@example.com', role: 'member' })
  const mail = install.outbox().filter((m) => m.to_email === 'guest@example.com').at(-1)!
  const token = decodeURIComponent(/\/invite\?token=([^\s]+)/.exec(mail.text)![1])
  const invited = await post(install, 'signup', { name: 'Guest', email: 'guest@example.com', password: 'guest password', inviteToken: token })
  assert.equal(invited.status, 200)
  assert.equal((await invited.json()).pending, false)
  assert.equal((await install.clientFromCookie(cookieOf(invited))).session.user.isInstallAdmin, false)
})

test('cloud: an ADMIN_EMAILS user with a pending sign-up is not an install admin until the code is entered', async (t) => {
  const install = await createInstall({ cloud: true, env: { ADMIN_EMAILS: 'boss@example.com' } })
  t.after(() => install.close())
  await post(install, 'signup', { name: 'Boss', email: 'boss@example.com', password: 'boss password' })
  const row = install.app.control.ctx.db.get<{ is_install_admin: number; email_verified_at: number | null }>('SELECT is_install_admin, email_verified_at FROM users WHERE email = ?', 'boss@example.com')!
  assert.equal(row.is_install_admin, 0)
  assert.equal(row.email_verified_at, null)
  const verified = await post(install, 'signup/verify', { email: 'boss@example.com', code: install.lastCode('boss@example.com') })
  assert.equal((await install.clientFromCookie(cookieOf(verified))).session.user.isInstallAdmin, true)
})
