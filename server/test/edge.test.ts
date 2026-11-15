import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { APP_URL, createInstall, type Client, type Install } from './harness.ts'
import { signEnvelope } from '../core/crypto.ts'

let install: Install
let owner: Client
before(async () => {
  install = await createInstall()
  owner = await install.signUp({ email: 'owner@example.com' })
})
after(() => install.close())

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

test('/healthz answers without a store', async () => {
  const r = await install.fetch('/healthz')
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true })
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
})

test('a forged actor header is stripped at the edge', async () => {
  const forged = await signEnvelope(install.app.keys.session, { actor: { userId: 'x', email: 'x@example.com', owner: true, grants: {}, access: 'full', via: 'web', installAdmin: true }, aud: owner.accountId, exp: install.clock.now() + 60_000 })
  const r = await install.fetch('/api/actions/newsletters.list', { ...json({}), headers: { 'content-type': 'application/json', 'x-mc-actor': forged, 'x-mc-account': owner.accountId! } })
  assert.equal(r.status, 401)
})

test('a store rejects an envelope for another audience or an expired one', async () => {
  const store = install.app.account(owner.accountId!)
  const actor = { userId: 'x', email: 'x@example.com', owner: true, grants: {}, access: 'full', via: 'web', installAdmin: false }
  const wrongAud = await signEnvelope(install.app.keys.session, { actor, aud: 'control', exp: install.clock.now() + 60_000 })
  const expired = await signEnvelope(install.app.keys.session, { actor, aud: owner.accountId, exp: install.clock.now() - 1 })
  for (const envelope of [wrongAud, expired, 'garbage']) {
    const r = await store.fetch(new Request(APP_URL + '/api/actions/newsletters.list', { ...json({}), headers: { 'content-type': 'application/json', 'x-mc-actor': envelope } }))
    assert.equal(r.status, 401)
    assert.equal((await r.json()).code, 'bad_envelope')
  }
})

test('a state-changing request with a session needs the CSRF header', async () => {
  const r = await owner.fetch('/api/actions/newsletters.create', { ...json({ name: 'No csrf' }), csrf: false })
  assert.equal(r.status, 403)
  assert.equal((await r.json()).code, 'csrf')
  const ok = await owner.fetch('/api/actions/newsletters.list', json({}))
  assert.equal(ok.status, 200)
})

test('API keys route by the account id in the key; a bad key is refused', async () => {
  const none = await install.fetch('/api/v1/newsletters')
  assert.equal(none.status, 401)
  const routed = await install.fetch('/api/v1/newsletters', { headers: { authorization: `Bearer mc_${owner.accountId}_${'a'.repeat(32)}` } })
  assert.equal(routed.status, 401, 'the account store rejects a secret that does not match a key')
  assert.equal((await routed.json()).error.code, 'unauthorized')
  const malformed = await install.fetch('/mcp', { method: 'POST', headers: { authorization: 'Bearer nonsense' } })
  assert.equal(malformed.status, 401)
})

test('public tokens route by their account prefix', async () => {
  const routed = await install.fetch(`/u/${owner.accountId}.u.payload.sig`)
  assert.equal(routed.status, 404)
  assert.equal((await routed.json()).code, 'not_found')
  const bad = await install.fetch('/u/garbage')
  assert.equal(bad.status, 404)
  const key = (await owner.action('newsletters.create', { name: 'Routed' })).key
  const form = await install.fetch(`/f/${key}`)
  assert.equal(form.status, 200)
  assert.match(await form.text(), /name="email"/)
  assert.equal((await install.fetch('/f/nl_bad')).status, 404)
})

test('a request on an unknown host is a 404, a known slug reaches the account', async () => {
  const r = await install.fetch('https://nobody.example.net/')
  assert.equal(r.status, 404)
  const nl = await owner.action('newsletters.create', { name: 'Sited', slug: 'sited' })
  await install.runJobs()
  const site = await install.app.stores.control.lookupSite({ slug: 'sited' })
  assert.equal(site?.newsletter_id, nl.id)
  const page = await install.fetch('/n/sited')
  assert.equal(page.status, 404, 'the website module is not built yet')
  assert.equal((await install.fetch('/n/unknown-slug')).status, 404)
})

test('the TLS check answers for the app host and verified custom hosts only', async () => {
  assert.equal((await install.fetch('/api/public/tls-check?domain=app.example.com')).status, 200)
  assert.equal((await install.fetch('/api/public/tls-check?domain=news.example.net')).status, 404)
  install.app.control.ctx.db.run("INSERT INTO sites (newsletter_id, account_id, slug, custom_host, host_verified_at) VALUES ('nl_x', ?, 'hosted', 'news.example.net', 1)", owner.accountId)
  install.clock.advance(61_000)
  assert.equal((await install.fetch('/api/public/tls-check?domain=news.example.net')).status, 200, 'the edge caches site lookups for 60 s')
  assert.equal((await install.fetch('/api/public/tls-check')).status, 404)
})

test('images come from blobs with long cache headers', async () => {
  await install.app.platform.blobs.put(`${owner.accountId}/logo.png`, new Uint8Array([1, 2, 3]), 'image/png')
  const r = await install.fetch(`/img/${owner.accountId}/logo.png`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'image/png')
  assert.match(r.headers.get('cache-control') ?? '', /immutable/)
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), new Uint8Array([1, 2, 3]))
  assert.equal((await install.fetch(`/img/${owner.accountId}/missing.png`)).status, 404)
  assert.equal((await install.fetch(`/img/${owner.accountId}/../secret.key`)).status, 404)
})

test('unknown API paths are JSON 404s and everything else falls through to assets', async () => {
  const api = await install.fetch('/api/nothing')
  assert.equal(api.status, 404)
  assert.equal((await api.json()).code, 'not_found')
  const page = await install.fetch('/campaigns')
  assert.equal(page.status, 404, 'the harness serves no web build')
})
