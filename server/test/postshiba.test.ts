import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createInstall, expectError, type Install } from './harness.ts'
import { addContacts, createIssue, drive, sendableInstall } from './sending-setup.ts'
import { postshibaProvider } from '../email/postshiba.ts'
import { parsePostshibaWebhook, type EmailMessage } from '../email/index.ts'
import { hmac, toBytes, toHex } from '../core/crypto.ts'

const message: EmailMessage = { from: '"Weekly News" <hello@mail.example.com>', to: 'reader@example.com', replyTo: 'reply@example.com', subject: 'Hello 🐕', text: 'Hello, world', html: '<p>Hello, world</p>', headers: { 'List-Unsubscribe': '<https://example.com/u/token>' }, meta: { accountId: 'acc_example', deliveryId: '42', kind: 'campaign' }, idempotencyKey: 'acc_example:cmp_1:42' }
const credentials = { postshiba_user: 'smtp_fixture', postshiba_password: 'placeholder-password' }
const accepted = () => Response.json({ success_count: 1, fail_count: 0, failed_recipients: [], errors: [] })
const signingSecret = 'placeholder-signing-secret'

async function hookRequest(now: number, body: unknown, overrides: Record<string, string> = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  const timestamp = String(Math.floor(now / 1000))
  const signature = `sha256=${toHex(await hmac(toBytes(signingSecret), `${timestamp}.${payload}`))}`
  return new Request('http://app.example.com/hooks/postshiba', { method: 'POST', headers: { 'x-capsule-timestamp': timestamp, 'x-capsule-signature': signature, ...overrides }, body: payload })
}

test('PostShiba posts the message to HTTP inject with Basic auth, unique args and the envelope sender', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  const calls: Request[] = []
  ctx.platform.fetch = async (input, init) => { calls.push(new Request(input, init)); return accepted() }
  const result = await postshibaProvider(ctx, credentials).send(message)
  assert.equal(calls[0].url, 'https://inject.postshiba.com/api/inject/v1')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.get('authorization'), `Basic ${Buffer.from('smtp_fixture:placeholder-password').toString('base64')}`)
  const body = await calls[0].json()
  assert.equal(body.envelope_sender, 'hello@mail.example.com')
  assert.deepEqual(body.recipients, [{ email: 'reader@example.com' }])
  assert.equal(body.content.text_body, 'Hello, world')
  assert.equal(body.content.html_body, '<p>Hello, world</p>')
  const headers = body.content.headers
  assert.equal(headers.From, '"Weekly News" <hello@mail.example.com>')
  assert.equal(headers.To, 'reader@example.com')
  assert.equal(headers['Reply-To'], 'reply@example.com')
  assert.match(headers.Subject, /^=\?UTF-8\?B\?/)
  assert.equal(headers['List-Unsubscribe'], '<https://example.com/u/token>')
  assert.deepEqual(JSON.parse(headers['X-Capsule-Unique-Args']), { mc_account: 'acc_example', mc_delivery: '42' })
  assert.match(headers['Message-ID'], /^<[A-Za-z0-9_-]+@mail\.example\.com>$/)
  assert.deepEqual(result, { ok: true, id: headers['Message-ID'] })

  await postshibaProvider(ctx, { ...credentials, postshiba_endpoint: 'https://inject.cluster.example.com/' }).send({ ...message, meta: { ...message.meta, deliveryId: null } })
  assert.equal(calls[1].url, 'https://inject.cluster.example.com/api/inject/v1')
  assert.deepEqual(JSON.parse((await calls[1].json()).content.headers['X-Capsule-Unique-Args']), { mc_account: 'acc_example' })
  const insecure = await postshibaProvider(ctx, { ...credentials, postshiba_endpoint: 'http://inject.cluster.example.com' }).send(message)
  assert.equal(insecure.ok, false)
  assert.equal(calls.length, 2, 'a plain http endpoint never receives the credential')
  const injected = await postshibaProvider(ctx, credentials).send({ ...message, subject: 'Hello\r\nBcc: victim@example.com' })
  assert.deepEqual(injected, { ok: false, kind: 'permanent', message: 'The email contains an invalid header.' })
  assert.equal(calls.length, 2)
})

test('PostShiba classifies refusals, caps and uncertain outcomes without exposing the reply', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  const provider = postshibaProvider(ctx, credentials)
  const reply = (status: number, body: string, headers: Record<string, string> = {}) => { ctx.platform.fetch = async () => new Response(body, { status, headers }) }
  const cases: [number, string, string, number | undefined][] = [
    [401, 'private reply', 'permanent', undefined],
    [429, 'hourly send limit reached', 'throttled', 600_000],
    [429, 'daily send limit reached', 'throttled', 3_600_000],
    [552, '552 5.3.4 message too large', 'permanent', undefined],
    [413, 'private reply', 'permanent', undefined],
    [550, '550 unverified domain', 'permanent', undefined],
    [400, 'private reply', 'permanent', undefined],
    [500, 'private reply', 'temporary', undefined],
    [503, 'private reply', 'temporary', undefined],
    [451, '451 temporary filter delay', 'temporary', undefined],
  ]
  for (const [status, body, kind, retryAfterMs] of cases) {
    reply(status, body)
    const result = await provider.send(message)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.kind, kind, `${status} ${body}`)
    assert.equal(result.retryAfterMs, retryAfterMs, `${status} ${body}`)
    assert.ok(!JSON.stringify(result).includes('private') && !JSON.stringify(result).includes('placeholder-password'))
  }
  reply(429, 'hourly send limit reached', { 'retry-after': '120' })
  assert.equal((await provider.send(message) as { retryAfterMs?: number }).retryAfterMs, 120_000)

  ctx.platform.fetch = async () => Response.json({ success_count: 0, fail_count: 1, failed_recipients: ['reader@example.com'], errors: ['550 firewall: disposable'] })
  assert.deepEqual(await provider.send(message), { ok: false, kind: 'permanent', message: 'The PostShiba email firewall refused the recipient.' })
  ctx.platform.fetch = async () => Response.json({ success_count: 0, fail_count: 1, failed_recipients: [{ email: 'reader@example.com' }], errors: [{ message: 'private reply' }] })
  assert.deepEqual(await provider.send(message), { ok: false, kind: 'permanent', message: 'PostShiba rejected the recipient.' })
  ctx.platform.fetch = async () => Response.json({ success_count: 0, fail_count: 1, failed_recipients: ['reader@example.com'], errors: ['429 hourly send limit reached'] })
  assert.equal((await provider.send(message) as { kind?: string }).kind, 'throttled')

  const unknown = { ok: false, kind: 'unknown', message: 'The email provider did not confirm the outcome.' }
  ctx.platform.fetch = async () => { throw new Error('connection reset with placeholder-password') }
  assert.deepEqual(await provider.send(message), unknown)
  ctx.platform.fetch = async () => { throw new DOMException('The operation timed out.', 'TimeoutError') }
  assert.deepEqual(await provider.send(message), unknown)
  ctx.platform.fetch = async () => new Response('not json')
  assert.deepEqual(await provider.send(message), unknown)
  ctx.platform.fetch = async () => Response.json({})
  assert.deepEqual(await provider.send(message), unknown)
})

const hookEvent = (event: string, extra: Record<string, unknown> = {}) => ({ event, email: 'reader@example.com', timestamp: 1_768_478_400, sg_event_id: `capsule-${event}`, sg_message_id: 'abc@capsule.test', 'smtp-id': '<abc@mail.example.com>', unique_args: { mc_account: 'acc_abcdefghijklmnop', mc_delivery: '12' }, mc_account: 'acc_abcdefghijklmnop', mc_delivery: '12', ...extra })

test('the PostShiba webhook checks the signature and timestamp before it reads the events', async () => {
  const now = Date.UTC(2026, 0, 15, 12)
  const settings = { postshiba_webhook_secret: signingSecret }
  const parse = (request: Request, at = now, config: Record<string, string> = settings) => parsePostshibaWebhook({ now: () => at }, request, config)
  const parsed = await parse(await hookRequest(now, [hookEvent('delivered')]))
  assert.deepEqual(parsed.events, [{ id: 'capsule-delivered', type: 'delivered', accountId: 'acc_abcdefghijklmnop', deliveryId: '12', messageId: '<abc@mail.example.com>', recipient: 'reader@example.com', occurredAt: 1_768_478_400_000 }])
  const rejected = { code: 'invalid_webhook', status: 401 }
  await assert.rejects(parse(await hookRequest(now, [hookEvent('delivered')], { 'x-capsule-signature': `sha256=${'0'.repeat(64)}` })), rejected)
  await assert.rejects(parse(await hookRequest(now, [hookEvent('delivered')], { 'x-capsule-signature': 'sha256=forged' })), rejected)
  await assert.rejects(parse(await hookRequest(now, [hookEvent('delivered')], { 'x-capsule-signature': '' })), rejected)
  await assert.rejects(parse(await hookRequest(now, [hookEvent('delivered')]), now + 301_000), rejected, 'a stale timestamp')
  await assert.rejects(parse(await hookRequest(now + 301_000, [hookEvent('delivered')])), rejected, 'a timestamp from the future')
  await assert.rejects(parse(await hookRequest(now, [hookEvent('delivered')]), now, {}), rejected, 'no secret saved')
  await assert.rejects(parse(await hookRequest(now, [hookEvent('delivered')]), now, { postshiba_webhook_secret: 'another-secret' }), rejected)
  const tampered = await hookRequest(now, [hookEvent('delivered')])
  await assert.rejects(parse(new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: JSON.stringify([hookEvent('bounce')]) })), rejected)
  await assert.rejects(parse(await hookRequest(now, 'not json')), { status: 400 })
  await assert.rejects(parse(await hookRequest(now, { event: 'delivered' })), { status: 400 })
})

test('PostShiba events map to delivered, hard and soft bounces, complaints and deferrals', async () => {
  const now = Date.UTC(2026, 0, 15, 12)
  const parse = async (body: unknown, headers: Record<string, string> = {}) => (await parsePostshibaWebhook({ now: () => now }, await hookRequest(now, body, headers), { postshiba_webhook_secret: signingSecret })).events
  const events = await parse([
    hookEvent('processed'),
    hookEvent('delivered'),
    hookEvent('deferred', { reason: 'Recipient server: try again later' }),
    hookEvent('bounce', { sg_event_id: 'capsule-hard', type: 'bounce', status: '5.1.1', reason: '550 5.1.1 user unknown' }),
    hookEvent('bounce', { sg_event_id: 'capsule-full', type: 'bounce', status: '5.2.2', reason: '552 5.2.2 mailbox full' }),
    hookEvent('bounce', { sg_event_id: 'capsule-blocked', type: 'blocked', status: '5.7.1', reason: '550 5.7.1 refused' }),
    hookEvent('dropped', { reason: 'suppressed' }),
    hookEvent('spamreport'),
    hookEvent('unsubscribe'),
    { event: 'delivered' },
    'junk',
  ])
  assert.deepEqual(events.map((e) => [e.id, e.type]), [['capsule-delivered', 'delivered'], ['capsule-deferred', 'deferred'], ['capsule-hard', 'bounce'], ['capsule-full', 'bounce'], ['capsule-blocked', 'bounce'], ['capsule-dropped', 'bounce'], ['capsule-spamreport', 'complaint']])
  assert.deepEqual(events[2].bounce, { permanent: true, nonexistent: true, reason: 'Permanent bounce' })
  assert.deepEqual(events[3].bounce, { permanent: true, nonexistent: false, reason: 'Permanent bounce' })
  assert.deepEqual(events[4].bounce, { permanent: false, nonexistent: false, reason: 'Blocked by the receiving server' })
  assert.deepEqual(events[5].bounce, { permanent: false, nonexistent: false, reason: 'Dropped by PostShiba: suppressed' })
  assert.deepEqual(await parse([hookEvent('bounce', { test: true, type: 'bounce' })]), [], 'an event marked as a test')
  assert.deepEqual(await parse([hookEvent('bounce', { type: 'bounce' })], { 'x-capsule-test': '1' }), [], 'a request marked as a test')
  const [fallback] = await parse([hookEvent('delivered', { sg_event_id: undefined, unique_args: undefined })])
  assert.match(fallback.id, /^[0-9a-f]{64}$/)
  assert.equal(fallback.accountId, null)
})

async function postshibaInstall() {
  const setup = await sendableInstall()
  await setup.owner.action('install.settings.set', { values: { email_provider: 'postshiba', ...credentials, postshiba_webhook_secret: signingSecret } })
  const sent: { email: string; args: { mc_account: string; mc_delivery?: string }; messageId: string }[] = []
  const state: { reply: (() => Response) | null } = { reply: null }
  setup.install.app.platform.fetch = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.url, 'https://inject.postshiba.com/api/inject/v1')
    if (state.reply) return state.reply()
    const body = await request.json() as { recipients: { email: string }[]; content: { headers: Record<string, string> } }
    sent.push({ email: body.recipients[0].email, args: JSON.parse(body.content.headers['X-Capsule-Unique-Args']), messageId: body.content.headers['Message-ID'] })
    return accepted()
  }
  return { ...setup, sent, state }
}
const batchWake = (ctx: { db: { get<T>(sql: string): T | undefined } }) => ctx.db.get<{ run_at: number }>("SELECT run_at FROM jobs WHERE kind = 'send.batch'")!.run_at
const post = async (install: Install, body: unknown, headers: Record<string, string> = {}) => install.app.edge.fetch(await hookRequest(install.clock.now(), body, headers))

test('a PostShiba send and its webhook update deliveries and contacts through the real route, once per event', async (t) => {
  const { install, owner, nl, ctx, sent } = await postshibaInstall()
  t.after(() => install.close())
  addContacts(ctx, nl.id, 6)
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: issue.id })
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  assert.equal(sent.length, 6)
  const delivery = (email: string) => ctx.db.get<{ id: number; status: string; provider_message_id: string; contact_id: string }>('SELECT id, status, provider_message_id, contact_id FROM deliveries WHERE campaign_id = ? AND email = ?', issue.id, email)!
  const contact = (email: string) => ctx.db.get<{ status: string }>('SELECT status FROM contacts WHERE id = ?', delivery(email).contact_id)!.status
  for (const s of sent) {
    assert.equal(s.args.mc_account, owner.accountId)
    assert.equal(s.args.mc_delivery, String(delivery(s.email).id))
    assert.equal(delivery(s.email).provider_message_id, s.messageId)
  }
  const at = Math.floor(install.clock.now() / 1000)
  const event = (n: number, name: string, extra: Record<string, unknown> = {}) => ({ event: name, email: `reader${n}@example.com`, timestamp: at, sg_event_id: `capsule-${n}-${name}`, 'smtp-id': sent.find((s) => s.email === `reader${n}@example.com`)!.messageId, unique_args: sent.find((s) => s.email === `reader${n}@example.com`)!.args, ...extra })
  const batch = [
    event(0, 'processed'), event(0, 'delivered'),
    event(1, 'bounce', { type: 'bounce', status: '5.1.1', reason: '550 5.1.1 user unknown' }),
    event(2, 'bounce', { type: 'blocked', status: '5.7.1', reason: '550 5.7.1 refused' }),
    event(3, 'dropped', { reason: 'suppressed' }),
    event(4, 'spamreport'),
    event(5, 'deferred'),
  ]

  const forged = await post(install, batch, { 'x-capsule-signature': `sha256=${'0'.repeat(64)}` })
  assert.equal(forged.status, 401)
  const stale = await install.app.edge.fetch(await hookRequest(install.clock.now() - 301_000, batch))
  assert.equal(stale.status, 401)
  const probe = await post(install, [{ ...event(1, 'bounce', { type: 'bounce' }), test: true }], { 'x-capsule-test': '1' })
  assert.equal(probe.status, 200)
  assert.deepEqual(await probe.json(), { ok: true, dropped: 0 })
  assert.deepEqual(['reader0', 'reader1', 'reader4'].map((name) => delivery(`${name}@example.com`).status), ['sent', 'sent', 'sent'], 'nothing changes before a verified event')

  const first = await post(install, batch)
  assert.equal(first.status, 200)
  assert.deepEqual(await first.json(), { ok: true, dropped: 0 })
  const check = async () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => delivery(`reader${n}@example.com`).status), ['delivered', 'bounced', 'sent', 'sent', 'complained', 'sent'])
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => contact(`reader${n}@example.com`)), ['subscribed', 'bounced', 'subscribed', 'subscribed', 'complained', 'subscribed'])
    const { counts } = await owner.action('campaigns.progress', { campaignId: issue.id })
    assert.deepEqual([counts.delivered, counts.bounced, counts.complained, counts.softBounces], [1, 1, 1, 2])
  }
  await check()
  assert.equal((await post(install, batch)).status, 200, 'a retried webhook is acknowledged')
  await check()
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM provider_events')!.n, 6, 'each sg_event_id is stored once')
  const untagged = await post(install, [{ ...event(0, 'delivered'), sg_event_id: 'capsule-untagged', unique_args: undefined }])
  assert.deepEqual(await untagged.json(), { ok: true, dropped: 1 })
  assert.equal((await install.app.edge.fetch(new Request('http://app.example.com/hooks/postshiba'))).status, 405)
})

test('PostShiba settings are validated, stored encrypted and redacted, and the webhook URL is listed', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const missing = await expectError(() => owner.action('install.settings.set', { values: { email_provider: 'postshiba', postshiba_user: 'smtp_fixture' } }))
  assert.equal(missing.code, 'missing_credentials')
  assert.match(missing.message, /PostShiba needs postshiba_password/)
  for (const values of [{ postshiba_endpoint: 'http://inject.postshiba.com' }, { postshiba_endpoint: 'inject.postshiba.com' }, { postshiba_endpoint: 'https://user:pass@inject.postshiba.com' }, { send_rate_per_hour: '-1' }, { send_rate_per_hour: '1.5' }, { send_rate_per_hour: 'many' }, { send_rate_per_hour: '10000001' }]) assert.equal((await expectError(() => owner.action('install.settings.set', { values }))).status, 400, JSON.stringify(values))
  const secrets = { postshiba_password: 'placeholder-password', postshiba_webhook_secret: signingSecret }
  assert.deepEqual(await owner.action('install.settings.set', { values: { email_provider: 'postshiba', postshiba_user: 'smtp_fixture', postshiba_endpoint: 'https://inject.cluster.example.com/', send_rate_per_hour: '90', ...secrets } }), { ok: true })
  const output = await owner.action('install.settings.get', {})
  assert.equal(output.values.email_provider, 'postshiba')
  assert.equal(output.values.postshiba_user, 'smtp_fixture')
  assert.equal(output.values.postshiba_endpoint, 'https://inject.cluster.example.com')
  assert.equal(output.values.send_rate_per_hour, '90')
  assert.deepEqual(output.missing, [])
  assert.equal(output.webhookUrls.postshiba, 'http://app.example.com/hooks/postshiba')
  for (const [key, value] of Object.entries(secrets)) {
    assert.equal(output.secretsSet[key], true)
    assert.equal(output.values[key], undefined)
    assert.ok(!JSON.stringify(output).includes(value))
    const row = install.app.control.ctx.db.get<{ value: string }>('SELECT value FROM install_settings WHERE key = ?', key)
    assert.match(row!.value, /^v1:/)
    assert.ok(!row!.value.includes(value))
  }
  const checklist = await owner.action('setup.checklist', {})
  assert.equal(checklist.items.find((item) => item.id === 'provider')!.detail, 'PostShiba is configured.')
  assert.match(checklist.items.find((item) => item.id === 'webhooks')!.detail, /Waiting for the first event from PostShiba/)
  await owner.action('install.settings.set', { values: { send_rate_per_hour: '' } })
  assert.equal((await owner.action('install.settings.get', {})).values.send_rate_per_hour, '')
})

test('the hourly cap is a rolling window shared by every account', async (t) => {
  const install = await createInstall({ env: { ALLOWED_EMAILS: 'second@example.com', SEND_RATE_PER_SECOND: '1000' } })
  t.after(() => install.close())
  const first = await install.signUp({ email: 'first@example.com' })
  const second = await install.signUp({ email: 'second@example.com' })
  const permits = (accountId: string, want: number) => install.app.stores.control.takeSendPermits({ accountId, want })
  assert.equal((await permits(first.accountId!, 500)).granted, 500, 'no cap by default')
  await first.action('install.settings.set', { values: { send_rate_per_hour: '10' } })
  const start = install.clock.now()
  assert.equal((await permits(first.accountId!, 6)).granted, 6)
  install.clock.advance(20 * 60_000)
  assert.equal((await permits(second.accountId!, 6)).granted, 4, 'the second account gets what is left of the hour')
  const full = await permits(first.accountId!, 6)
  assert.equal(full.granted, 0)
  assert.ok(full.retryAt! > start + 3_600_000 - 1 && full.retryAt! <= start + 3_660_000, 'the caller sleeps until the oldest minute leaves the window')
  install.clock.set(full.retryAt! - 1)
  assert.equal((await permits(first.accountId!, 6)).granted, 0)
  install.clock.set(full.retryAt!)
  assert.equal((await permits(first.accountId!, 10)).granted, 6, 'only the first six have left the window')
  assert.equal((await permits(second.accountId!, 1)).granted, 0)
  await first.action('install.settings.set', { values: { send_rate_per_hour: '0' } })
  assert.equal((await permits(second.accountId!, 50)).granted, 50, '0 removes the cap')
})

test('a campaign over the hourly cap is spread over the following hours instead of failing', async (t) => {
  const { install, owner, nl, ctx, sent } = await postshibaInstall()
  t.after(() => install.close())
  await owner.action('install.settings.set', { values: { send_rate_per_hour: '5' } })
  addContacts(ctx, nl.id, 12)
  const issue = await createIssue(owner, nl.id)
  const start = install.clock.now()
  await owner.action('campaigns.send', { campaignId: issue.id })
  await install.runJobs()
  const counts = async () => (await owner.action('campaigns.progress', { campaignId: issue.id })).counts
  assert.deepEqual([(await counts()).sent, (await counts()).queued, (await counts()).failed], [5, 7, 0])
  assert.equal((await owner.action('campaigns.get', { campaignId: issue.id })).status, 'sending')
  const wake = batchWake(ctx)
  assert.ok(wake >= start + 3_600_000 && wake <= start + 3_660_000 + 1000, 'the batch sleeps until the window has room')
  install.clock.advance(30 * 60_000)
  await install.runJobs()
  assert.equal(sent.length, 5, 'nothing more goes out inside the hour')
  install.clock.set(wake)
  await install.runJobs()
  assert.equal(sent.length, 10)
  const done = await drive(install, owner, issue.id, { stepMs: 10 * 60_000, maxSeconds: 20 })
  assert.equal(done.status, 'sent')
  assert.ok(install.clock.now() >= start + 2 * 3_600_000)
  assert.equal(new Set(sent.map((s) => s.email)).size, 12)
  assert.deepEqual([(await counts()).sent, (await counts()).failed], [12, 0])
  assert.deepEqual(ctx.db.all<{ attempts: number }>('SELECT DISTINCT attempts FROM deliveries WHERE campaign_id = ?', issue.id).map((r) => r.attempts), [1])
})

test('a PostShiba 429 keeps deliveries queued and backs the batch off; a test send reports it', async (t) => {
  const { install, owner, nl, ctx, sent, state } = await postshibaInstall()
  t.after(() => install.close())
  addContacts(ctx, nl.id, 3)
  const issue = await createIssue(owner, nl.id)
  assert.deepEqual(await owner.action('campaigns.sendTest', { campaignId: issue.id, to: ['tester@example.com'] }), { sent: ['tester@example.com'], failed: [] })
  assert.deepEqual(sent[0].args, { mc_account: owner.accountId }, 'a test send carries no delivery id')
  const used = () => ctx.db.get<{ n: number }>('SELECT COALESCE(SUM(emails_sent), 0) AS n FROM usage')!.n
  assert.equal(used(), 1)
  state.reply = () => new Response('hourly send limit reached', { status: 429 })
  assert.deepEqual(await owner.action('campaigns.sendTest', { campaignId: issue.id, to: ['tester@example.com'] }), { sent: [], failed: [{ to: 'tester@example.com', error: 'PostShiba hourly send limit reached. The send resumes when the cluster has room.' }] })
  assert.equal(used(), 1)

  const start = install.clock.now()
  await owner.action('campaigns.send', { campaignId: issue.id })
  await install.runJobs()
  const rows = () => ctx.db.all<{ status: string; attempts: number }>('SELECT status, attempts FROM deliveries WHERE campaign_id = ? ORDER BY id', issue.id).map((r) => ({ status: r.status, attempts: r.attempts }))
  assert.deepEqual(rows(), [{ status: 'queued', attempts: 0 }, { status: 'queued', attempts: 0 }, { status: 'queued', attempts: 0 }], 'the batch stops at the first 429 and no attempt is spent')
  assert.ok(batchWake(ctx) >= start + 8 * 60_000 && batchWake(ctx) <= start + 12 * 60_000, 'the hourly limit backs off for about ten minutes')
  state.reply = () => new Response('daily send limit reached', { status: 429 })
  install.clock.advance(13 * 60_000)
  const retried = install.clock.now()
  await install.runJobs()
  assert.ok(batchWake(ctx) >= retried + 48 * 60_000 && batchWake(ctx) <= retried + 72 * 60_000, 'the daily limit backs off for about an hour')
  assert.deepEqual(rows().map((r) => r.status), ['queued', 'queued', 'queued'])
  state.reply = null
  const done = await drive(install, owner, issue.id, { stepMs: 10 * 60_000, maxSeconds: 12 })
  assert.equal(done.status, 'sent')
  assert.deepEqual(rows(), [{ status: 'sent', attempts: 1 }, { status: 'sent', attempts: 1 }, { status: 'sent', attempts: 1 }])
})

test('the PostShiba provider and webhook use nothing that is missing on Workers', () => {
  for (const file of ['postshiba.ts', 'postshiba-webhook.ts']) {
    const source = fs.readFileSync(new URL(`../email/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from 'node:|require\(|nodemailer|\bBuffer\b|\bprocess\./, file)
    for (const [, specifier] of source.matchAll(/from '([^']+)'/g)) assert.ok(specifier === 'zod' || specifier.startsWith('.'), `${file} imports ${specifier}`)
  }
})
