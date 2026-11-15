import { test, after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Install } from './harness.ts'

describe('self-hosted', () => {
  let install: Install
  before(async () => {
    install = await createInstall({ env: { ALLOWED_EMAILS: 'friend@example.com' } })
  })
  after(() => install.close())

  test('the first visitor sets up the install admin and gets an account', async () => {
    const boot = await (await install.fetch('/api/auth/bootstrap')).json()
    assert.equal(boot.setupRequired, true)
    const admin = await install.signUp({ email: 'Admin@Example.com', name: 'Admin' })
    assert.equal(admin.session.user.email, 'admin@example.com')
    assert.equal(admin.session.user.isInstallAdmin, true)
    assert.equal(admin.session.accounts.length, 1)
    assert.equal(admin.session.accounts[0].owner, true)
    assert.equal((await (await install.fetch('/api/auth/bootstrap')).json()).setupRequired, false)
    const again = await install.fetch('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', name: 'x', password: 'password123' }) })
    assert.equal(again.status, 409)
  })

  test('only allowed emails can sign up; others are refused', async () => {
    const closed = await install.fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'stranger@example.com', name: 'S', password: 'password123' }) })
    assert.equal(closed.status, 403)
    const friend = await install.signUp({ email: 'friend@example.com' })
    assert.equal(friend.session.user.isInstallAdmin, false)
    assert.equal(friend.session.accounts.length, 1)
  })

  test('sign in checks the password and sign out ends the session', async () => {
    assert.equal((await expectError(() => install.signIn('admin@example.com', 'wrong password'))).status, 401)
    const admin = await install.signIn('admin@example.com', 'correct horse battery')
    assert.equal(admin.session.user.email, 'admin@example.com')
    await admin.post('/api/auth/signout')
    const boot = await admin.get('/api/auth/bootstrap')
    assert.equal(boot.session, null)
    assert.equal((await admin.actionRaw('newsletters.list', {})).status, 401)
  })

  test('a password reset emails a code and replaces the password', async () => {
    await install.fetch('/api/auth/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com' }) })
    const code = install.lastCode('admin@example.com')
    const bad = await install.fetch('/api/auth/reset/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', code: '000000', password: 'new password 1' }) })
    assert.equal(bad.status, 400)
    const ok = await install.fetch('/api/auth/reset/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', code, password: 'new password 1' }) })
    assert.equal(ok.status, 200)
    assert.equal((await expectError(() => install.signIn('admin@example.com', 'correct horse battery'))).status, 401)
    await install.signIn('admin@example.com', 'new password 1')
  })

  test('sessions can be listed and revoked', async () => {
    const a = await install.signIn('admin@example.com', 'new password 1')
    const b = await install.signIn('admin@example.com', 'new password 1')
    const list = await a.get<{ sessions: { id: string; current: boolean }[] }>('/api/auth/sessions')
    assert.ok(list.sessions.length >= 2)
    const other = list.sessions.find((s) => !s.current)!
    await a.post('/api/auth/sessions/revoke', { id: other.id })
    const after = await a.get<{ sessions: { id: string }[] }>('/api/auth/sessions')
    assert.ok(!after.sessions.some((s) => s.id === other.id))
    void b
  })

  test('sessions expire with the clock', async () => {
    const a = await install.signIn('admin@example.com', 'new password 1')
    install.clock.advance(31 * 86_400_000)
    assert.equal((await a.actionRaw('newsletters.list', {})).status, 401)
  })
})

describe('cloud', () => {
  let install: Install
  before(async () => {
    install = await createInstall({ cloud: true, env: { ADMIN_EMAILS: 'root@example.com' } })
  })
  after(() => install.close())

  test('there is no setup step and sign-up needs the emailed code', async () => {
    const boot = await (await install.fetch('/api/auth/bootstrap')).json()
    assert.equal(boot.setupRequired, false)
    assert.equal(boot.cloud, true)
    const pending = await install.fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'one@example.com', name: 'One', password: 'password123' }) })
    assert.deepEqual(await pending.json(), { ok: true, pending: true })
    assert.equal(pending.headers.getSetCookie().length, 0, 'no session before the code')
    const wrong = await install.fetch('/api/auth/signup/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'one@example.com', code: '123456' }) })
    assert.equal(wrong.status, 400)
    const signin = await install.fetch('/api/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'one@example.com', password: 'password123' }) })
    assert.equal(signin.status, 403, 'unverified users cannot sign in')
    const code = install.lastCode('one@example.com')
    const ok = await install.fetch('/api/auth/signup/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'one@example.com', code }) })
    assert.equal(ok.status, 200)
    assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith('mc_session=')))
  })

  test('each sign-up gets its own account store and cannot see another account', async () => {
    const one = await install.signIn('one@example.com', 'password123')
    const two = await install.signUp({ email: 'two@example.com' })
    assert.notEqual(one.accountId, two.accountId)
    const theirs = await one.action('newsletters.create', { name: 'Ones' })
    await install.runJobs()
    assert.equal((await expectError(() => two.action('newsletters.get', { newsletterId: theirs.id }))).status, 404)
    assert.deepEqual((await two.action('newsletters.list', {})).newsletters, [])
    const taken = await expectError(() => two.action('newsletters.create', { name: 'Ones' }))
    assert.equal(taken.code, 'slug_taken', 'public slugs are unique across accounts')
  })

  test('a sign-in code works as a password alternative', async () => {
    await install.fetch('/api/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'two@example.com' }) })
    const code = install.lastCode('two@example.com')
    const ok = await install.fetch('/api/auth/signin/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'two@example.com', code }) })
    assert.equal(ok.status, 200)
  })

  test('ADMIN_EMAILS makes an install admin', async () => {
    const root = await install.signUp({ email: 'root@example.com' })
    assert.equal(root.session.user.isInstallAdmin, true)
  })

  test('too many attempts are rate limited', async () => {
    let status = 0
    for (let i = 0; i < 12; i++) {
      const r = await install.fetch('/api/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'limited@example.com', password: 'nope nope nope' }) })
      status = r.status
    }
    assert.equal(status, 429)
  })
})
