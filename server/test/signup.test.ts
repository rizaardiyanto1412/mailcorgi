import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall, expectError, type Install } from './harness.ts'
import { runAction, type Actor } from '../core/actions.ts'
import { AppError } from '../core/http.ts'
import { suppress } from '../account/contacts/index.ts'
import { token } from '../account/signup/tokens.ts'

async function form(install: Install, key: string) {
  const response = await install.fetch(`/api/public/subscribe/${key}`)
  assert.equal(response.status, 200)
  const config: { formToken: string } = await response.json()
  install.clock.advance(2001)
  return config.formToken
}
async function signup(install: Install, key: string, email = 'reader@example.com', extra: Record<string, unknown> = {}, ip = '192.0.2.1') {
  return install.fetch(`/api/public/subscribe/${key}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify({ email, name: 'Reader', formToken: await form(install, key), ...extra }) })
}
function confirmLink(install: Install, account: string, email = 'reader@example.com') {
  const mail = install.outbox(account).filter((m) => m.to_email === email && m.subject.startsWith('Confirm')).at(-1)
  assert.ok(mail)
  const match = /http:\/\/app\.example\.com\/confirm\/[^\s<>"\]]+/.exec(mail.text)
  assert.ok(match, mail.text)
  return match[0]
}
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello {{first_name|friend}}, welcome aboard.' }] }] } as const

for (const cloud of [false, true]) test(`signup confirms once and sends a themed welcome (${cloud ? 'cloud' : 'self-hosted'})`, async () => {
  const install = await createInstall({ cloud })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const account = owner.accountId!
    await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome reader', doc: JSON.parse(JSON.stringify(doc)), revision: null })
    const response = await signup(install, nl.key)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.deepEqual(await response.json(), { ok: true, message: 'Thanks! Check your inbox for the next step.', redirectUrl: null })
    const pending = await owner.action('contacts.list', { newsletterId: nl.id })
    assert.equal(pending.contacts[0].status, 'unconfirmed')
    const link = confirmLink(install, account)
    assert.equal((await install.fetch(link)).status, 200)
    assert.equal((await owner.action('contacts.list', { newsletterId: nl.id })).contacts[0].status, 'subscribed')
    assert.equal(install.outbox(account).length, 2)
    assert.match(install.outbox(account)[1].text, /Hello Reader/)
    assert.equal(install.outbox(account)[1].kind, 'system')
    assert.equal((await install.fetch(link)).status, 200)
    await install.runJobs()
    assert.equal(install.outbox(account).length, 2)
    const same = await signup(install, nl.key)
    assert.deepEqual(await same.json(), { ok: true, message: 'Thanks! Check your inbox for the next step.', redirectUrl: null })
    await owner.action('contacts.unsubscribe', { newsletterId: nl.id, contactId: pending.contacts[0].id })
    await install.fetch(link)
    assert.equal((await owner.action('contacts.list', { newsletterId: nl.id })).contacts[0].status, 'unsubscribed', 'consumed links cannot resubscribe')
  } finally { install.close() }
})

test('single opt-in, form encoding, theme, custom fields and welcome off', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const base = await owner.action('signup.get', { newsletterId: nl.id })
    await owner.action('signup.update', { newsletterId: nl.id, settings: { ...base.settings, buttonLabel: 'Join us', successMessage: 'You are all set.', redirectUrl: 'https://example.com/thanks' }, doubleOptIn: false })
    await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Hello', doc: JSON.parse(JSON.stringify(doc)), revision: null })
    const hosted = await (await install.fetch(`/f/${nl.key}`)).text()
    assert.match(hosted, /Join us/)
    const params = new URLSearchParams({ email: 'reader@example.com', formToken: await form(install, nl.key) })
    const response = await install.fetch(base.apiUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), 'https://example.com/thanks')
    assert.equal((await owner.action('contacts.list', { newsletterId: nl.id })).contacts[0].status, 'subscribed')
    assert.equal(install.outbox(owner.accountId!).length, 1)
    await signup(install, nl.key)
    assert.equal(install.outbox(owner.accountId!).length, 1)
    const welcome = (await owner.action('signup.get', { newsletterId: nl.id })).welcome!
    await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: false, subject: 'Hello', doc: welcome.doc, revision: welcome.revision })
    await signup(install, nl.key, 'other@example.com')
    assert.equal(install.outbox(owner.accountId!).length, 1)
  } finally { install.close() }
})

test('suppressed reader confirms for only one newsletter; account suppression stays', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const a = await owner.action('newsletters.create', { name: 'Alpha' })
    const b = await owner.action('newsletters.create', { name: 'Bravo' })
    for (const nl of [a, b]) {
      const c = await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com' })
      await owner.action('contacts.unsubscribe', { newsletterId: nl.id, contactId: c.contact.id })
    }
    await signup(install, a.key)
    const link = confirmLink(install, owner.accountId!)
    await install.fetch(link)
    assert.equal((await owner.action('contacts.list', { newsletterId: a.id })).contacts[0].status, 'subscribed')
    assert.equal((await owner.action('contacts.list', { newsletterId: b.id })).contacts[0].status, 'unsubscribed')
    suppress(install.app.account(owner.accountId!).ctx, { email: 'reader@example.com', newsletterId: null, reason: 'hard_bounce' })
    const before = install.outbox(owner.accountId!).length
    await signup(install, b.key)
    assert.equal(install.outbox(owner.accountId!).length, before)
    assert.equal((await owner.action('contacts.list', { newsletterId: b.id })).contacts[0].status, 'unsubscribed')
  } finally { install.close() }
})

test('abuse limits: fourth confirmation is silent; twenty-first IP attempt is refused', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    for (let i = 0; i < 4; i++) assert.equal((await signup(install, nl.key)).status, 200)
    assert.equal(install.outbox(owner.accountId!).length, 3)
    for (let i = 0; i < 20; i++) assert.equal((await signup(install, nl.key, `r${i}@example.com`, {}, '192.0.2.2')).status, 200)
    const limited = await signup(install, nl.key, 'another@example.com', {}, '192.0.2.2')
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('access-control-allow-origin'), '*')
    install.clock.advance(86_400_000)
    await signup(install, nl.key)
    assert.equal(install.outbox(owner.accountId!).filter((m) => m.to_email === 'reader@example.com').length, 4)
  } finally { install.close() }
})

test('honeypot, signed minimum fill time, token purposes, expiry and deleted contacts', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    assert.equal((await signup(install, nl.key, 'bot@example.com', { website: 'spam' })).status, 200)
    assert.equal(install.outbox(owner.accountId!).length, 0)
    const config = await (await install.fetch(`/api/public/subscribe/${nl.key}`)).json()
    const post = (formToken: string) => install.fetch(`/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'reader@example.com', formToken }) })
    assert.equal((await post(config.formToken)).status, 400)
    install.clock.advance(2001)
    assert.equal((await post(config.formToken + 'x')).status, 400)
    await signup(install, nl.key)
    const link = confirmLink(install, owner.accountId!)
    assert.equal((await install.fetch(link.replace('.cf.', '.u.'))).status, 400)
    install.clock.advance(7 * 86_400_000 + 1)
    assert.equal((await install.fetch(link)).status, 400)
    await signup(install, nl.key)
    const newLink = confirmLink(install, owner.accountId!)
    const contact = (await owner.action('contacts.list', { newsletterId: nl.id })).contacts[0]
    await owner.action('contacts.delete', { newsletterId: nl.id, contactId: contact.id })
    assert.equal((await install.fetch(newLink)).status, 400)
    assert.equal((await post(config.formToken)).status, 400)
  } finally { install.close() }
})

test('redirect tricks and cross-newsletter settings are rejected through actions and HTTP', async () => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'other@example.com' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const settings = (await owner.action('signup.get', { newsletterId: nl.id })).settings
    for (const redirectUrl of ['javascript:alert(1)', '//example.com', '/\\example.com', ' https://example.com', 'https://user:pass@example.com', 'https:\\example.com']) {
      assert.equal((await expectError(() => owner.action('signup.update', { newsletterId: nl.id, settings: { ...settings, redirectUrl }, doubleOptIn: true }))).status, 400, redirectUrl)
      assert.equal((await signup(install, nl.key, 'reader@example.com', { redirectUrl })).status, 400, redirectUrl)
    }
    const other = await install.signUp({ email: 'other@example.com' })
    assert.equal((await expectError(() => other.action('signup.get', { newsletterId: nl.id }))).status, 404)
    const actor: Actor = { userId: 'member', email: 'member@example.com', owner: false, grants: { [nl.id]: 'member' }, access: 'full', via: 'web', installAdmin: false }
    await assert.rejects(runAction(install.app.account(owner.accountId!).ctx, 'signup.update', { newsletterId: nl.id, settings, doubleOptIn: false }, actor), (e: unknown) => e instanceof AppError && e.status === 403)
    const preflight = await install.fetch(`/api/public/subscribe/${nl.key}`, { method: 'OPTIONS', headers: { origin: 'https://example.com' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
    const ctx = install.app.account(owner.accountId!).ctx
    assert.equal((await install.fetch(`/confirm/${await token(ctx, 'form', { newsletterId: nl.id, issuedAt: ctx.now() })}`)).status, 400)
  } finally { install.close() }
})

test('Turnstile fails closed without network access', async () => {
  const install = await createInstall({ env: { TURNSTILE_SITE_KEY: 'test-site', TURNSTILE_SECRET_KEY: 'test-secret' } })
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    assert.equal((await signup(install, nl.key)).status, 400)
    assert.equal(install.outbox(owner.accountId!).length, 0)
    const hosted = await install.fetch(`/f/${nl.key}`)
    assert.match(hosted.headers.get('content-security-policy') ?? '', /challenges.cloudflare.com/)
    assert.match(await hosted.text(), /data-sitekey="test-site"/)
  } finally { install.close() }
})

test('selected typed custom fields are rendered, validated and stored; welcome revision conflicts', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    for (const f of [{ key: 'city', label: 'City', type: 'text' }, { key: 'age', label: 'Age', type: 'number' }, { key: 'hidden', label: 'Private', type: 'text' }]) {
      await owner.actionRaw('contactFields.create', { newsletterId: nl.id, ...f })
    }
    const settings = (await owner.action('signup.get', { newsletterId: nl.id })).settings
    await owner.action('signup.update', { newsletterId: nl.id, settings: { ...settings, fieldKeys: ['city', 'age'], showName: false }, doubleOptIn: false })
    const hosted = await (await install.fetch(`/f/${nl.key}`)).text()
    assert.match(hosted, /name="field.city"/)
    assert.doesNotMatch(hosted, /name="name"|name="field.hidden"/)
    const response = await signup(install, nl.key, 'reader@example.com', { fields: { city: 'Test city', age: 25, hidden: 'ignored' } })
    assert.equal(response.status, 200)
    const contact = (await owner.action('contacts.list', { newsletterId: nl.id })).contacts[0]
    assert.equal(contact.name, '')
    assert.deepEqual(contact.fields, { city: 'Test city', age: 25 })
    assert.equal((await signup(install, nl.key, 'other@example.com', { fields: { age: 'bad' } })).status, 400)
    assert.equal((await signup(install, nl.key, 'form@example.com', {}, '192.0.2.2')).status, 200)
    const first = await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Hello', doc: JSON.parse(JSON.stringify(doc)), revision: null })
    assert.equal(first.welcome?.kind, 'welcome')
    assert.equal((await expectError(() => owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Stale', doc: first.welcome!.doc, revision: null }))).status, 409)
    assert.equal((await owner.action('signup.get', { newsletterId: nl.id })).welcome?.subject, 'Hello')
  } finally { install.close() }
})

test('provider retries use one stable system idempotency key and recover without a campaign delivery', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    await owner.action('install.settings.set', { values: { email_provider: 'resend', resend_api_key: 'fixture-key', email_from: 'sender@example.com' } })
    const ctx = install.app.account(owner.accountId!).ctx
    const calls: Request[] = []
    ctx.platform.fetch = async (input, init) => {
      const request = new Request(input, init)
      assert.equal(request.url, 'https://api.resend.com/emails')
      calls.push(request)
      if (calls.length === 1) return new Response('', { status: 429 })
      return Response.json({ id: 'fixture-message' })
    }
    assert.equal((await signup(install, nl.key)).status, 200)
    await owner.action('newsletters.update', { newsletterId: nl.id, name: 'Changed while waiting' })
    await install.runJobs()
    assert.equal(calls.length, 2)
    assert.equal(await calls[0].clone().text(), await calls[1].clone().text())
    assert.equal(calls[0].headers.get('idempotency-key'), calls[1].headers.get('idempotency-key'))
    const sent = await calls[1].json()
    assert.deepEqual(sent.tags, [{ name: 'mc_account', value: owner.accountId }])
    assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries')!.n, 0)
    await install.runJobs()
    assert.equal(calls.length, 2)
  } finally { install.close() }
})

test('an uncertain non-idempotent provider send is not retried', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    await owner.action('install.settings.set', { values: { email_provider: 'ses', ses_region: 'us-east-1', ses_access_key_id: 'fixture-access', ses_secret_access_key: 'fixture-secret', email_from: 'sender@example.com' } })
    const ctx = install.app.account(owner.accountId!).ctx
    let calls = 0
    ctx.platform.fetch = async () => { calls++; throw new Error('Fixture connection dropped after acceptance.') }
    assert.equal((await signup(install, nl.key)).status, 200)
    assert.equal(calls, 1)
    await install.runJobs()
    install.clock.advance(600_001)
    await install.runJobs()
    assert.equal(calls, 1)
    assert.equal(ctx.db.get<{ state: string }>('SELECT state FROM signup_mail')?.state, 'unknown')
  } finally { install.close() }
})

test('an unsubscribe during provider preparation stops the pending welcome', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    const settings = (await owner.action('signup.get', { newsletterId: nl.id })).settings
    await owner.action('signup.update', { newsletterId: nl.id, settings, doubleOptIn: false })
    await owner.action('signup.saveWelcome', { newsletterId: nl.id, enabled: true, subject: 'Welcome', doc: JSON.parse(JSON.stringify(doc)), revision: null })
    const ctx = install.app.account(owner.accountId!).ctx
    ctx.stores = { ...ctx.stores, control: new Proxy(ctx.stores.control, {
      get(target, key, receiver) {
        if (key !== 'getInstallSettings') return Reflect.get(target, key, receiver)
        return async (input: { keys: string[] }) => {
          const contacts = await owner.action('contacts.list', { newsletterId: nl.id })
          if (contacts.contacts[0]?.status === 'subscribed') await owner.action('contacts.unsubscribe', { newsletterId: nl.id, contactId: contacts.contacts[0].id })
          return target.getInstallSettings(input)
        }
      },
    }) }
    assert.equal((await signup(install, nl.key)).status, 200)
    assert.equal(install.outbox(owner.accountId!).length, 0)
    assert.equal((await owner.action('contacts.list', { newsletterId: nl.id })).contacts[0].status, 'unsubscribed')
    await install.runJobs()
    assert.equal(install.outbox(owner.accountId!).length, 0)
  } finally { install.close() }
})

test('a provider change does not resend a pending attempt through a different provider', async () => {
  const install = await createInstall()
  try {
    const owner = await install.signUp({ email: 'owner@example.com' })
    const nl = await owner.action('newsletters.create', { name: 'Weekly' })
    await owner.action('install.settings.set', { values: { email_provider: 'resend', resend_api_key: 'fixture-key', email_from: 'sender@example.com' } })
    const ctx = install.app.account(owner.accountId!).ctx
    ctx.platform.fetch = async () => new Response('', { status: 429 })
    assert.equal((await signup(install, nl.key)).status, 200)
    await owner.action('install.settings.set', { values: { email_provider: 'test' } })
    await install.runJobs()
    assert.equal(install.outbox(owner.accountId!).length, 0)
    assert.equal(ctx.db.get<{ state: string }>('SELECT state FROM signup_mail')?.state, 'unknown')
  } finally { install.close() }
})
