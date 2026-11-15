import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall } from './harness.ts'
import { sesProvider } from '../email/ses.ts'
import { resendProvider } from '../email/resend.ts'
import { smtpProvider } from '../email/smtp.ts'
import { buildMime } from '../email/mime.ts'
import type { EmailMessage } from '../email/index.ts'

const message: EmailMessage = { from: 'Sender <sender@example.com>', to: 'reader@example.com', replyTo: 'reply@example.com', subject: 'Hello 🐕 — 世界', text: 'Hello, world\nSecond line', html: '<p>Hello, world</p>', headers: { 'List-Unsubscribe': '<https://example.com/u/token>' }, meta: { accountId: 'acc_example', deliveryId: '42', kind: 'campaign' }, idempotencyKey: 'delivery-42' }

test('MIME carries both alternatives, Unicode headers and routing headers without allowing injection', () => {
  const mime = buildMime(message)
  assert.match(mime, /Subject: =\?UTF-8\?B\?[^\r\n]+\?=/)
  assert.match(mime, /multipart\/alternative;\s+boundary=/)
  assert.match(mime, /Content-Type: text\/plain; charset=UTF-8/)
  assert.match(mime, /Content-Type: text\/html; charset=UTF-8/)
  assert.match(mime, /X-MC-Account: acc_example/)
  assert.match(mime, /X-MC-Delivery: 42/)
  assert.ok(mime.includes(Buffer.from('Hello, world\r\nSecond line').toString('base64')))
  assert.throws(() => buildMime({ ...message, subject: 'Hello\r\nBcc: victim@example.com' }), /Invalid email header/)
  assert.throws(() => buildMime({ ...message, headers: { Bcc: 'victim@example.com' } }), /Invalid email header/)
  assert.doesNotMatch(buildMime({ ...message, meta: { ...message.meta, deliveryId: null }, headers: { 'x-mc-account': 'forged', 'x-mc-delivery': 'forged' } }), /forged/)
  assert.ok(buildMime({ ...message, subject: '世界'.repeat(100) }).split('\r\n').every((line) => line.length <= 998))
})

test('SES signs raw MIME sends and identity requests, including tags and configuration set', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  const calls: Request[] = []
  ctx.platform.fetch = async (input, init) => {
    const request = new Request(input, init)
    calls.push(request.clone())
    if (request.url.endsWith('outbound-emails')) return Response.json({ MessageId: 'ses-message-1' })
    return Response.json({ VerifiedForSendingStatus: true, DkimAttributes: { Status: 'SUCCESS', Tokens: ['token1', 'token2', 'token3'] } })
  }
  const provider = sesProvider(ctx, { ses_region: 'us-east-1', ses_access_key_id: 'fixture-access', ses_secret_access_key: 'fixture-secret', ses_configuration_set: 'newsletter-events' })
  assert.deepEqual(await provider.send(message), { ok: true, id: 'ses-message-1' })
  const send = calls[0]
  assert.match(send.headers.get('authorization')!, /^AWS4-HMAC-SHA256 Credential=fixture-access\/.*\/us-east-1\/ses\/aws4_request/)
  assert.ok(send.headers.has('x-amz-date'))
  const body = await send.json()
  assert.equal(body.ConfigurationSetName, 'newsletter-events')
  assert.deepEqual(body.EmailTags, [{ Name: 'mc_account', Value: 'acc_example' }, { Name: 'mc_delivery', Value: '42' }])
  assert.match(Buffer.from(body.Content.Raw.Data, 'base64').toString(), /List-Unsubscribe:/)
  const identity = await provider.createIdentity!('example.com')
  assert.equal(identity.status, 'verified')
  assert.equal(identity.records.length, 5)
  assert.match(identity.records[3].value, /feedback-smtp.us-east-1/)
  assert.equal(calls[1].method, 'POST')
  assert.equal((await calls[1].json()).DkimSigningAttributes.NextSigningKeyLength, 'RSA_2048_BIT')
  assert.equal(calls[2].method, 'PUT')
  assert.equal((await calls[2].json()).BehaviorOnMxFailure, 'REJECT_MESSAGE')
  await provider.deleteIdentity!('example.com')
  assert.equal(calls.at(-1)?.method, 'DELETE')
})

test('Resend sends routing tags, headers and idempotency key and supports domain identities', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  const calls: Request[] = []
  ctx.platform.fetch = async (input, init) => {
    const request = new Request(input, init)
    calls.push(request.clone())
    if (request.url.endsWith('/emails')) return Response.json({ id: 'resend-message-1' })
    if (new URL(request.url).pathname === '/domains' && request.method === 'GET') return Response.json({ data: [{ id: 'domain-1', name: 'example.com' }] })
    return Response.json({ id: 'domain-1', name: 'example.com', status: 'verified', records: [{ name: 'resend._domainkey', type: 'TXT', value: 'p=fixture', record: 'DKIM' }, { name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, record: 'SPF' }] })
  }
  const provider = resendProvider(ctx, { resend_api_key: 'fixture-key' })
  assert.deepEqual(await provider.send(message), { ok: true, id: 'resend-message-1' })
  assert.equal(calls[0].headers.get('idempotency-key'), message.idempotencyKey)
  const body = await calls[0].json()
  assert.equal(body.headers['X-MC-Delivery'], '42')
  assert.equal(body.tags[0].value, 'acc_example')
  const identity = await provider.createIdentity!('example.com')
  assert.equal(identity.records[0].name, 'resend._domainkey.example.com')
  assert.equal(identity.records[1].value, '10 feedback-smtp.us-east-1.amazonses.com')
  assert.equal((await provider.getIdentity!('example.com')).status, 'verified')
  await provider.deleteIdentity!('example.com')
  assert.equal(calls.at(-1)?.method, 'DELETE')
})

for (const name of ['ses', 'resend'] as const) test(`${name} classifies refusals and uncertain outcomes without exposing response bodies`, async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  const provider = name === 'ses' ? sesProvider(ctx, { ses_access_key_id: 'fixture', ses_secret_access_key: 'fixture' }) : resendProvider(ctx, { resend_api_key: 'fixture' })
  for (const [status, kind] of [[400, 'permanent'], [401, 'permanent'], [408, 'unknown'], [429, 'throttled'], [500, 'temporary'], [503, 'temporary']] as const) {
    ctx.platform.fetch = async () => new Response('credential and email body must stay private', { status, headers: { 'retry-after': '3' } })
    const result = await provider.send(message)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.equal(result.kind, kind)
    assert.equal(result.retryAfterMs, 3000)
    assert.ok(!JSON.stringify(result).includes('private'))
  }
  ctx.platform.fetch = async () => { throw new Error('credential-containing connection error') }
  assert.deepEqual(await provider.send(message), { ok: false, kind: 'unknown', message: 'The email provider did not confirm the outcome.' })
  ctx.platform.fetch = async () => Response.json({})
  assert.equal((await provider.send(message)).ok, false)
})

test('SMTP reports its Node requirement on Workers', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } })
  try {
    const result = await smtpProvider(install.app.control.ctx, {}).send(message)
    assert.equal(result.ok, false)
    if (!result.ok) { assert.equal(result.kind, 'permanent'); assert.match(result.message, /SMTP needs the Node build/) }
  }
  finally { if (original) Object.defineProperty(globalThis, 'navigator', original); else Reflect.deleteProperty(globalThis, 'navigator') }
})

test('SMTP sends the MIME message to a local server and maps a definite rejection', async (t) => {
  const { createServer } = await import('node:net')
  const install = await createInstall()
  t.after(() => install.close())
  let received = ''
  let reject = false
  const server = createServer((socket) => {
    socket.write('220 localhost ESMTP\r\n')
    let buffer = ''
    let data = false
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      while (buffer.includes('\r\n')) {
        const at = buffer.indexOf('\r\n')
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        if (data) {
          if (line === '.') { data = false; socket.write('250 queued as fixture-message\r\n') }
          else received += line + '\r\n'
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250 localhost\r\n')
        else if (/^MAIL FROM|^RCPT TO/.test(line)) socket.write(reject ? '550 mailbox rejected\r\n' : '250 OK\r\n')
        else if (line === 'DATA') { data = true; socket.write('354 End with dot\r\n') }
        else if (line === 'QUIT') { socket.end('221 bye\r\n') }
        else socket.write('250 OK\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const provider = smtpProvider(install.app.control.ctx, { smtp_host: '127.0.0.1', smtp_port: String(address.port), smtp_security: 'none' })
  assert.equal((await provider.send(message)).ok, true)
  assert.match(received, /Subject: =\?UTF-8\?B\?/) 
  assert.match(received, /X-MC-Delivery: 42/)
  assert.match(received, /Reply-To: reply@example.com/)
  reject = true
  const result = await provider.send(message)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.kind, 'permanent')
})
