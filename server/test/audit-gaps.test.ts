import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StoreCtx } from '../core/store.ts'
import { APP_URL, createInstall, expectError } from './harness.ts'
import { subscribe } from '../account/contacts/index.ts'
import { addContacts, createIssue, sendableInstall } from './sending-setup.ts'
import { finish, upload } from './imports-setup.ts'
import { statusOutcome } from '../account/imports/model.ts'

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

test('gap 3: an import with consent but no status column says plainly who ends up unconfirmed', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  install.dns.set('example.com', 'MX', ['10 mx.example.com'])
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Imports' })
  const rows = [{ email: 'one@example.com' }, { email: 'two@example.com' }]
  const id = await upload(owner, nl.id, rows, { mapping: { email: 'email', fields: {} }, options: { consent: true, tagIds: [], statuses: 'preserve', defaultStatus: 'pending' } })
  const report = await finish(install, owner, nl.id, id)
  assert.equal(report.added, 2)
  assert.deepEqual(report.addedBreakdown && { subscribed: report.addedBreakdown.subscribed, unconfirmed: report.addedBreakdown.unconfirmed, reasons: report.addedBreakdown.unconfirmedReasons }, { subscribed: 0, unconfirmed: 2, reasons: { no_status_column: 2 } })
  assert.match(report.addedBreakdown!.note!, /2 contacts were added as unconfirmed because no status column was mapped/)
  assert.match(report.addedBreakdown!.note!, /receive no issues/)
  const note = install.app.account(owner.accountId!).ctx.db.get<{ body: string }>("SELECT body FROM notifications WHERE kind = 'import_finished'")!.body
  assert.match(note, /0 contacts added and subscribed\. 2 contacts were added as unconfirmed/)

  const mixed = await upload(owner, nl.id, [{ email: 'three@example.com', status: 'subscribed' }, { email: 'four@example.com', status: 'pending' }], { mapping: { email: 'email', status: 'status', fields: {} } })
  const split = (await finish(install, owner, nl.id, mixed)).addedBreakdown!
  assert.deepEqual([split.subscribed, split.unconfirmed, split.unconfirmedReasons], [1, 1, { pending_in_file: 1 }])

  const noConsent = await upload(owner, nl.id, [{ email: 'five@example.com' }], { mapping: { email: 'email', fields: {} }, options: { consent: false, tagIds: [], statuses: 'preserve', defaultStatus: 'subscribed' } })
  assert.deepEqual((await finish(install, owner, nl.id, noConsent)).addedBreakdown!.unconfirmedReasons, { no_consent: 1 })

  const outcome = statusOutcome({}, { consent: true, defaultStatus: 'pending', statuses: 'preserve' })
  assert.equal(outcome.tone, 'warn')
  assert.match(outcome.text, /every row is added as unconfirmed\. Unconfirmed contacts receive no issues/)
  assert.equal(statusOutcome({}, { consent: true, defaultStatus: 'subscribed', statuses: 'preserve' }).tone, 'ok')
})

test('gap 3: the import options tell REST and MCP callers what an unmapped status means', async (t) => {
  const install = await createInstall()
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  const key = await owner.action('apikeys.create', { name: 'Docs', access: 'read' })
  const response = await install.fetch('/api/v1/openapi.json', { headers: { authorization: `Bearer ${key.secret}` } })
  const doc = JSON.stringify(await response.json())
  assert.match(doc, /adds contacts as unconfirmed: they receive no issues and no confirmation email/)
  assert.match(doc, /every other active row is added as unconfirmed and receives no email/)
})

test('gap 4: past the contact limit, the API refuses, signup says so, imports skip, and subscribe() reports limit', async (t) => {
  const install = await createInstall({ cloud: true })
  t.after(() => install.close())
  install.dns.set('example.com', 'MX', ['10 mx.example.com'])
  const owner = await install.signUp({ email: 'owner@example.com' })
  const nl = await owner.action('newsletters.create', { name: 'Limits' })
  const accountId = owner.accountId!
  await install.app.stores.account(accountId).applyPolicy({ version: 5, status: 'active', plan: 'test', limits: { maxContacts: 2, maxEmailsPerMonth: 100, maxNewsletters: 3, maxTeamPerNewsletter: 2 } })
  const ctx = install.app.account(accountId).ctx
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'one@example.com' })
  await owner.action('contacts.create', { newsletterId: nl.id, email: 'two@example.com' })
  const count = () => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts')!.n

  const err = await expectError(() => owner.action('contacts.create', { newsletterId: nl.id, email: 'three@example.com' }))
  assert.equal(err.status, 403)
  assert.equal(err.code, 'limit_reached')
  assert.equal((err.details as { billingUrl: string }).billingUrl, '/settings/billing')
  assert.match(err.message, /2 of 2 contacts used/)
  assert.equal(count(), 2)

  const key = await owner.action('apikeys.create', { name: 'Full', access: 'full' })
  const rest = await install.fetch(`/api/v1/newsletters/${nl.id}/contacts`, { method: 'POST', headers: { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'four@example.com' }) })
  assert.equal(rest.status, 403)
  const body = await rest.json() as { error: { code: string } }
  assert.equal(body.error.code, 'limit_reached')
  assert.equal(count(), 2)

  assert.equal(subscribe(ctx, { newsletterId: nl.id, email: 'five@example.com', source: 'test', consent: 'confirmed' }).outcome, 'limit')

  const formConfig = await (await install.fetch(`/api/public/subscribe/${nl.key}`)).json() as { formToken: string }
  install.clock.advance(2001)
  const signup = await install.app.edge.fetch(new Request(`${APP_URL}/api/public/subscribe/${nl.key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'reader@example.com', formToken: formConfig.formToken }) }), '192.0.2.9')
  assert.equal(signup.status, 503)
  assert.match(JSON.stringify(await signup.json()), /not taking new subscribers/)
  assert.equal(count(), 2)
  assert.equal(install.outbox(accountId).filter((m) => m.to_email === 'reader@example.com').length, 0)
  assert.equal(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE title = 'New signups are being turned away'")!.n, 1)

  const id = await upload(owner, nl.id, [{ email: 'six@example.com', status: 'subscribed' }])
  assert.deepEqual((await finish(install, owner, nl.id, id)).skipped, { contact_limit: 1 })
})

test('gap 5: billing shows live usage right after adding contacts; the admin list labels its snapshot time', async (t) => {
  const install = await createInstall({ cloud: true, env: { ADMIN_EMAILS: 'owner@example.com' } })
  t.after(() => install.close())
  const owner = await install.signUp({ email: 'owner@example.com' })
  await install.runJobs()
  const nl = await owner.action('newsletters.create', { name: 'Live' })
  const snapshotAt = install.clock.now()
  install.clock.advance(10 * 60_000)
  for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) await owner.action('contacts.create', { newsletterId: nl.id, email })
  const billing = await owner.action('billing.get', { accountId: owner.accountId! })
  assert.equal(billing.usage.contacts, 3)
  assert.equal(billing.usage.live, true)

  const accounts = await owner.action('admin.accounts', {})
  const row = accounts.find((a) => a.id === owner.accountId)!
  assert.equal(row.contacts, 0, 'the admin list stays on the snapshot')
  assert.ok(row.usage_updated_at !== null && row.usage_updated_at <= snapshotAt, 'and says when it was taken')

  const err = await expectError(() => owner.action('newsletters.create', { name: 'Second' }))
  assert.equal(err.code, 'limit_reached')
  assert.match(err.message, /1 of 1 active newsletters/)
})
