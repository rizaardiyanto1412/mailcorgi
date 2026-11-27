/** The optional 30-day copy of each campaign and sequence email, and GET /newsletters/:newsletterId/sends/:deliveryId. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addContacts, createIssue, drive, sendableInstall } from './sending-setup.ts'
import type { Install } from './harness.ts'
import type { StoreCtx } from '../core/store.ts'
import { parseConfig } from '../core/config.ts'
import type { EmailProvider, SendResult } from '../email/index.ts'
import { testProvider } from '../email/test.ts'
import { resendProvider } from '../email/resend.ts'
import { sesProvider } from '../email/ses.ts'
import { postshibaProvider } from '../email/postshiba.ts'
import { sendHooks } from '../account/sending/index.ts'
import { CONTENT_TTL_MS, armPurge, capturesKind, keepContent } from '../account/sending/content.ts'

const DAY = 86_400_000
const ON = { DELIVERY_CONTENT_CAPTURE: 'true' }
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
type Content = { subject: string; html: string | null; text: string }
type Detail = { id: number; sentAt: number | null; content: Content | null }

const doc = (text: string) => ({ type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] })
const auth = (secret: string) => ({ authorization: `Bearer ${secret}` })
const getDetail = (install: Install, secret: string, newsletterId: string, deliveryId: string | number) => install.fetch(`/api/v1/newsletters/${newsletterId}/sends/${deliveryId}`, { headers: auth(secret) })
const detailOf = async (install: Install, secret: string, newsletterId: string, deliveryId: number) => {
  const response = await getDetail(install, secret, newsletterId, deliveryId)
  assert.equal(response.status, 200)
  return (await response.json()) as Detail
}
const campaignMail = (install: Install, accountId: string) => install.outbox(accountId).filter((m) => m.kind === 'campaign')
const deliveriesOf = (ctx: StoreCtx, campaignId: string) => ctx.db.all<{ id: number; email: string; contact_id: string }>('SELECT id, email, contact_id FROM deliveries WHERE campaign_id = ? ORDER BY id', campaignId).map((d) => ({ ...d }))
const copies = (ctx: StoreCtx) => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM delivery_content')!.n
const purgeJob = (ctx: StoreCtx) => ctx.db.get<{ run_at: number }>("SELECT run_at FROM jobs WHERE dedupe_key = 'delivery_content.purge'")

async function sendIssue(t: { after: (fn: () => unknown) => void }, env: Record<string, string> = ON, contacts = 2, extra: Record<string, unknown> = {}) {
  const base = await sendableInstall({ env })
  t.after(() => { sendHooks.provider = null; base.install.close() })
  const secret = (await base.owner.action('apikeys.create', { name: 'CRM', access: 'full' })).secret
  addContacts(base.ctx, base.nl.id, contacts)
  const issue = await createIssue(base.owner, base.nl.id, extra)
  await base.owner.action('campaigns.send', { campaignId: issue.id })
  assert.equal((await drive(base.install, base.owner, issue.id)).status, 'sent')
  return { ...base, secret, issue, deliveries: deliveriesOf(base.ctx, issue.id) }
}

test('the flag is off by default and reads the environment on Node and Workers alike', () => {
  assert.equal(parseConfig({}).captureDeliveryContent, false)
  assert.equal(parseConfig({ DELIVERY_CONTENT_CAPTURE: 'false' }).captureDeliveryContent, false)
  assert.equal(parseConfig({ DELIVERY_CONTENT_CAPTURE: 'true' }).captureDeliveryContent, true)
  for (const other of ['1', 'TRUE', 'yes', '']) assert.equal(parseConfig({ DELIVERY_CONTENT_CAPTURE: other }).captureDeliveryContent, false, other)
})

test('a campaign email is kept exactly as the provider received it, and later edits cannot change it', async (t) => {
  const { install, nl, ctx, accountId, secret, issue, deliveries } = await sendIssue(t)
  const mail = campaignMail(install, accountId)
  assert.equal(mail.length, 2)
  for (const d of deliveries) {
    const sent = mail.find((m) => m.to_email === d.email)!
    const body = await detailOf(install, secret, nl.id, d.id)
    assert.equal(body.id, d.id)
    assert.equal(body.sentAt, ctx.db.get<{ sent_at: number }>('SELECT sent_at FROM deliveries WHERE id = ?', d.id)!.sent_at)
    assert.deepEqual(body.content, { subject: sent.subject, html: sent.html, text: sent.text })
    assert.match(body.content!.html!, /\/u\//, 'the recipient\'s own unsubscribe link is in the copy')
  }
  const before = await detailOf(install, secret, nl.id, deliveries[0].id)
  ctx.db.run("UPDATE campaigns SET subject = 'Edited later', source = 'Edited later', html = '<p>Edited later</p>', text = 'Edited later' WHERE id = ?", issue.id)
  assert.deepEqual((await detailOf(install, secret, nl.id, deliveries[0].id)).content, before.content)
  assert.equal(copies(ctx), 2)
})

test('a sequence step is kept the same way', async (t) => {
  const base = await sendableInstall({ env: ON })
  const { install, owner, nl, ctx, accountId } = base
  t.after(() => install.close())
  const secret = (await owner.action('apikeys.create', { name: 'CRM', access: 'full' })).secret
  const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'new-signup' })
  const draft = await owner.action('sequences.create', { newsletterId: nl.id, name: 'Onboarding', entry: { type: 'tag', tagId: tag.id }, steps: [{ delayDays: 1, subject: 'Day 1', doc: doc('Body for day 1') }] })
  const sequence = await owner.action('sequences.activate', { newsletterId: nl.id, sequenceId: draft.id })
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'reader@example.com', tags: [tag.id] })
  install.clock.advance(DAY)
  await install.runJobs()
  const [delivery] = deliveriesOf(ctx, sequence.steps[0].campaignId)
  const sent = campaignMail(install, accountId).find((m) => m.to_email === 'reader@example.com')!
  const body = await detailOf(install, secret, nl.id, delivery.id)
  assert.deepEqual(body.content, { subject: 'Day 1', html: sent.html, text: sent.text })
})

test('a plain-text send has html null, and an unsent, historical or default-off send has no content', async (t) => {
  const plain = await sendIssue(t, ON, 1, { sendFormat: 'plain' })
  const sent = campaignMail(plain.install, plain.accountId)[0]
  const body = await detailOf(plain.install, plain.secret, plain.nl.id, plain.deliveries[0].id)
  assert.equal(body.content!.html, null)
  assert.equal(body.content!.text, sent.text)

  const campaign = plain.issue.id
  plain.ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, queued_at) VALUES (?, 'ct_unsent', 'unsent@example.com', 'queued', 1)", campaign)
  plain.ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, queued_at, sent_at) VALUES (?, 'ct_old', 'old@example.com', 'sent', 1, 1000)", campaign)
  const ids = plain.ctx.db.all<{ id: number; email: string }>("SELECT id, email FROM deliveries WHERE email IN ('unsent@example.com', 'old@example.com')")
  for (const row of ids) {
    const detail = await detailOf(plain.install, plain.secret, plain.nl.id, row.id)
    assert.equal(detail.content, null, row.email)
    assert.equal(detail.sentAt, row.email === 'old@example.com' ? 1000 : null)
  }

  const off = await sendIssue(t, {}, 1)
  assert.equal(off.install.config.captureDeliveryContent, false)
  assert.equal(copies(off.ctx), 0, 'nothing is written while the flag is off')
  assert.equal(purgeJob(off.ctx), undefined)
  const detail = await detailOf(off.install, off.secret, off.nl.id, off.deliveries[0].id)
  assert.equal(detail.content, null)
  assert.ok(detail.sentAt !== null)
})

test('only campaign and sequence emails are kept', async (t) => {
  const { ctx } = await sendIssue(t, ON, 1)
  assert.equal(capturesKind(ctx, 'issue'), true)
  assert.equal(capturesKind(ctx, 'sequence'), true)
  assert.equal(capturesKind(ctx, 'welcome'), false)
  assert.equal(capturesKind(ctx, 'keep'), false)
})

test('turning the flag off hides stored copies at once but erases nothing, and the purge runs anyway', async (t) => {
  const { install, nl, ctx, secret, deliveries } = await sendIssue(t, ON, 1)
  assert.equal((await detailOf(install, secret, nl.id, deliveries[0].id)).content !== null, true)
  ctx.config.captureDeliveryContent = false
  const body = await detailOf(install, secret, nl.id, deliveries[0].id)
  assert.equal(body.content, null)
  assert.equal(copies(ctx), 1, 'disabling does not erase the active row')
  install.clock.advance(CONTENT_TTL_MS)
  await install.runJobs()
  assert.equal(copies(ctx), 0, 'the expiry job does not depend on the flag')
})

test('an email retried after an earlier attempt gets no copy, even when the provider deduplicates a lost result', async (t) => {
  const base = await sendableInstall({ env: ON })
  const { install, owner, nl, ctx, accountId } = base
  t.after(() => { sendHooks.provider = null; install.close() })
  const secret = (await owner.action('apikeys.create', { name: 'CRM', access: 'full' })).secret
  addContacts(ctx, nl.id, 1)
  const issue = await createIssue(owner, nl.id)
  const seen: { subject: string }[] = []
  let first: SendResult | null = null
  sendHooks.provider = (c) => {
    const inner = testProvider(c)
    const provider: EmailProvider = {
      name: 'test', capabilities: { identities: false, events: false, idempotency: true },
      async send(msg) {
        seen.push({ subject: msg.subject })
        if (first) return first
        first = await inner.send(msg)
        ctx.db.run("UPDATE campaigns SET subject = 'Rendered as B' WHERE id = ?", issue.id)
        throw new Error('connection lost after the provider accepted A')
      },
    }
    return provider
  }
  await owner.action('campaigns.send', { campaignId: issue.id })
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  assert.deepEqual(seen.map((s) => s.subject), ['Issue one', 'Rendered as B'], 'the second attempt rendered other content than the accepted one')
  assert.equal(campaignMail(install, accountId).length, 1, 'the provider holds only A')
  const [delivery] = deliveriesOf(ctx, issue.id)
  const body = await detailOf(install, secret, nl.id, delivery.id)
  assert.ok(body.sentAt !== null)
  assert.equal(body.content, null)
  assert.equal(copies(ctx), 0)
})

for (const kind of ['throttled', 'temporary'] as const) test(`an email retried after a ${kind} answer gets no copy`, async (t) => {
  const base = await sendableInstall({ env: ON })
  const { install, owner, nl, ctx } = base
  t.after(() => { sendHooks.provider = null; install.close() })
  const secret = (await owner.action('apikeys.create', { name: 'CRM', access: 'full' })).secret
  addContacts(ctx, nl.id, 1)
  const issue = await createIssue(owner, nl.id)
  let calls = 0
  sendHooks.provider = (c) => {
    const inner = testProvider(c)
    return { name: 'test', capabilities: { identities: false, events: false, idempotency: false }, async send(msg) { return ++calls === 1 ? { ok: false, kind, message: 'Try again later', retryAfterMs: 1000 } : inner.send(msg) } } satisfies EmailProvider
  }
  await owner.action('campaigns.send', { campaignId: issue.id })
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  assert.equal(calls, 2)
  const [delivery] = deliveriesOf(ctx, issue.id)
  assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM deliveries WHERE id = ?', delivery.id)!.status, 'sent')
  assert.equal((await detailOf(install, secret, nl.id, delivery.id)).content, null)
  assert.equal(copies(ctx), 0)
})

test('a copy is hidden at the exact cutoff, then the durable job purges it without any request', async (t) => {
  const { install, owner, nl, ctx, secret, deliveries } = await sendIssue(t, ON, 2)
  const first =(await detailOf(install, secret, nl.id, deliveries[0].id)).sentAt!
  assert.equal(purgeJob(ctx)!.run_at, first + CONTENT_TTL_MS, 'one job, armed for the first expiry')
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'delivery_content.purge'")!.n, 1)

  install.clock.advance(10 * DAY)
  const second = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: second.id })
  assert.equal((await drive(install, owner, second.id)).status, 'sent')
  assert.equal(copies(ctx), 4)
  assert.equal(purgeJob(ctx)!.run_at, first + CONTENT_TTL_MS, 'a later send does not move the job and does not add one')
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'delivery_content.purge'")!.n, 1)

  install.clock.set(first + CONTENT_TTL_MS - 1)
  assert.notEqual((await detailOf(install, secret, nl.id, deliveries[0].id)).content, null, 'one millisecond before the cutoff')
  install.clock.set(first + CONTENT_TTL_MS)
  const hidden = await detailOf(install, secret, nl.id, deliveries[0].id)
  assert.equal(hidden.content, null, 'hidden at the cutoff')
  assert.ok(hidden.sentAt !== null, 'the send itself stays in the log')
  assert.equal(copies(ctx), 4, 'nothing was purged yet: hiding does not wait for the job')

  await install.runJobs()
  assert.equal(copies(ctx), 2, 'only the expired copies went')
  assert.equal(purgeJob(ctx)!.run_at > first + CONTENT_TTL_MS, true, 'the job sleeps until the next expiry')
  assert.notEqual((await detailOf(install, secret, nl.id, deliveriesOf(ctx, second.id)[0].id)).content, null)
  install.clock.set(purgeJob(ctx)!.run_at)
  await install.runJobs()
  assert.equal(copies(ctx), 0)
  assert.equal(purgeJob(ctx), undefined, 'with nothing left the job ends')
})

test('a large expired backlog is purged in bounded runs that continue by themselves', async (t) => {
  const { install, nl, ctx, accountId } = await sendIssue(t, ON, 1)
  ctx.db.run('DELETE FROM delivery_content')
  ctx.db.run("DELETE FROM jobs WHERE dedupe_key = 'delivery_content.purge'")
  const campaign = ctx.db.get<{ id: string }>('SELECT id FROM campaigns WHERE newsletter_id = ? LIMIT 1', nl.id)!.id
  const past = ctx.now() - 1000
  ctx.db.tx(() => {
    for (let n = 0; n < 4500; n++) {
      const { id } = ctx.db.run("INSERT INTO deliveries (campaign_id, contact_id, email, status, queued_at, sent_at) VALUES (?, ?, ?, 'sent', 1, ?)", campaign, `ct_bulk_${n}`, `bulk${n}@example.com`, past - CONTENT_TTL_MS)
      ctx.db.run("INSERT INTO delivery_content (delivery_id, contact_id, accepted_at, expires_at, subject, html, text) VALUES (?, ?, ?, ?, 's', '<p>h</p>', 't')", id, `ct_bulk_${n}`, past - CONTENT_TTL_MS, past)
    }
  })
  armPurge(ctx, past)
  await install.app.account(accountId).alarm()
  const left = copies(ctx)
  assert.ok(left > 0 && left < 4500, `one run removed some rows and not all (${left} left)`)
  assert.ok(purgeJob(ctx), 'the job is still queued to continue')
  await install.runJobs()
  assert.equal(copies(ctx), 0)
  assert.equal(purgeJob(ctx), undefined)
})

test('a copy goes with its delivery, its contact, its newsletter and the in-flight race is closed', async (t) => {
  const { install, owner, nl, ctx, secret, issue, deliveries } = await sendIssue(t, ON, 3)
  assert.equal(copies(ctx), 3)

  ctx.db.run('DELETE FROM deliveries WHERE id = ?', deliveries[0].id)
  assert.equal(copies(ctx), 2, 'the delivery cascade removes the copy')

  const contact = ctx.db.get<{ id: string }>('SELECT id FROM contacts WHERE email = ?', deliveries[1].email)!
  await owner.action('contacts.delete', { newsletterId: nl.id, contactId: contact.id })
  assert.equal(copies(ctx), 1, 'deleting a contact erases that contact\'s copy')
  assert.ok(ctx.db.get('SELECT 1 FROM deliveries WHERE id = ?', deliveries[1].id), 'the delivery record stays')
  assert.equal((await detailOf(install, secret, nl.id, deliveries[1].id)).content, null)
  assert.notEqual((await detailOf(install, secret, nl.id, deliveries[2].id)).content, null, 'other contacts keep theirs')

  const spare = await owner.action('newsletters.create', { name: 'Spare' })
  assert.ok(spare.id)
  await owner.action('newsletters.delete', { newsletterId: nl.id, confirmName: 'Weekly' })
  for (let i = 0; i < 60; i++) {
    await install.runJobs()
    install.clock.advance(2_000)
  }
  assert.equal(ctx.db.get('SELECT id FROM newsletters WHERE id = ?', nl.id), undefined)
  assert.equal(copies(ctx), 0)
  assert.equal(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE campaign_id = ?', issue.id)!.n, 0)
})

test('a contact or newsletter deleted while the provider call is in flight gets no copy back', async () => {
  for (const race of ['contact', 'newsletter'] as const) {
    const base = await sendableInstall({ env: ON })
    const { install, owner, nl, ctx } = base
    const [contactId] = addContacts(ctx, nl.id, 1)
    const issue = await createIssue(owner, nl.id)
    sendHooks.provider = (c) => {
      const inner = testProvider(c)
      return { name: 'test', capabilities: { identities: false, events: false, idempotency: true }, async send(msg) {
        const result = await inner.send(msg)
        if (race === 'contact') await owner.action('contacts.delete', { newsletterId: nl.id, contactId })
        else ctx.db.run('UPDATE newsletters SET deleting_at = ? WHERE id = ?', ctx.now(), nl.id)
        return result
      } } satisfies EmailProvider
    }
    await owner.action('campaigns.send', { campaignId: issue.id })
    for (let i = 0; i < 5; i++) { await install.runJobs(); install.clock.advance(1000) }
    assert.equal(ctx.db.get<{ status: string }>('SELECT status FROM deliveries WHERE campaign_id = ?', issue.id)!.status, 'sent', race)
    assert.equal(copies(ctx), 0, `${race} deleted in flight`)
    sendHooks.provider = null
    install.close()
  }
})

test('a copy that is too large, or not of the same accepted send, is skipped without an error', async (t) => {
  const { nl, ctx, deliveries } = await sendIssue(t, ON, 1)
  const [d] = deliveries
  const row = ctx.db.get<{ attempt_token: string; sent_at: number }>('SELECT attempt_token, sent_at FROM deliveries WHERE id = ?', d.id)!
  const own = { id: d.id, contact_id: d.contact_id, attempt_token: row.attempt_token }
  ctx.db.run('DELETE FROM delivery_content')
  keepContent(ctx, own, nl.id, { subject: 's', html: 'x'.repeat(1_100_000), text: 't' }, row.sent_at)
  assert.equal(copies(ctx), 0)
  keepContent(ctx, { ...own, attempt_token: 'another' }, nl.id, { subject: 's', html: null, text: 't' }, row.sent_at)
  keepContent(ctx, own, nl.id, { subject: 's', html: null, text: 't' }, row.sent_at + 1)
  assert.equal(copies(ctx), 0, 'another token or another accepted time is not the same accepted send')
  keepContent(ctx, own, nl.id, { subject: 's', html: '<p>ok</p>', text: 't' }, row.sent_at)
  assert.equal(copies(ctx), 1)
})

for (const failure of ['write', 'quota', 'job'] as const) test(`a failed copy (${failure}) never undoes the accepted send and logs nothing about the error`, async (t) => {
  const { install, owner, nl, ctx } = await sendableInstall({ env: ON })
  t.after(() => install.close())
  addContacts(ctx, nl.id, 2)
  const issue = await createIssue(owner, nl.id)
  const run = ctx.db.run.bind(ctx.db)
  const enqueue = ctx.jobs.enqueue.bind(ctx.jobs)
  const SECRET = 'LEAK-7c1d'
  if (failure === 'job') ctx.jobs.enqueue = (kind, ...rest) => { if (kind === 'delivery_content.purge') throw new Error(SECRET + ' cannot arm'); return enqueue(kind, ...rest) }
  else ctx.db.run = (sql, ...params) => {
    if (/INSERT OR IGNORE INTO delivery_content/.test(sql)) throw new Error(failure === 'quota' ? SECRET + ' rows written limit reached' : SECRET + ' SQLITE_TOOBIG')
    return run(sql, ...params)
  }
  const logged: string[] = []
  const error = console.error
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
  try {
    await owner.action('campaigns.send', { campaignId: issue.id })
    assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  } finally {
    console.error = error
    ctx.db.run = run
    ctx.jobs.enqueue = enqueue
  }
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE campaign_id = ? AND status = 'sent' AND sent_at IS NOT NULL", issue.id)!.n, 2)
  assert.equal(copies(ctx), 0, 'the row and the job commit together or not at all')
  assert.equal(purgeJob(ctx), undefined)
  assert.ok(logged.some((l) => l.includes('copy skipped')))
  assert.equal(logged.some((l) => l.includes(SECRET) || /TOOBIG|limit/.test(l)), false)
})

test('the detail route needs a key of this account and newsletter, and every answer is private and uncached', async (t) => {
  const { install, owner, nl, secret, deliveries } = await sendIssue(t, ON, 1)
  const [d] = deliveries
  const other = await owner.action('newsletters.create', { name: 'Other' })
  const readKey = (await owner.action('apikeys.create', { name: 'Read', access: 'read' })).secret
  const stranger = await install.signUp({ email: 'other@example.com' })
  const strangerKey = (await stranger.action('apikeys.create', { name: 'x', access: 'full' })).secret
  const expectPrivate = (response: Response) => assert.equal(response.headers.get('cache-control'), 'private, no-store')

  const ok = await getDetail(install, secret, nl.id, d.id)
  assert.equal(ok.status, 200)
  expectPrivate(ok)
  assert.deepEqual(Object.keys((await ok.json()) as object).sort(), ['content', 'id', 'sentAt'])
  const read = await getDetail(install, readKey, nl.id, d.id)
  assert.equal(read.status, 200, 'a read-only key may read')
  expectPrivate(read)

  const unauthenticated: [string, Response][] = [
    ['no key', await install.fetch(`/api/v1/newsletters/${nl.id}/sends/${d.id}`)],
    ['bad key', await install.fetch(`/api/v1/newsletters/${nl.id}/sends/${d.id}`, { headers: auth('mc_nope') })],
  ]
  for (const [name, response] of unauthenticated) {
    assert.equal(response.status, 401, name)
    expectPrivate(response)
  }
  const missing: [string, Response][] = [
    ['another account', await getDetail(install, strangerKey, nl.id, d.id)],
    ['unknown newsletter', await getDetail(install, secret, 'nl_missing', d.id)],
    ['other newsletter of this account', await getDetail(install, secret, other.id, d.id)],
    ['unknown id', await getDetail(install, secret, nl.id, d.id + 1000)],
  ]
  for (const id of ['abc', '0', '01', '1e3', '-1', '1.5', '9007199254740993', '9'.repeat(40), '9'.repeat(60)]) missing.push([`malformed ${id}`, await getDetail(install, secret, nl.id, id)])
  for (const [name, response] of missing) {
    assert.equal(response.status, 404, name)
    expectPrivate(response)
  }

  assert.equal((await owner.actionRaw('sends.detail', { newsletterId: nl.id, deliveryId: String(d.id) })).status, 404, 'no web-session route')
  const tools = (await (await install.fetch('/mcp', { method: 'POST', headers: { ...auth(secret), ...JSON_HEADERS }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json()).result.tools as { name: string }[]
  assert.ok(tools.some((tool) => tool.name === 'sends_list'))
  assert.equal(tools.some((tool) => tool.name === 'sends_detail'), false, 'no MCP tool')
  const call = await (await install.fetch('/mcp', { method: 'POST', headers: { ...auth(secret), ...JSON_HEADERS }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sends_detail', arguments: { newsletterId: nl.id, deliveryId: String(d.id) } } }) })).json()
  assert.equal(call.result.isError, true)

  const list = await (await install.fetch(`/api/v1/newsletters/${nl.id}/sends`, { headers: auth(secret) })).json() as { items: Record<string, unknown>[] }
  assert.equal(list.items.some((item) => 'content' in item), false, 'the list is unchanged')
})

const MARKER = 'ECHO-MARKER-7f3a'

/** Send one issue through a real adapter whose mocked server echoes the marker, and collect what was logged and stored. */
async function echo(adapter: 'resend' | 'ses' | 'postshiba', mode: 'reply' | 'throw', capture: boolean) {
  const base = await sendableInstall({ env: capture ? ON : {} })
  const { install, owner, nl, ctx } = base
  addContacts(ctx, nl.id, 1)
  const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Body ${MARKER}` }] }, { type: 'paragraph', content: [{ type: 'text', text: 'A link', marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }] }] }] }
  const issue = await createIssue(owner, nl.id, { doc: body })
  const fetchMock = async () => {
    if (mode === 'throw') throw new Error(`${MARKER} echoed by the transport`)
    return new Response(`${MARKER} {"message":"invalid html"}`, { status: 422 })
  }
  sendHooks.provider = (c) => {
    const mocked = { ...c, platform: { ...c.platform, fetch: fetchMock } } as unknown as StoreCtx
    if (adapter === 'resend') return resendProvider(mocked, { resend_api_key: 'rk_test_secret' })
    if (adapter === 'ses') return sesProvider(mocked, { ses_region: 'us-east-1', ses_access_key_id: 'AKIATESTKEY', ses_secret_access_key: 'secretsecretsecret' })
    return postshibaProvider(mocked, { postshiba_user: 'smtp_test', postshiba_password: 'pw-secret' })
  }
  const logs: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(' '))
  try {
    await owner.action('campaigns.send', { campaignId: issue.id })
    await drive(install, owner, issue.id, { maxSeconds: 5 })
  } finally {
    console.error = original
    sendHooks.provider = null
  }
  const error = ctx.db.get<{ error: string | null }>('SELECT error FROM deliveries WHERE campaign_id = ?', issue.id)?.error ?? ''
  install.close()
  return { logs: logs.filter((l) => l.startsWith('email provider failed')), error }
}

for (const adapter of ['resend', 'ses', 'postshiba'] as const) for (const mode of ['reply', 'throw'] as const) {
  test(`${adapter} logs only safe diagnostics for a kept send when the provider echoes content in a ${mode === 'reply' ? 'non-OK reply' : 'thrown error'}`, async () => {
    const kept = await echo(adapter, mode, true)
    assert.ok(kept.logs.length >= 1, 'the failure is still logged')
    for (const line of kept.logs) {
      assert.equal(line.includes(MARKER), false, line)
      const fields = JSON.parse(line.slice('email provider failed '.length)) as Record<string, unknown>
      assert.deepEqual(Object.keys(fields).filter((k) => !['provider', 'stage', 'status', 'error'].includes(k)), [])
      assert.equal(fields.provider, adapter)
      if (mode === 'reply') assert.deepEqual([fields.stage, fields.status], ['status', 422])
      else assert.deepEqual([fields.stage, fields.error], ['fetch', 'other'])
    }
    assert.equal(kept.error.includes(MARKER), false, 'nothing echoed is stored on the delivery')

    const unrelated = await echo(adapter, mode, false)
    assert.ok(unrelated.logs.some((l) => l.includes(MARKER)), 'with the flag off the old diagnostics are unchanged')
  })
}

test('a send that throws before the provider answers stores only a fixed description when copies are kept', async () => {
  for (const capture of [true, false]) {
    const base = await sendableInstall({ env: capture ? ON : {} })
    const { install, owner, nl, ctx } = base
    addContacts(ctx, nl.id, 1)
    const issue = await createIssue(owner, nl.id)
    sendHooks.provider = (c) => ({ ...testProvider(c), capabilities: { identities: false, events: false, idempotency: false }, async send() { throw new Error(`${MARKER} thrown by the adapter`) } })
    await owner.action('campaigns.send', { campaignId: issue.id })
    await drive(install, owner, issue.id, { maxSeconds: 5 })
    const error = ctx.db.get<{ error: string }>('SELECT error FROM deliveries WHERE campaign_id = ?', issue.id)!.error
    assert.equal(error.includes(MARKER), !capture, `capture ${capture}: ${error}`)
    sendHooks.provider = null
    install.close()
  }
})
