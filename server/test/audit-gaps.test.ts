import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StoreCtx } from '../core/store.ts'
import { expectError } from './harness.ts'
import { addContacts, createIssue, sendableInstall } from './sending-setup.ts'

type Sendable = Awaited<ReturnType<typeof sendableInstall>>

async function bounceSent(s: Sendable, campaignId: string, n: number, prefix: string) {
  const sent = s.ctx.db.all<{ id: number; email: string }>("SELECT id, email FROM deliveries WHERE campaign_id = ? AND status = 'sent' ORDER BY id LIMIT ?", campaignId, n)
  const events = sent.map((d, i) => ({ id: `${prefix}${i}`, type: 'bounce' as const, bounce: { permanent: true, nonexistent: false, reason: 'Unknown user' }, accountId: s.accountId, deliveryId: String(d.id), messageId: `m${d.id}`, recipient: d.email, occurredAt: s.install.clock.now() }))
  await s.install.app.stores.account(s.accountId).ingestProviderEvents({ events })
}

const sentCount = (ctx: StoreCtx, campaignId: string) => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM deliveries WHERE campaign_id = ? AND sent_at IS NOT NULL', campaignId)!.n

test('gap 1: "send to more now" is refused while the warm-up bounces, naming the rate and the limit', async (t) => {
  const s = await sendableInstall()
  t.after(() => s.install.close())
  const { install, owner, nl, ctx } = s
  addContacts(ctx, nl.id, 1000)
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: issue.id, gradual: true })
  await install.runJobs()
  assert.equal(sentCount(ctx, issue.id), 20)
  await bounceSent(s, issue.id, 2, 'b')
  const err = await expectError(() => owner.action('campaigns.sendMore', { campaignId: issue.id }))
  assert.equal(err.code, 'step_held')
  assert.equal(err.status, 409)
  assert.match(err.message, /10%/)
  assert.match(err.message, /2\.5% limit/)
  const progress = await owner.action('campaigns.progress', { campaignId: issue.id })
  assert.deepEqual(progress.steps.map((step) => step.state), ['done', 'pending', 'pending'])
  await install.runJobs()
  assert.equal(sentCount(ctx, issue.id), 20, 'nothing from the held step went out')
})

test('gap 1: pausing and resuming does not reset the step gate', async (t) => {
  const s = await sendableInstall()
  t.after(() => s.install.close())
  const { install, owner, nl, ctx } = s
  addContacts(ctx, nl.id, 1000)
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: issue.id, gradual: true })
  await install.runJobs()
  await bounceSent(s, issue.id, 2, 'r')
  await owner.action('campaigns.pause', { campaignId: issue.id })
  install.clock.advance(30 * 60_000)
  const err = await expectError(() => owner.action('campaigns.resume', { campaignId: issue.id }))
  assert.equal(err.code, 'step_held')
  assert.match(err.message, /Hard bounces are at 10%/)
  assert.equal((await owner.action('campaigns.get', { campaignId: issue.id })).status, 'paused')
  assert.equal(sentCount(ctx, issue.id), 20)
})

test('gap 1: a resume before the next step is due still holds that step when its time comes', async (t) => {
  const s = await sendableInstall()
  t.after(() => s.install.close())
  const { install, owner, nl, ctx } = s
  addContacts(ctx, nl.id, 1000)
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: issue.id, gradual: true })
  await install.runJobs()
  await bounceSent(s, issue.id, 2, 'e')
  await owner.action('campaigns.pause', { campaignId: issue.id })
  assert.equal((await owner.action('campaigns.resume', { campaignId: issue.id })).status, 'sending')
  install.clock.advance(30 * 60_000)
  await install.runJobs()
  const c = await owner.action('campaigns.get', { campaignId: issue.id })
  assert.equal(c.status, 'paused')
  assert.equal(c.pauseReason, 'bounce_rate')
  assert.equal(sentCount(ctx, issue.id), 20)
})

test('gap 1: engaged-first "send to more" is gated too, and passes when rates are fine', async (t) => {
  const s = await sendableInstall()
  t.after(() => s.install.close())
  const { install, owner, nl, ctx } = s
  const ids = addContacts(ctx, nl.id, 60)
  ctx.db.run(`UPDATE contacts SET last_opened_at = ? WHERE id IN (${ids.slice(0, 30).map(() => '?').join(',')})`, install.clock.now() - 86_400_000, ...ids.slice(0, 30))
  const issue = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: issue.id, engagedFirst: true })
  await install.runJobs()
  assert.equal(sentCount(ctx, issue.id), 30)
  await bounceSent(s, issue.id, 1, 'g')
  assert.equal((await expectError(() => owner.action('campaigns.sendMore', { campaignId: issue.id }))).code, 'step_held')

  const second = await createIssue(owner, nl.id)
  await owner.action('campaigns.send', { campaignId: second.id, engagedFirst: true })
  await install.runJobs()
  const { steps } = await owner.action('campaigns.sendMore', { campaignId: second.id })
  assert.equal(steps[1].state, 'released')
})
