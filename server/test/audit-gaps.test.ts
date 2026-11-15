import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StoreCtx } from '../core/store.ts'
import { createInstall, expectError } from './harness.ts'
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

test('gap 2: choosing an email provider needs its credentials, checked against saved values and env', async (t) => {
  const install = await createInstall({ env: { SES_SECRET_ACCESS_KEY: 'environment-secret' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const refused = async (values: Record<string, string>) => {
    const err = await expectError(() => owner.action('install.settings.set', { values }))
    assert.equal(err.code, 'missing_credentials')
    assert.equal(err.status, 400)
    return { message: err.message, missing: (err.details as { missing: string[] }).missing }
  }

  const ses = await refused({ email_provider: 'ses' })
  assert.deepEqual(ses.missing, ['ses_region', 'ses_access_key_id'], 'the env secret counts; the rest are named')
  assert.match(ses.message, /Amazon SES needs ses_region, ses_access_key_id/)
  assert.deepEqual((await refused({ email_provider: 'resend' })).missing, ['resend_api_key'])
  assert.deepEqual((await refused({ email_provider: 'smtp' })).missing, ['smtp_host'])
  assert.deepEqual((await refused({ email_provider: 'smtp', smtp_host: 'smtp.example.com', smtp_user: 'mailer' })).missing, ['smtp_password'])
  assert.equal((await owner.action('install.settings.get', {})).values.email_provider, '', 'nothing was saved')

  await owner.action('install.settings.set', { values: { email_provider: 'ses', ses_region: 'us-east-1', ses_access_key_id: 'fixture-id' } })
  let settings = await owner.action('install.settings.get', {})
  assert.equal(settings.values.email_provider, 'ses')
  assert.deepEqual(settings.missing, [])

  await owner.action('install.settings.set', { values: { resend_api_key: 'fixture-key' } })
  assert.deepEqual((await refused({ ses_access_key_id: '' })).missing, ['ses_access_key_id'], 'clearing a needed credential is refused')
  await owner.action('install.settings.set', { values: { email_provider: 'resend' } })
  await owner.action('install.settings.set', { values: { email_provider: 'test', resend_api_key: '' } })
  settings = await owner.action('install.settings.get', {})
  assert.equal(settings.values.email_provider, 'test')
})
