/**
 * Load pass (unit N): 100,000 contacts, one full send through the test provider, the stats rollup,
 * a hygiene scan and segment counts. Prints wall time, peak RSS and database size for
 * docs/performance.md and fails on anything that no longer scales.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { subscribe } from '../account/contacts/index.ts'
import { rebuild } from '../account/stats/index.ts'
import { sendableInstall, createIssue, drive, LINK_A, LINK_B } from './sending-setup.ts'

const N = 100_000
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`

test(`${N.toLocaleString()} contacts: full send, rollup, hygiene scan and segment counts`, { timeout: 1_800_000 }, async () => {
  const { install, owner, nl, ctx, accountId } = await sendableInstall({ env: { SEND_RATE_PER_SECOND: '10000', SEND_BATCH_SIZE: '1000' } })
  let peak = process.memoryUsage().rss
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 100)
  const laps: Record<string, number> = {}
  const lap = async <T>(label: string, fn: () => Promise<T> | T): Promise<T> => {
    const started = performance.now()
    const result = await fn()
    laps[label] = Math.round(performance.now() - started)
    return result
  }
  try {
    await owner.action('contactFields.create', { newsletterId: nl.id, key: 'city', label: 'City', type: 'text' })
    await lap('contacts', () => {
      for (let at = 0; at < N; at += 5000) ctx.db.tx(() => {
        for (let i = at; i < at + 5000; i++) subscribe(ctx, { newsletterId: nl.id, email: `load${i}@example.com`, name: `Load ${i}`, fields: { city: i % 2 ? 'Paris' : 'Berlin' }, source: 'test', consent: 'confirmed' })
      })
    })
    assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM contacts WHERE newsletter_id = ? AND status = 'subscribed'", nl.id)!.n, N)

    const issue = await createIssue(owner, nl.id, { doc: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello {{first_name|reader}} in {{field.city|town}}.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'A', marks: [{ type: 'link', attrs: { href: LINK_A } }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'B', marks: [{ type: 'link', attrs: { href: LINK_B } }] }] },
    ] } })
    const planned = await lap('plan', () => owner.action('campaigns.send', { campaignId: issue.id }))
    assert.equal(planned.planned, N)
    const sent = await lap('send', () => drive(install, owner, issue.id, { maxSeconds: 1200 }))
    assert.equal(sent.status, 'sent')
    const progress = await owner.action('campaigns.progress', { campaignId: issue.id })
    assert.equal(progress.counts.sent, N)
    assert.equal(install.outbox(accountId).length, N)

    await lap('rollup first', () => rebuild(ctx, nl.id))
    await lap('rollup again', () => rebuild(ctx, nl.id))
    await lap('rollup job', async () => {
      ctx.jobs.enqueue('stats.rollup', {}, { dedupeKey: 'stats.rollup:load' })
      await install.runJobs()
    })
    const report = await lap('report', () => owner.action('stats.report', { campaignId: issue.id }))
    assert.equal(report.counts.sent, N)
    const overview = await lap('overview', () => owner.action('stats.overview', { newsletterId: nl.id, range: '30' }))
    assert.equal(overview.subscribers, N)

    await owner.action('hygiene.updateSettings', { newsletterId: nl.id, enabled: true, afterIssues: 1, waitDays: 14, strict: false, subject: 'Still with us?', body: 'Confirm below.' })
    ctx.db.run('UPDATE contacts SET subscribed_at = subscribed_at - ? WHERE newsletter_id = ?', 91 * 86_400_000, nl.id)
    const keep = await lap('hygiene scan', async () => {
      ctx.jobs.enqueue('hygiene.scan', { newsletterId: nl.id }, { dedupeKey: 'hygiene.scan:load' })
      await install.tick()
      return ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM campaigns WHERE newsletter_id = ? AND kind = 'keep'", nl.id)!.n
    })
    assert.ok(keep >= 1, 'the scan found inactive readers and created a keep campaign')
    const health = await lap('health', () => owner.action('hygiene.health', { newsletterId: nl.id }))
    assert.ok(health.statuses.some((s) => s.status === 'subscribed' && s.count === N))

    const paris = await lap('segment custom', () => owner.action('segments.count', { newsletterId: nl.id, filter: { field: 'custom', key: 'city', op: 'eq', value: 'Paris' } }))
    assert.equal(paris.count, N / 2)
    const ignored = await lap('segment engagement', () => owner.action('segments.count', { newsletterId: nl.id, filter: { field: 'engagement', op: 'ignoredLast', issues: 1 } }))
    assert.equal(ignored.count, N)
    const page = await lap('contacts page', () => owner.action('contacts.list', { newsletterId: nl.id, sort: 'email', direction: 'asc', limit: 50 }))
    assert.equal(page.contacts.length, 50)
    const next = await lap('contacts page 2', () => owner.action('contacts.list', { newsletterId: nl.id, sort: 'email', direction: 'asc', limit: 50, cursor: page.nextCursor! }))
    assert.equal(next.contacts.length, 50)

    ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const file = path.join(install.dataDir, 'accounts', `${accountId}.db`)
    const size = fs.statSync(file).size
    const rows = Object.fromEntries(['contacts', 'deliveries', 'events', 'outbox', 'links'].map((t) => [t, ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)!.n]))
    console.log(JSON.stringify({ contacts: N, laps, peakRss: mb(peak), dbSize: mb(size), rows }, null, 2))
    for (const [label, ms] of Object.entries(laps)) assert.ok(ms < 600_000, `${label} took ${ms} ms`)
  } finally {
    clearInterval(sampler)
    install.close()
  }
})

/** Row writes per email on the Node driver: the number docs/self-hosting.md turns into a Workers Free list size. */
test('row writes per sent email, open, click and signup', { timeout: 600_000 }, async () => {
  const { install, owner, nl, ctx } = await sendableInstall({ env: { SEND_RATE_PER_SECOND: '10000', SEND_BATCH_SIZE: '1000' } })
  try {
    const n = 1000
    for (let i = 0; i < n; i++) subscribe(ctx, { newsletterId: nl.id, email: `rows${i}@example.com`, source: 'test', consent: 'confirmed' })
    const issue = await createIssue(owner, nl.id)
    let changes = 0
    const run = ctx.db.run
    ctx.db.run = (sql, ...params) => { const r = run.call(ctx.db, sql, ...params); changes += r.changes; return r }
    const control = install.app.control.ctx
    let controlChanges = 0
    const controlRun = control.db.run
    control.db.run = (sql, ...params) => { const r = controlRun.call(control.db, sql, ...params); controlChanges += r.changes; return r }
    await owner.action('campaigns.send', { campaignId: issue.id })
    const planned = changes
    changes = 0
    const sent = await drive(install, owner, issue.id, { maxSeconds: 300 })
    assert.equal(sent.status, 'sent')
    const perEmail = { plan: planned / n, send: changes / n, control: controlChanges / n }
    const mail = install.outbox(owner.accountId!).find((m) => m.to_email === 'rows1@example.com')!
    const pixel = /http:\/\/app\.example\.com\/t\/o\/[A-Za-z0-9_.-]+/.exec(mail.html)![0]
    const click = /http:\/\/app\.example\.com\/t\/c\/[A-Za-z0-9_.-]+/.exec(mail.html)![0]
    install.clock.advance(10_000)
    changes = 0
    await install.fetch(pixel, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } })
    const open = changes
    changes = 0
    await install.fetch(click, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } })
    const clicked = changes
    changes = 0
    subscribe(ctx, { newsletterId: nl.id, email: 'rows-new@example.com', source: 'test', consent: 'confirmed' })
    const signup = changes
    console.log(JSON.stringify({ rowWrites: { perEmail, open, click: clicked, signup } }))
    assert.ok(perEmail.send < 20, `sending writes ${perEmail.send} rows per email`)
  } finally { install.close() }
})
