import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInstall } from './harness.ts'
import { parseSesWebhook, parseResendWebhook, type ProviderEvent } from '../email/index.ts'
import { fromBase64, hmac, toBase64 } from '../core/crypto.ts'
import { setSetting } from '../control/install/index.ts'

const topic = 'arn:aws:sns:us-east-1:123456789012:newsletter-events'
const certUrl = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-fixture.pem'
const settings = { ses_sns_topic_arn: topic }

async function snsFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sns-fixture-'))
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=sns.us-east-1.amazonaws.com'], { stdio: 'ignore', timeout: 10_000 })
    const cert = fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8')
    execFileSync('openssl', ['pkcs8', '-topk8', '-nocrypt', '-in', path.join(dir, 'key.pem'), '-outform', 'DER', '-out', path.join(dir, 'key.der')], { stdio: 'ignore', timeout: 10_000 })
    const key = await crypto.subtle.importKey('pkcs8', fs.readFileSync(path.join(dir, 'key.der')), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    const ownerAccount = 'acc_abcdefghijklmnop'
    const base = { Type: 'Notification', MessageId: 'sns-message-1', Timestamp: '2026-01-15T12:00:00.000Z', TopicArn: topic, SigningCertURL: certUrl, SignatureVersion: '2', Message: JSON.stringify({ eventType: 'Bounce', mail: { messageId: 'ses-message-1', timestamp: '2026-01-15T12:00:00.000Z', tags: { mc_account: [ownerAccount], mc_delivery: ['12'] } }, bounce: { timestamp: '2026-01-15T12:00:01.000Z', bounceType: 'Permanent', bounceSubType: 'NoEmail', bouncedRecipients: [{ emailAddress: 'missing@example.com' }] } }) }
    async function sign(message: Record<string, string>) {
      const fields = message.Type === 'Notification' ? ['Message', 'MessageId', ...(message.Subject ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type'] : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type']
      const canonical = fields.map((name) => `${name}\n${message[name]}\n`).join('')
      return { ...message, Signature: toBase64(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(canonical)))) }
    }
    return { cert, base, sign }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const snsRequest = (body: unknown) => new Request('https://app.example.com/hooks/ses', { method: 'POST', body: JSON.stringify(body) })

test('SNS accepts a certificate-signed event and rejects wrong hosts, topics, signatures and redirects', async (t) => {
  const fixture = await snsFixture()
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  let calls = 0
  ctx.platform.fetch = async (input, init) => {
    calls++
    assert.equal(String(input), certUrl)
    assert.equal(init?.redirect, 'error')
    return new Response(fixture.cert)
  }
  const signed = await fixture.sign(fixture.base)
  const result = await parseSesWebhook(ctx, snsRequest(signed), settings)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].type, 'bounce')
  assert.equal(result.events[0].bounce?.nonexistent, true)
  assert.equal(result.events[0].deliveryId, '12')
  assert.equal(result.events[0].recipient, 'missing@example.com')
  const before = calls
  for (const value of ['https://evil.example.com/cert.pem', 'http://sns.us-east-1.amazonaws.com/cert.pem', 'https://sns.us-east-1.amazonaws.com.evil.example.com/cert.pem', 'https://sns.us-east-1.amazonaws.com/cert.txt', 'https://user@sns.us-east-1.amazonaws.com/cert.pem', 'https://sns.eu-west-1.amazonaws.com/cert.pem']) await assert.rejects(parseSesWebhook(ctx, snsRequest({ ...signed, SigningCertURL: value }), settings), /verification failed/)
  await assert.rejects(parseSesWebhook(ctx, snsRequest({ ...signed, TopicArn: topic + '-other' }), settings), /verification failed/)
  assert.equal(calls, before)
  await assert.rejects(parseSesWebhook(ctx, snsRequest({ ...signed, Message: fixture.base.Message + ' ' }), settings), /verification failed/)
  ctx.platform.fetch = async () => Response.redirect('https://evil.example.com/cert.pem')
  await assert.rejects(parseSesWebhook(ctx, snsRequest(signed), settings), /verification failed/)
})

test('SNS only confirms a signed subscription URL on the same SNS host', async (t) => {
  const fixture = await snsFixture()
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  ctx.platform.fetch = async () => new Response(fixture.cert)
  const base = { ...fixture.base, Type: 'SubscriptionConfirmation', Message: 'Confirm subscription', Token: 'fixture-token', SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=fixture-token' }
  const result = await parseSesWebhook(ctx, snsRequest(await fixture.sign(base)), settings)
  assert.equal(result.confirmUrl, base.SubscribeURL)
  assert.deepEqual(result.events, [])
  await assert.rejects(parseSesWebhook(ctx, snsRequest(await fixture.sign({ ...base, SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription' })), settings), /verification failed/)
})

const resendSecret = toBase64(new TextEncoder().encode('throwaway-test-signing-material'))
async function resendRequest(now: number, body: unknown, overrides: Record<string, string> = {}) {
  const payload = JSON.stringify(body)
  const timestamp = String(Math.floor(now / 1000))
  const signature = toBase64(await hmac(fromBase64(resendSecret), `evt-example.${timestamp}.${payload}`))
  return new Request('http://app.example.com/hooks/resend', { method: 'POST', headers: { 'svix-id': 'evt-example', 'svix-timestamp': timestamp, 'svix-signature': `v1,invalid v1,${signature}`, ...overrides }, body: payload })
}
const resendEvent = { type: 'email.delivered', created_at: '2026-01-15T12:00:00.000Z', data: { email_id: 'email-1', to: ['reader@example.com'], tags: [{ name: 'mc_account', value: 'acc_abcdefghijklmnop' }, { name: 'mc_delivery', value: '12' }] } }

test('Resend verifies the exact body, supports rotated signatures, and rejects old or forged requests', async () => {
  const now = Date.UTC(2026, 0, 15, 12)
  const settings = { resend_webhook_secret: `whsec_${resendSecret}` }
  const parsed = await parseResendWebhook({ now: () => now }, await resendRequest(now, resendEvent), settings)
  assert.equal(parsed.events[0].accountId, 'acc_abcdefghijklmnop')
  assert.equal(parsed.events[0].type, 'delivered')
  await assert.rejects(parseResendWebhook({ now: () => now + 301_000 }, await resendRequest(now, resendEvent), settings), /verification failed/)
  await assert.rejects(parseResendWebhook({ now: () => now }, await resendRequest(now, resendEvent, { 'svix-signature': 'v1,Zm9yZ2Vk' }), settings), /verification failed/)
  await assert.rejects(parseResendWebhook({ now: () => now }, await resendRequest(now + 301_000, resendEvent), settings), /verification failed/)
})

test('the edge verifies, groups events by account, counts dropped events and retries ingestion failures', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  assert.ok(owner.accountId)
  await setSetting(install.app.control.ctx, 'resend_webhook_secret', `whsec_${resendSecret}`)
  const batches: ProviderEvent[][] = []
  const registry = install.app.account(owner.accountId).ctx.registry
  const previous = registry.rpc.get('ingestProviderEvents')
  registry.rpc.set('ingestProviderEvents', (_ctx, { events }: { events: ProviderEvent[] }) => { batches.push(events); return { applied: events.length } })
  t.after(() => { if (previous) registry.rpc.set('ingestProviderEvents', previous); else registry.rpc.delete('ingestProviderEvents') })
  const event = { ...resendEvent, data: { ...resendEvent.data, tags: [{ name: 'mc_account', value: owner.accountId }, { name: 'mc_delivery', value: '42' }] } }
  const request = await resendRequest(install.clock.now(), event)
  const response = await install.app.edge.fetch(request)
  assert.equal(response.status, 200)
  assert.equal(batches[0][0].deliveryId, '42')
  assert.equal(batches.length, 1)
  const forged = await install.app.edge.fetch(await resendRequest(install.clock.now(), event, { 'svix-signature': 'v1,Zm9yZ2Vk' }))
  assert.equal(forged.status, 400)
  assert.equal(batches.length, 1)
  const dropped = await install.app.edge.fetch(await resendRequest(install.clock.now(), { ...resendEvent, data: { ...resendEvent.data, tags: [] } }))
  assert.deepEqual(await dropped.json(), { ok: true, dropped: 1 })
  for (const accountId of ['acc_aaaaaaaaaaaaaaaa', 'not-an-account']) {
    const unknown = { ...event, data: { ...event.data, tags: [{ name: 'mc_account', value: accountId }, { name: 'mc_delivery', value: '42' }] } }
    const response = await install.app.edge.fetch(await resendRequest(install.clock.now(), unknown))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, dropped: 1 })
    assert.deepEqual(install.app.accountIds(), [owner.accountId])
    assert.equal(batches.length, 1)
  }
  registry.rpc.set('ingestProviderEvents', () => { throw new Error('Store unavailable') })
  assert.equal((await install.app.edge.fetch(await resendRequest(install.clock.now(), event))).status, 503)
})

test('the SES edge drops unknown account tags before opening a store and still accepts known accounts', async (t) => {
  const fixture = await snsFixture()
  const install = await createInstall()
  t.after(() => install.close())
  await setSetting(install.app.control.ctx, 'ses_sns_topic_arn', topic)
  install.app.platform.fetch = async () => new Response(fixture.cert)
  const unknown = await install.app.edge.fetch(snsRequest(await fixture.sign(fixture.base)))
  assert.equal(unknown.status, 200)
  assert.deepEqual(await unknown.json(), { ok: true, dropped: 1 })
  assert.deepEqual(install.app.accountIds(), [])
  assert.deepEqual(fs.readdirSync(path.join(install.dataDir, 'accounts')), [])

  const owner = await install.signUp({ email: 'owner@example.com' })
  assert.ok(owner.accountId)
  const registry = install.app.account(owner.accountId).ctx.registry
  const previous = registry.rpc.get('ingestProviderEvents')
  const batches: ProviderEvent[][] = []
  registry.rpc.set('ingestProviderEvents', (_ctx, { events }: { events: ProviderEvent[] }) => { batches.push(events); return { applied: events.length } })
  t.after(() => { if (previous) registry.rpc.set('ingestProviderEvents', previous); else registry.rpc.delete('ingestProviderEvents') })
  const message = fixture.base.Message.replace('acc_abcdefghijklmnop', owner.accountId)
  const known = await install.app.edge.fetch(snsRequest(await fixture.sign({ ...fixture.base, Message: message })))
  assert.equal(known.status, 200)
  assert.deepEqual(await known.json(), { ok: true, dropped: 0 })
  assert.equal(batches[0][0].accountId, owner.accountId)
})
