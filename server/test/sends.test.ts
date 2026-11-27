import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StoreCtx } from '../core/store.ts'
import { createInstall, expectError, type Client } from './harness.ts'

const headers = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' })
type Item = { id: number; email: string; contactId: string; subject: string; sentAt: number | null; status: string; openedAt: number | null; clickedAt: number | null; source: Record<string, unknown> }
type Page = { items: Item[]; nextCursor: string | null }

async function setup(t: { after: (fn: () => unknown) => void }, cloud = false) {
  const install = await createInstall({ cloud })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Main' })
  const other = cloud ? nl : await owner.action('newsletters.create', { name: 'Other' })
  const ctx = install.app.account(owner.accountId!).ctx
  const key = await owner.action('apikeys.create', { name: 'CRM', access: 'full' })
  const list = (input: Record<string, unknown> = {}, client: Client = owner) => client.action('sends.list', { newsletterId: nl.id, ...input } as never) as Promise<Page>
  return { install, owner, nl, other, ctx, key, list }
}
let seq = 0
function campaign(ctx: StoreCtx, newsletterId: string, over: { kind?: string; slug?: string; subject?: string } = {}) {
  const id = `cmp_t${++seq}`
  ctx.db.run("INSERT INTO campaigns (id, newsletter_id, kind, format, subject, slug, status, audience, created_by, created_at, updated_at, stats) VALUES (?, ?, ?, 'doc', ?, ?, 'sent', '{}', 'owner', 1, 1, '{}')", id, newsletterId, over.kind ?? 'issue', over.subject ?? `Subject ${id}`, over.slug ?? '')
  return id
}
type D = { status?: string; sentAt?: number | null; deliveredAt?: number; openedAt?: number; clickedAt?: number; bouncedAt?: number; complainedAt?: number; unsubscribedAt?: number }
let contactSeq = 0
function delivery(ctx: StoreCtx, campaignId: string, email: string, d: D = {}) {
  const sentAt = d.sentAt === undefined ? 1000 : d.sentAt
  ctx.db.run('INSERT INTO deliveries (campaign_id, contact_id, email, status, queued_at, sent_at, delivered_at, opened_at, clicked_at, bounced_at, complained_at, unsubscribed_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)', campaignId, `ct_${++contactSeq}`, email, d.status ?? 'sent', sentAt, d.deliveredAt ?? null, d.openedAt ?? null, d.clickedAt ?? null, d.bouncedAt ?? null, d.complainedAt ?? null, d.unsubscribedAt ?? null)
  return ctx.db.get<{ id: number }>('SELECT MAX(id) id FROM deliveries')!.id
}

test('email filter is exact and case-insensitive, with no partial matches and no cross-newsletter leakage', async (t) => {
  const { nl, other, ctx, list } = await setup(t)
  const mine = campaign(ctx, nl.id)
  const theirs = campaign(ctx, other.id)
  delivery(ctx, mine, 'ann@example.com')
  delivery(ctx, mine, 'ann@example.com.au')
  delivery(ctx, mine, 'joann@example.com')
  delivery(ctx, theirs, 'ann@example.com')
  assert.deepEqual((await list({ email: 'ann@example.com' })).items.map((i) => i.email), ['ann@example.com'])
  assert.equal((await list({ email: '  ANN@Example.COM ' })).items.length, 1)
  assert.equal((await list({ email: 'ann' })).items.length, 0)
  assert.equal((await list()).items.length, 3, 'global log has only this newsletter')
})

test('status filters match stats.recipients: raw status, or timestamp for opened, clicked and unsubscribed', async (t) => {
  const { nl, ctx, list } = await setup(t)
  const c = campaign(ctx, nl.id)
  const clicked = delivery(ctx, c, 'a@example.com', { status: 'delivered', deliveredAt: 2, openedAt: 3, clickedAt: 4 })
  const opened = delivery(ctx, c, 'b@example.com', { status: 'delivered', openedAt: 3 })
  const unsub = delivery(ctx, c, 'c@example.com', { status: 'delivered', unsubscribedAt: 5 })
  const queued = delivery(ctx, c, 'd@example.com', { status: 'queued', sentAt: null })
  delivery(ctx, c, 'e@example.com', { status: 'failed' })
  const ids = async (status?: string) => (await list(status ? { status } : {})).items.map((i) => i.id).sort((x, y) => x - y)
  assert.equal((await ids()).length, 5, 'default is all, including unsent rows')
  assert.deepEqual(await ids('opened'), [clicked, opened])
  assert.deepEqual(await ids('clicked'), [clicked])
  assert.deepEqual(await ids('unsubscribed'), [unsub])
  assert.deepEqual(await ids('queued'), [queued])
  assert.deepEqual(await ids('delivered'), [clicked, opened, unsub])
  assert.equal((await ids('failed')).length, 1)
  assert.equal((await ids('bounced')).length, 0)
  assert.equal((await list({ status: 'opened' })).items.find((i) => i.id === clicked)!.status, 'clicked')
  await expectError(() => list({ status: 'nonsense' }))
})

test('displayed status follows the documented precedence', async (t) => {
  const { nl, ctx, list } = await setup(t)
  const c = campaign(ctx, nl.id)
  const cases: [string, D][] = [
    ['unsubscribed', { unsubscribedAt: 9, bouncedAt: 8, complainedAt: 7, clickedAt: 6, openedAt: 5, deliveredAt: 4 }],
    ['bounced', { bouncedAt: 8, complainedAt: 7, clickedAt: 6 }],
    ['bounced', { status: 'bounced', openedAt: 5 }],
    ['complained', { complainedAt: 7, clickedAt: 6, openedAt: 5 }],
    ['clicked', { clickedAt: 6, openedAt: 5, deliveredAt: 4 }],
    ['opened', { openedAt: 5, deliveredAt: 4 }],
    ['delivered', { deliveredAt: 4 }],
    ['delivered', { status: 'delivered' }],
    ['sent', { status: 'sent' }],
    ['queued', { status: 'queued', sentAt: null }],
  ]
  const ids = cases.map(([, d], n) => delivery(ctx, c, `p${n}@example.com`, d))
  const byId = new Map((await list()).items.map((i) => [i.id, i]))
  cases.forEach(([expected], n) => assert.equal(byId.get(ids[n])!.status, expected, `case ${n}`))
  const row = byId.get(ids[0])!
  assert.deepEqual(Object.keys(row).sort(), ['bouncedAt', 'clickedAt', 'complainedAt', 'contactId', 'deliveredAt', 'email', 'id', 'openedAt', 'sentAt', 'source', 'status', 'subject', 'unsubscribedAt'])
  assert.equal(byId.get(ids[6])!.openedAt, null)
})

test('pagination: defaults, limits, stable keyset over ties and unsent rows, invalid cursors', async (t) => {
  const { owner, nl, other, ctx, list } = await setup(t)
  const c = campaign(ctx, nl.id)
  ctx.db.tx(() => {
    for (let n = 0; n < 130; n++) delivery(ctx, c, `r${n % 5}@example.com`, { sentAt: 1000 + (n % 20) })
    for (let n = 0; n < 5; n++) delivery(ctx, c, `q${n}@example.com`, { status: 'queued', sentAt: null })
  })
  assert.equal((await list()).items.length, 50)
  assert.equal((await list({ limit: 200 })).items.length, 135)
  await expectError(() => list({ limit: 201 }))
  await expectError(() => list({ limit: 0 }))
  const seen: number[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < 30; pages++) {
    const page = await list({ limit: 7, cursor })
    assert.ok(page.items.length <= 7)
    seen.push(...page.items.map((i) => i.id))
    if (!page.nextCursor) break
    assert.equal(page.items.length, 7)
    cursor = page.nextCursor
  }
  assert.equal(seen.length, 135)
  assert.equal(new Set(seen).size, 135, 'no overlap')
  const all = (await list({ limit: 200 })).items
  assert.deepEqual(seen, all.map((i) => i.id), 'same order as one big page')
  const sorted = all.map((i) => [i.sentAt ?? -Infinity, i.id])
  assert.deepEqual(sorted, [...sorted].sort((a, b) => b[0] - a[0] || b[1] - a[1]))
  assert.deepEqual(all.slice(-5).map((i) => i.sentAt), [null, null, null, null, null])
  assert.equal((await list({ limit: 135 })).nextCursor, null)
  assert.equal(typeof (await list({ limit: 134 })).nextCursor, 'string')
  for (const bad of ['garbage', '123', 'e30']) assert.equal((await expectError(() => list({ cursor: bad }))).status, 400)
  const foreign = ((await list({ limit: 1 })).nextCursor)!
  assert.equal((await expectError(() => owner.action('sends.list', { newsletterId: other.id, cursor: foreign } as never))).status, 400, 'a cursor is bound to its newsletter')
})

test('source: campaign slug or subject, welcome, and sequence steps', async (t) => {
  const { owner, nl, ctx, list } = await setup(t)
  const slugged = campaign(ctx, nl.id, { slug: 'october', subject: 'October newsletter' })
  const plain = campaign(ctx, nl.id, { subject: 'No slug here' })
  const keep = campaign(ctx, nl.id, { kind: 'keep', subject: 'Keep me' })
  const welcome = campaign(ctx, nl.id, { kind: 'welcome', slug: 'ignored-for-welcome', subject: 'Welcome!' })
  const tag = await owner.action('tags.create', { newsletterId: nl.id, name: 'drip' })
  const sequence = await owner.action('sequences.create', { newsletterId: nl.id, name: 'New signup drip', entry: { type: 'tag', tagId: tag.id }, steps: [{ delayDays: 1, subject: 'Day 1' }, { delayDays: 3, subject: 'Day 3' }] })
  const step = sequence.steps[1]
  const stepCampaign = ctx.db.get<{ campaign_id: string; position: number }>('SELECT campaign_id, position FROM sequence_steps WHERE id = ?', step.id)!
  for (const [n, id] of [slugged, plain, keep, welcome, stepCampaign.campaign_id].entries()) delivery(ctx, id, `s${n}@example.com`, { sentAt: 100 - n })
  const bySubject = new Map((await list()).items.map((i) => [i.email, i]))
  assert.deepEqual(bySubject.get('s0@example.com')!.source, { type: 'campaign', name: 'october', campaignId: slugged })
  assert.deepEqual(bySubject.get('s1@example.com')!.source, { type: 'campaign', name: 'No slug here', campaignId: plain })
  assert.deepEqual(bySubject.get('s2@example.com')!.source, { type: 'campaign', name: 'Keep me', campaignId: keep })
  assert.deepEqual(bySubject.get('s3@example.com')!.source, { type: 'welcome', name: 'ignored-for-welcome', campaignId: welcome })
  assert.deepEqual(bySubject.get('s4@example.com')!.source, { type: 'sequence', name: 'New signup drip', sequenceId: sequence.id, stepId: step.id, stepPosition: stepCampaign.position, campaignId: stepCampaign.campaign_id })
  assert.equal(bySubject.get('s4@example.com')!.subject, 'Day 3')
  // A sequence campaign whose step row is gone still reports its type.
  const orphan = campaign(ctx, nl.id, { kind: 'sequence', subject: 'Lost step' })
  delivery(ctx, orphan, 'orphan@example.com', { sentAt: 500 })
  const lost = (await list({ email: 'orphan@example.com' })).items[0].source
  assert.equal(lost.type, 'sequence')
  assert.equal(lost.name, 'Lost step')
})

test('auth: API key REST and MCP work; no bearer is 401; other accounts and unknown newsletters are refused', async (t) => {
  const { install, nl, ctx, key } = await setup(t, true)
  delivery(ctx, campaign(ctx, nl.id), 'ann@example.com')
  const url = `/api/v1/newsletters/${nl.id}/sends?email=ANN@example.com&status=all&limit=5`
  assert.equal((await install.fetch(url)).status, 401)
  assert.equal((await install.fetch(url, { headers: { authorization: 'Bearer mc_nope' } })).status, 401)
  const ok = await install.fetch(url, { headers: headers(key.secret) })
  assert.equal(ok.status, 200)
  const body = await ok.json() as Page
  assert.equal(body.items.length, 1)
  assert.equal(body.nextCursor, null)
  assert.equal((await install.fetch(`/api/v1/newsletters/nl_missing/sends`, { headers: headers(key.secret) })).status, 404)
  assert.equal((await install.fetch(`/api/v1/newsletters/${nl.id}/sends?limit=999`, { headers: headers(key.secret) })).status, 400)

  const rpc = (method: string, params?: object) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  const tools = (await (await install.fetch('/mcp', { method: 'POST', headers: headers(key.secret), body: rpc('tools/list') })).json()).result.tools as { name: string; annotations: { readOnlyHint: boolean } }[]
  assert.equal(tools.find((x) => x.name === 'sends_list')?.annotations.readOnlyHint, true)
  const call = await (await install.fetch('/mcp', { method: 'POST', headers: headers(key.secret), body: rpc('tools/call', { name: 'sends_list', arguments: { newsletterId: nl.id, email: 'ann@example.com' } }) })).json()
  assert.notEqual(call.result.isError, true)
  assert.equal(call.result.structuredContent.items[0].email, 'ann@example.com')

  const stranger = await install.signUp({ email: 'stranger@example.com' })
  const strangerKey = await stranger.action('apikeys.create', { name: 'x', access: 'full' })
  assert.equal((await install.fetch(`/api/v1/newsletters/${nl.id}/sends`, { headers: headers(strangerKey.secret) })).status, 404)
  await expectError(() => stranger.action('sends.list', { newsletterId: nl.id } as never))
})
