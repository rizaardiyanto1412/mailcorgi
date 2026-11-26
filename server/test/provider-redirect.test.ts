import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createInstall } from './harness.ts'
import { postshibaProvider } from '../email/postshiba.ts'
import { resendProvider } from '../email/resend.ts'
import { sesProvider } from '../email/ses.ts'
import { smtpProvider } from '../email/smtp.ts'
import { failedSend, isRedirect, logSendFailure, noRedirect } from '../email/http.ts'
import type { EmailMessage, EmailProvider } from '../email/index.ts'
import type { StoreCtx } from '../core/store.ts'

const message: EmailMessage = { from: '"Weekly News" <hello@mail.example.com>', to: 'reader@example.com', subject: 'Hello', text: 'Hello, world', html: '<p>Hello, world</p>', headers: {}, meta: { accountId: 'acc_example', deliveryId: '42', kind: 'campaign' }, idempotencyKey: 'acc_example:cmp_1:42' }
const postshiba = { postshiba_user: 'smtp_fixture', postshiba_password: 'placeholder-password' }
/** What a log line must never carry: each provider's own credential, and the addresses of the message. */
const addresses = ['reader@example.com', 'hello@mail.example.com']
const credentials: Record<string, string[]> = { postshiba: ['placeholder-password', 'smtp_fixture'], resend: ['placeholder-api-key'], ses: ['placeholder-secret-key', 'PLACEHOLDERKEYID'], smtp: ['placeholder-password', 'smtp_fixture'] }

/** The exact refusal of the Workers runtime, which Node's fetch does not have. */
const WORKERS_ERROR = 'Invalid redirect value, must be one of "follow" or "manual" ("error" won\'t be implemented since it does not make sense at the edge; use "manual" and check the response status code).'
function workersFetch(reply: () => Response, seen: { url: string; redirect: unknown }[] = []) {
  const fetcher: StoreCtx['platform']['fetch'] = async (input, init) => {
    const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : undefined)
    if (redirect === 'error') throw new TypeError(WORKERS_ERROR)
    seen.push({ url: input instanceof Request ? input.url : String(input), redirect })
    return reply()
  }
  return { fetcher, seen }
}

/** Collects what a block writes with console.error. */
async function captureErrors<T>(run: () => Promise<T> | T): Promise<{ result: T; lines: string[] }> {
  const original = console.error
  const lines: string[] = []
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')) }
  try { return { result: await run(), lines } } finally { console.error = original }
}
const logged = (line: string) => JSON.parse(line.slice('email provider failed '.length)) as Record<string, unknown>

const providers: [string, (ctx: StoreCtx) => EmailProvider, () => Response][] = [
  ['postshiba', (ctx) => postshibaProvider(ctx, postshiba), () => Response.json({ success_count: 1, fail_count: 0 })],
  ['resend', (ctx) => resendProvider(ctx, { resend_api_key: 'placeholder-api-key' }), () => Response.json({ id: 'email-1' })],
  ['ses', (ctx) => sesProvider(ctx, { ses_access_key_id: 'PLACEHOLDERKEYID', ses_secret_access_key: 'placeholder-secret-key' }), () => Response.json({ MessageId: 'ses-1' })],
]

for (const [name, make, accepted] of providers) test(`${name} sends on a runtime that refuses the error redirect mode, and never follows a redirect`, async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  const { fetcher, seen } = workersFetch(accepted)
  ctx.platform.fetch = fetcher
  const { result, lines } = await captureErrors(() => make(ctx).send(message))
  assert.equal(result.ok, true, lines.join('\n'))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].redirect, 'manual')
  assert.deepEqual(lines, [])

  for (const redirect of [() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } }), () => new Response(null, { status: 307, headers: { location: 'https://evil.example.com/' } }), () => Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' })]) {
    const calls = workersFetch(redirect)
    ctx.platform.fetch = calls.fetcher
    const refused = await captureErrors(() => make(ctx).send(message))
    assert.equal(refused.result.ok, false)
    if (refused.result.ok) continue
    assert.equal(refused.result.kind, 'permanent')
    assert.match(refused.result.message, /^The email provider answered with a redirect\. /)
    if (name === 'postshiba') assert.match(refused.result.message, /postshiba_endpoint/)
    assert.equal(calls.seen.length, 1, 'the redirect target is never requested')
    assert.equal(refused.lines.length, 1)
    assert.equal(logged(refused.lines[0]).provider, name)
    assert.equal(logged(refused.lines[0]).stage, 'redirect')
  }
})

test('an empty or blank PostShiba endpoint falls back to the default host, and a set one is trimmed', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  const { fetcher, seen } = workersFetch(() => Response.json({ success_count: 1, fail_count: 0 }))
  ctx.platform.fetch = fetcher
  for (const postshiba_endpoint of ['', ' ', ' \t ']) assert.equal((await postshibaProvider(ctx, { ...postshiba, postshiba_endpoint }).send(message)).ok, true)
  assert.equal((await postshibaProvider(ctx, { ...postshiba, postshiba_endpoint: '  https://inject.cluster.example.com/ ' }).send(message)).ok, true)
  assert.deepEqual(seen.map((call) => call.url), [...Array<string>(3).fill('https://inject.postshiba.com/api/inject/v1'), 'https://inject.cluster.example.com/api/inject/v1'])
})

test('a failed send logs the provider, stage and status, and no credential or address', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const ctx = install.app.control.ctx
  const unknown = { ok: false, kind: 'unknown', message: 'The email provider did not confirm the outcome.' }
  const leak = (name: string) => `Authorization: Basic c210cF9maXh0dXJlOnBsYWNlaG9sZGVy Bearer opaque-bearer-token https://someone:something-private@inject.postshiba.com to <reader@example.com> from hello@mail.example.com with ${credentials[name].join(' and ')}`
  const stages = (leaky: string): [string, StoreCtx['platform']['fetch'], Record<string, unknown>][] => [
    ['fetch', async () => { throw new TypeError(leaky) }, { stage: 'fetch', error: 'TypeError' }],
    ['workers', async () => { throw new TypeError(WORKERS_ERROR) }, { stage: 'fetch', error: 'TypeError', message: WORKERS_ERROR.slice(0, 200) }],
    ['timeout', async () => { throw new DOMException('The operation timed out.', 'TimeoutError') }, { stage: 'timeout', error: 'TimeoutError' }],
    ['abort', async () => { throw new DOMException('This operation was aborted', 'AbortError') }, { stage: 'timeout', error: 'AbortError' }],
    ['parse', async () => new Response(`not json ${leaky}`), { stage: 'parse', status: 200 }],
    ['shape', async () => Response.json({ unexpected: leaky }), { stage: 'parse', status: 200 }],
    ['status', async () => new Response(`refused ${leaky} ${'x'.repeat(500)}`, { status: 401 }), { stage: 'status', status: 401 }],
  ]
  for (const [name, make] of providers) for (const [label, fetcher, expected] of stages(leak(name))) {
    ctx.platform.fetch = fetcher
    const { result, lines } = await captureErrors(() => make(ctx).send(message))
    assert.equal(result.ok, false)
    if (expected.stage !== 'status') assert.deepEqual(result, unknown, `${name} ${label}`)
    assert.equal(lines.length, 1, `${name} ${label}`)
    assert.match(lines[0], /^email provider failed \{/)
    assert.ok(!lines[0].includes('\n'))
    const line = logged(lines[0])
    assert.deepEqual({ ...line, provider: name, ...expected }, line, `${name} ${label}`)
    assert.equal(line.provider, name)
    for (const secret of [...credentials[name], ...addresses, 'c210cF9maXh0dXJlOnBsYWNlaG9sZGVy', 'opaque-bearer-token', 'something-private']) assert.ok(!lines[0].includes(secret), `${name} ${label} logs ${secret}`)
    assert.ok(!lines[0].includes('Hello, world'))
    for (const key of ['message', 'body'] as const) assert.ok(typeof line[key] !== 'string' || line[key].length <= 200)
    assert.equal('body' in line, expected.stage === 'status', 'the reply is only quoted for a non-OK status')
    if (expected.stage === 'status') assert.match(String(line.body), /^refused /)
  }

  const invalid = await captureErrors(() => postshibaProvider(ctx, postshiba).send({ ...message, subject: 'Hello\r\nBcc: victim@example.com' }))
  assert.deepEqual(invalid.result, { ok: false, kind: 'permanent', message: 'The email contains an invalid header.' })
  assert.deepEqual(invalid.lines, [], 'an invalid header is the caller\'s mistake, not a provider failure')
})

test('the logging helper writes one structured line and drops the reply of an OK status', async () => {
  const { lines } = await captureErrors(() => {
    logSendFailure('postshiba', 'status', { status: 503, body: 'busy', error: new RangeError('m'.repeat(300)) })
    logSendFailure('postshiba', 'parse', { status: 200, body: 'reader@example.com' })
    failedSend('smtp', Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }))
    failedSend('smtp', 'not an error object')
  })
  assert.deepEqual(lines.map(logged), [
    { provider: 'postshiba', stage: 'status', status: 503, error: 'RangeError', message: 'm'.repeat(200), body: 'busy' },
    { provider: 'postshiba', stage: 'parse', status: 200 },
    { provider: 'smtp', stage: 'timeout', error: 'Error', message: 'Connection timeout' },
    { provider: 'smtp', stage: 'fetch', error: 'Error', message: 'not an error object' },
  ])
})

test('SMTP logs a connection failure without the credential or the recipient', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const { createServer } = await import('node:net')
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = String((server.address() as { port: number }).port)
  const { result, lines } = await captureErrors(() => smtpProvider(install.app.control.ctx, { smtp_host: '127.0.0.1', smtp_port: port, smtp_security: 'none', smtp_user: 'smtp_fixture', smtp_password: 'placeholder-password' }).send(message))
  assert.deepEqual(result, { ok: false, kind: 'unknown', message: 'The email provider did not confirm the outcome.' })
  assert.equal(lines.length, 1)
  assert.equal(logged(lines[0]).provider, 'smtp')
  assert.ok(['fetch', 'timeout'].includes(String(logged(lines[0]).stage)))
  for (const secret of [...credentials.smtp, ...addresses]) assert.ok(!lines[0].includes(secret))
})

test('redirect helpers ask for manual mode and recognise every redirect', () => {
  assert.deepEqual(noRedirect, { redirect: 'manual' })
  for (const status of [300, 301, 302, 303, 307, 308, 399]) assert.equal(isRedirect(new Response(null, { status })), true)
  for (const status of [200, 204, 400, 401, 500]) assert.equal(isRedirect(new Response(null, { status })), false)
  assert.equal(isRedirect(Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' })), true)
})

test('no server or worker source asks fetch for the error redirect mode, which Workers refuses', () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== 'test') walk(full) }
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) files.push(full)
    }
  }
  walk(path.join(root, 'server'))
  walk(path.join(root, 'worker'))
  assert.ok(files.length > 50)
  const offenders = files.filter((file) => /redirect['"]?\s*:\s*['"`]error['"`]/.test(fs.readFileSync(file, 'utf8'))).map((file) => path.relative(root, file))
  assert.deepEqual(offenders, [])
})
