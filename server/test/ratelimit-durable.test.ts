/**
 * Rate limits that guard authentication and emails to strangers must hold across a Durable Object
 * restart (eviction, deploy, memory pressure) and across key churn. Each case counts what one
 * client is admitted in total when the store restarts partway through its attempts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APP_URL, createInstall, type Client, type Install, type InstallOptions } from './harness.ts'
import { createIssue, sendableInstall } from './sending-setup.ts'

const PEER = '203.0.113.9'
const json = (install: Install, path: string, body: unknown, peer = PEER) =>
  install.app.edge.fetch(new Request(APP_URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), peer)

/** A wrong 6-digit code: the right one plus one. */
const wrongCode = (right: string) => String((Number(right) + 1) % 1_000_000).padStart(6, '0')

interface Run {
  install: Install
  /** Returns true when the attempt was admitted (not 429). Receives the current install, which changes on restart. */
  attempt(install: Install, i: number): Promise<boolean>
  restartAfter: number
  cap?: number
}

/** Attempts until the first refusal, restarting the install once. Returns how many were admitted. */
async function admitted(run: Run): Promise<{ n: number; install: Install }> {
  let { install } = run
  let n = 0
  for (let i = 0; i < (run.cap ?? 200); i++) {
    if (i === run.restartAfter) install = await install.restart()
    if (!(await run.attempt(install, i))) break
    n++
  }
  return { n, install }
}

async function fresh(opts: InstallOptions = {}) {
  const install = await createInstall(opts)
  const owner = await install.signUp({ email: 'owner@example.com' })
  return { install, owner }
}

test('password sign-in per email: at most 10 wrong passwords in 15 minutes, restart included', async (t) => {
  const { install } = await fresh()
  const result = await admitted({ install, restartAfter: 7, attempt: async (i) => (await json(i, '/api/auth/signin', { email: 'owner@example.com', password: 'wrong password here' })).status !== 429 })
  t.after(() => result.install.close())
  t.diagnostic(`sign-in per email admitted ${result.n} across a restart`)
  assert.ok(result.n <= 11, `admitted ${result.n}, expected at most 11`)
})

test('password sign-in per IP: at most 30 attempts in 15 minutes, restart included', async (t) => {
  const { install } = await fresh()
  const result = await admitted({ install, restartAfter: 20, attempt: async (i, k) => (await json(i, '/api/auth/signin', { email: `guess${k}@example.com`, password: 'wrong password here' })).status !== 429 })
  t.after(() => result.install.close())
  t.diagnostic(`sign-in per IP admitted ${result.n} across a restart`)
  assert.ok(result.n <= 35, `admitted ${result.n}, expected at most 35`)
})

test('key churn cannot reset a counter: ten thousand other clients do not forgive earlier attempts', async (t) => {
  const { install } = await fresh()
  t.after(() => install.close())
  const wrong = () => json(install, '/api/auth/signin', { email: 'owner@example.com', password: 'wrong password here' })
  for (let i = 0; i < 8; i++) assert.equal((await wrong()).status, 401)
  // Each of these touches two fresh keys, which pushes the earlier ones out of the in-memory map.
  for (let i = 0; i < 10_001; i++) await json(install, '/api/auth/signin', { email: `other${i}@example.com`, password: 'wrong password here' }, `11.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`)
  let more = 0
  for (let i = 0; i < 20; i++) {
    if ((await wrong()).status === 429) break
    more++
  }
  t.diagnostic(`after churn, ${more} more attempts were admitted on the same email`)
  assert.ok(8 + more <= 11, `admitted ${8 + more} in total, expected at most 11`)
})

test('sign-in codes: five wrong guesses spoil a code even across a restart', async (t) => {
  let { install } = await fresh({ cloud: true })
  t.after(() => install.close())
  assert.equal((await json(install, '/api/auth/code', { email: 'owner@example.com' })).status, 200)
  const right = install.lastCode('owner@example.com')
  const guess = (code: string) => json(install, '/api/auth/signin/code', { email: 'owner@example.com', code })
  for (let i = 0; i < 3; i++) assert.equal((await guess(wrongCode(right))).status, 400)
  install = await install.restart()
  for (let i = 0; i < 2; i++) assert.equal((await guess(wrongCode(right))).status, 400)
  assert.equal((await guess(right)).status, 400, 'the right code must be refused after five wrong guesses')
})

test('sign-up codes: five wrong guesses spoil a code even across a restart', async (t) => {
  let install = await createInstall({ cloud: true })
  t.after(() => install.close())
  assert.equal((await json(install, '/api/auth/signup', { name: 'New', email: 'new@example.com', password: 'correct horse battery' })).status, 200)
  const right = install.lastCode('new@example.com')
  const guess = (code: string) => json(install, '/api/auth/signup/verify', { email: 'new@example.com', code })
  for (let i = 0; i < 3; i++) assert.equal((await guess(wrongCode(right))).status, 400)
  install = await install.restart()
  for (let i = 0; i < 2; i++) assert.equal((await guess(wrongCode(right))).status, 400)
  assert.equal((await guess(right)).status, 400)
})

test('password reset codes: five wrong guesses spoil a code even across a restart', async (t) => {
  let { install } = await fresh()
  t.after(() => install.close())
  assert.equal((await json(install, '/api/auth/reset', { email: 'owner@example.com' })).status, 200)
  const right = install.lastCode('owner@example.com')
  const guess = (code: string) => json(install, '/api/auth/reset/confirm', { email: 'owner@example.com', code, password: 'another long password' })
  for (let i = 0; i < 3; i++) assert.equal((await guess(wrongCode(right))).status, 400)
  install = await install.restart()
  for (let i = 0; i < 2; i++) assert.equal((await guess(wrongCode(right))).status, 400)
  assert.equal((await guess(right)).status, 400)
})

test('team invitations per address: at most 5 emails a day to one stranger, restart included', async (t) => {
  const { install, owner } = await fresh()
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  let client: Client = owner
  let app = install.app
  const result = await admitted({ install, restartAfter: 3, attempt: async (i) => {
    if (i.app !== app) { app = i.app; client = await i.clientFromCookie(owner.cookie) }
    const response = await client.actionRaw('team.invite', { accountId: owner.accountId, newsletterId: nl.id, email: 'friend@example.com', role: 'member' })
    if (response.status === 429) return false
    const invite = await response.json()
    await client.action('team.revoke', { accountId: owner.accountId!, newsletterId: nl.id, inviteId: invite.id })
    return true
  } })
  t.after(() => result.install.close())
  t.diagnostic(`invitations to one address admitted ${result.n} across a restart`)
  assert.ok(result.n <= 5, `admitted ${result.n}, expected at most 5`)
})

test('public subscribe per IP: at most 20 posts an hour, restart included', async (t) => {
  const { install, owner } = await fresh()
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const result = await admitted({ install, restartAfter: 12, attempt: async (i) => (await json(i, `/api/public/subscribe/${nl.key}`, { email: 'reader@example.com' })).status !== 429 })
  t.after(() => result.install.close())
  t.diagnostic(`subscribe per IP admitted ${result.n} across a restart`)
  assert.ok(result.n <= 24, `admitted ${result.n}, expected at most 24`)
})

async function formToken(install: Install, key: string) {
  const response = await install.fetch(`/api/public/subscribe/${key}`)
  assert.equal(response.status, 200)
  const config: { formToken: string } = await response.json()
  install.clock.advance(2001)
  return config.formToken
}

test('public subscribe per target address: at most 10 signups an hour land for one address, restart included', async (t) => {
  const { install, owner } = await fresh()
  const keys: { id: string; key: string }[] = []
  for (let i = 0; i < 14; i++) {
    const nl = await owner.action('newsletters.create', { name: `List ${i}` })
    const base = await owner.action('signup.get', { newsletterId: nl.id })
    await owner.action('signup.update', { newsletterId: nl.id, settings: base.settings, doubleOptIn: false })
    keys.push({ id: nl.id, key: nl.key })
  }
  let client: Client = owner
  let app = install.app
  const result = await admitted({ install, restartAfter: 6, cap: 14, attempt: async (i, k) => {
    if (i.app !== app) { app = i.app; client = await i.clientFromCookie(owner.cookie) }
    // Spread over IPs so only the per-address limit applies.
    const response = await json(i, `/api/public/subscribe/${keys[k].key}`, { email: 'target@example.com', formToken: await formToken(i, keys[k].key) }, `203.0.113.${k + 1}`)
    assert.equal(response.status, 200)
    return (await client.action('contacts.list', { newsletterId: keys[k].id, limit: 10 })).contacts.length === 1
  } })
  t.after(() => result.install.close())
  t.diagnostic(`signups for one address admitted ${result.n} across a restart`)
  assert.ok(result.n <= 11, `admitted ${result.n}, expected at most 11`)
})

test('confirmation emails per address: at most 3 a day, restart included', async (t) => {
  const first = await fresh()
  const { owner } = first
  let { install } = first
  t.after(() => install.close())
  const nl = await owner.action('newsletters.create', { name: 'Weekly' })
  const confirmations = () => install.outbox(owner.accountId!).filter((m) => m.to_email === 'reader@example.com' && m.subject.startsWith('Confirm')).length
  const post = async (k: number) => assert.equal((await json(install, `/api/public/subscribe/${nl.key}`, { email: 'reader@example.com', formToken: await formToken(install, nl.key) }, `203.0.113.${k + 1}`)).status, 200)
  for (let i = 0; i < 2; i++) await post(i)
  assert.equal(confirmations(), 2)
  install = await install.restart()
  for (let i = 2; i < 6; i++) await post(i)
  t.diagnostic(`confirmation emails sent across a restart: ${confirmations()}`)
  assert.ok(confirmations() <= 3, `sent ${confirmations()} confirmations, expected at most 3`)
})

test('password re-authentication per user: at most 10 wrong passwords in 15 minutes, restart included', async (t) => {
  const { install, owner } = await fresh()
  let client: Client = owner
  let app = install.app
  const result = await admitted({ install, restartAfter: 6, attempt: async (i) => {
    if (i.app !== app) { app = i.app; client = await i.clientFromCookie(owner.cookie) }
    return (await client.actionRaw('account.changePassword', { currentPassword: 'not the password', newPassword: 'another long password' })).status !== 429
  } })
  t.after(() => result.install.close())
  t.diagnostic(`re-authentication admitted ${result.n} across a restart`)
  assert.ok(result.n <= 11, `admitted ${result.n}, expected at most 11`)
})

test('email change codes per user: at most 3 an hour, restart included', async (t) => {
  const { install, owner } = await fresh()
  let client: Client = owner
  let app = install.app
  const result = await admitted({ install, restartAfter: 2, attempt: async (i, k) => {
    if (i.app !== app) { app = i.app; client = await i.clientFromCookie(owner.cookie) }
    return (await client.actionRaw('account.requestEmailChange', { email: `new${k}@example.com`, currentPassword: 'correct horse battery' })).status !== 429
  } })
  t.after(() => result.install.close())
  t.diagnostic(`email change codes admitted ${result.n} across a restart`)
  assert.ok(result.n <= 3, `admitted ${result.n}, expected at most 3`)
})

test('test emails per campaign: at most 10 an hour, restart included', async (t) => {
  const { install, owner, nl } = await sendableInstall()
  const issue = await createIssue(owner, nl.id)
  let client: Client = owner
  let app = install.app
  const result = await admitted({ install, restartAfter: 6, attempt: async (i) => {
    if (i.app !== app) { app = i.app; client = await i.clientFromCookie(owner.cookie) }
    return (await client.actionRaw('campaigns.sendTest', { campaignId: issue.id, to: ['stranger@example.com'] })).status !== 429
  } })
  t.after(() => result.install.close())
  t.diagnostic(`test emails admitted ${result.n} across a restart`)
  assert.ok(result.n <= 11, `admitted ${result.n}, expected at most 11`)
})
