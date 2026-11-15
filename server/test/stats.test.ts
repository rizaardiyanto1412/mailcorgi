import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAction, type Actor } from '../core/actions.ts'
import { rebuild, rebuildCampaign } from '../account/stats/index.ts'
import { subscribe, unsubscribe } from '../account/contacts/index.ts'
import { signToken } from '../account/tracking/index.ts'
import { createInstall, expectError } from './harness.ts'
import { finish, upload } from './imports-setup.ts'
import { addContacts, createIssue, drive, issueDoc, LINK_A, LINK_B, sendableInstall, tokensIn } from './sending-setup.ts'

const UA = 'Mozilla/5.0 Mobile Safari/604.1'
for (const cloud of [false, true]) test(`campaign reports match a hand-counted send, scanner noise and provider outcomes (${cloud ? 'cloud' : 'self-hosted'})`, async (t) => {
  const { install, owner, ctx, nl, accountId } = await sendableInstall({ cloud })
  t.after(() => install.close())
  const ids = addContacts(ctx, nl.id, 6)
  const issue = await createIssue(owner, nl.id, { doc: issueDoc([LINK_A, LINK_B]) })
  await owner.action('campaigns.send', { campaignId: issue.id })
  await drive(install, owner, issue.id)
  install.clock.advance(60_000)
  const deliveries = ctx.db.all<{ id: number; email: string }>('SELECT id, email FROM deliveries WHERE campaign_id = ? ORDER BY id', issue.id)
  const outbox = install.outbox(accountId).filter((r) => r.kind === 'campaign')
  const html = (index: number) => outbox.find((r) => r.to_email === deliveries[index].email)!.html
  const hit = (path: string, userAgent = UA) => install.fetch(path, { headers: { 'user-agent': userAgent } })
  for (const i of [0, 3]) {
    const token = tokensIn(html(i), '/t/o/')[0]
    await hit(`/t/o/${token}`)
    await hit(`/t/o/${token}`)
  }
  await hit(`/t/o/${tokensIn(html(4), '/t/o/')[0]}`, 'Barracuda scanner')
  await hit(`/t/c/${tokensIn(html(0), '/t/c/')[0]}`)
  await hit(`/t/c/${tokensIn(html(0), '/t/c/')[0]}`)
  const scanner = tokensIn(html(5), '/t/c/')
  await hit(`/t/c/${scanner[0]}`)
  install.clock.advance(1000)
  await hit(`/t/c/${scanner[1]}`)
  const provider = install.app.stores.account(accountId)
  for (const i of [0, 1, 2, 3]) await provider.ingestProviderEvents({ events: [{ id: `delivered-${i}`, type: 'delivered', deliveryId: String(deliveries[i].id), accountId, messageId: `message-${i}`, recipient: deliveries[i].email, occurredAt: install.clock.now() }] })
  const bounce = { id: 'bounce-1', type: 'bounce' as const, bounce: { permanent: true, nonexistent: false, reason: 'No mailbox' }, deliveryId: String(deliveries[1].id), accountId, messageId: 'message-1', recipient: deliveries[1].email, occurredAt: install.clock.now() }
  await provider.ingestProviderEvents({ events: [bounce, bounce] })
  await provider.ingestProviderEvents({ events: [{ id: 'complaint-2', type: 'complaint', deliveryId: String(deliveries[2].id), accountId, messageId: 'message-2', recipient: deliveries[2].email, occurredAt: install.clock.now() }] })
  const unsubToken = await signToken(ctx, 'u', [ids.find((id) => ctx.db.get<{ email: string }>('SELECT email FROM contacts WHERE id = ?', id)?.email === deliveries[0].email)!, issue.id])
  assert.equal((await install.fetch(`/u/${unsubToken}`, { method: 'POST' })).status, 200)
  const before = (await owner.action('stats.report', { campaignId: issue.id })).counts
  assert.deepEqual({ sent: before.sent, delivered: before.delivered, opens: before.opens, clicks: before.clicks, bounces: before.bounces, complaints: before.complaints, unsubscribes: before.unsubscribes }, { sent: 6, delivered: 2, opens: 2, clicks: 1, bounces: 1, complaints: 1, unsubscribes: 1 })
  assert.ok(Math.abs(before.openRate - 100 / 3) < 1e-10)
  assert.equal(before.clickToOpen, 50)
  const cachedBeforeRebuild = JSON.parse(ctx.db.get<{ stats: string }>('SELECT stats FROM campaigns WHERE id = ?', issue.id)!.stats)
  const dailyBeforeRebuild = ctx.db.all('SELECT * FROM daily_stats WHERE newsletter_id = ? ORDER BY day', nl.id)
  rebuild(ctx, nl.id)
  assert.deepEqual(JSON.parse(ctx.db.get<{ stats: string }>('SELECT stats FROM campaigns WHERE id = ?', issue.id)!.stats), cachedBeforeRebuild)
  assert.deepEqual(ctx.db.all('SELECT * FROM daily_stats WHERE newsletter_id = ? ORDER BY day', nl.id), dailyBeforeRebuild)
  const rebuilt = await owner.action('stats.report', { campaignId: issue.id })
  assert.deepEqual(rebuilt.counts, before, 'cached counters equal a full recount')
  const cached = ctx.db.get<{ stats: string }>('SELECT stats FROM campaigns WHERE id = ?', issue.id)!.stats
  rebuild(ctx, nl.id)
  assert.equal(ctx.db.get<{ stats: string }>('SELECT stats FROM campaigns WHERE id = ?', issue.id)!.stats, cached, 'rebuild is idempotent')
  const sum = (key: 'sent' | 'delivered' | 'opens' | 'clicks' | 'bounces' | 'complaints' | 'unsubscribes') => rebuilt.timeline.reduce((n, p) => n + p[key], 0)
  assert.deepEqual(['sent', 'delivered', 'opens', 'clicks', 'bounces', 'complaints', 'unsubscribes'].map((key) => key === 'sent' ? sum('sent') : key === 'delivered' ? sum('delivered') : key === 'opens' ? sum('opens') : key === 'clicks' ? sum('clicks') : key === 'bounces' ? sum('bounces') : key === 'complaints' ? sum('complaints') : sum('unsubscribes')), [6, 4, 2, 1, 1, 1, 1])
  assert.equal(rebuilt.links.reduce((n, l) => n + l.unique_clicks, 0), 1)
  assert.equal(rebuilt.providers[0].sent, 6)
  assert.equal(rebuilt.providers[0].opens, 2)
  const overview = await owner.action('stats.overview', { newsletterId: nl.id, range: '7' })
  assert.equal(overview.subscribers, 3)
  assert.equal(overview.netNew, 3)
  assert.equal(overview.growth.length, 7)
  assert.equal(overview.sources[0].net, 3)
  assert.equal(overview.checklist.domain, true)
  assert.equal(overview.checklist.campaign, true)
  const bounced = await owner.action('stats.recipients', { campaignId: issue.id, status: 'bounced' })
  assert.deepEqual(bounced.items.map((r) => r.email), [deliveries[1].email])
  const page1 = await owner.action('stats.recipients', { campaignId: issue.id, limit: 2 })
  const page2 = await owner.action('stats.recipients', { campaignId: issue.id, limit: 2, after: page1.next! })
  assert.equal(new Set([...page1.items, ...page2.items].map((r) => r.id)).size, 4)
  const member: Actor = { userId: 'usr_member', email: 'member@example.com', owner: false, grants: { [nl.id]: 'member' }, access: 'full', via: 'web', installAdmin: false }
  await runAction(ctx, 'stats.report', { campaignId: issue.id }, member)
  await assert.rejects(runAction(ctx, 'stats.exportRecipients', { campaignId: issue.id }, member), { status: 403 })
  await assert.rejects(runAction(ctx, 'stats.report', { campaignId: issue.id }, { ...member, grants: { other: 'admin' } }), { status: 403 })
  const other = await install.signUp({ email: 'other@example.com' })
  assert.equal((await expectError(() => other.action('stats.report', { campaignId: issue.id }))).status, 404)
})

test('empty reports have zero rates, bounded rates and formula-safe paginated exports', async (t) => {
  const { install, owner, ctx, nl } = await sendableInstall()
  t.after(() => install.close())
  const issue = await createIssue(owner, nl.id)
  const empty = await owner.action('stats.report', { campaignId: issue.id })
  assert.equal(empty.counts.openRate, 0)
  assert.equal(empty.counts.clickToOpen, 0)
  ctx.db.run('UPDATE campaigns SET stats = ? WHERE id = ?', JSON.stringify({ sent: 1, opens: 50, clicks: 100 }), issue.id)
  const corrupt = await owner.action('stats.report', { campaignId: issue.id })
  assert.equal(corrupt.counts.openRate, 100)
  assert.equal(corrupt.counts.clickRate, 100)
  assert.equal(corrupt.counts.clickToOpen, 100)
  addContacts(ctx, nl.id, 3)
  ctx.db.run(`INSERT INTO deliveries (campaign_id, contact_id, email, status, queued_at) SELECT ?, id, CASE WHEN email = 'reader0@example.com' THEN '=formula@example.com' ELSE email END, 'queued', ? FROM contacts WHERE newsletter_id = ?`, issue.id, ctx.now(), nl.id)
  const first = await owner.action('stats.exportRecipients', { campaignId: issue.id, limit: 2 })
  const second = await owner.action('stats.exportRecipients', { campaignId: issue.id, limit: 2, after: first.next! })
  assert.match(first.csv + second.csv, /"'=formula@example.com"/)
  assert.equal(first.csv.trim().split('\r\n').length, 3)
  assert.equal(second.csv.trim().split('\r\n').length, 2)
  assert.equal(second.next, null)
  rebuildCampaign(ctx, issue.id)
  assert.equal((await owner.action('stats.report', { campaignId: issue.id })).counts.sent, 0)
})

test('rollup counts confirmed subscriptions once, website views and real import state', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Growth' })
  const ctx = install.app.account(owner.accountId!).ctx
  const pending = subscribe(ctx, { newsletterId: nl.id, email: 'pending@example.com', source: 'form', consent: 'pending' })
  subscribe(ctx, { newsletterId: nl.id, email: 'pending@example.com', source: 'form', consent: 'confirmed' })
  unsubscribe(ctx, { contactId: pending.contact.id })
  subscribe(ctx, { newsletterId: nl.id, email: 'pending@example.com', source: 'form', consent: 'confirmed' })
  ctx.db.run("INSERT INTO imports (id, newsletter_id, status, created_by, created_at) VALUES ('imp_done', ?, 'done', ?, ?)", nl.id, owner.session.user.id, ctx.now())
  await install.runJobs()
  await install.fetch(`/n/${nl.slug}`, { headers: { 'user-agent': UA, referer: 'https://example.com/article' } })
  await install.runJobs()
  rebuild(ctx, nl.id)
  const overview = await owner.action('stats.overview', { newsletterId: nl.id, range: '30' })
  assert.equal(overview.subscribers, 1)
  assert.equal(overview.netNew, 1)
  assert.equal(overview.sources[0].added, 2)
  assert.equal(overview.sources[0].removed, 1)
  assert.equal(overview.pageViews, 1)
  assert.ok(overview.website.some((r) => r.dimension === 'referrer' && r.value === 'example.com'))
  assert.equal(overview.checklist.imported, true)
  const daily = ctx.db.all('SELECT * FROM daily_stats WHERE newsletter_id = ?', nl.id)
  rebuild(ctx, nl.id)
  assert.deepEqual(ctx.db.all('SELECT * FROM daily_stats WHERE newsletter_id = ?', nl.id), daily)
})

test('overview query count stays constant with 200 campaigns and 50,000 contacts', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Large' })
  const ctx = install.app.account(owner.accountId!).ctx
  ctx.db.run(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<50000) INSERT INTO contacts (id, newsletter_id, email, status, created_at, updated_at) SELECT 'ct_' || n, ?, 'reader' || n || '@example.com', 'subscribed', ?, ? FROM numbers`, nl.id, ctx.now(), ctx.now())
  ctx.db.run(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<200) INSERT INTO campaigns (id, newsletter_id, subject, status, created_by, created_at, updated_at) SELECT 'cmp_' || n, ?, 'Issue ' || n, 'sent', ?, ?, ? FROM numbers`, nl.id, owner.session.user.id, ctx.now(), ctx.now())
  const original = ctx.db
  const queries: string[] = []
  ctx.db = { ...original, all: (sql, ...params) => { queries.push(sql); return original.all(sql, ...params) }, get: (sql, ...params) => { queries.push(sql); return original.get(sql, ...params) } }
  const data = await owner.action('stats.overview', { newsletterId: nl.id, range: '90' })
  ctx.db = original
  assert.equal(data.subscribers, 50_000)
  assert.equal(data.campaigns.length, 5)
  assert.ok(queries.length <= 10, `overview ran ${queries.length} reads`)
  assert.ok(queries.every((q) => !/\bFROM\s+(events|deliveries|page_views)\b/i.test(q)), 'page load does not scan raw event or delivery data')
})

test('growth by source counts every imported contact, at once and on its signup day, and a full recount agrees', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  install.dns.set('example.com', 'MX', ['mx.example.com'])
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Growth' })
  const ctx = install.app.account(owner.accountId!).ctx
  await install.runJobs()
  const tenDaysAgo = new Date(install.clock.now() - 10 * 86_400_000).toISOString()
  const rows = Array.from({ length: 40 }, (_, i) => ({ email: `reader${i}@example.com`, status: 'subscribed', created_at: i < 25 ? tenDaysAgo : '' }))
  const importId = await upload(owner, nl.id, rows)
  await finish(install, owner, nl.id, importId)
  const bySource = async (range: '7' | '30') => (await owner.action('stats.overview', { newsletterId: nl.id, range })).sources.reduce((n, s) => n + s.added, 0)
  assert.equal(await bySource('30'), 40)
  assert.equal(await bySource('7'), 15)
  const before = ctx.db.all('SELECT * FROM stats_sources WHERE newsletter_id = ? ORDER BY day, source', nl.id)
  rebuild(ctx, nl.id)
  assert.deepEqual(ctx.db.all('SELECT * FROM stats_sources WHERE newsletter_id = ? ORDER BY day, source', nl.id), before)
})
