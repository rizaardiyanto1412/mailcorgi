/**
 * A send batch writes its daily, campaign and usage counters once at the end. A crash between the
 * provider calls and that write must lose none of them for good: what is transactional with the
 * delivery rows stays right, and the rest is repaired from `deliveries` by the hourly and rollup jobs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addContacts, createIssue, drive, sendableInstall } from './sending-setup.ts'

for (const cloud of [false, true]) test(`a crash after the sends and before the batch counters loses no count (${cloud ? 'cloud' : 'self-hosted'})`, async (t) => {
  const { install, owner, nl, ctx, accountId } = await sendableInstall({ cloud })
  t.after(() => install.close())
  addContacts(ctx, nl.id, 3)
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: issue.id })
  const today = new Date(install.clock.now()).toISOString().slice(0, 10)
  const period = today.slice(0, 7)

  // The crash: the first counter statement after the provider calls dies, as a killed isolate would.
  const run = ctx.db.run.bind(ctx.db)
  let crashed = false
  ctx.db.run = (sql, ...params) => {
    if (!crashed && /INSERT INTO daily_stats \(newsletter_id, day, sent\) VALUES/.test(sql)) {
      crashed = true
      throw new Error('simulated crash before the batch counters')
    }
    return run(sql, ...params)
  }
  install.clock.advance(1000)
  await install.runJobs()
  ctx.db.run = run
  assert.ok(crashed, 'the batch reached its counter write')

  const count = (sql: string, ...params: (string | number)[]) => ctx.db.get<{ n: number }>(sql, ...params)!.n
  assert.equal(count("SELECT COUNT(*) n FROM deliveries WHERE campaign_id = ? AND status = 'sent'", issue.id), 3, 'the emails went out')
  assert.equal(install.outbox(accountId).filter((m) => m.kind === 'campaign').length, 3)
  // Counters written in the same transaction as the delivery row survive the crash.
  assert.equal(count('SELECT COUNT(*) n FROM contacts WHERE newsletter_id = ? AND sent_count = 1 AND last_sent_at IS NOT NULL AND ignored_streak = 1', nl.id), 3, 'contact counters ride with the delivery row')
  assert.equal(count('SELECT COALESCE(SUM(emails_sent), 0) n FROM usage WHERE period = ?', period), 0, 'the batch tally was lost')
  const job = ctx.db.get<{ attempts: number }>("SELECT attempts FROM jobs WHERE kind = 'send.batch'")
  assert.equal(job?.attempts, 1, 'the job is retried')

  // Recovery: the retry finishes the campaign, the rollup repairs the day, the hourly job repairs the month.
  install.clock.advance(60_000)
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  install.clock.advance(3_600_000)
  await install.runJobs()
  install.clock.advance(301_000)
  await install.runJobs()
  const report = await owner.action('stats.report', { campaignId: issue.id })
  assert.equal(report.counts.sent, 3, 'the campaign report counts every send')
  assert.equal(count('SELECT COALESCE(SUM(sent), 0) n FROM daily_stats WHERE newsletter_id = ? AND day = ?', nl.id, today), 3, 'the daily count is repaired')
  const usage = await install.app.stores.account(accountId).liveUsage({})
  assert.equal(usage.emailsSent, 3, 'the monthly usage is repaired from the deliveries')
  if (cloud) {
    const control = install.app.control.ctx
    const snapshot = control.db.get<{ emails_sent: number }>('SELECT emails_sent FROM usage_snapshots WHERE account_id = ? AND period = ?', accountId, period)
    assert.equal(snapshot?.emails_sent, 3, 'billing sees the repaired month')
    const reserved = Number(control.db.get<{ value: string }>('SELECT value FROM install_settings WHERE key = ?', `_send_reserved:${accountId}:${period}`)?.value ?? 0)
    assert.ok(reserved >= 3, `the permit reservation (${reserved}) never falls below what was sent`)
  }
})

test('monthly usage never counts a period twice and keeps test emails that have no delivery row', async (t) => {
  const { install, owner, nl, ctx, accountId } = await sendableInstall()
  t.after(() => install.close())
  addContacts(ctx, nl.id, 2)
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.sendTest', { campaignId: issue.id, to: ['tester@example.com'] })
  await owner.action('campaigns.send', { campaignId: issue.id })
  assert.equal((await drive(install, owner, issue.id)).status, 'sent')
  for (let i = 0; i < 3; i++) {
    install.clock.advance(3_600_000)
    await install.runJobs()
    assert.equal((await install.app.stores.account(accountId).liveUsage({})).emailsSent, 3, `hour ${i + 1}`)
  }
})
