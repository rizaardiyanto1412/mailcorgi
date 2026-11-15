import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Install } from './harness.ts'

const post = (install: Install, path: string, body: unknown) => install.fetch(`/api/auth/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const signup = { email: 'owner@example.com', name: 'Owner', password: 'owner password' }

test('concurrent first-run requests create only one install administrator', async () => {
  const install = await createInstall()
  try {
    const results = await Promise.all([
      post(install, 'setup', signup),
      post(install, 'setup', { ...signup, email: 'other@example.com' }),
    ])
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
    assert.equal((await results.find((r) => r.status === 409)!.json()).code, 'setup_done')
    const client = await install.clientFromCookie(results.find((r) => r.ok)!.headers.getSetCookie()[0].split(';')[0])
    assert.equal(client.session.accounts.length, 1)
    assert.equal(client.session.user.isInstallAdmin, true)
  } finally { install.close() }
})

test('a concurrent pending signup cannot replace the password being verified', async () => {
  const install = await createInstall({ cloud: true })
  try {
    await post(install, 'signup', signup)
    const code = install.lastCode(signup.email)
    const [verified, submitted] = await Promise.all([
      post(install, 'signup/verify', { email: signup.email, code }),
      post(install, 'signup', { ...signup, password: 'attacker password' }),
    ])
    assert.equal(verified.status, 200)
    assert.ok([200, 409].includes(submitted.status))
    const owner = await install.signIn(signup.email, signup.password)
    assert.equal(owner.session.accounts.length, 1)
    assert.equal((await expectError(() => install.signIn(signup.email, 'attacker password'))).status, 401)
  } finally { install.close() }
})

test('concurrent reset confirmations consume a code only once', async () => {
  const install = await createInstall()
  try {
    await install.signUp(signup)
    await post(install, 'reset', { email: signup.email })
    const code = install.lastCode(signup.email)
    const results = await Promise.all(['new password one', 'new password two'].map((password) =>
      post(install, 'reset/confirm', { email: signup.email, code, password })))
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400])
    const password = results[0].ok ? 'new password one' : 'new password two'
    await install.signIn(signup.email, password)
  } finally { install.close() }
})

test('pending cloud users cannot verify through concurrent password resets', async () => {
  const install = await createInstall({ cloud: true })
  try {
    await post(install, 'signup', signup)
    const messages = install.outbox().length
    const responses = await Promise.all([
      post(install, 'reset', { email: signup.email }),
      post(install, 'reset', { email: 'missing@example.com' }),
    ])
    for (const response of responses) {
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { ok: true })
    }
    assert.equal(install.outbox().length, messages)
    assert.equal((await post(install, 'reset/confirm', { email: signup.email, code: install.lastCode(signup.email), password: 'reset password' })).status, 400)
    assert.equal((await post(install, 'signup/verify', { email: signup.email, code: install.lastCode(signup.email) })).status, 200)
    const owner = await install.signIn(signup.email, signup.password)
    assert.equal(owner.session.accounts.length, 1)
    assert.ok(owner.session.current)
    assert.deepEqual((await owner.action('newsletters.list', {})).newsletters, [])
  } finally { install.close() }
})

for (const purpose of ['signup', 'signin'] as const) {
  test(`concurrent ${purpose} confirmations consume a code only once`, async () => {
    const install = await createInstall({ cloud: true })
    try {
      if (purpose === 'signup') await post(install, 'signup', signup)
      else {
        await install.signUp(signup)
        await post(install, 'code', { email: signup.email })
      }
      const code = install.lastCode(signup.email)
      const path = purpose === 'signup' ? 'signup/verify' : 'signin/code'
      const results = await Promise.all([1, 2].map(() => post(install, path, { email: signup.email, code })))
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 400])
      const owner = await install.signIn(signup.email, signup.password)
      assert.equal(owner.session.accounts.length, 1)
    } finally { install.close() }
  })
}

test('concurrent wrong codes exhaust the attempt limit', async () => {
  const install = await createInstall({ cloud: true })
  try {
    await install.signUp(signup)
    await post(install, 'code', { email: signup.email })
    const code = install.lastCode(signup.email)
    const wrong = code === '000000' ? '000001' : '000000'
    const responses = await Promise.all(Array.from({ length: 5 }, () => post(install, 'signin/code', { email: signup.email, code: wrong })))
    assert.ok(responses.every((r) => r.status === 400))
    assert.equal((await post(install, 'signin/code', { email: signup.email, code })).status, 400)
  } finally { install.close() }
})

test('a replaced signup code cannot activate another submission password', async () => {
  const install = await createInstall({ cloud: true })
  try {
    await post(install, 'signup', { ...signup, password: 'earlier password' })
    const earlier = install.lastCode(signup.email)
    await post(install, 'signup', signup)
    const current = install.lastCode(signup.email)
    if (earlier !== current) assert.equal((await post(install, 'signup/verify', { email: signup.email, code: earlier })).status, 400)
    assert.equal((await post(install, 'signup/verify', { email: signup.email, code: current })).status, 200)
    await install.signIn(signup.email, signup.password)
    assert.equal((await expectError(() => install.signIn(signup.email, 'earlier password'))).status, 401)
  } finally { install.close() }
})
