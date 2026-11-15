/**
 * Query plans for the hot queries after the index audit (docs/performance.md). Every index entry is
 * a row written on Durable Objects, so only indexes a hot query needs are kept; this pins which
 * index each one uses, so dropping one that matters fails here, not in production.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstall } from './harness.ts'
import { compileFilter, audienceQuery } from '../account/segments/index.ts'
import { OPEN_ROWS } from '../account/sending/index.ts'

const CONTACTS = 50_000

test('50,000 contacts and 100,000 deliveries: every hot query uses the index it is meant to', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  install.clock.set(Date.now())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Large list' })
  const ctx = install.app.account(owner.accountId!).ctx
  const now = ctx.now()
  ctx.db.tx(() => {
    ctx.db.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ${CONTACTS})
      INSERT INTO contacts (id, newsletter_id, email, status, sent_count, created_at, updated_at)
      SELECT printf('c%06d', x), ?, printf('reader%06d@example.com', x), 'subscribed', x % 3, x, x FROM n`, nl.id)
    for (const [id, status, sentAt] of [['cmp_one', 'sent', now - 86_400_000], ['cmp_two', 'sending', null]] as const) {
      ctx.db.run("INSERT INTO campaigns (id, newsletter_id, kind, format, subject, status, audience, sent_at, created_by, created_at, updated_at, stats) VALUES (?, ?, 'issue', 'doc', ?, ?, '{}', ?, 'owner', ?, ?, '{}')", id, nl.id, id, status, sentAt, now, now)
      ctx.db.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ${CONTACTS})
        INSERT INTO deliveries (campaign_id, send_id, contact_id, email, status, provider_message_id, queued_at, sent_at, opened_at, hygiene_epoch)
        SELECT ?, 'snd_1', printf('c%06d', x), printf('reader%06d@example.com', x), ?, CASE WHEN ? = 'sent' THEN 'msg-' || ? || x END, ?, CASE WHEN ? = 'sent' THEN ? END, CASE WHEN ? = 'sent' AND x % 2 = 0 THEN ? END, 0 FROM n`,
        id, status === 'sent' ? 'sent' : 'queued', status, id, now, status, sentAt, status, sentAt)
    }
    ctx.db.run("INSERT INTO events (type, newsletter_id, contact_id, campaign_id, delivery_id, data, at) SELECT 'click', ?, 'c000001', 'cmp_one', id, '{\"link\":\"lnk_a\"}', ? FROM deliveries WHERE campaign_id = 'cmp_one' AND contact_id = 'c000001'", nl.id, now)
    ctx.db.run("INSERT INTO events (type, newsletter_id, contact_id, campaign_id, delivery_id, data, at) SELECT 'soft_bounce', ?, 'c000002', 'cmp_one', id, '{}', ? FROM deliveries WHERE campaign_id = 'cmp_one' AND contact_id = 'c000002'", nl.id, now)
  })
  const plan = (sql: string, ...params: unknown[]) => ctx.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...(params as never[])).map((r) => r.detail).join('\n')
  const uses = (label: string, sql: string, params: unknown[], index: RegExp) => {
    const p = plan(sql, ...params)
    assert.match(p, index, `${label} should use ${index}:\n${p}`)
    assert.doesNotMatch(p, /SCAN (contacts|deliveries|events)\b(?! USING)/, `${label} scans a big table:\n${p}`)
    return p
  }
  const timed = async (label: string, fn: () => unknown, limitMs: number) => {
    const start = performance.now()
    const result = await fn()
    assert.ok(performance.now() - start < limitMs, `${label} took ${Math.round(performance.now() - start)} ms, limit ${limitMs}`)
    return result
  }

  // Contacts: the status count, the default page, the warm-up "fresh" check and the cross-newsletter bounce lookup.
  const q = compileFilter({ field: 'status', in: ['subscribed'] }, nl.id)
  uses('segment count', `SELECT COUNT(*) FROM contacts c WHERE ${q.where}`, q.params, /COVERING INDEX contacts_status/)
  uses('contact page', 'SELECT * FROM contacts c WHERE c.newsletter_id = ? AND (c.created_at, c.id) < (?, ?) ORDER BY c.created_at DESC, c.id DESC LIMIT 51', [nl.id, 49950, 'c049950'], /INDEX contacts_created_page/)
  const email = plan('SELECT * FROM contacts c WHERE c.newsletter_id = ? AND (c.email, c.id) > (?, ?) ORDER BY c.email ASC, c.id ASC LIMIT 51', nl.id, 'reader000100@example.com', 'c000100')
  assert.match(email, /sqlite_autoindex_contacts_2/, `paging by email uses the UNIQUE(newsletter_id, email) index:\n${email}`)
  assert.doesNotMatch(email, /TEMP B-TREE/, `paging by email needs no sort:\n${email}`)
  uses('fresh check', 'SELECT 1 FROM contacts o WHERE o.email = ? AND o.sent_count > 0', ['reader000001@example.com'], /INDEX contacts_email_status/)
  uses('bounce propagation', "SELECT id FROM contacts WHERE email = ? AND id != ? AND status IN ('subscribed', 'unconfirmed')", ['reader000001@example.com', 'x'], /INDEX contacts_email_status/)
  const audience = audienceQuery(ctx, nl.id, { all: true })
  const audiencePlan = plan(`SELECT c.id, c.email, NOT EXISTS (SELECT 1 FROM contacts o WHERE o.email = c.email AND o.sent_count > 0) AS fresh FROM contacts c WHERE ${audience.where}`, ...audience.params)
  assert.match(audiencePlan, /INDEX contacts_status/, audiencePlan)
  assert.match(audiencePlan, /INDEX contacts_email_status/, audiencePlan)
  await timed('a name-sorted page scans and sorts within a second', () => owner.action('contacts.list', { newsletterId: nl.id, sort: 'name', limit: 50 }), 1000)
  await timed('an email-sorted page', () => owner.action('contacts.list', { newsletterId: nl.id, sort: 'email', limit: 50 }), 200)

  // Deliveries: the send loop reads queued and sending rows through the partial index; webhooks find a row by message id.
  const releasedWhere = `d.campaign_id = ? AND d.${OPEN_ROWS} AND d.status = 'queued' AND d.send_id IN (SELECT id FROM campaign_sends WHERE campaign_id = ? AND state = 'released')`
  uses('send candidates', `SELECT d.id, d.email FROM deliveries d WHERE ${releasedWhere} AND d.queued_at <= ? ORDER BY d.id LIMIT 100`, ['cmp_two', 'cmp_two', now], /INDEX deliveries_open/)
  uses('in-flight count', `SELECT COUNT(*) AS n, MIN(attempt_at) AS oldest FROM deliveries WHERE campaign_id = ? AND ${OPEN_ROWS} AND status = 'sending'`, ['cmp_two'], /INDEX deliveries_open/)
  uses('stuck rows', `UPDATE deliveries SET status = 'unknown' WHERE campaign_id = ? AND ${OPEN_ROWS} AND status = 'sending' AND attempt_at <= ?`, ['cmp_two', now], /INDEX deliveries_open/)
  uses('stop a send', `UPDATE deliveries SET status = 'skipped' WHERE campaign_id = ? AND ${OPEN_ROWS} AND status = 'queued'`, ['cmp_two'], /INDEX deliveries_open/)
  uses('by message id', 'SELECT d.*, c.newsletter_id FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE d.provider_message_id = ? ORDER BY d.id DESC LIMIT 1', ['msg-cmp_one7'], /INDEX deliveries_message/)
  uses('unsubscribe from an issue', 'SELECT id, unsubscribed_at FROM deliveries WHERE campaign_id = ? AND contact_id = ?', ['cmp_one', 'c000001'], /sqlite_autoindex_deliveries_1/)
  uses('rolling bounce window', "SELECT d.bounced_at, d.complained_at FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE d.sent_at IS NOT NULL AND d.hygiene_epoch = ? ORDER BY d.sent_at DESC, d.id DESC LIMIT 1000", [0], /INDEX hygiene_deliveries_recent/)
  const engaged = compileFilter({ field: 'engagement', op: 'openedLast', issues: 2 }, nl.id)
  const engagedPlan = uses('engagement filter', `SELECT COUNT(*) FROM contacts c WHERE ${engaged.where}`, engaged.params, /sqlite_autoindex_deliveries_1/)
  assert.doesNotMatch(engagedPlan, /SCAN d\b/, engagedPlan)
  assert.equal(await timed('engagement count', () => owner.action('segments.count', { newsletterId: nl.id, filter: { field: 'engagement', op: 'openedLast', issues: 2 } }), 2000).then((r) => (r as { count: number }).count), CONTACTS / 2)
  uses('timeline deliveries', 'SELECT d.campaign_id, c.subject, d.sent_at, d.opened_at, d.clicked_at FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE d.campaign_id IN (SELECT id FROM campaigns WHERE newsletter_id = ?) AND d.contact_id = ? AND d.sent_at IS NOT NULL ORDER BY d.sent_at DESC LIMIT 500', [nl.id, 'c000001'], /sqlite_autoindex_deliveries_1/)

  // Events: the timeline, the daily rebuild, click bookkeeping and soft-bounce counts.
  uses('timeline events', 'SELECT id, type, data, at, campaign_id FROM events WHERE newsletter_id = ? AND contact_id = ? AND id < ? ORDER BY id DESC LIMIT 101', [nl.id, 'c000001', Number.MAX_SAFE_INTEGER], /INDEX events_contact_page/)
  uses('daily rebuild', "SELECT newsletter_id, strftime('%Y-%m-%d', at / 1000, 'unixepoch'), COUNT(*) FROM events WHERE newsletter_id = ? AND at >= ? GROUP BY 1, 2", [nl.id, 0], /INDEX events_newsletter/)
  // The burst window is the last ten seconds, so the (newsletter_id, at) index is as good as the contact's.
  uses('clicks of a delivery', "SELECT id, json_extract(data, '$.link') AS link, at FROM events WHERE newsletter_id = ? AND contact_id = ? AND delivery_id = ? AND type = 'click' AND at >= ?", [nl.id, 'c000001', 1, now - 10_000], /INDEX events_(contact_page|newsletter)/)
  uses('first click on a link', "SELECT 1 FROM events WHERE newsletter_id = ? AND contact_id = ? AND delivery_id = ? AND type = 'click' AND json_extract(data, '$.link') = ?", [nl.id, 'c000001', 1, 'lnk_a'], /INDEX events_contact_page/)
  uses('soft bounces of a campaign', "SELECT COUNT(*) n FROM events WHERE campaign_id = ? AND type = 'soft_bounce'", ['cmp_one'], /INDEX events_soft_bounces/)
  uses('soft bounces of a contact', "SELECT COUNT(*) AS n FROM events WHERE newsletter_id = ? AND contact_id = ? AND type = 'soft_bounce'", [nl.id, 'c000002'], /INDEX events_contact_page/)
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM events WHERE campaign_id = ? AND type = 'soft_bounce'", 'cmp_one')!.n, 1)

  // The timeline action itself stays fast on a contact with deliveries in both campaigns.
  const page = await timed('contacts.get', () => owner.action('contacts.get', { newsletterId: nl.id, contactId: 'c000001' }), 200) as { deliveries: { campaignId: string; openedAt: number | null }[] }
  assert.deepEqual(page.deliveries.map((d) => d.campaignId), ['cmp_one'])
})
